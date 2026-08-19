import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { VesselDB } from './db';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

/**
 * The writer calls the merge_vessels RPC (server-side COALESCE per column),
 * not a PostgREST bulk upsert — see the note in db.ts. The mock stands in for
 * that call; the tests reason about batches and rows exactly as before.
 */
function mockClient(upsert: ReturnType<typeof vi.fn>): SupabaseClient {
    return {
        rpc: vi.fn((_fn: string, args: { rows: unknown[] }) => upsert(args.rows)),
    } as unknown as SupabaseClient;
}

describe('VesselDB flush ownership', () => {
    it('requeues a failed batch and retries it without losing the vessel', async () => {
        const upsert = vi
            .fn()
            .mockResolvedValueOnce({ error: { message: 'temporary outage' } })
            .mockResolvedValueOnce({ error: null });
        const db = new VesselDB(mockClient(upsert));
        db.enqueue({ mmsi: 123456789, lat: -27.4, lon: 153.1 });

        await db.flush();
        expect(db.getStats()).toMatchObject({ buffered: 1, totalUpserts: 0, totalErrors: 1 });

        await db.flush();
        expect(db.getStats()).toMatchObject({ buffered: 0, totalUpserts: 1, totalErrors: 1 });
        expect(upsert).toHaveBeenCalledTimes(2);
    });

    it('preserves a fresher message when an older in-flight snapshot fails', async () => {
        const first = deferred<{ error: { message: string } }>();
        const upsert = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce({ error: null });
        const db = new VesselDB(mockClient(upsert));
        db.enqueue({ mmsi: 123456789, lat: -27.4, lon: 153.1, sog: 4 });

        const initialFlush = db.flush();
        await vi.waitFor(() => expect(upsert).toHaveBeenCalledOnce());
        db.enqueue({ mmsi: 123456789, lat: -27.5, lon: 153.2, sog: 8 });
        first.resolve({ error: { message: 'temporary outage' } });
        await initialFlush;

        await db.flush();
        const retriedRows = upsert.mock.calls[1][0] as Array<Record<string, unknown>>;
        expect(retriedRows).toEqual([
            expect.objectContaining({
                mmsi: 123456789,
                location: 'SRID=4326;POINT(153.2 -27.5)',
                sog: 8,
            }),
        ]);
    });

    it('serializes overlapping flushes and drains arrivals before the waiter resolves', async () => {
        const first = deferred<{ error: null }>();
        const upsert = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce({ error: null });
        const db = new VesselDB(mockClient(upsert));
        db.enqueue({ mmsi: 123456789, lat: -27.4, lon: 153.1 });

        const firstFlush = db.flush();
        await vi.waitFor(() => expect(upsert).toHaveBeenCalledOnce());
        db.enqueue({ mmsi: 987654321, lat: -33.8, lon: 151.2 });
        const overlappingFlush = db.flush();
        expect(upsert).toHaveBeenCalledTimes(1);

        first.resolve({ error: null });
        await Promise.all([firstFlush, overlappingFlush]);

        expect(upsert).toHaveBeenCalledTimes(2);
        expect(db.getStats()).toMatchObject({ buffered: 0, totalUpserts: 2, totalErrors: 0 });
    });
});

/**
 * WRITE ONLY WHAT CHANGED.
 *
 * Measured 2026-08-18: 34,661,184 row-inserts into public.vessels, ~1.8 TB
 * written, the Micro's disk IO budget flat at 0% for a week — because every
 * position report was a full row rewrite whether or not the boat had moved,
 * and most AIS traffic is boats sitting still. These tests pin the writer's
 * new restraint, and the two ways restraint could go wrong: skipping a
 * genuine move, or starving the 24 h stale-vessel sweep.
 */
