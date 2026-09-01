/**
 * aishub.ts — AISHub aggregated-feed poller.
 *
 * The third data source, earned by feeding: contributors who meet AISHub's
 * quality bar get an API key for the AGGREGATED feed — every contributing
 * station's coverage, national and beyond. This poller fills the same
 * VesselDB as the aisstream socket and the boat bridge, so the app's pond
 * drinks from all three through one set of change-detection semantics.
 *
 * Contract facts that shape this code:
 *  - HARD rate limit: one request per minute, enforced, violators blocked.
 *    The interval is floored at 60 s no matter what the env says, and the
 *    poller never fires concurrent requests.
 *  - The response is the aggregate's LAST KNOWN state per vessel, each row
 *    carrying its own TIME. A vessel that went quiet yesterday still appears
 *    — upserting it would stamp updated_at "now" and resurrect a stale
 *    position as fresh. Rows older than MAX_RECORD_AGE_MS are dropped.
 *  - Gated on AISHUB_API_KEY: absent key, nothing starts and nothing logs
 *    but one line — the worker keeps its existing behaviour exactly.
 */
import type { VesselRecord } from './parser.js';
import type { VesselDB } from './db.js';

const AISHUB_ENDPOINT = 'https://data.aishub.net/ws.php';
/** AISHub's enforced etiquette: never more than one request per minute. */
const MIN_POLL_MS = 60_000;
/** Aggregate rows older than this are history, not observations. */
const MAX_RECORD_AGE_MS = 15 * 60_000;
const FETCH_TIMEOUT_MS = 30_000;

export interface AishubStats {
    enabled: boolean;
    polls: number;
    pollErrors: number;
    /** Polls refused for cadence. Counted apart from pollErrors: being told
     *  to slow down is the ration working, not the feed failing. */
    rateLimited: number;
    lastPollAt: number | null;
    lastRecords: number;
    lastAccepted: number;
}

/** MEASURED 2026-09-02 against the live service with a real key: a too-soon
 *  poll answers HTTP 200 with a normal ERROR envelope reading
 *  "Too frequent requests!" — NOT the empty body the docs describe. Both
 *  shapes are handled; this matches the real one. */
export function isRateLimitMessage(message: string): boolean {
    return /too frequent/i.test(message);
}

const stats: AishubStats = {
    enabled: false,
    polls: 0,
    pollErrors: 0,
    rateLimited: 0,
    lastPollAt: null,
    lastRecords: 0,
    lastAccepted: 0,
};

export function getAishubStats(): AishubStats {
    return { ...stats };
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
    const record: VesselRecord = { mmsi };
    if (
        lat !== undefined &&
        lon !== undefined &&
        Math.abs(lat) <= 90 &&
        Math.abs(lon) <= 180 &&
        !(lat === 0 && lon === 0)
    ) {
        record.lat = lat;
        record.lon = lon;
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

    // A row that told us nothing beyond its MMSI is not a record.
    return Object.keys(record).length > 1 ? record : null;
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
    const rows = Array.isArray(body[1]) ? body[1] : [];
    const records: VesselRecord[] = [];
    for (const row of rows) {
        const record = parseAishubVessel(row, now);
        if (record) records.push(record);
    }
    return { records, total: rows.length };
}

export interface AishubPollerOptions {
    apiKey: string;
    /** [latMin, lonMin, latMax, lonMax] — matches the worker's bounding box. */
    bounds: { latMin: number; lonMin: number; latMax: number; lonMax: number };
    pollMs?: number;
    fetchImpl?: typeof fetch;
}

/**
 * Start polling the aggregate into the shared VesselDB. Returns a stop
 * function. Never throws from the poll loop — an aggregate outage is logged
 * and retried at the same rationed cadence.
 */
export function startAishubPoller(db: VesselDB, opts: AishubPollerOptions): () => void {
    const pollMs = Math.max(MIN_POLL_MS, opts.pollMs ?? MIN_POLL_MS);
    const doFetch = opts.fetchImpl ?? fetch;
    const params = new URLSearchParams({
        username: opts.apiKey,
        format: '1',
        output: 'json',
        compress: '0',
        latmin: String(opts.bounds.latMin),
        latmax: String(opts.bounds.latMax),
        lonmin: String(opts.bounds.lonMin),
        lonmax: String(opts.bounds.lonMax),
        // Server-side freshness filter (minutes): matches MAX_RECORD_AGE_MS
        // so stale rows never even cross the wire; the client-side TIME
        // check remains as the authoritative guard.
        interval: String(Math.round(MAX_RECORD_AGE_MS / 60_000)),
    });
    const url = `${AISHUB_ENDPOINT}?${params.toString()}`;
    stats.enabled = true;
    let inFlight = false;
    let stopped = false;

    const poll = async (): Promise<void> => {
        if (inFlight || stopped) return;
        inFlight = true;
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
            const response = await doFetch(url, { signal: controller.signal });
            clearTimeout(timeout);
            stats.polls++;
            stats.lastPollAt = Date.now();
            if (!response.ok) {
                stats.pollErrors++;
                console.warn(`[AISHUB] HTTP ${response.status}`);
                return;
            }
            const bodyText = await response.text();
            if (!bodyText.trim()) {
                // The DOCUMENTED rate-limit response: an empty body at HTTP
                // 200. Kept as a defensive path — the live service actually
                // answers with an ERROR envelope instead (see below), but a
                // documented behaviour that costs one branch stays handled.
                stats.rateLimited++;
                console.warn('[AISHUB] Empty body — rate-limited; skipping this cycle');
                return;
            }
            let json: unknown;
            try {
                json = JSON.parse(bodyText);
            } catch {
                stats.pollErrors++;
                console.warn('[AISHUB] Unparseable body');
                return;
            }
            const parsed = parseAishubResponse(json);
            if ('error' in parsed) {
                // A cadence refusal is not a fault. With the 60 s floor one
                // instance cannot cause it, so if this climbs the cause is
                // outside this process: a second worker sharing the key, or a
                // restart re-polling immediately after the previous instance.
                // Counted separately so /health does not cry outage over it.
                if (isRateLimitMessage(parsed.error)) {
                    stats.rateLimited++;
                    console.warn('[AISHUB] Rate-limited by the aggregate; skipping this cycle');
                    return;
                }
                stats.pollErrors++;
                console.warn(`[AISHUB] API error: ${parsed.error}`);
                return;
            }
            stats.lastRecords = parsed.total;
            stats.lastAccepted = parsed.records.length;
            for (const record of parsed.records) db.enqueue(record);
        } catch (e) {
            stats.pollErrors++;
            console.warn('[AISHUB] Poll failed:', e instanceof Error ? e.message : e);
        } finally {
            inFlight = false;
        }
    };

    console.log(`[AISHUB] Aggregate poller started (every ${pollMs / 1000}s, bbox ${JSON.stringify(opts.bounds)})`);
    void poll();
    const timer = setInterval(() => void poll(), pollMs);
    return () => {
        stopped = true;
        clearInterval(timer);
        stats.enabled = false;
    };
}
