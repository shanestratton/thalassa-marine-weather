/**
 * aishub.ts — pure, bounded parsing of AISHub aggregate responses.
 * fleetAishub.ts owns the sole provider timer and persisted fleet-wide claim.
 * AISHub returns last-known positions with their own TIME. Preserve that
 * observation clock; a database write must never make old positions fresh.
 */
import type { VesselRecord } from './parser.js';
import { aisEta } from './parser.js';

/** Aggregate rows older than this are history, not observations. */
const MAX_RECORD_AGE_MS = 15 * 60_000;

/** MEASURED 2026-09-02 against the live service with a real key: a too-soon
 *  poll answers HTTP 200 with a normal ERROR envelope reading
 *  "Too frequent requests!" — NOT the empty body the docs describe. Both
 *  shapes are handled; this matches the real one. */
export function isRateLimitMessage(message: string): boolean {
    return /too frequent/i.test(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value);
        if (Number.isFinite(n)) return n;
    }
    return undefined;
}

function inRange(value: number | undefined, min: number, max: number): number | undefined {
    return value !== undefined && value >= min && value <= max ? value : undefined;
}

function text(value: unknown, maxLength: number): string | undefined {
    if (typeof value !== 'string') return undefined;
    const cleaned = value.replace(/@+$/g, '').trim().slice(0, maxLength);
    return cleaned || undefined;
}

/** AISHub TIME strings are UTC ("2026-08-21 03:15:07 GMT"). */
export function parseAishubTime(value: unknown): number | null {
    if (typeof value !== 'string' || !value.trim()) return null;
    const normalised = value.trim().replace(' GMT', 'Z').replace(' ', 'T');
    const t = Date.parse(normalised);
    return Number.isFinite(t) ? t : null;
}

/**
 * Parse one human-format (format=1) AISHub vessel row into a VesselRecord.
 * Sentinels follow the same conventions as every other source in this
 * package: COG 360, SOG 102.4 (AISHub's own convention; ITU's 102.3 is also
 * excluded), heading 511 are omitted; Null Island and invalid MMSIs are
 * rejected.
 */
export function parseAishubVessel(row: unknown, now = Date.now()): VesselRecord | null {
    if (!isRecord(row)) return null;
    const mmsi = num(row.MMSI);
    if (mmsi === undefined || !Number.isInteger(mmsi) || mmsi < 100_000_000 || mmsi > 999_999_999) return null;

    const time = parseAishubTime(row.TIME);
    if (time === null || now - time > MAX_RECORD_AGE_MS || time - now > 60_000) return null;

    const lat = num(row.LATITUDE);
    const lon = num(row.LONGITUDE);
    const record: VesselRecord = { mmsi, data_source: 'aishub' };
    if (
        lat !== undefined &&
        lon !== undefined &&
        Math.abs(lat) <= 90 &&
        Math.abs(lon) <= 180 &&
        !(lat === 0 && lon === 0)
    ) {
        record.lat = lat;
        record.lon = lon;
        record.position_at = new Date(time).toISOString();
        record.cog = inRange(num(row.COG), 0, 359.9);
        // AISHub's own SOG sentinel is 102.4 (deliberately unlike ITU's
        // 102.3); the 102.2 cap excludes both conventions.
        record.sog = inRange(num(row.SOG), 0, 102.2);
        record.heading = inRange(num(row.HEADING), 0, 359);
        record.nav_status = inRange(num(row.NAVSTAT), 0, 15);
    }
    const name = text(row.NAME, 20);
    if (name !== undefined) record.name = name;
    const callSign = text(row.CALLSIGN, 7);
    if (callSign !== undefined) record.call_sign = callSign;
    const shipType = inRange(num(row.TYPE), 0, 99);
    if (shipType !== undefined) record.ship_type = shipType;
    const destination = text(row.DEST, 20);
    if (destination !== undefined) record.destination = destination;
    const imo = num(row.IMO);
    if (imo !== undefined && imo >= 1_000_000 && imo <= 9_999_999) record.imo_number = imo;
    const dimA = inRange(num(row.A), 0, 511);
    if (dimA !== undefined) record.dimension_a = dimA;
    const dimB = inRange(num(row.B), 0, 511);
    if (dimB !== undefined) record.dimension_b = dimB;
    const dimC = inRange(num(row.C), 0, 63);
    if (dimC !== undefined) record.dimension_c = dimC;
    const dimD = inRange(num(row.D), 0, 63);
    if (dimD !== undefined) record.dimension_d = dimD;
    const draught = inRange(num(row.DRAUGHT), 0.1, 25.5);
    if (draught !== undefined) record.draught_m = draught;
    const eta = typeof row.ETA === 'string' ? /^(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(row.ETA) : null;
    if (eta) record.eta = aisEta(...(eta.slice(1).map(Number) as [number, number, number, number]));

    // A row that told us nothing beyond its MMSI is not a record.
    return Object.keys(record).some(
        (key) => !['mmsi', 'data_source'].includes(key) && record[key as keyof VesselRecord] !== undefined,
    )
        ? record
        : null;
}

/**
 * Parse a full AISHub webservice response body (output=json, format=1):
 *   [ { ERROR: false, USERNAME, FORMAT, RECORDS }, [ ...rows ] ]
 * Error case: [ { ERROR: true, ERROR_MESSAGE: '...' } ]
 */
export function parseAishubResponse(
    body: unknown,
    now = Date.now(),
): { records: VesselRecord[]; total: number } | { error: string } {
    if (!Array.isArray(body) || body.length === 0 || !isRecord(body[0])) {
        return { error: 'malformed envelope' };
    }
    const head = body[0];
    if (head.ERROR === true) {
        const message = typeof head.ERROR_MESSAGE === 'string' ? head.ERROR_MESSAGE : 'unknown AISHub error';
        return { error: message };
    }
    if (head.ERROR !== false || !Array.isArray(body[1]) || body.length !== 2) return { error: 'malformed envelope' };
    const rows = body[1];
    const records: VesselRecord[] = [];
    for (const row of rows.slice(0, 500)) {
        const record = parseAishubVessel(row, now);
        if (record) records.push(record);
    }
    return { records, total: rows.length };
}
