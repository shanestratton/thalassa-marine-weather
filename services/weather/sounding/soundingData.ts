/**
 * soundingData — ECMWF IFS 0.25° upper air for the Sounding sheet (build 125, SND).
 *
 * THE PATH. The Supabase proxy, the app's only weather backend. The plan
 * named a tailnet wx-server path for Shane's own devices, but that path was
 * deleted on Shane's ruling of 2026-08-20 ("we are not using tailnet in the
 * final product. the wx server should update supabase which in turn updates
 * the app"), and check-beta-readiness pins its absence. Until the proxy's
 * pressure-level allowlist is deployed (an edge deploy, Shane's call), the
 * proxy answers 400 and the sheet says soundings need the next server update.
 *
 * THE RULES (CLAUDE.md, weather server):
 *  - Always &models=ecmwf_ifs025: a silent default must never stand in.
 *  - Count non-null VALUES, never keys: a model that is not synced answers
 *    200 with every field null, and a sync can be partial.
 *  - surface_pressure is not a field the wx server serves; pressure_msl is.
 *  - Split the request: neither call carries ~40 fields (the proxy caps an
 *    hourly list at 32).
 *
 * THE CACHE. One answer covers now to +75 h, so it is kept per 0.25° grid
 * point and per clock hour: a second tap in the same place that hour costs
 * nothing, and two taps in flight share one request. Failures are never kept,
 * except "needs the next server update", which holds for an hour: every
 * refused tap would spend quota on an answer that cannot change sooner.
 * Fetched only on an explicit tap, never on a map move.
 *
 * WHY A 400 MEANS "NEEDS THE UPDATE". The proxy answers every refusal with
 * the same 400, so the request is made one the deployed allowlist cannot
 * refuse on any other ground: the longitude wrapped into ±180 (Mapbox hands
 * back 186° past the antimeridian with world copies on), the position checked
 * here first, and the fixed shape run through the proxy's own validator in
 * the tests. A 400 left over is the pressure-level names.
 */
import { fetchOpenMeteoProxy, type OpenMeteoParameters } from '../openMeteoProxy';

export const SOUNDING_MODEL = 'ecmwf_ifs025';
/** The seven levels the wx server syncs for ECMWF (om-sync-upper), surface up. */
export const SOUNDING_LEVELS = [1000, 925, 850, 700, 500, 300, 250] as const;
/** Now plus 72 h, and the hour after it so the 24 h trend has room. */
const FORECAST_HOURS = 76;
const HOUR_MS = 3_600_000;

const SURFACE_FIELDS = [
    'temperature_2m',
    'dew_point_2m',
    'pressure_msl',
    'wind_speed_10m',
    'wind_direction_10m',
    'cape',
];
const THERMO_FIELDS = SOUNDING_LEVELS.flatMap((p) => [
    `temperature_${p}hPa`,
    `relative_humidity_${p}hPa`,
    `geopotential_height_${p}hPa`,
]);
const WIND_FIELDS = SOUNDING_LEVELS.flatMap((p) => [`wind_speed_${p}hPa`, `wind_direction_${p}hPa`]);

type Series = (number | null)[];

export interface SoundingLevelSeries {
    p: number;
    t: Series;
    rh: Series;
    z: Series;
    windKmh: Series;
    windFrom: Series;
}

export interface SoundingData {
    /** The grid point that answered (0.25°). */
    lat: number;
    lon: number;
    elevation: number;
    /** The offset at the first hour; formatting uses the zone, so a clock change inside 72 h is kept. */
    utcOffsetSeconds: number;
    /** The location's IANA zone (timezone=auto), when the answer names one. */
    timezone: string | null;
    /** Epoch ms, hourly from the current hour. */
    times: number[];
    surface: { t: Series; td: Series; mslp: Series; windKmh: Series; windFrom: Series; cape: Series };
    levels: SoundingLevelSeries[];
}

export type SoundingFetch =
    | { status: 'ok'; data: SoundingData }
    | { status: 'unavailable' }
    | { status: 'needs-update' }
    | { status: 'error'; message: string };

/** The nearest point on ECMWF's 0.25° grid. */
export const snapToGrid = (v: number): number => Math.round(v * 4) / 4;

/** Into −180..180: a tap on a world copy past the antimeridian arrives as 186°. */
export const wrapLongitude = (lon: number): number => ((((lon + 180) % 360) + 360) % 360) - 180;

/** The grid point the request names: snapped, and wrapped again so 179.9° never asks for 180.25°. */
const gridPoint = (lat: number, lon: number) => ({
    lat: snapToGrid(lat),
    lon: wrapLongitude(snapToGrid(wrapLongitude(lon))),
});

