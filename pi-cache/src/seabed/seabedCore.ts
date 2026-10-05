/**
 * Seabed mapping, phase 1: the shared pure core (Pi copy).
 *
 * A MIRROR of services/seabed/seabedCore.ts in the app: everything below the
 * marker line is byte-for-byte the same, and tests/seabedCoreMirror.test.ts in
 * the app fails when it is not. Never edit this copy on its own.
 */
// ── seabed-core: everything below this line is identical in all three copies ──

/*
 * What this is. Shane 2026-10-05: "also you should do the bottom mapping as a
 * parallel add in". An opt-in log of the boat's own depth sounder (time,
 * position, depth BELOW THE TRANSDUCER) shaped for the IHO crowdsourced
 * bathymetry programme (IHO B-12 Ed. 3.0.0; NCEI "Sample CSB File Formats"
 * 3.0). Phase 1 only captures, filters, protects and stores privately.
 *
 * No imports, no I/O, no clock of its own: the Pi, the phone and the ingest
 * function all run exactly this code, so a sounding is judged the same way
 * wherever it was taken.
 *
 * Values are NEVER altered. Quality problems become FLAGS; only privacy zones
 * and trip trimming remove rows, and both are counted. The one exception is a
 * value no instrument could mean (a course of 360.5, a negative speed, a heel
 * of 95): an optional one is left empty, a row with an impossible depth,
 * position or time is not kept, and both are counted, because one such value
 * would otherwise make the ingest function refuse the whole hour.
 */

export const SEABED_CORE_VERSION = 1;
/** Bump when the consent copy's substance changes; phase 3 (sharing) asks again. */
export const SEABED_CONSENT_VERSION = '2026-10-05';
export const SEABED_RAW_SCHEMA = 'thalassa-csb-raw/1';

/** The first four columns are the DCDB XYZ order (LON,LAT,DEPTH,TIME). */
const XYZ = 'LON,LAT,DEPTH,TIME';
const EXTRA = 'SOG_KN,COG_DEG,HDG_DEG,HEEL_DEG,FIX_Q,HDOP,SATS,POS_AGE_MS,DEPTH_REF,FLAGS';
export const SEABED_CSV_HEADER = `${XYZ},${EXTRA}`;

export const SEABED_FLAG = {
    NO_FIX: 1,
    DR_FIX: 2,
    POS_STALE: 4,
    HDOP_HIGH: 8,
    SOG_LOW: 16,
    SOG_HIGH: 32,
    DEPTH_RANGE: 64,
    SPIKE: 128,
    FROZEN: 256,
    GAP_BEFORE: 512,
    HEEL: 1024,
    DEPTH_DERIVED: 2048,
};
export const SEABED_FLAG_MAX = 4095;
/** Flags that describe the record rather than doubt it. */
const BENIGN_FLAGS = SEABED_FLAG.GAP_BEFORE | SEABED_FLAG.DEPTH_DERIVED;

/** At most one row per this many ms: one per new depth measurement, ~1 Hz. */
export const SAMPLE_MIN_GAP_MS = 900;
export const UNDERWAY_START_KN = 1.5;
export const UNDERWAY_START_HOLD_MS = 20_000;
export const UNDERWAY_STOP_KN = 0.8;
export const UNDERWAY_STOP_HOLD_MS = 60_000;
export const NO_FIX_STOP_MS = 30_000;
/** Rows this close to where a trip starts are dropped; rows this close to the
 * boat are held until she has been further away (so the end of a trip is too). */
export const TRIM_RADIUS_M = 500;
/** Held rows beyond this (an hour of circling inside 500 m) drop oldest first. */
export const HOLD_MAX_ROWS = 3_600;
export const BATCH_MAX_ROWS = 3_600;
export const INGEST_MAX_ROWS = 7_200;
export const GAP_BEFORE_MS = 5_000;
export const TRACK_GAP_MS = 10_000;
export const ZONE_MIN_RADIUS_M = 250;
export const ZONE_MAX_RADIUS_M = 5_000;
export const ZONE_MAX_COUNT = 20;
export const ZONE_JITTER_FRACTION = 0.25;
export const HOME_DEFAULT_RADIUS_M = 1_000;
export const MARKED_DEFAULT_RADIUS_M = 500;
/** Nothing is eligible for a map or a DCDB submission until this long after it ends. */
export const SEABED_HOLD_DAYS = 30;
const EARLIEST_MS = Date.UTC(2020, 0, 1);
const FUTURE_SKEW_MS = 5 * 60_000;

