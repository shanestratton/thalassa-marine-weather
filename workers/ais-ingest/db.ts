/**
 * db.ts — Supabase batched upsert layer for AIS vessel data.
 *
 * Buffers VesselRecords and flushes to Supabase in batches
 * to reduce round-trips and stay within connection limits.
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { VesselRecord } from './parser.js';

function boundedPositiveInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

const BATCH_MAX = boundedPositiveInteger(process.env.BATCH_MAX_SIZE, 50, 1, 500);
const FLUSH_INTERVAL = boundedPositiveInteger(process.env.BATCH_FLUSH_MS, 2000, 250, 60_000);
const MAX_BUFFER = 500; // Memory guard — drop oldest if exceeded

/**
 * WRITE ONLY WHAT CHANGED.
 *
 * Measured 2026-08-18 on the production Micro: 34,661,184 row-inserts into
 * public.vessels, 235,633,110 blocks = ~1.8 TB written, and the disk IO
 * budget flat at 0% for a week. Every position report became a full row
 * rewrite — heap + the GIST geography index + the updated_at index + WAL,
 * ~6.8 blocks each — whether or not anything had actually moved. And most
 * AIS traffic is boats sitting still: a moored yacht reports the same
 * position every few seconds, and a whole planet of them was being rewritten
 * to disk every flush.
 *
 * So the writer now remembers what it last sent per MMSI and skips a row
 * whose position has not moved materially and whose kinematics and static
 * data are unchanged. Only `updated_at` would have differed, and a
 * last-seen timestamp is not worth 6.8 disk blocks and a GIST update.
 *
 * The cost of being wrong here is only that a stationary vessel's
 * updated_at ages, so the stale-vessel sweep could eventually delete a boat
 * that is still faithfully reporting from its mooring. HEARTBEAT_MS bounds
 * that: a vessel is rewritten at least this often even if unchanged, kept
 * well inside the sweep's max age. Everything else is pure saving.
 */
const MIN_MOVE_M = boundedPositiveInteger(process.env.MIN_MOVE_M, 25, 1, 5000);
const HEARTBEAT_MS = boundedPositiveInteger(process.env.HEARTBEAT_MS, 10 * 60_000, 30_000, 24 * 3_600_000);
/** Bounded so a planet-wide subscription cannot grow this without limit. */
const LAST_SENT_MAX = 50_000;

interface SentState {
    lat?: number;
    lon?: number;
    cog?: number;
    sog?: number;
    heading?: number;
    nav_status?: number;
    staticSig: string;
    sentAt: number;
}

/** Equirectangular distance in metres — plenty for a 25 m threshold. */
function metresBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6_371_000;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const mLat = ((lat1 + lat2) / 2) * (Math.PI / 180);
    const x = dLon * Math.cos(mLat);
    return Math.sqrt(x * x + dLat * dLat) * R;
}

/** The static/identity fields, as one comparable string. */
function staticSignature(r: VesselRecord): string {
    return [
        r.name,
        r.call_sign,
        r.ship_type,
        r.destination,
        r.imo_number,
        r.dimension_a,
        r.dimension_b,
        r.dimension_c,
        r.dimension_d,
    ]
        .map((v) => (v === undefined ? '' : String(v)))
        .join('|');
}

/**
 * Is this record worth a disk write, given what was last sent for the MMSI?
 * Exported for tests.
 */
export function isMaterialChange(prev: SentState | undefined, r: VesselRecord, now: number): boolean {
    if (!prev) return true; // never seen — of course
    if (now - prev.sentAt >= HEARTBEAT_MS) return true; // keep updated_at alive

    // Position: moved more than the threshold, or appeared/disappeared.
    const hadPos = prev.lat !== undefined && prev.lon !== undefined;
    const hasPos = r.lat !== undefined && r.lon !== undefined;
    if (hadPos !== hasPos) return true;
    if (hasPos && hadPos && metresBetween(prev.lat!, prev.lon!, r.lat!, r.lon!) >= MIN_MOVE_M) return true;

    // Kinematics: a boat that has started or stopped moving, or turned, is news.
    if (r.sog !== undefined && r.sog !== prev.sog) {
        // Ignore GPS jitter on a stationary boat (sog < 0.5 kt either side).
        const wasStill = (prev.sog ?? 0) < 0.5;
        const isStill = r.sog < 0.5;
        if (!(wasStill && isStill)) return true;
    }
    if (r.nav_status !== undefined && r.nav_status !== prev.nav_status) return true;
    if (r.heading !== undefined && prev.heading !== undefined && Math.abs(r.heading - prev.heading) >= 5) return true;
    if (r.cog !== undefined && prev.cog !== undefined && Math.abs(r.cog - prev.cog) >= 5 && (r.sog ?? 0) >= 0.5) {
        return true;
    }

    // Static data changed (name, destination, dimensions…)
    if (staticSignature(r) !== prev.staticSig) return true;

    return false;
}

