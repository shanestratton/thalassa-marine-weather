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

function mockClient(upsert: ReturnType<typeof vi.fn>): SupabaseClient {
    return {
        from: vi.fn(() => ({ upsert })),
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