export type SeabedDepthRef = 'T' | 'W';

export interface SeabedRow {
    lon: number;
    lat: number;
    /** Positive metres below the vertical reference (T = transducer, W = waterline). */
    depth: number;
    timeMs: number;
    sogKn: number | null;
    cogDeg: number | null;
    hdgDeg: number | null;
    heelDeg: number | null;
    /** GGA fix quality 0..8. */
    fixQ: number | null;
    hdop: number | null;
    sats: number | null;
    /** Depth time minus position time. */
    posAgeMs: number | null;
    depthRef: SeabedDepthRef;
    flags: number;
}

export interface SeabedZone {
    id: string;
    kind: 'home' | 'marked';
    lat: number;
    lon: number;
    radius_m: number;
    /** The most the centre was moved when the zone was made (a quarter of the radius it was made with). */
    jitter_m: number;
}

export interface SeabedFix {
    lat: number;
    lon: number;
}

export interface SeabedCounters {
    privacy_dropped: number;
    trim_dropped: number;
    too_soon: number;
    rereads_skipped: number;
    no_bus_fix: number;
    no_gps_time: number;
    /** Rows not kept: a depth, position or time no instrument could mean. */
    bad_values: number;
    /** Rows kept with an impossible optional value left empty. */
    fields_cleared: number;
}

export interface SeabedSummary {
    row_count: number;
    rows_flagged: number;
    flag_counts: Record<string, number>;
    t_start: string;
    t_end: string;
    min_lat: number;
    max_lat: number;
    /** West edge; greater than max_lon when the batch crosses the antimeridian. */
    min_lon: number;
    max_lon: number;
    crosses_antimeridian: boolean;
    track_m: number;
    depth_min: number | null;
    depth_max: number | null;
    hdop_median: number | null;
    fix_q_hist: Record<string, number>;
}

export interface SeabedClosedBatch {
    rows: SeabedRow[];
    csv: string;
    summary: SeabedSummary;
    counters: SeabedCounters;
    /**
     * Closed in the middle of a trip (a new hour, or 3600 rows). The device
     * keeps it, never queues it, until the trip ends, then runs trimTripEnd()
     * on it: where a trip ends is not known until it has.
     */
    parked: boolean;
}

export interface SeabedStep {
    /** Rows that passed every filter and joined the open batch, in order. */
    appended: SeabedRow[];
    closed: SeabedClosedBatch[];
    event: 'start' | 'stop' | null;
    /** A trip ended in this step: trim the parked batches by where she was last seen (null: no fix ever). */
    tripEnd: { at: SeabedFix | null } | null;
}

export function zeroCounters(): SeabedCounters {
    return {
        privacy_dropped: 0,
        trim_dropped: 0,
        too_soon: 0,
        rereads_skipped: 0,
        no_bus_fix: 0,
        no_gps_time: 0,
        bad_values: 0,
        fields_cleared: 0,
    };
}

function emptyStep(): SeabedStep {
    return { appended: [], closed: [], event: null, tripEnd: null };
}

// ── Geometry ──────────────────────────────────────────────────────────────

const EARTH_RADIUS_M = 6_371_008.8;
const RAD = Math.PI / 180;

/** Great-circle distance in metres. */
export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const dLat = (lat2 - lat1) * RAD;
    const dLon = (lon2 - lon1) * RAD;
    const s = Math.sin(dLat / 2);
    const t = Math.sin(dLon / 2);
    const a = s * s + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * t * t;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

function wrapLon(lon: number): number {
    const w = ((((lon + 180) % 360) + 360) % 360) - 180;
    return w === -180 && lon > 0 ? 180 : w;
}

// ── Per-row flags (the row's own fields only) ─────────────────────────────

export function captureFlags(row: SeabedRow): number {
    const F = SEABED_FLAG;
    let flags = row.flags & (F.DEPTH_DERIVED | F.GAP_BEFORE);
    if (row.fixQ === 0) flags |= F.NO_FIX;
    if (row.fixQ === 6) flags |= F.DR_FIX;
    if (row.posAgeMs !== null && Math.abs(row.posAgeMs) > 2_000) flags |= F.POS_STALE;
    if (row.hdop !== null && row.hdop > 4) flags |= F.HDOP_HIGH;
    if (row.sogKn !== null && row.sogKn < 1) flags |= F.SOG_LOW;
    if (row.sogKn !== null && row.sogKn > 25) flags |= F.SOG_HIGH;
    if (row.depth < 0.5 || row.depth > 1_500) flags |= F.DEPTH_RANGE;
    if (row.heelDeg !== null && Math.abs(row.heelDeg) > 20) flags |= F.HEEL;
    return flags;
}

