import {
    MAX_FEED_BYTES,
    NDBC_MEASUREMENTS_URL,
    AWC_API_URL,
    numberIn,
    validPosition,
    withinHistory,
    hasMeasurement,
    safeText,
    type Observation,
    type ParsedObservations,
    type Station,
} from './model.js';
const fail = (error: string): ParsedObservations => ({
    rows: [],
    partial: false,
    error,
});
const boundedText = (text: string) =>
    text.length <= MAX_FEED_BYTES && new TextEncoder().encode(text).length <= MAX_FEED_BYTES;
const direction = (raw: unknown) => {
    const n = numberIn(raw, 0, 360);
    return n === null ? null : n % 360;
};
/** Calendar round-trip rejects invalid dates instead of Date.UTC normalising them. */
function utc(parts: (string | undefined)[]): number {
    if (parts.some((p) => p === undefined || !/^\d+$/.test(p))) return NaN;
    const [year, month, day, hour, minute] = parts.map(Number);
    if (year < 2000 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59)
        return NaN;
    const ms = Date.UTC(year, month - 1, day, hour, minute),
        d = new Date(ms);
    return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? ms : NaN;
}
function ndbcRows(
    text: string,
    now: number,
    station?: Station,
    metadata: ReadonlyMap<string, Station> = new Map(),
): ParsedObservations {
    if (!boundedText(text)) return fail('NDBC payload exceeds 2 MiB.');
    const lines = text.split(/\r?\n/);
    if (lines.length > 8002) return fail('NDBC row limit exceeded.');
    const header = lines.find((line) => /^#(?:STN|YY|YYYY)\s/.test(line));
    if (!header) return fail('NDBC header missing.');
    const cols = new Map(
        header
            .slice(1)
            .trim()
            .split(/\s+/)
            .map((s, i) => [s, i]),
    );
    if (!['MM', 'DD', 'hh', 'mm'].every((s) => cols.has(s)) || (!cols.has('YY') && !cols.has('YYYY')))
        return fail('NDBC clock columns missing.');
    if (!station && !['STN', 'LAT', 'LON'].every((s) => cols.has(s))) return fail('NDBC station coordinates missing.');
    const rows: Observation[] = [];
    for (const line of lines) {
        if (!line.trim() || line.startsWith('#')) continue;
        if (line.length > 1024) return fail('NDBC row too long.');
        const cells = line.trim().split(/\s+/),
            cell = (name: string) => cells[cols.get(name) ?? -1];
        const id = (station?.id ?? cell('STN') ?? '').toUpperCase();
        if (!/^[A-Z0-9]{3,8}$/.test(id)) continue;
        const lat = numberIn(station?.lat ?? cell('LAT'), -90, 90),
            lon = numberIn(station?.lon ?? cell('LON'), -180, 180);
        if (lat === null || lon === null || !validPosition(lat, lon)) continue;
        const observedAtMs = utc([
            cell(cols.has('YYYY') ? 'YYYY' : 'YY'),
            cell('MM'),
            cell('DD'),
            cell('hh'),
            cell('mm'),
        ]);
        if (!withinHistory(observedAtMs, now)) continue;
        const meta = station ?? metadata.get(id);
        // Metadata from a relocated/reassigned station cannot label this different deployment.
        const sameSite = meta && Math.abs(meta.lat - lat) < 0.01 && Math.abs(meta.lon - lon) < 0.01;
        const speed = numberIn(cell('WSPD'), 0, 120),
            gust = numberIn(cell('GST'), 0, 120);
        const row: Observation = {
            id,
            name: sameSite ? meta.name : `NDBC ${id}`,
            lat,
            lon,
            exposure: sameSite ? meta.exposure : 'unknown',
            owner: sameSite ? meta.owner : null,
            provider: 'ndbc',
            observedAtMs,
            retrievedAtMs: now,
            receivedAtMs: null,
            windSpeedKts: speed === null ? null : (speed * 3600) / 1852,
            gustKts: gust === null || (speed !== null && gust < speed) ? null : (gust * 3600) / 1852,
            fromDeg: speed === 0 ? null : direction(cell('WDIR')),
            variableWind: false,
            seaLevelPressureHpa: numberIn(cell('PRES'), 800, 1100),
            altimeterHpa: null,
            airTempC: numberIn(cell('ATMP'), -90, 65),
            sourceUrl: NDBC_MEASUREMENTS_URL,
            attribution:
                sameSite && meta.owner ? `NOAA NDBC / ${meta.owner}` : 'NOAA NDBC; station owner not identified',
        };
        if (hasMeasurement(row)) rows.push(row);
    }
    return { rows, partial: false, error: null };
}
export const parseNdbcLatest = (
    text: string,
    now: number,
    metadata?: ReadonlyMap<string, Station>,
): ParsedObservations => ndbcRows(text, now, undefined, metadata);
/** Position is trusted station metadata; never the map tap or boat fix. */
export const parseNdbcHistory = (text: string, station: Station, now: number): ParsedObservations =>
    ndbcRows(text, now, station);

/** AWC API v4 JSON fields; no receipt/report-time fallback for missing obsTime. */
export function parseAwcMetars(text: string, now: number): ParsedObservations {
    if (!boundedText(text)) return fail('AWC payload exceeds 2 MiB.');
    let body: unknown;
    try {
        body = JSON.parse(text);
    } catch {
        return fail('AWC JSON invalid.');
    }
    if (!Array.isArray(body) || body.length > 400) return fail('AWC response is not a bounded observation list.');
    const rows: Observation[] = [];
    for (const value of body) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const raw = value as Record<string, unknown>,
            id = safeText(raw.icaoId, 8)?.toUpperCase();
        // The endpoint can also carry BUOY/CMAN/SYNOP; do not mislabel these as airports.
        if (!id || !/^[A-Z0-9]{4}$/.test(id) || !['METAR', 'SPECI'].includes(String(raw.metarType))) continue;
        const seconds = numberIn(raw.obsTime, 1_000_000_000, 8_000_000_000);
        const lat = numberIn(raw.lat, -90, 90),
            lon = numberIn(raw.lon, -180, 180);
        if (seconds === null || !Number.isInteger(seconds) || lat === null || lon === null || !validPosition(lat, lon))
            continue;
        const observedAtMs = seconds * 1000;
        if (!withinHistory(observedAtMs, now)) continue;
        const received = typeof raw.receiptTime === 'string' ? Date.parse(raw.receiptTime) : NaN;
        const speed = numberIn(raw.wspd, 0, 250),
            gust = numberIn(raw.wgst, 0, 250);
        const row: Observation = {
            provider: 'awc-metar',
            id,
            name: safeText(raw.name) ?? id,
            lat,
            lon,
            // METAR also exists at offshore helidecks; report type alone does
            // not verify a land site or exposure to the inspected water.
            exposure: 'metar-station',
            owner: null,
            observedAtMs,
            retrievedAtMs: now,
            receivedAtMs:
                Number.isFinite(received) && received >= observedAtMs && received <= now + 300000 ? received : null,
            windSpeedKts: speed,
            gustKts: gust === null || (speed !== null && gust < speed) ? null : gust,
            fromDeg: speed === 0 ? null : direction(raw.wdir),
            variableWind: raw.wdir === 'VRB' && speed !== 0,
            seaLevelPressureHpa: numberIn(raw.slp, 800, 1100),
            altimeterHpa: numberIn(raw.altim, 800, 1100),
            airTempC: numberIn(raw.temp, -90, 65),
            sourceUrl: AWC_API_URL,
            attribution: 'NOAA Aviation Weather Center; originating METAR station',
        };
        if (hasMeasurement(row)) rows.push(row);
    }
    return { rows, partial: body.length === 400, error: null };
}