export function soundingRequestParams(lat: number, lon: number): OpenMeteoParameters[] {
    const at = gridPoint(lat, lon);
    const common = {
        latitude: at.lat,
        longitude: at.lon,
        models: SOUNDING_MODEL,
        forecast_hours: FORECAST_HOURS,
        timezone: 'auto',
        timeformat: 'unixtime',
        cell_selection: 'nearest',
    };
    return [
        { ...common, hourly: [...SURFACE_FIELDS, ...THERMO_FIELDS].join(',') },
        { ...common, hourly: WIND_FIELDS.join(',') },
    ];
}

interface Answer {
    latitude?: number;
    longitude?: number;
    elevation?: number;
    utc_offset_seconds?: number;
    timezone?: string;
    hourly?: Record<string, unknown>;
}

function series(hourly: Record<string, unknown> | undefined, name: string, length: number): Series {
    const raw = hourly?.[name];
    return Array.from({ length }, (_, i) => {
        const v = Array.isArray(raw) ? raw[i] : null;
        return typeof v === 'number' && Number.isFinite(v) ? v : null;
    });
}

const nonNull = (s: Series): number => s.filter((v) => v !== null).length;

/** Both answers as one sounding, or null when no hour could ever be drawn. */
export function parseSounding(thermo: Answer, wind: Answer): SoundingData | null {
    const time = thermo.hourly?.time;
    if (!Array.isArray(time) || time.length === 0) return null;
    const n = time.length;
    const levels = SOUNDING_LEVELS.map((p) => ({
        p,
        t: series(thermo.hourly, `temperature_${p}hPa`, n),
        rh: series(thermo.hourly, `relative_humidity_${p}hPa`, n),
        z: series(thermo.hourly, `geopotential_height_${p}hPa`, n),
        windKmh: series(wind.hourly, `wind_speed_${p}hPa`, n),
        windFrom: series(wind.hourly, `wind_direction_${p}hPa`, n),
    }));
    // Values, not keys: an unsynced model answers every key with nulls.
    if (levels.every((l) => nonNull(l.t) === 0 || nonNull(l.rh) === 0)) return null;
    const surface = {
        t: series(thermo.hourly, 'temperature_2m', n),
        td: series(thermo.hourly, 'dew_point_2m', n),
        mslp: series(thermo.hourly, 'pressure_msl', n),
        windKmh: series(thermo.hourly, 'wind_speed_10m', n),
        windFrom: series(thermo.hourly, 'wind_direction_10m', n),
        cape: series(thermo.hourly, 'cape', n),
    };
    // Every hour starts from the surface air: without it no hour can be drawn.
    if (nonNull(surface.t) === 0 || nonNull(surface.td) === 0 || nonNull(surface.mslp) === 0) return null;
    return {
        lat: Number(thermo.latitude),
        lon: Number(thermo.longitude),
        elevation: Number(thermo.elevation) || 0,
        utcOffsetSeconds: Number(thermo.utc_offset_seconds) || 0,
        timezone: typeof thermo.timezone === 'string' && thermo.timezone ? thermo.timezone : null,
        times: time.map((t) => Number(t) * 1000),
        surface,
        levels,
    };
}

/** A handful of points is plenty: each answer is ~3,000 numbers. */
const CACHE_LIMIT = 12;
const cache = new Map<string, { hour: number; result: Promise<SoundingFetch> }>();
/** Until when a refused request is answered from memory (epoch ms). */
let needsUpdateUntil = 0;

export function clearSoundingCache(): void {
    cache.clear();
    needsUpdateUntil = 0;
}

async function load(lat: number, lon: number): Promise<SoundingFetch> {
    try {
        const [thermo, wind] = await Promise.all(
            soundingRequestParams(lat, lon).map((params) => fetchOpenMeteoProxy<Answer>('forecast', params)),
        );
        const data = parseSounding(thermo, wind);
        return data ? { status: 'ok', data } : { status: 'unavailable' };
    } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        // The proxy refuses names it does not allow with a 400: until the
        // pressure-level allowlist is deployed, that is what a sounding gets.
        if (/\(400\)/.test(message)) return { status: 'needs-update' };
        return { status: 'error', message };
    }
}

/** The sounding for the grid point nearest (lat, lon), cached per point and hour. */
export function fetchSounding(lat: number, lon: number, opts: { now?: number } = {}): Promise<SoundingFetch> {
    const now = opts.now ?? Date.now();
    if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon))
        return Promise.resolve({ status: 'error', message: 'Not a position on the globe' });
    if (now < needsUpdateUntil) return Promise.resolve({ status: 'needs-update' });
    const hour = Math.floor(now / HOUR_MS);
    const at = gridPoint(lat, lon);
    const key = `${at.lat},${at.lon}`;
    const hit = cache.get(key);
    if (hit && hit.hour === hour) return hit.result;
    const result = load(at.lat, at.lon).then((outcome) => {
        if (outcome.status === 'needs-update') needsUpdateUntil = now + HOUR_MS;
        if (outcome.status !== 'ok' && cache.get(key)?.result === result) cache.delete(key);
        return outcome;
    });
    cache.delete(key);
    cache.set(key, { hour, result });
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    return result;
}