// ── Under way ─────────────────────────────────────────────────────────────

export interface UnderwayState {
    underway: boolean;
    aboveSince: number | null;
    belowSince: number | null;
    lastFixAt: number | null;
}

export function newUnderwayState(): UnderwayState {
    return { underway: false, aboveSince: null, belowSince: null, lastFixAt: null };
}

/**
 * Starts once SOG has stayed at or above 1.5 kn for 20 s; stops once it has
 * stayed below 0.8 kn for 60 s, or there has been no fix for 30 s. The gap
 * between the two speeds is the hysteresis that stops a boat drifting at
 * 1 kn on her anchor from starting and stopping a trip every minute.
 */
export function stepUnderway(
    s: UnderwayState,
    nowMs: number,
    sogKn: number | null,
    hasFix: boolean,
): 'start' | 'stop' | null {
    if (hasFix) s.lastFixAt = nowMs;
    const known = hasFix && sogKn !== null;
    if (!s.underway) {
        if (known && (sogKn as number) >= UNDERWAY_START_KN) {
            if (s.aboveSince === null) s.aboveSince = nowMs;
            if (nowMs - s.aboveSince >= UNDERWAY_START_HOLD_MS) {
                s.underway = true;
                s.aboveSince = null;
                s.belowSince = null;
                return 'start';
            }
        } else {
            s.aboveSince = null;
        }
        return null;
    }
    if (known && (sogKn as number) < UNDERWAY_STOP_KN) {
        if (s.belowSince === null) s.belowSince = nowMs;
    } else if (known) {
        s.belowSince = null;
    }
    const slow = s.belowSince !== null && nowMs - s.belowSince >= UNDERWAY_STOP_HOLD_MS;
    const lost = s.lastFixAt === null || nowMs - s.lastFixAt >= NO_FIX_STOP_MS;
    if (!slow && !lost) return null;
    s.underway = false;
    s.aboveSince = null;
    s.belowSince = null;
    return 'stop';
}

// ── Privacy zones ─────────────────────────────────────────────────────────

export function insideAnyZone(lat: number, lon: number, zones: readonly SeabedZone[]): boolean {
    for (const z of zones) {
        if (distanceM(lat, lon, z.lat, z.lon) < z.radius_m) return true;
    }
    return false;
}

/**
 * Move a zone's centre once, at creation, by a uniform random offset of up to
 * a quarter of its radius. Only the moved centre is ever stored, so the true
 * berth never leaves the phone, and the circle still covers it by at least
 * three quarters of its radius. The zone keeps that bound (jitter_m), so the
 * circle can later shrink only to 4/3 of it (zoneMinRadiusM): the true spot
 * then still sits a quarter of the radius inside the edge.
 */
export function jitterZoneCentre(lat: number, lon: number, radiusM: number, rand: () => number): SeabedFix {
    const d = radiusM * ZONE_JITTER_FRACTION * Math.sqrt(rand());
    const bearing = 2 * Math.PI * rand();
    const angular = d / EARTH_RADIUS_M;
    const outLat = lat + (angular * Math.cos(bearing)) / RAD;
    const cosLat = Math.max(0.01, Math.cos(lat * RAD));
    const outLon = lon + (angular * Math.sin(bearing)) / cosLat / RAD;
    return { lat: Math.max(-90, Math.min(90, outLat)), lon: wrapLon(outLon) };
}

/** The smallest radius a zone may be given: never so small that its jittered centre could leave the true spot outside. */
export function zoneMinRadiusM(zone: Pick<SeabedZone, 'jitter_m'>): number {
    return Math.max(ZONE_MIN_RADIUS_M, Math.ceil((zone.jitter_m * 4) / 3));
}

function isText(v: unknown, max: number): v is string {
    return typeof v === 'string' && v.length > 0 && v.length <= max && !/\p{Cc}/u.test(v);
}

function inRange(v: unknown, min: number, max: number): v is number {
    return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}

