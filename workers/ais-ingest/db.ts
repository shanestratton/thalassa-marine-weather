/**
 * db.ts — Supabase batched upsert layer for AIS vessel data.
 *
 * Buffers VesselRecords and flushes to Supabase in batches
 * to reduce round-trips and stay within connection limits.
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { VesselRecord } from './parser.js';

const BATCH_MAX = parseInt(process.env.BATCH_MAX_SIZE || '50', 10);
const FLUSH_INTERVAL = parseInt(process.env.BATCH_FLUSH_MS || '2000', 10);
const MAX_BUFFER = 500; // Memory guard — drop oldest if exceeded

export class VesselDB {
    private client: SupabaseClient;
    private buffer: Map<number, VesselRecord> = new Map(); // mmsi → latest record
    private flushTimer: ReturnType<typeof setInterval> | null = null;
    private totalUpserts = 0;
    private totalErrors = 0;

    constructor() {
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
        // eslint-disable-next-line no-console
        console.log(`[DB] Flush timer started (${FLUSH_INTERVAL}ms, max ${BATCH_MAX}/batch)`);
    }

    /** Stop the flush timer and flush remaining */
    async stop(): Promise<void> {
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
        await this.flush();
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
    async flush(): Promise<void> {
        if (this.buffer.size === 0) return;

        // Take a snapshot and clear buffer
        const records = Array.from(this.buffer.values());
        this.buffer.clear();

        // Process in batches
        for (let i = 0; i < records.length; i += BATCH_MAX) {
            const batch = records.slice(i, i + BATCH_MAX);
            await this.upsertBatch(batch);
        }
    }

    /** Upsert a batch of vessels into Supabase */
    private async upsertBatch(records: VesselRecord[]): Promise<void> {
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
            } else {
                this.totalUpserts += rows.length;
            }
        } catch (e) {
            console.error('[DB] Upsert exception:', e);
            this.totalErrors++;
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
