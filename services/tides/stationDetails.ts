/**
 * On-demand chart tide-station predictions. Heights come only from the
 * provider's sampled predictions, never a curve invented between HW/LW.
 * WorldTides accepts coordinates (not a station ID); actual response position,
 * station name and datum are retained so a neighbouring model cannot masquerade
 * as the selected station. Nothing here is a live observed buoy reading.
 */
import { getAuthenticatedFunctionHeaders } from '../supabaseAuth';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../authIdentityScope';
import { fetchOpenMeteoProxy } from '../weather/openMeteoProxy';

export interface TideStation {
    id: string;
    name: string;
    lat: number;
    lon: number;
    distance: number;
    timezone?: string;
}
export interface StationTideHeight {
    timeMs: number;
    heightM: number;
}
export interface StationTideExtreme extends StationTideHeight {
    type: 'High' | 'Low';
}
export interface StationForecastWind {
    speedKn: number;
    directionDeg: number;
    gustKn: number | null;
    validTimeMs: number;
    fetchedAtMs: number;
    model: 'ECMWF IFS';
    source: 'ECMWF / Open-Meteo';
    kind: 'forecast';
}
export interface TideStationDetails {
    station: TideStation;
    predictionLocation: { lat: number; lon: number } | null;
    predictionStationName: string | null;
    /** The ACTUAL datum, never inferred from the requested datum. */
    datum: string | null;
    requestedDatum: string | null;
    timezone: string | null;
    fetchedAtMs: number;
    heights: StationTideHeight[];
    extremes: StationTideExtreme[];
    source: 'WorldTides';
    copyright: string;
    kind: 'prediction';
    wind: StationForecastWind | null;
}

const MAX_BYTES = 512_000;
const MAX_STATIONS = 500;
const MAX_HEIGHTS = 146; // Three days at the server-owned 30-minute interval.
const MAX_EXTREMES = 40;
const TIDE_TTL = 6 * 3_600_000;
const SEARCH_TTL = 5 * 60_000;
const WIND_TTL = 15 * 60_000;
const MAX_CACHE_ENTRIES = 48;
const tideCache = new Map<string, TideStationDetails>();
const stationCache = new Map<string, { at: number; stations: TideStation[] }>();
const windCache = new Map<string, StationForecastWind>();

function putBounded<T>(cache: Map<string, T>, key: string, value: T): void {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
}
function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
function numberIn(value: unknown, min: number, max: number): number | null {
    if (
        value === null ||
        value === undefined ||
        typeof value === 'boolean' ||
        (typeof value === 'string' && !value.trim())
    )
        return null;
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= min && n <= max ? n : null;
}
function text(value: unknown, max = 300): string | null {
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}
function position(lat: unknown, lon: unknown): { lat: number; lon: number } | null {
    const a = numberIn(lat, -90, 90),
        o = numberIn(lon, -180, 180);
    return a === null || o === null ? null : { lat: a, lon: o };
}
function timezone(value: unknown): string | null {
    const zone = text(value, 100);
    if (!zone) return null;
    try {
        new Intl.DateTimeFormat('en', { timeZone: zone });
        return zone;
    } catch {
        return null;
    }
}
function pointKey(station: { lat: number; lon: number }): string {
    return `${getAuthIdentityScope().key}:${station.lat.toFixed(6)},${station.lon.toFixed(6)}`;
}

async function readBoundedJson(response: Response): Promise<Record<string, unknown> | null> {
    const advertised = Number(response.headers.get('content-length'));
    if (Number.isFinite(advertised) && advertised > MAX_BYTES) {
        await response.body?.cancel().catch(() => undefined);
        return null;
    }
    if (!response.body) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > MAX_BYTES) {
                await reader.cancel();
                return null;
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let at = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.byteLength;
    }
    return record(JSON.parse(new TextDecoder().decode(bytes)));
}