/** A zone list as stored on the platform row; null when anything is malformed. */
export function parseSeabedZones(raw: unknown): SeabedZone[] | null {
    if (!Array.isArray(raw) || raw.length > ZONE_MAX_COUNT) return null;
    const out: SeabedZone[] = [];
    let homes = 0;
    for (const item of raw) {
        if (!item || typeof item !== 'object') return null;
        const z = item as Record<string, unknown>;
        if (!isText(z.id, 40) || (z.kind !== 'home' && z.kind !== 'marked')) return null;
        if (!inRange(z.lat, -90, 90) || !inRange(z.lon, -180, 180)) return null;
        if (!inRange(z.radius_m, ZONE_MIN_RADIUS_M, ZONE_MAX_RADIUS_M)) return null;
        if (!inRange(z.jitter_m, 0, ZONE_MAX_RADIUS_M * ZONE_JITTER_FRACTION)) return null;
        // The same arithmetic as the SQL check: integers both sides, no rounding.
        if (3 * z.radius_m < 4 * z.jitter_m) return null;
        if (z.kind === 'home') homes += 1;
        out.push({ id: z.id, kind: z.kind, lat: z.lat, lon: z.lon, radius_m: z.radius_m, jitter_m: z.jitter_m });
    }
    return homes > 1 ? null : out;
}

// ── Batch close: spikes, frozen sounders, summary ─────────────────────────

function median(values: number[]): number {
    const v = values.slice().sort((a, b) => a - b);
    const mid = v.length >> 1;
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** |d - median of up to 10 rows either side, within 30 s| > max(1 m, 25 %), needing 5 neighbours. */
export function markSpikes(rows: SeabedRow[]): void {
    for (let i = 0; i < rows.length; i++) {
        const near: number[] = [];
        const lo = Math.max(0, i - 10);
        const hi = Math.min(rows.length - 1, i + 10);
        for (let j = lo; j <= hi; j++) {
            if (j !== i && Math.abs(rows[j].timeMs - rows[i].timeMs) <= 30_000) near.push(rows[j].depth);
        }
        if (near.length < 5) continue;
        const m = median(near);
        if (Math.abs(rows[i].depth - m) > Math.max(1, 0.25 * m)) rows[i].flags |= SEABED_FLAG.SPIKE;
    }
}

/** The same depth to the centimetre for 60 rows running while making 2 kn or more. */
export function markFrozen(rows: SeabedRow[]): void {
    const moving = (r: SeabedRow): boolean => r.sogKn !== null && r.sogKn >= 2;
    const cm = (r: SeabedRow): number => Math.round(r.depth * 100);
    let start = 0;
    while (start < rows.length) {
        let end = start;
        if (moving(rows[start])) {
            while (end + 1 < rows.length && moving(rows[end + 1]) && cm(rows[end + 1]) === cm(rows[start])) {
                end += 1;
            }
            if (end - start + 1 >= 60) {
                for (let j = start; j <= end; j++) rows[j].flags |= SEABED_FLAG.FROZEN;
            }
        }
        start = end + 1;
    }
}

function bump(map: Record<string, number>, key: string): void {
    map[key] = (map[key] ?? 0) + 1;
}

export function summariseRows(rows: readonly SeabedRow[]): SeabedSummary {
    const flagCounts: Record<string, number> = {};
    const fixHist: Record<string, number> = {};
    const hdops: number[] = [];
    let flagged = 0;
    let minLat = 90;
    let maxLat = -90;
    let depthMin: number | null = null;
    let depthMax: number | null = null;
    let trackM = 0;
    let unwrapped = rows.length ? rows[0].lon : 0;
    let minU = unwrapped;
    let maxU = unwrapped;
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        for (const [name, bit] of Object.entries(SEABED_FLAG)) {
            if (r.flags & bit) bump(flagCounts, name);
        }
        if (r.flags & ~BENIGN_FLAGS) {
            flagged += 1;
        } else {
            depthMin = depthMin === null ? r.depth : Math.min(depthMin, r.depth);
            depthMax = depthMax === null ? r.depth : Math.max(depthMax, r.depth);
        }
        bump(fixHist, r.fixQ === null ? 'unknown' : String(r.fixQ));
        if (r.hdop !== null) hdops.push(r.hdop);
        minLat = Math.min(minLat, r.lat);
        maxLat = Math.max(maxLat, r.lat);
        if (i > 0) {
            const prev = rows[i - 1];
            let step = r.lon - prev.lon;
            if (step > 180) step -= 360;
            if (step < -180) step += 360;
            unwrapped += step;
            minU = Math.min(minU, unwrapped);
            maxU = Math.max(maxU, unwrapped);
            if (r.timeMs - prev.timeMs < TRACK_GAP_MS) trackM += distanceM(prev.lat, prev.lon, r.lat, r.lon);
        }
    }
    const crosses = rows.length > 0 && (minU < -180 || maxU > 180) && maxU - minU < 360;
    const first = rows.length ? rows[0].timeMs : 0;
    const last = rows.length ? rows[rows.length - 1].timeMs : 0;
    return {
        row_count: rows.length,
        rows_flagged: flagged,
        flag_counts: flagCounts,
        t_start: new Date(first).toISOString(),
        t_end: new Date(last).toISOString(),
        min_lat: minLat,
        max_lat: maxLat,
        min_lon: crosses ? wrapLon(minU) : Math.max(-180, minU),
        max_lon: crosses ? wrapLon(maxU) : Math.min(180, maxU),
        crosses_antimeridian: crosses,
        track_m: Math.round(trackM * 10) / 10,
        depth_min: depthMin,
        depth_max: depthMax,
        hdop_median: hdops.length ? median(hdops) : null,
        fix_q_hist: fixHist,
    };
}