describe('VesselDB writes only material change', () => {
    const still = { mmsi: 503101240, lat: -27.20525, lon: 153.09304, sog: 0.1, cog: 12, heading: 15 };

    it('does not rewrite a moored boat that reports the same position again', async () => {
        const upsert = vi.fn().mockResolvedValue({ error: null });
        const db = new VesselDB(mockClient(upsert));

        db.enqueue(still);
        await db.flush();
        expect(upsert).toHaveBeenCalledTimes(1);

        // The same boat, the same spot, thirty more reports. Not one write.
        for (let i = 0; i < 30; i++) {
            db.enqueue({ ...still, sog: 0.2, cog: 14 }); // GPS jitter only
            await db.flush();
        }
        expect(upsert).toHaveBeenCalledTimes(1);
        expect(db.getStats().totalSkipped).toBe(30);
    });

    it('does write a boat that has actually moved', async () => {
        const upsert = vi.fn().mockResolvedValue({ error: null });
        const db = new VesselDB(mockClient(upsert));
        db.enqueue(still);
        await db.flush();

        // ~110 m north — well past the 25 m threshold.
        db.enqueue({ ...still, lat: still.lat + 0.001 });
        await db.flush();
        expect(upsert).toHaveBeenCalledTimes(2);
    });

    it('does write a boat that has got under way, even in place', async () => {
        // sog 0.1 → 4 kt at the same fix is a boat leaving; nav_status change too.
        const upsert = vi.fn().mockResolvedValue({ error: null });
        const db = new VesselDB(mockClient(upsert));
        db.enqueue(still);
        await db.flush();
        db.enqueue({ ...still, sog: 4.0 });
        await db.flush();
        expect(upsert).toHaveBeenCalledTimes(2);
    });

    it('does write when static data changes (a name or destination arrives)', async () => {
        const upsert = vi.fn().mockResolvedValue({ error: null });
        const db = new VesselDB(mockClient(upsert));
        db.enqueue(still);
        await db.flush();
        db.enqueue({ mmsi: still.mmsi, name: 'SERENE SUMMER' });
        await db.flush();
        expect(upsert).toHaveBeenCalledTimes(2);
    });

    it('still heartbeats an unchanged boat so the 24 h stale sweep never eats it', async () => {
        // The one cost of skipping writes is that updated_at ages. A boat that
        // faithfully reports from its mooring for a week must not be deleted
        // as stale, so it is rewritten at least every HEARTBEAT_MS (10 min by
        // default) — comfortably inside the sweep's 24 h.
        vi.useFakeTimers();
        try {
            const upsert = vi.fn().mockResolvedValue({ error: null });
            const db = new VesselDB(mockClient(upsert));
            db.enqueue(still);
            await db.flush();
            expect(upsert).toHaveBeenCalledTimes(1);

            vi.advanceTimersByTime(5 * 60_000);
            db.enqueue(still);
            await db.flush();
            expect(upsert).toHaveBeenCalledTimes(1); // still inside the heartbeat — skipped

            vi.advanceTimersByTime(6 * 60_000); // now 11 min since the last write
            db.enqueue(still);
            await db.flush();
            expect(upsert).toHaveBeenCalledTimes(2); // heartbeat write
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not remember a row that failed to reach the database', async () => {
        // If the diff basis were updated on a FAILED upsert, the retry would
        // then be judged "unchanged" and skipped — and the row lost for good.
        const upsert = vi
            .fn()
            .mockResolvedValueOnce({ error: { message: 'outage' } })
            .mockResolvedValue({ error: null });
        const db = new VesselDB(mockClient(upsert));
        db.enqueue(still);
        await db.flush(); // fails, requeued
        await db.flush(); // retried — must actually be sent
        expect(upsert).toHaveBeenCalledTimes(2);
        expect(db.getStats().totalUpserts).toBe(1);
    });
});

/**
 * A partial message must never blank a field it did not carry.
 *
 * AIS sends position and static data as separate messages. Measured live on
 * 2026-08-19: BUNGAREE (503058420), 22.7 kt, name gone from the table — a
 * position report had gone up as {name: null, ...} and overwritten it. The
 * writer now sends ONLY the keys each row actually has and merges via the
 * COALESCE RPC, so the server keeps what the message was silent about.
 */
describe('VesselDB never nulls a field the message did not carry', () => {
    it('sends a position-only row without any static keys at all', async () => {
        const upsert = vi.fn().mockResolvedValue({ error: null });
        const db = new VesselDB(mockClient(upsert));
        db.enqueue({ mmsi: 503058420, lat: -27.4, lon: 153.1, sog: 22.7, cog: 36.6 });
        await db.flush();

        const rows = upsert.mock.calls[0][0] as Record<string, unknown>[];
        expect(rows).toHaveLength(1);
        // Absent — not null. Absent lets COALESCE keep the stored name;
        // null would replace it.
        expect('name' in rows[0]).toBe(false);
        expect('call_sign' in rows[0]).toBe(false);
        expect('destination' in rows[0]).toBe(false);
        expect(rows[0].sog).toBe(22.7);
    });

    it('sends a static-only row without any position keys', async () => {
        const upsert = vi.fn().mockResolvedValue({ error: null });
        const db = new VesselDB(mockClient(upsert));
        db.enqueue({ mmsi: 503058420, name: 'BUNGAREE', call_sign: 'VJN2' });
        await db.flush();

        const rows = upsert.mock.calls[0][0] as Record<string, unknown>[];
        expect('location' in rows[0]).toBe(false);
        expect('sog' in rows[0]).toBe(false);
        expect(rows[0].name).toBe('BUNGAREE');
    });

    it('goes through the merge RPC, not a bulk upsert', async () => {
        // The whole point: a bulk upsert unions columns across the batch and
        // NULL-fills. Only the RPC path COALESCEs server-side.
        const upsert = vi.fn().mockResolvedValue({ error: null });
        const client = mockClient(upsert);
        const db = new VesselDB(client);
        db.enqueue({ mmsi: 1, lat: -27, lon: 153 });
        db.enqueue({ mmsi: 2, name: 'OTHER' });
        await db.flush();
        expect((client as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc).toHaveBeenCalledWith(
            'merge_vessels',
            expect.objectContaining({ rows: expect.any(Array) }),
        );
    });
});
