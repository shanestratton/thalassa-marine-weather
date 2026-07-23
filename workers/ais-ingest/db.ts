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

export class VesselDB {
    private client: SupabaseClient;
    private buffer: Map<number, VesselRecord> = new Map(); // mmsi → latest record
    private flushTimer: ReturnType<typeof setInterval> | null = null;
    private flushPromise: Promise<void> | null = null;
    private totalUpserts = 0;
    private totalErrors = 0;

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
        const records = Array.from(this.buffer.values());
        this.buffer.clear();

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
            const { error } = await this.client.from('vessels').upsert(rows, { onConflict: 'mmsi' });

            if (error) {
                console.error(`[DB] Upsert error (${rows.length} rows):`, error.message);
                this.totalErrors++;
                return false;
            } else {
                this.totalUpserts += rows.length;
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

    /** Get stats for logging */
    getStats(): { buffered: number; totalUpserts: number; totalErrors: number } {
        return {
            buffered: this.buffer.size,
            totalUpserts: this.totalUpserts,
            totalErrors: this.totalErrors,
        };
    }
}