/** Close a run of rows: spike and frozen flags over the whole batch, then the CSV and the summary. */
export function closeRows(rows: readonly SeabedRow[], counters: SeabedCounters, parked = false): SeabedClosedBatch {
    const out = rows.map((r) => ({ ...r }));
    markSpikes(out);
    markFrozen(out);
    return { rows: out, csv: encodeSeabedCsv(out), summary: summariseRows(out), counters: { ...counters }, parked };
}

/**
 * A parked batch once its trip has ended: every row within 500 m of where she
 * stopped goes (counted as trimmed), and what is left is ready to queue. Null
 * when nothing is left.
 */
export function trimTripEnd(
    rows: readonly SeabedRow[],
    counters: SeabedCounters,
    end: SeabedFix | null,
): SeabedClosedBatch | null {
    const kept = end ? rows.filter((r) => distanceM(r.lat, r.lon, end.lat, end.lon) >= TRIM_RADIUS_M) : rows.slice();
    if (!kept.length) return null;
    const trimmed = { ...zeroCounters(), ...counters };
    trimmed.trim_dropped += rows.length - kept.length;
    return closeRows(kept, trimmed);
}

/**
 * After a restart: the trip that was running ended where its last kept row
 * was taken (the open rows' last, else the last parked batch's). Parked
 * batches oldest first.
 */
export function recoverTrip(
    parked: ReadonlyArray<{ rows: readonly SeabedRow[]; counters: SeabedCounters }>,
    open: readonly SeabedRow[],
): SeabedClosedBatch[] {
    const lastParked = parked.length ? parked[parked.length - 1].rows : [];
    const last = open.length ? open[open.length - 1] : lastParked[lastParked.length - 1];
    if (!last) return [];
    const end = { lat: last.lat, lon: last.lon };
    const runs = [...parked, ...(open.length ? [{ rows: open, counters: zeroCounters() }] : [])];
    const out: SeabedClosedBatch[] = [];
    for (const run of runs) {
        const batch = trimTripEnd(run.rows, run.counters, end);
        if (batch) out.push(batch);
    }
    return out;
}

// ── CSV ───────────────────────────────────────────────────────────────────

function fixed(v: number | null, digits: number): string {
    return v === null || !Number.isFinite(v) ? '' : v.toFixed(digits);
}

function whole(v: number | null): string {
    return v === null || !Number.isFinite(v) ? '' : String(Math.round(v));
}

export function encodeSeabedRow(r: SeabedRow): string {
    const time = new Date(r.timeMs).toISOString();
    const xyz = `${r.lon.toFixed(6)},${r.lat.toFixed(6)},${r.depth.toFixed(2)},${time}`;
    const motion = `${fixed(r.sogKn, 2)},${fixed(r.cogDeg, 1)},${fixed(r.hdgDeg, 1)},${fixed(r.heelDeg, 1)}`;
    const quality = `${whole(r.fixQ)},${fixed(r.hdop, 1)},${whole(r.sats)},${whole(r.posAgeMs)}`;
    return `${xyz},${motion},${quality},${r.depthRef},${r.flags}`;
}

export function encodeSeabedCsv(rows: readonly SeabedRow[]): string {
    let out = `${SEABED_CSV_HEADER}\n`;
    for (const r of rows) out += `${encodeSeabedRow(r)}\n`;
    return out;
}

// ── Values no instrument could mean ───────────────────────────────────────

