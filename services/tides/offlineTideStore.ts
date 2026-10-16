/** Per-end-user saved tables, deliberately separate from fresh publisher capability.
 * Only actual events are retained; this store invents neither heights nor datums. */
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    type AuthIdentityScope,
} from '../authIdentityScope';
import { loadLargeData, saveLargeDataImmediate } from '../nativeStorage';
import type { OfficialTideDocument } from './officialTides';
import type { TideStation, TideStationDetails, StationTideExtreme } from './stationDetails';

export const OFFLINE_TIDE_KEY = 'thalassa_offline_tides_v1';
const DAY = 86_400_000;
const MAX_BYTES = 1_048_576;
const MAX_TABLES = 24;
export interface SavedTideTable {
    id: string;
    provider: 'WorldTides' | 'MSQ' | 'NOAA' | 'LINZ';
    station: TideStation;
    requestedLocation: { lat: number; lon: number };
    predictionLocation: { lat: number; lon: number } | null;
    predictionStationName: string | null;
    datum: string | null;
    datumId: string | null;
    timezone: string | null;
    fetchedAtMs: number;
    savedAtMs: number;
    generatedAt: string | null;
    /** Actual first/last returned events, not the requested number of days. */
    coverageStartMs: number;
    coverageEndMs: number;
    extremes: StationTideExtreme[];
    copyright: string;
    sourceUrl: string;
    licenceUrl: string;
    official: boolean;
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const text = (v: unknown, max = 300): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const nullableText = (v: unknown, max = 300) => v === null || text(v, max);
export function tidePosition(v: unknown): v is { lat: number; lon: number } {
    return record(v) && finite(v.lat) && finite(v.lon) && Math.abs(v.lat) <= 90 && Math.abs(v.lon) <= 180;
}
function publicUrl(value: unknown): boolean {
    if (!text(value, 1024)) return false;
    try {
        const u = new URL(value);
        return (
            u.protocol === 'https:' &&
            !u.username &&
            !u.password &&
            !u.hash &&
            ![...u.searchParams.keys()].some((k) => /key|token|password|secret|authorization/i.test(k))
        );
    } catch {
        return false;
    }
}
export function tideDistanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
    const r = Math.PI / 180,
        dlat = (b.lat - a.lat) * r,
        dlon = (b.lon - a.lon) * r;
    const x = Math.sin(dlat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dlon / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(Math.min(1, x)));
}
export function validSavedTideTable(raw: unknown, now = Date.now()): raw is SavedTideTable {
    if (
        !record(raw) ||
        !text(raw.id, 500) ||
        !['WorldTides', 'MSQ', 'NOAA', 'LINZ'].includes(String(raw.provider)) ||
        !record(raw.station) ||
        !text(raw.station.id, 200) ||
        !text(raw.station.name) ||
        !finite(raw.station.distance) ||
        raw.station.distance < 0 ||
        raw.station.distance > 30_000 ||
        !tidePosition(raw.station) ||
        !tidePosition(raw.requestedLocation) ||
        !(raw.predictionLocation === null || tidePosition(raw.predictionLocation)) ||
        !nullableText(raw.predictionStationName) ||
        !nullableText(raw.datum, 120) ||
        !nullableText(raw.datumId, 200) ||
        !nullableText(raw.timezone, 100) ||
        !nullableText(raw.generatedAt, 64) ||
        !finite(raw.fetchedAtMs) ||
        !finite(raw.savedAtMs) ||
        raw.fetchedAtMs > raw.savedAtMs ||
        raw.fetchedAtMs < now - 31 * DAY ||
        raw.savedAtMs > now + 120_000 ||
        raw.savedAtMs < now - 31 * DAY ||
        !finite(raw.coverageStartMs) ||
        !finite(raw.coverageEndMs) ||
        raw.coverageStartMs >= raw.coverageEndMs ||
        raw.coverageEndMs - raw.coverageStartMs > 32 * DAY ||
        raw.coverageEndMs < now - DAY ||
        !text(raw.copyright, 4096) ||
        !publicUrl(raw.sourceUrl) ||
        !publicUrl(raw.licenceUrl) ||
        typeof raw.official !== 'boolean' ||
        raw.official !== (raw.provider !== 'WorldTides') ||
        !Array.isArray(raw.extremes) ||
        raw.extremes.length < 2 ||
        raw.extremes.length > 256
    )
        return false;
    let previous = -Infinity;
    for (const event of raw.extremes) {
        if (
            !record(event) ||
            !finite(event.timeMs) ||
            !finite(event.heightM) ||
            Math.abs(event.heightM) > 100 ||
            !['High', 'Low'].includes(String(event.type)) ||
            event.timeMs <= previous ||
            event.timeMs < raw.coverageStartMs ||
            event.timeMs > raw.coverageEndMs
        )
            return false;
        previous = event.timeMs;
    }
    if (
        raw.generatedAt !== null &&
        (!/Z$/.test(raw.generatedAt as string) ||
            !Number.isFinite(Date.parse(raw.generatedAt as string)) ||
            Date.parse(raw.generatedAt as string) > raw.fetchedAtMs + 120000)
    )
        return false;
    if (raw.official && (!raw.generatedAt || !raw.datum || !raw.datumId)) return false;
    return (
        raw.id === keyFor(raw as unknown as SavedTideTable) &&
        raw.extremes[0].timeMs === raw.coverageStartMs &&
        previous === raw.coverageEndMs
    );
}
function keyFor(table: Pick<SavedTideTable, 'provider' | 'station' | 'requestedLocation' | 'datum'>): string {
    return `${table.provider}:${table.station.id}:${table.requestedLocation.lat.toFixed(6)},${table.requestedLocation.lon.toFixed(6)}:${table.datum ?? 'unknown'}`;
}
export function tableFromStationDetails(detail: TideStationDetails, now = Date.now()): SavedTideTable | null {
    if (detail.source !== 'WorldTides' || detail.extremes.length < 2) return null;
    const table: SavedTideTable = {
        id: '',
        provider: 'WorldTides',
        station: detail.station,
        requestedLocation: { lat: detail.station.lat, lon: detail.station.lon },
        predictionLocation: detail.predictionLocation,
        predictionStationName: detail.predictionStationName,
        datum: detail.datum,
        datumId: null,
        timezone: detail.timezone,
        fetchedAtMs: detail.fetchedAtMs,
        savedAtMs: now,
        generatedAt: null,
        coverageStartMs: detail.extremes[0].timeMs,
        coverageEndMs: detail.extremes.at(-1)!.timeMs,
        extremes: detail.extremes.map((e) => ({ ...e })),
        copyright: detail.copyright,
        official: false,
        sourceUrl: 'https://www.worldtides.info',
        licenceUrl: 'https://www.worldtides.info/copyright',
    };
    table.id = keyFor(table);
    return validSavedTideTable(table, now) ? table : null;
}
export function tableFromOfficial(
    doc: OfficialTideDocument,
    requestedLocation: { lat: number; lon: number },
    now = Date.now(),
): SavedTideTable | null {
    const extremes = doc.events.map((e) => ({ timeMs: Date.parse(e.time), heightM: e.heightM, type: e.type }));
    const table: SavedTideTable = {
        id: '',
        provider: doc.provider,
        station: { id: doc.stationId, name: doc.stationName, lat: doc.lat, lon: doc.lon, distance: 0 },
        requestedLocation,
        predictionLocation: { lat: doc.lat, lon: doc.lon },
        predictionStationName: doc.stationName,
        datum: doc.datumLabel,
        datumId: doc.datumId,
        timezone: null,
        fetchedAtMs: now,
        savedAtMs: now,
        generatedAt: doc.generatedAt,
        coverageStartMs: extremes[0]?.timeMs,
        coverageEndMs: extremes.at(-1)?.timeMs ?? NaN,
        extremes,
        copyright: doc.attribution,
        sourceUrl: doc.sourceUrl,
        licenceUrl: doc.licenceUrl,
        official: true,
    };
    table.id = keyFor(table);
    return validSavedTideTable(table, now) ? table : null;
}
interface Envelope {
    schema: 1;
    ownerKey: string;
    tables: SavedTideTable[];
}
async function read(scope: AuthIdentityScope): Promise<SavedTideTable[]> {
    let raw: unknown;
    try {
        raw = await loadLargeData(authScopedStorageKey(OFFLINE_TIDE_KEY, scope));
    } catch {
        return [];
    }
    if (
        !isAuthIdentityScopeCurrent(scope) ||
        !record(raw) ||
        raw.schema !== 1 ||
        raw.ownerKey !== scope.key ||
        !Array.isArray(raw.tables) ||
        raw.tables.length > MAX_TABLES ||
        new TextEncoder().encode(JSON.stringify(raw)).length > MAX_BYTES
    )
        return [];
    return raw.tables.filter((t) => validSavedTideTable(t));
}
let writes: Promise<unknown> = Promise.resolve();
export async function listSavedTideTables(): Promise<SavedTideTable[]> {
    return read(getAuthIdentityScope());
}
export async function saveTideTable(table: SavedTideTable): Promise<boolean> {
    const scope = getAuthIdentityScope();
    const work = async () => {
        if (!isAuthIdentityScopeCurrent(scope) || !validSavedTideTable(table)) return false;
        const current = await read(scope);
        if (!isAuthIdentityScopeCurrent(scope)) return false;
        const tables = [table, ...current.filter((t) => t.id !== table.id)].slice(0, MAX_TABLES);
        const envelope: Envelope = { schema: 1, ownerKey: scope.key, tables };
        while (new TextEncoder().encode(JSON.stringify(envelope)).length > MAX_BYTES && tables.length > 1) tables.pop();
        if (new TextEncoder().encode(JSON.stringify(envelope)).length > MAX_BYTES) return false;
        try {
            await saveLargeDataImmediate(authScopedStorageKey(OFFLINE_TIDE_KEY, scope), envelope);
            if (!isAuthIdentityScopeCurrent(scope)) return false;
            return (await read(scope)).some((t) => t.id === table.id && t.savedAtMs === table.savedAtMs);
        } catch {
            return false;
        }
    };
    const result = writes.then(work, work);
    writes = result.catch(() => undefined);
    return result;
}
export async function removeSavedTideTable(id: string): Promise<void> {
    const scope = getAuthIdentityScope();
    const work = async () => {
        const tables = (await read(scope)).filter((t) => t.id !== id);
        if (isAuthIdentityScopeCurrent(scope))
            await saveLargeDataImmediate(authScopedStorageKey(OFFLINE_TIDE_KEY, scope), {
                schema: 1,
                ownerKey: scope.key,
                tables,
            });
    };
    const result = writes.then(work, work);
    writes = result.catch(() => undefined);
    await result;
}
export async function savedTidesForPoint(
    point: { lat: number; lon: number },
    now = Date.now(),
): Promise<SavedTideTable | null> {
    if (!tidePosition(point)) return null;
    return (
        (await listSavedTideTables())
            .filter(
                (t) =>
                    t.coverageStartMs <= now &&
                    t.coverageEndMs > now &&
                    tideDistanceKm(point, t.requestedLocation) <= 5,
            )
            .sort(
                (a, b) => tideDistanceKm(point, a.requestedLocation) - tideDistanceKm(point, b.requestedLocation),
            )[0] ?? null
    );
}
export function savedTableDetails(table: SavedTideTable): TideStationDetails {
    return {
        station: table.station,
        predictionLocation: table.predictionLocation,
        predictionStationName: table.predictionStationName,
        datum: table.datum,
        requestedDatum: null,
        timezone: table.timezone,
        fetchedAtMs: table.fetchedAtMs,
        heights: [],
        extremes: table.extremes,
        source: table.provider,
        copyright: table.copyright,
        kind: 'prediction',
        wind: null,
        savedAtMs: table.savedAtMs,
    };
}
