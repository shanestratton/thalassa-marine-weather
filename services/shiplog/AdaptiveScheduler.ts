/**
 * AdaptiveScheduler — clock-aligned tick scheduler for the ship-log
 * tracking interval.
 *
 * The ship's log writes one entry per "tick" — but a tick isn't every
 * `intervalMs` from `start()`; it's every `intervalMs` aligned to wall
 * clock midnight. So:
 *
 *   - 15-min interval → fires at xx:00, xx:15, xx:30, xx:45
 *   - 2-min interval  → fires at xx:00, xx:02, xx:04, …
 *   - 30-sec interval → fires at xx:xx:00, xx:xx:30
 *
 * The scheduler uses one `setTimeout` to land on the next clock mark,
 * then a `setInterval` from there. `scheduleClockAligned()` clears any
 * prior timer chain so re-calling on speed-tier change is safe.
 *
 * Coupling: the orchestrator owns `TrackingState` and the
 * `flushBufferedTrack` callback. The scheduler is told what to do; it
 * doesn't peek at state. It exposes `isRunning()` so the orchestrator
 * can guard "should I reschedule?" decisions without touching the
 * timer handle directly.
 */
import { createLogger } from '../../utils/logger';

const log = createLogger('ShipLog.Scheduler');

export class AdaptiveScheduler {
    private intervalId?: ReturnType<typeof setInterval>;
    private alignTimeoutId?: ReturnType<typeof setTimeout>;

    /**
     * Schedule `onTick` to fire at the next clock-aligned mark and then
     * every `intervalMs` after that. Re-callable: existing timers are
     * cleared first.
     *
     * `onTick` exceptions are caught and logged so a single failure
     * doesn't kill the timer chain. (Without this guard, an unhandled
     * promise rejection inside the callback could end the chain on
     * environments that promote rejections to uncaught errors.)
     */
    scheduleClockAligned(intervalMs: number, onTick: () => Promise<unknown> | unknown): void {
        this.stop();

        const now = Date.now();
        const msToNext = intervalMs - (now % intervalMs);

        this.alignTimeoutId = setTimeout(() => {
            this.fire(onTick);
            this.intervalId = setInterval(() => this.fire(onTick), intervalMs);
        }, msToNext);
    }

    /**
     * Schedule `onTick` every `intervalMs` immediately — no clock
     * alignment. Used by rapid-mode (5s marina navigation) where the
     * cadence is independent of clock marks. Re-callable: existing
     * timers are cleared first.
     */
    scheduleEvery(intervalMs: number, onTick: () => Promise<unknown> | unknown): void {
        this.stop();
        this.intervalId = setInterval(() => this.fire(onTick), intervalMs);
    }

    /** Stop both the alignment timeout and the recurring interval. */
    stop(): void {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
        }
        if (this.alignTimeoutId) {
            clearTimeout(this.alignTimeoutId);
            this.alignTimeoutId = undefined;
        }
    }

    /**
     * True if a tick interval is currently running. Used by the
     * orchestrator's "interval changed AND a timer is already going"
     * checks — without this, we'd end up resetting the chain on every
     * GPS fix even when the interval hadn't changed.
     */
    isRunning(): boolean {
        return this.intervalId !== undefined;
    }

    private fire(onTick: () => Promise<unknown> | unknown): void {
        try {
            const result = onTick();
            if (result && typeof (result as Promise<unknown>).catch === 'function') {
                (result as Promise<unknown>).catch((err) => {
                    log.warn('onTick rejection', err);
                });
            }
        } catch (err) {
            log.warn('onTick threw', err);
        }
    }
}