/** The value as the CSV will show it, when the decoder will take it back; else null. */
function shown(v: number | null, digits: number, min: number, max: number): number | null {
    if (v === null || !Number.isFinite(v)) return null;
    const text = digits < 0 ? String(Math.round(v)) : v.toFixed(digits);
    const back = Number(text);
    return back >= min && back <= max ? v : null;
}

/**
 * The row as offer() will keep it: null when its depth, position or time
 * cannot be encoded so the decoder takes it back (bad_values); otherwise each
 * optional value outside the decoder's range is left empty (fields_cleared).
 * The ranges are parseRow's, checked on the encoded text.
 */
export function sanitizeSeabedRow(r: SeabedRow): { row: SeabedRow; cleared: boolean } | null {
    if (shown(r.lon, 6, -180, 180) === null || shown(r.lat, 6, -90, 90) === null) return null;
    if (shown(r.depth, 2, 0, 12_000) === null) return null;
    if (!Number.isFinite(r.timeMs) || r.timeMs < EARLIEST_MS || r.timeMs > Date.UTC(9999, 0, 1)) return null;
    if (r.depthRef !== 'T' && r.depthRef !== 'W') return null;
    const row: SeabedRow = {
        ...r,
        sogKn: shown(r.sogKn, 2, 0, 200),
        cogDeg: shown(r.cogDeg, 1, 0, 360),
        hdgDeg: shown(r.hdgDeg, 1, 0, 360),
        heelDeg: shown(r.heelDeg, 1, -90, 90),
        fixQ: shown(r.fixQ, -1, 0, 8),
        hdop: shown(r.hdop, 1, 0, 100),
        sats: shown(r.sats, -1, 0, 256),
        posAgeMs: shown(r.posAgeMs, -1, -86_400_000, 86_400_000),
    };
    const keys = ['sogKn', 'cogDeg', 'hdgDeg', 'heelDeg', 'fixQ', 'hdop', 'sats', 'posAgeMs'] as const;
    return { row, cleared: keys.some((k) => r[k] !== null && row[k] === null) };
}

const NUMBER_RE = /^-?\d+(\.\d+)?$/;
const INT_RE = /^-?\d+$/;
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function num(text: string, min: number, max: number, optional: boolean): number | null | undefined {
    if (text === '') return optional ? null : undefined;
    if (!NUMBER_RE.test(text)) return undefined;
    const v = Number(text);
    return v >= min && v <= max ? v : undefined;
}

function int(text: string, min: number, max: number): number | null | undefined {
    if (text === '') return null;
    if (!INT_RE.test(text)) return undefined;
    const v = Number(text);
    return v >= min && v <= max ? v : undefined;
}

function parseRow(line: string, nowMs: number): SeabedRow | string {
    // MUST stay in step with sanitizeSeabedRow above.
    const c = line.split(',');
    if (c.length !== 14) return 'expected 14 columns';
    const lon = num(c[0], -180, 180, false);
    const lat = num(c[1], -90, 90, false);
    const depth = num(c[2], 0, 12_000, false);
    if (typeof lon !== 'number' || typeof lat !== 'number') return 'position out of range';
    if (typeof depth !== 'number') return 'depth out of range';
    const timeMs = TIME_RE.test(c[3]) ? Date.parse(c[3]) : NaN;
    if (!Number.isFinite(timeMs) || timeMs < EARLIEST_MS || timeMs > nowMs + FUTURE_SKEW_MS) return 'bad time';
    const sogKn = num(c[4], 0, 200, true);
    const cogDeg = num(c[5], 0, 360, true);
    const hdgDeg = num(c[6], 0, 360, true);
    const heelDeg = num(c[7], -90, 90, true);
    const fixQ = int(c[8], 0, 8);
    const hdop = num(c[9], 0, 100, true);
    const sats = int(c[10], 0, 256);
    const posAgeMs = int(c[11], -86_400_000, 86_400_000);
    const optional = [sogKn, cogDeg, hdgDeg, heelDeg, fixQ, hdop, sats, posAgeMs];
    if (optional.some((v) => v === undefined)) return 'an optional column is malformed';
    const depthRef = c[12];
    if (depthRef !== 'T' && depthRef !== 'W') return 'DEPTH_REF must be T or W';
    const flags = int(c[13], 0, SEABED_FLAG_MAX);
    if (typeof flags !== 'number') return 'bad FLAGS';
    return {
        lon,
        lat,
        depth,
        timeMs,
        sogKn: sogKn as number | null,
        cogDeg: cogDeg as number | null,
        hdgDeg: hdgDeg as number | null,
        heelDeg: heelDeg as number | null,
        fixQ: fixQ as number | null,
        hdop: hdop as number | null,
        sats: sats as number | null,
        posAgeMs: posAgeMs as number | null,
        depthRef,
        flags,
    };
}

