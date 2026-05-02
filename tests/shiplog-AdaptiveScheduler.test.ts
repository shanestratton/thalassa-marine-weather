/**
 * Tests for AdaptiveScheduler — verifies clock-aligned vs non-aligned
 * scheduling, isRunning(), stop() idempotency, and that an exception
 * inside onTick doesn't kill the chain.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdaptiveScheduler } from '../services/shiplog/AdaptiveScheduler';

describe('AdaptiveScheduler', () => {
    let scheduler: AdaptiveScheduler;

    beforeEach(() => {
        vi.useFakeTimers();
        scheduler = new AdaptiveScheduler();
    });

    afterEach(() => {
        scheduler.stop();
        vi.useRealTimers();
    });

    describe('scheduleClockAligned', () => {
        it('fires the first tick on the next clock-aligned mark', () => {
            // Lock to xx:00:13 → 15-min boundary is at xx:15:00 = 887000ms away.
            // Use something easier: 1-minute interval, set time to xx:xx:30 → next mark is 30s away.
            vi.setSystemTime(new Date('2026-05-02T06:00:30Z'));
            const onTick = vi.fn();
            scheduler.scheduleClockAligned(60_000, onTick);
            expect(onTick).toHaveBeenCalledTimes(0);
            vi.advanceTimersByTime(29_999);
            expect(onTick).toHaveBeenCalledTimes(0);
            vi.advanceTimersByTime(1);
            expect(onTick).toHaveBeenCalledTimes(1);
        });

        it('continues firing every interval after the first tick', () => {
            vi.setSystemTime(new Date('2026-05-02T06:01:00Z'));
            const onTick = vi.fn();
            scheduler.scheduleClockAligned(60_000, onTick); // alignment is 0ms (we're already on the mark)
            vi.advanceTimersByTime(60_000);
            expect(onTick).toHaveBeenCalledTimes(1);
            vi.advanceTimersByTime(60_000);
            expect(onTick).toHaveBeenCalledTimes(2);
            vi.advanceTimersByTime(60_000);
            expect(onTick).toHaveBeenCalledTimes(3);
        });

        it('re-calling clears the prior chain (no double-firing)', () => {
            vi.setSystemTime(new Date('2026-05-02T06:01:00Z'));
            const a = vi.fn();
            const b = vi.fn();
            scheduler.scheduleClockAligned(60_000, a);
            // Re-schedule before the first fire.
            scheduler.scheduleClockAligned(60_000, b);
            vi.advanceTimersByTime(60_000);
            expect(a).toHaveBeenCalledTimes(0);
            expect(b).toHaveBeenCalledTimes(1);
        });
    });

    describe('scheduleEvery', () => {
        it('fires every intervalMs without clock alignment', () => {
            vi.setSystemTime(new Date('2026-05-02T06:00:30Z'));
            const onTick = vi.fn();
            scheduler.scheduleEvery(5_000, onTick);
            // No alignment → first tick fires after exactly 5s, regardless
            // of where on the clock we are.
            vi.advanceTimersByTime(4_999);
            expect(onTick).toHaveBeenCalledTimes(0);
            vi.advanceTimersByTime(1);
            expect(onTick).toHaveBeenCalledTimes(1);
            vi.advanceTimersByTime(5_000);
            expect(onTick).toHaveBeenCalledTimes(2);
        });
    });

    describe('isRunning', () => {
        it('is false before any schedule call', () => {
            expect(scheduler.isRunning()).toBe(false);
        });

        it('returns false during the alignment window (only timeout active)', () => {
            vi.setSystemTime(new Date('2026-05-02T06:00:30Z'));
            scheduler.scheduleClockAligned(60_000, () => {});
            // Aligned schedule has only an alignment timeout running yet —
            // the recurring interval starts AFTER the first tick. This
            // matches the orchestrator's invariant: `!isRunning()` means
            // a fresh start is pending or we're cold.
            expect(scheduler.isRunning()).toBe(false);
        });

        it('is true once the recurring interval has started', () => {
            vi.setSystemTime(new Date('2026-05-02T06:00:30Z'));
            scheduler.scheduleClockAligned(60_000, () => {});
            vi.advanceTimersByTime(30_000); // hits the alignment mark, sets interval
            expect(scheduler.isRunning()).toBe(true);
        });

        it('is true immediately after scheduleEvery', () => {
            scheduler.scheduleEvery(5_000, () => {});
            expect(scheduler.isRunning()).toBe(true);
        });

        it('is false after stop()', () => {
            scheduler.scheduleEvery(5_000, () => {});
            scheduler.stop();
            expect(scheduler.isRunning()).toBe(false);
        });
    });

    describe('stop', () => {
        it('halts both pending alignment timeout and recurring interval', () => {
            vi.setSystemTime(new Date('2026-05-02T06:00:30Z'));
            const onTick = vi.fn();
            scheduler.scheduleClockAligned(60_000, onTick);
            scheduler.stop();
            vi.advanceTimersByTime(60_000 * 5);
            expect(onTick).toHaveBeenCalledTimes(0);
        });

        it('is idempotent (calling twice is fine)', () => {
            scheduler.scheduleEvery(5_000, () => {});
            expect(() => {
                scheduler.stop();
                scheduler.stop();
            }).not.toThrow();
        });
    });

    describe('error handling', () => {
        it('keeps firing after an onTick throw', () => {
            let calls = 0;
            scheduler.scheduleEvery(1_000, () => {
                calls++;
                if (calls === 1) throw new Error('boom');
            });
            vi.advanceTimersByTime(1_000);
            vi.advanceTimersByTime(1_000);
            vi.advanceTimersByTime(1_000);
            expect(calls).toBeGreaterThanOrEqual(3);
        });

        it('keeps firing after an onTick promise rejection', async () => {
            let calls = 0;
            scheduler.scheduleEvery(1_000, () => {
                calls++;
                return Promise.reject(new Error('async boom'));
            });
            await vi.advanceTimersByTimeAsync(1_000);
            await vi.advanceTimersByTimeAsync(1_000);
            await vi.advanceTimersByTimeAsync(1_000);
            expect(calls).toBeGreaterThanOrEqual(3);
        });
    });
});
