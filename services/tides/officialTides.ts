/** Official high/low tables for display. This module never supplies routing,
 * any-time depth, constants, or a sampled prediction invented from extremes. */
export type OfficialTideProvider = 'MSQ' | 'NOAA' | 'LINZ';
export interface OfficialTideObservation {
    stationId: string;
    datumId: string;
    time: string;
    observedM: number;
    predictedM: number;
    residualM: number;
    sourceUrl: string;
    predictionSourceUrl: string;
    unvalidated: true;
}
export interface OfficialTideStation {
    provider: OfficialTideProvider;
    stationId: string;
    stationName: string;
    lat: number;
    lon: number;
    datumId: string;
    datumLabel: string;
    rawDatum: string;
    sourceUrl: string;
    attribution: string;
    licenceUrl: string;
    maxDistanceKm: number;
}
export interface OfficialTideDocument extends OfficialTideStation {
    schema: 1;
    generatedAt: string;
    expiresAt: string;
    coverageStart: string;
    coverageEnd: string;
    events: { time: string; type: 'High' | 'Low'; heightM: number }[];
    observation?: OfficialTideObservation;
}
interface ManifestStation extends OfficialTideStation { path: string; }
interface Manifest { schema: 1; generatedAt: string; expiresAt: string; stations: ManifestStation[]; }
const MINUTE = 60_000, DAY = 86_400_000;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const instant = (v: unknown): v is string => typeof v === 'string' && /Z$/.test(v) && Number.isFinite(Date.parse(v));
const publicUrl = (v: unknown): v is string => {
    if (!text(v, 1024)) return false;
    try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; }
};
function fresh(v: Record<string, unknown>, now: number): boolean {
    return instant(v.generatedAt) && instant(v.expiresAt) && Date.parse(v.generatedAt) <= now + 2 * MINUTE &&
        Date.parse(v.generatedAt) >= now - 36 * 60 * MINUTE && Date.parse(v.expiresAt) > now &&
        Date.parse(v.expiresAt) <= Date.parse(v.generatedAt) + 36 * 60 * MINUTE;
}
function station(v: unknown): v is OfficialTideStation {
    if (!record(v) || !['MSQ', 'NOAA', 'LINZ'].includes(String(v.provider))) return false;
    if (!(text(v.stationId, 32) && /^[A-Za-z0-9-]+$/.test(v.stationId) && text(v.stationName, 100) &&
        finite(v.lat) && Math.abs(v.lat) <= 90 && finite(v.lon) && Math.abs(v.lon) <= 180 &&
        text(v.datumId, 120) && text(v.datumLabel, 120) && text(v.rawDatum, 200) &&
        text(v.attribution, 600) && publicUrl(v.sourceUrl) && publicUrl(v.licenceUrl) &&
        finite(v.maxDistanceKm) && v.maxDistanceKm > 0 && v.maxDistanceKm <= 15)) return false;
    // Preserve the actual provider's local datum identity. Never alias QPD1992
    // or a LINZ port chart datum to universal LAT. CHS is deliberately absent.
    return v.provider === 'NOAA' ? v.datumId === 'noaa:' + v.stationId + ':MLLW' && v.datumLabel === 'MLLW' && v.rawDatum === 'MLLW'
        : v.provider === 'MSQ' ? v.datumId === 'msq:' + v.stationId + ':QPD-LAT-1992' && v.datumLabel === 'QPD LAT (1992)' && v.rawDatum === 'LOWEST ASTRONOMICAL TIDE'
        : v.datumId === 'linz:' + v.stationId + ':chart-datum' && v.datumLabel === 'Port chart datum';
}
export function validateOfficialManifest(raw: unknown, now: number): Manifest | null {
    if (!record(raw) || raw.schema !== 1 || !fresh(raw, now) || !Array.isArray(raw.stations) || raw.stations.length > 400) return null;
    const seen = new Set<string>();
    for (const candidate of raw.stations) {
        if (!station(candidate) || !record(candidate) || typeof candidate.path !== 'string') return null;
        const prefix = 'v1/' + candidate.provider.toLowerCase() + '/' + candidate.stationId + '/';
        if (!candidate.path.startsWith(prefix) || !/^v1\/(msq|noaa|linz)\/[A-Za-z0-9-]{1,32}\/[0-9]{10,13}\.json$/.test(candidate.path)) return null;
        const key = candidate.provider + '/' + candidate.stationId;
        if (seen.has(key)) return null;
        seen.add(key);
    }
    return raw as unknown as Manifest;
}
export function validateOfficialObservation(raw: unknown, expected: Pick<OfficialTideStation, 'provider' | 'stationId' | 'datumId'>, now: number): OfficialTideObservation | null {
    if (!record(raw) || expected.provider !== 'MSQ' || raw.unvalidated !== true || raw.stationId !== expected.stationId || raw.datumId !== expected.datumId ||
        !instant(raw.time) || Date.parse(raw.time) > now + 2 * MINUTE || Date.parse(raw.time) < now - 30 * MINUTE ||
        !finite(raw.observedM) || !finite(raw.predictedM) || !finite(raw.residualM) || Math.abs(raw.residualM) > 2 ||
        Math.abs(raw.observedM - raw.predictedM - raw.residualM) > 0.002 || !publicUrl(raw.sourceUrl) || !publicUrl(raw.predictionSourceUrl)) return null;
    return raw as unknown as OfficialTideObservation;
}
export function validateOfficialDocument(raw: unknown, expected: OfficialTideStation, generatedAt: string, now: number): OfficialTideDocument | null {
    if (!record(raw) || raw.schema !== 1 || !station(raw) || !fresh(raw, now) || raw.generatedAt !== generatedAt) return null;
    for (const key of ['provider', 'stationId', 'stationName', 'lat', 'lon', 'datumId', 'datumLabel', 'rawDatum', 'sourceUrl', 'licenceUrl', 'attribution', 'maxDistanceKm'] as const) {
        if (raw[key] !== expected[key]) return null;
    }
    if (!instant(raw.coverageStart) || !instant(raw.coverageEnd) || !Array.isArray(raw.events) || raw.events.length < 4 || raw.events.length > 100) return null;
    const start = Date.parse(raw.coverageStart), end = Date.parse(raw.coverageEnd);
    if (start > now || end < now + 14 * DAY) return null;
    let previous = -Infinity;
    for (const event of raw.events) {
        if (!record(event) || !instant(event.time) || !finite(event.heightM) || event.heightM < -10 || event.heightM > 20 || (event.type !== 'High' && event.type !== 'Low')) return null;
        const at = Date.parse(event.time);
        if (at <= previous || at < start || at > end) return null;
        previous = at;
    }
    if (Date.parse(raw.events[0].time) > now || previous < now + 14 * DAY) return null;
    const document = { ...raw } as unknown as OfficialTideDocument;
    document.observation = validateOfficialObservation(raw.observation, expected, now) ?? undefined;
    return document;
}
function distanceKm(lat: number, lon: number, other: OfficialTideStation): number {
    const rad = Math.PI / 180, dlat = (other.lat - lat) * rad, dlon = (other.lon - lon) * rad;
    const a = Math.sin(dlat / 2) ** 2 + Math.cos(lat * rad) * Math.cos(other.lat * rad) * Math.sin(dlon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}
/** Fixed public Storage origin, bounded reads and timeouts, no redirect or
 * server-provided fetch URLs. All caches and failures are bounded in memory. */
export function createOfficialTideClient(base: string, fetcher: typeof fetch = fetch, clock: () => number = Date.now) {
    let root: URL | null = null;
    try { const u = new URL(base); if (u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash) root = new URL('/storage/v1/object/public/weather/tides/', u.origin); } catch { /* unavailable */ }
    let manifest: Manifest | null = null, manifestUntil = 0, failedUntil = 0;
    let pending: Promise<Manifest | null> | null = null;
    const documents = new Map<string, OfficialTideDocument>();
    const failures = new Map<string, number>();
    const pendingDocuments = new Map<string, Promise<unknown>>();
    async function get(path: string, limit: number): Promise<unknown> {
        if (!root) return null;
        const url = new URL(path, root);
        if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) return null;
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 4000);
        try {
            const response = await fetcher(url.toString(), { signal: controller.signal, redirect: 'error', credentials: 'omit' });
            if (!response.ok || (response.url && new URL(response.url).origin !== root.origin) || !response.headers.get('content-type')?.includes('application/json')) return null;
            const declared = response.headers.get('content-length');
            if (declared && Number(declared) > limit) return null;
            if (!response.body) return null;
            const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
            while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > limit) { await reader.cancel(); return null; } chunks.push(part.value); }
            const bytes = new Uint8Array(size); let offset = 0;
            for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
            return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        } catch { return null; } finally { clearTimeout(timer); }
    }
    async function readManifest(): Promise<Manifest | null> {
        const now = clock();
        if (manifest && now < manifestUntil && Date.parse(manifest.expiresAt) > now) return manifest;
        if (now < failedUntil) return null;
        if (pending) return pending;
        pending = (async () => {
            const next = validateOfficialManifest(await get('manifest.json', 512_000), clock());
            if (next) { manifest = next; manifestUntil = clock() + 5 * MINUTE; } else { manifest = null; failedUntil = clock() + MINUTE; }
            return next;
        })().finally(() => { pending = null; });
        return pending;
    }
    return async function read(lat: number, lon: number): Promise<OfficialTideDocument | null> {
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
        const list = await readManifest(); if (!list) return null;
        const nearest = list.stations.map((s) => ({ s, d: distanceKm(lat, lon, s) })).filter(({ s, d }) => d <= s.maxDistanceKm).sort((a, b) => a.d - b.d)[0]?.s;
        if (!nearest || clock() < (failures.get(nearest.path) ?? 0)) return null;
        let raw: unknown = documents.get(nearest.path);
        if (!raw) {
            let request = pendingDocuments.get(nearest.path);
            if (!request) { request = get(nearest.path, 160_000).finally(() => pendingDocuments.delete(nearest.path)); pendingDocuments.set(nearest.path, request); }
            raw = await request;
        }
        const result = validateOfficialDocument(raw, nearest, list.generatedAt, clock());
        if (!result) { documents.delete(nearest.path); failures.set(nearest.path, clock() + MINUTE); while (failures.size > 24) failures.delete(failures.keys().next().value!); return null; }
        documents.delete(nearest.path); documents.set(nearest.path, result);
        while (documents.size > 12) documents.delete(documents.keys().next().value!);
        return result;
    };
}
let defaultClient: ReturnType<typeof createOfficialTideClient> | null = null;
export async function fetchOfficialTides(lat: number, lon: number): Promise<OfficialTideDocument | null> {
    defaultClient ??= createOfficialTideClient(import.meta.env?.VITE_SUPABASE_URL ?? '');
    return defaultClient(lat, lon);
}