export type SeabedDecode = { ok: true; rows: SeabedRow[] } | { ok: false; error: string };

/** Strict: the exact header, every row valid, time never going backwards, at most 7200 rows. */
export function decodeSeabedCsv(text: string, nowMs: number): SeabedDecode {
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    if (lines[0] !== SEABED_CSV_HEADER) return { ok: false, error: 'the header is not the seabed CSV header' };
    if (lines.length < 2) return { ok: false, error: 'no rows' };
    if (lines.length - 1 > INGEST_MAX_ROWS) return { ok: false, error: 'too many rows' };
    const rows: SeabedRow[] = [];
    let previous = -Infinity;
    for (let i = 1; i < lines.length; i++) {
        const row = parseRow(lines[i], nowMs);
        if (typeof row === 'string') return { ok: false, error: `line ${i + 1}: ${row}` };
        if (row.timeMs < previous) return { ok: false, error: `line ${i + 1}: time goes backwards` };
        previous = row.timeMs;
        rows.push(row);
    }
    return { ok: true, rows };
}

// ── Metadata that travels beside the file ─────────────────────────────────

const META_TEXT = [
    'schema',
    'device',
    'logger',
    'logger_version',
    'time_source',
    'position_source',
    'depth_source',
    'sounder_note',
    'sounder_product',
    'sampling',
];
const META_NUMBER: Record<string, [number, number]> = {
    transducer_to_keel_m: [0, 10],
    surface_to_transducer_m: [0, 10],
    vessel_draft_m: [0, 30],
    core_version: [0, 1_000],
};
const META_FLAG = ['draft_confirmed', 'recovered'];

export type SeabedMeta = Record<string, string | number | boolean>;

/** Keep only the known keys, each bounded; anything else is dropped, never echoed. */
export function cleanCaptureMeta(raw: unknown): SeabedMeta {
    const out: SeabedMeta = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    const m = raw as Record<string, unknown>;
    for (const key of META_TEXT) {
        const v = m[key];
        if (isText(v, 120)) out[key] = v;
    }
    for (const [key, [min, max]] of Object.entries(META_NUMBER)) {
        const v = m[key];
        if (inRange(v, min, max)) out[key] = v;
    }
    for (const key of META_FLAG) {
        if (typeof m[key] === 'boolean') out[key] = m[key] as boolean;
    }
    return out;
}

export function cleanCounters(raw: unknown): SeabedCounters {
    const out = zeroCounters();
    if (!raw || typeof raw !== 'object') return out;
    const m = raw as Record<string, unknown>;
    for (const key of Object.keys(out) as (keyof SeabedCounters)[]) {
        const v = m[key];
        if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10_000_000) out[key] = v;
    }
    return out;
}

// ── The capture: under way, zones, trimming, hourly batches ───────────────

function hourOf(ms: number): number {
    return Math.floor(ms / 3_600_000);
}

interface Held {
    row: SeabedRow;
    cleared: boolean;
}

/**
 * One boat's capture. Feed it navigation with observe() and soundings with
 * offer(); it hands back the rows that survived and any batch it closed. Rows
 * pass, in order: values an instrument could mean, under way, at most one per
 * 900 ms, outside every privacy zone, outside 500 m of where the trip
 * started, then HELD until the boat has been more than 500 m from them.
 *
 * Neither end of a trip (a friend's mooring, an anchorage, the berth before
 * the skipper marks it) is ever kept. When the trip ends, rows still held are
 * dropped, and so is every row within 500 m of where she stopped: in the open
 * batch here, and in the batches closed earlier in the trip, which come out
 * PARKED for the device to hold and trim with trimTripEnd() once tripEnd says
 * where that was. Holding alone is not enough: a boat that sails past her
 * anchorage and comes back released those rows on the way past.
 */
export class SeabedCapture {
    readonly state: UnderwayState = newUnderwayState();
    counters: SeabedCounters = zeroCounters();
    private zones: SeabedZone[] = [];
    private start: SeabedFix | null = null;
    private held: Held[] = [];
    private open: SeabedRow[] = [];
    private lastOfferMs: number | null = null;
    private lastAppendedMs: number | null = null;
    private lastFix: SeabedFix | null = null;
    private inTrip = false;

    constructor(zones: readonly SeabedZone[] = []) {
        this.setZones(zones);
    }