export class VesselDB {
    private client: SupabaseClient;
    private buffer: Map<number, VesselRecord> = new Map(); // mmsi → latest record
    private flushTimer: ReturnType<typeof setInterval> | null = null;
    private flushPromise: Promise<void> | null = null;
    private totalUpserts = 0;
    private totalErrors = 0;
    /** What was last WRITTEN per MMSI — the basis for skipping no-op rows. */
    private lastSent: Map<number, SentState> = new Map();
    private totalSkipped = 0;

    constructor(client?: SupabaseClient) {
        if (client) {
            this.client = client;
            return;
        }
        const url = process.env.SUPABASE_URL;
        const key = process.env.SUPABASE_SERVICE_KEY;
        if (!url || !key) {
            throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
        }
        this.client = createClient(url, key);
    }

    /** Start the flush timer */
    start(): void {
        if (this.flushTimer) return;
        this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL);

        console.log(`[DB] Flush timer started (${FLUSH_INTERVAL}ms, max ${BATCH_MAX}/batch)`);
    }

    /** Stop the flush timer and flush remaining */
    async stop(): Promise<void> {
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
        await this.flush();
        // One bounded retry gives a transient shutdown-time failure a chance
        // to recover while preserving the unsent buffer if it still fails.
        if (this.buffer.size > 0) await this.flush();
    }

    /** Buffer a vessel record for batch upsert */
    enqueue(record: VesselRecord): void {
        // Memory guard — if buffer is full, it naturally overwrites by MMSI
        if (this.buffer.size >= MAX_BUFFER && !this.buffer.has(record.mmsi)) {
            // Drop the oldest entry (first in map iteration order)
            const oldest = this.buffer.keys().next().value;
            if (oldest !== undefined) this.buffer.delete(oldest);
        }

        // Merge with existing buffer entry (position + static data may arrive separately)
        const existing = this.buffer.get(record.mmsi);
        if (existing) {
            this.buffer.set(record.mmsi, { ...existing, ...record });
        } else {
            this.buffer.set(record.mmsi, record);
        }
    }

    /** Flush buffered records to Supabase */
    flush(): Promise<void> {
        // setInterval may tick while the previous network request is still in
        // flight. Serialize drains so two snapshots can never race each other.
        // A caller such as stop() that arrives mid-flush chains one final drain
        // and therefore does not return before newly buffered records are sent.
        if (this.flushPromise) {
            return this.flushPromise.then(() => (this.buffer.size > 0 ? this.flush() : undefined));
        }

        const work = this.drainSnapshot();
        const tracked = work.finally(() => {
            if (this.flushPromise === tracked) this.flushPromise = null;
        });
        this.flushPromise = tracked;
        return tracked;
    }

    private async drainSnapshot(): Promise<void> {
        if (this.buffer.size === 0) return;

        // Take a snapshot and clear buffer
        const snapshot = Array.from(this.buffer.values());
        this.buffer.clear();

        // Drop rows that would only refresh updated_at. This is the whole
        // fix for the 1.8 TB — see the note on MIN_MOVE_M above.
        const now = Date.now();
        const records = snapshot.filter((r) => {
            const keep = isMaterialChange(this.lastSent.get(r.mmsi), r, now);
            if (!keep) this.totalSkipped++;
            return keep;
        });
        if (records.length === 0) return;

        // Process in batches
        for (let i = 0; i < records.length; i += BATCH_MAX) {
            const batch = records.slice(i, i + BATCH_MAX);
            const saved = await this.upsertBatch(batch);
            if (!saved) this.requeueFailed(batch);
        }
    }

    /** Upsert a batch of vessels into Supabase */
    private async upsertBatch(records: VesselRecord[]): Promise<boolean> {
        const rows = records.map((r) => {
            const row: Record<string, unknown> = {
                mmsi: r.mmsi,
                updated_at: new Date().toISOString(),
            };

            // Position data — build PostGIS point
            if (r.lat !== undefined && r.lon !== undefined) {
                row.location = `SRID=4326;POINT(${r.lon} ${r.lat})`;
            }

            // Kinematics
            if (r.cog !== undefined) row.cog = r.cog;
            if (r.sog !== undefined) row.sog = r.sog;
            if (r.heading !== undefined) row.heading = r.heading;
            if (r.nav_status !== undefined) row.nav_status = r.nav_status;

            // Static data
            if (r.name !== undefined) row.name = r.name;
            if (r.call_sign !== undefined) row.call_sign = r.call_sign;
            if (r.ship_type !== undefined) row.ship_type = r.ship_type;
            if (r.destination !== undefined) row.destination = r.destination;
            if (r.imo_number !== undefined) row.imo_number = r.imo_number;
            if (r.dimension_a !== undefined) row.dimension_a = r.dimension_a;
            if (r.dimension_b !== undefined) row.dimension_b = r.dimension_b;
            if (r.dimension_c !== undefined) row.dimension_c = r.dimension_c;
            if (r.dimension_d !== undefined) row.dimension_d = r.dimension_d;

            return row;
        });

        try {
            // merge_vessels, not a PostgREST bulk upsert. supabase-js builds a
            // batch's `columns` as the UNION of every row's keys, and PostgREST
            // NULL-fills any row missing one — then upserts that NULL over the
            // stored value. A position report sharing a batch with someone
            // else's static-data report arrived as {name: null, ...} and wiped
            // the name. It always did; nobody saw it while every boat was
            // rewritten every ~10 s and the next static frame put it back.
            // Change-detection made the NULL stick (BUNGAREE, 2026-08-19).
            // The RPC COALESCEs per column server-side, so a message can only
            // ever change the fields it actually carried.
            const { error } = await this.client.rpc('merge_vessels', { rows });

            if (error) {
                console.error(`[DB] Upsert error (${rows.length} rows):`, error.message);
                this.totalErrors++;
                return false;
            } else {
                this.totalUpserts += rows.length;
                this.rememberSent(records);
                return true;
            }
        } catch (e) {
            console.error('[DB] Upsert exception:', e);
            this.totalErrors++;
            return false;
        }
    }

    /**
     * Put an unsuccessful snapshot back without overwriting fresher messages
     * that arrived while the request was in flight.
     */
    private requeueFailed(records: VesselRecord[]): void {
        for (const record of records) {
            const newer = this.buffer.get(record.mmsi);
            if (this.buffer.size >= MAX_BUFFER && !newer) {
                const oldest = this.buffer.keys().next().value;
                if (oldest !== undefined) this.buffer.delete(oldest);
            }
            this.buffer.set(record.mmsi, newer ? { ...record, ...newer } : record);
        }
    }

    /** Record what actually reached the database, so the next flush can diff. */
    private rememberSent(records: VesselRecord[]): void {
        const now = Date.now();
        for (const r of records) {
            const prev = this.lastSent.get(r.mmsi);
            // Merge, because a partial record (static-only) must not erase the
            // last-known position for the diff.
            this.lastSent.set(r.mmsi, {
                lat: r.lat ?? prev?.lat,
                lon: r.lon ?? prev?.lon,
                cog: r.cog ?? prev?.cog,
                sog: r.sog ?? prev?.sog,
                heading: r.heading ?? prev?.heading,
                nav_status: r.nav_status ?? prev?.nav_status,
                staticSig: staticSignature({ ...(prev as VesselRecord | undefined), ...r } as VesselRecord),
                sentAt: now,
            });
        }
        // Bound memory: evict the oldest-written entries past the cap.
        while (this.lastSent.size > LAST_SENT_MAX) {
            const oldest = this.lastSent.keys().next().value;
            if (oldest === undefined) break;
            this.lastSent.delete(oldest);
        }
    }

    /** Get stats for logging */
    getStats(): { buffered: number; totalUpserts: number; totalErrors: number; totalSkipped: number } {
        return {
            buffered: this.buffer.size,
            totalUpserts: this.totalUpserts,
            totalErrors: this.totalErrors,
            totalSkipped: this.totalSkipped,
        };
    }
}
