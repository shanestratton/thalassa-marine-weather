/**
 * The serial queue exists to cap PEAK memory, not to be clever.
 *
 * 2026-08-10: every per-job byte bound in the merge and tracer paths held —
 * 32 MB merge registers, byte-budgeted grid LRU — and the renderer still
 * died, always inside a window where two heavyweight builds overlapped
 * (two merge-starts a second apart; two tracer ctx-starts with both readys
 * later). Per-job bounds cannot see each other; the queue makes overlap
 * impossible. These tests pin the properties the callers rely on.
 */
import { describe, expect, it } from 'vitest';
import { createSerialQueue } from '../utils/serialQueue';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('createSerialQueue', () => {
    it('never runs two jobs at once, even when enqueued together', async () => {
        const queue = createSerialQueue();
        let running = 0;
        let peak = 0;
        const job = () =>
            queue(async () => {
                running += 1;
                peak = Math.max(peak, running);
                await tick();
                await tick();
                running -= 1;
            });
        await Promise.all([job(), job(), job(), job()]);
        expect(peak).toBe(1);
    });

    it('runs jobs in enqueue order', async () => {
        const queue = createSerialQueue();
        const order: number[] = [];
        await Promise.all(
            [1, 2, 3].map((n) =>
                queue(async () => {
                    await tick();
                    order.push(n);
                }),
            ),
        );
        expect(order).toEqual([1, 2, 3]);
    });

    it('returns each job its own result', async () => {
        const queue = createSerialQueue();
        const [a, b] = await Promise.all([queue(async () => 'merge'), queue(async () => 42)]);
        expect(a).toBe('merge');
        expect(b).toBe(42);
    });

    it('a failed job rejects its caller without blocking the queue', async () => {
        // A superseded merge THROWS (MergeSupersededError) as a matter of
        // course — if that wedged the queue, the first superseded build would
        // freeze every merge for the rest of the session.
        const queue = createSerialQueue();
        const failed = queue(async () => {
            throw new Error('superseded');
        });
        const next = queue(async () => 'still running');
        await expect(failed).rejects.toThrow('superseded');
        await expect(next).resolves.toBe('still running');
    });

    it('keeps working after multiple consecutive failures', async () => {
        const queue = createSerialQueue();
        for (let i = 0; i < 3; i++) {
            await expect(
                queue(async () => {
                    throw new Error(`fail ${i}`);
                }),
            ).rejects.toThrow(`fail ${i}`);
        }
        await expect(queue(async () => 'recovered')).resolves.toBe('recovered');
    });
});