    setZones(zones: readonly SeabedZone[]): void {
        this.zones = zones.slice(0, ZONE_MAX_COUNT);
    }

    get underway(): boolean {
        return this.state.underway;
    }

    get heldRows(): number {
        return this.held.length;
    }

    /** The open batch so far (a copy), for a store that keeps it across restarts. */
    openRows(): SeabedRow[] {
        return this.open.map((r) => ({ ...r }));
    }

    observe(nowMs: number, sogKn: number | null, fix: SeabedFix | null): SeabedStep {
        const step = emptyStep();
        if (fix) this.lastFix = { lat: fix.lat, lon: fix.lon };
        step.event = stepUnderway(this.state, nowMs, sogKn, fix !== null);
        if (step.event === 'start') {
            this.start = fix;
            this.inTrip = true;
        }
        if (fix && this.state.underway) this.release(fix, step);
        if (step.event === 'stop') this.endTrip(step);
        return step;
    }

    offer(input: SeabedRow): SeabedStep {
        const step = emptyStep();
        if (!this.state.underway) return step;
        const clean = sanitizeSeabedRow(input);
        if (!clean) {
            this.counters.bad_values += 1;
            return step;
        }
        if (this.lastOfferMs !== null && clean.row.timeMs - this.lastOfferMs < SAMPLE_MIN_GAP_MS) {
            this.counters.too_soon += 1;
            return step;
        }
        if (clean.cleared) this.counters.fields_cleared += 1;
        this.lastOfferMs = clean.row.timeMs;
        const row: SeabedRow = { ...clean.row, flags: captureFlags(clean.row) };
        this.lastFix = { lat: row.lat, lon: row.lon };
        if (insideAnyZone(row.lat, row.lon, this.zones)) {
            this.counters.privacy_dropped += 1;
            return step;
        }
        if (this.start && distanceM(row.lat, row.lon, this.start.lat, this.start.lon) < TRIM_RADIUS_M) {
            this.counters.trim_dropped += 1;
            return step;
        }
        this.held.push({ row, cleared: false });
        if (this.held.length > HOLD_MAX_ROWS) {
            this.held.shift();
            this.counters.trim_dropped += 1;
        }
        this.release({ lat: row.lat, lon: row.lon }, step);
        return step;
    }

    /** End the trip now (switched off, shutting down): held rows go, the open batch closes. */
    finish(): SeabedStep {
        const step = emptyStep();
        if (this.state.underway) step.event = 'stop';
        Object.assign(this.state, newUnderwayState());
        this.endTrip(step);
        return step;
    }

    private release(at: SeabedFix, step: SeabedStep): void {
        for (const h of this.held) {
            if (!h.cleared && distanceM(at.lat, at.lon, h.row.lat, h.row.lon) > TRIM_RADIUS_M) h.cleared = true;
        }
        while (this.held.length && this.held[0].cleared) {
            this.append((this.held.shift() as Held).row, step);
        }
    }

    private append(row: SeabedRow, step: SeabedStep): void {
        if (this.lastAppendedMs !== null && row.timeMs - this.lastAppendedMs > GAP_BEFORE_MS) {
            row.flags |= SEABED_FLAG.GAP_BEFORE;
        }
        const first = this.open[0];
        const newHour = first !== undefined && hourOf(first.timeMs) !== hourOf(row.timeMs);
        if (newHour || this.open.length >= BATCH_MAX_ROWS) this.closeOpen(step, true);
        this.open.push(row);
        this.lastAppendedMs = row.timeMs;
        step.appended.push(row);
    }

    private endTrip(step: SeabedStep): void {
        this.counters.trim_dropped += this.held.length;
        this.held = [];
        const end = this.lastFix;
        if (end) {
            const before = this.open.length;
            this.open = this.open.filter((r) => distanceM(r.lat, r.lon, end.lat, end.lon) >= TRIM_RADIUS_M);
            this.counters.trim_dropped += before - this.open.length;
        }
        const ended = this.inTrip || this.open.length > 0;
        this.closeOpen(step, false);
        if (ended) step.tripEnd = { at: end };
        this.start = null;
        this.lastOfferMs = null;
        this.lastAppendedMs = null;
        this.lastFix = null;
        this.inTrip = false;
    }

    private closeOpen(step: SeabedStep, parked: boolean): void {
        if (!this.open.length) return;
        step.closed.push(closeRows(this.open, this.counters, parked));
        this.open = [];
        this.counters = zeroCounters();
    }
}