async function tideProxy(
    payload: Record<string, number | boolean>,
    signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
    const url = import.meta.env.VITE_SUPABASE_URL;
    const key = import.meta.env.VITE_SUPABASE_ANON_KEY || import.meta.env.VITE_SUPABASE_KEY;
    if (!url || !key || signal?.aborted) return null;
    const scope = getAuthIdentityScope();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 15_000);
    try {
        let headers: Record<string, string>;
        try {
            headers = await getAuthenticatedFunctionHeaders();
        } catch {
            headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, apikey: key };
        }
        if (controller.signal.aborted || !isAuthIdentityScopeCurrent(scope)) return null;
        const response = await fetch(`${url}/functions/v1/proxy-tides`, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
            signal: controller.signal,
        });
        if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            return null;
        }
        const data = await readBoundedJson(response);
        return !controller.signal.aborted && isAuthIdentityScopeCurrent(scope) && data?.status === 200 && !data.error
            ? data
            : null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
    }
}

/** null means request/schema failure; [] is a successful search with no stations. */
export async function fetchNearbyTideStations(
    lat: number,
    lon: number,
    options: { signal?: AbortSignal } = {},
): Promise<TideStation[] | null> {
    const p = position(lat, lon);
    if (!p || options.signal?.aborted) return null;
    const key = pointKey(p);
    const cached = stationCache.get(key);
    if (cached && Date.now() - cached.at >= 0 && Date.now() - cached.at < SEARCH_TTL) return cached.stations;
    const data = await tideProxy({ lat, lon, stations: true, stationDistance: 100 }, options.signal);
    if (!Array.isArray(data?.stations) || data.stations.length > MAX_STATIONS) return null;
    const stations: TideStation[] = [];
    for (const value of data.stations) {
        const row = record(value);
        const at = row && position(row.lat, row.lon);
        const name = text(row?.name);
        const id = typeof row?.id === 'number' && Number.isSafeInteger(row.id) ? String(row.id) : text(row?.id, 200);
        if (!row || !at || !name || !id) return null;
        stations.push({
            id,
            name,
            ...at,
            distance: numberIn(row.distance, 0, 1000) ?? 0,
            ...(timezone(row.timezone) ? { timezone: timezone(row.timezone) as string } : {}),
        });
    }
    putBounded(stationCache, key, { at: Date.now(), stations });
    return stations;
}

function parseHeight(value: unknown): StationTideHeight | null {
    const row = record(value);
    if (!row) return null;
    const dt = numberIn(row.dt, 946_684_800, 4_102_444_800);
    const dateMs = typeof row.date === 'string' ? Date.parse(row.date) : NaN;
    const heightM = numberIn(row.height, -100, 100);
    if (dt === null || heightM === null || !Number.isFinite(dateMs) || Math.abs(dateMs - dt * 1000) > 1000) return null;
    return { timeMs: dt * 1000, heightM };
}

export function normaliseTideStationDetails(
    station: TideStation,
    raw: unknown,
    fetchedAtMs = Date.now(),
): TideStationDetails | null {
    const data = record(raw);
    if (
        !data ||
        data.status !== 200 ||
        data.error ||
        !Array.isArray(data.extremes) ||
        data.extremes.length > MAX_EXTREMES
    )
        return null;
    // An older deployed proxy may still return extremes only. Keep those
    // useful events, but provide no pretend current height or tide curve.
    if (data.heights !== undefined && (!Array.isArray(data.heights) || data.heights.length > MAX_HEIGHTS)) return null;
    const heights: StationTideHeight[] = [];
    const extremes: StationTideExtreme[] = [];
    for (const value of (data.heights ?? []) as unknown[]) {
        const item = parseHeight(value);
        if (!item) return null;
        heights.push(item);
    }
    for (const value of data.extremes) {
        const item = parseHeight(value),
            type = record(value)?.type;
        if (!item || (type !== 'High' && type !== 'Low')) return null;
        extremes.push({ ...item, type });
    }
    heights.sort((a, b) => a.timeMs - b.timeMs);
    extremes.sort((a, b) => a.timeMs - b.timeMs);
    if (heights.some((p, i) => i > 0 && p.timeMs === heights[i - 1].timeMs)) return null;
    const sourceStation = record(data.station);
    return {
        station,
        heights,
        extremes,
        fetchedAtMs,
        predictionLocation: position(data.responseLat, data.responseLon),
        predictionStationName: text(data.station) ?? text(sourceStation?.name),
        datum: text(data.responseDatum, 50),
        requestedDatum: text(data.requestDatum, 50),
        timezone: timezone(data.timezone) ?? timezone(station.timezone),
        source: 'WorldTides',
        copyright: text(data.copyright, 4096) ?? 'WorldTides',
        kind: 'prediction',
        wind: null,
    };
}

/** A forecast grid near this station, deliberately not a measured buoy wind. */
export async function fetchStationForecastWind(station: TideStation): Promise<StationForecastWind | null> {
    if (!position(station.lat, station.lon)) return null;
    const key = pointKey(station),
        scope = getAuthIdentityScope();
    const cached = windCache.get(key);
    if (cached && Date.now() - cached.fetchedAtMs >= 0 && Date.now() - cached.fetchedAtMs < WIND_TTL) return cached;
    try {
        const data = await fetchOpenMeteoProxy<Record<string, unknown>>(
            'forecast',
            {
                latitude: station.lat,
                longitude: station.lon,
                models: 'ecmwf_ifs025',
                current: 'wind_speed_10m,wind_direction_10m,wind_gusts_10m',
                wind_speed_unit: 'kn',
                timeformat: 'unixtime',
                timezone: 'UTC',
                forecast_days: 1,
                cell_selection: 'sea',
            },
            12_000,
        );
        if (!isAuthIdentityScopeCurrent(scope)) return null;
        const current = record(data.current),
            units = record(data.current_units);
        if (!current || units?.wind_speed_10m !== 'kn' || units.wind_direction_10m !== '°' || units.time !== 'unixtime')
            return null;
        const speedKn = numberIn(current.wind_speed_10m, 0, 250),
            directionDeg = numberIn(current.wind_direction_10m, 0, 360);
        const time = numberIn(current.time, 946_684_800, 4_102_444_800);
        const fetchedAtMs = Date.now();
        if (
            speedKn === null ||
            directionDeg === null ||
            time === null ||
            Math.abs(time * 1000 - fetchedAtMs) > 3 * 3_600_000
        )
            return null;
        const wind: StationForecastWind = {
            speedKn,
            directionDeg: directionDeg % 360,
            gustKn: units.wind_gusts_10m === 'kn' ? numberIn(current.wind_gusts_10m, 0, 300) : null,
            validTimeMs: time * 1000,
            fetchedAtMs,
            model: 'ECMWF IFS',
            source: 'ECMWF / Open-Meteo',
            kind: 'forecast',
        };
        putBounded(windCache, key, wind);
        return wind;
    } catch {
        return null;
    }
}

export async function fetchTideStationDetails(
    station: TideStation,
    options: { signal?: AbortSignal; includeWind?: boolean } = {},
): Promise<TideStationDetails | null> {
    if (!position(station.lat, station.lon) || options.signal?.aborted) return null;
    const key = `${pointKey(station)}:${station.id}`,
        scope = getAuthIdentityScope();
    let details = tideCache.get(key) ?? null;
    const age = details ? Date.now() - details.fetchedAtMs : Infinity;
    if (age < 0 || age >= TIDE_TTL) details = null;
    if (!details) {
        const data = await tideProxy(
            { lat: station.lat, lon: station.lon, days: 3, heights: true, stationDistance: 1 },
            options.signal,
        );
        details = normaliseTideStationDetails(station, data);
        if (!details || options.signal?.aborted || !isAuthIdentityScopeCurrent(scope)) return null;
        putBounded(tideCache, key, details);
    }
    const wind = options.includeWind ? await fetchStationForecastWind(station) : null;
    return options.signal?.aborted || !isAuthIdentityScopeCurrent(scope) ? null : { ...details, wind };
}

export function __resetTideStationDetailsForTests(): void {
    tideCache.clear();
    stationCache.clear();
    windCache.clear();
}
