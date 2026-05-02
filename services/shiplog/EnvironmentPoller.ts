/**
 * EnvironmentPoller — 60-second loop that re-checks "is the boat on water"
 * and re-evaluates the logging zone.
 *
 * Why decouple this from the GPS-fix stream:
 *  - Water/land detection runs against tile lookups; cheap but not free,
 *    and hourly resolution is fine for "are we still on water".
 *  - Logging-zone changes (nearshore → coastal → offshore) want a steady
 *    cadence, not "fire on every fix" — fixes can arrive at 1–10 Hz and
 *    rescheduling that often would thrash the timer stack.
 *
 * Coupling: the poller calls into `getPos()`, `isActive()`,
 * `onWaterStatus()` (cache + UI fan-out), and `onZoneRecheck()` (the
 * orchestrator's `rescheduleAdaptiveInterval()`). It owns its own timer
 * and nothing else.
 */
import { createLogger } from '../../utils/logger';
import type { CachedPosition } from '../BgGeoManager';
import { checkIsOnWater } from './waterDetection';

const log = createLogger('ShipLog.Env');

const POLL_INTERVAL_MS = 60_000;

export interface EnvironmentPollerOptions {
    getPos: () => CachedPosition | null;
    isActive: () => boolean;
    /** Called with the result of `checkIsOnWater`. Caller caches it for log entries. */
    onWaterStatus: (isOnWater: boolean) => void;
    /** Called once per tick after the water check, in case the zone has changed. */
    onZoneRecheck: () => Promise<void> | void;
}

export class EnvironmentPoller {
    private intervalId?: ReturnType<typeof setInterval>;

    /**
     * Start the 60s polling loop. Subsequent calls clear the existing
     * timer first, so re-calling on resume is safe.
     */
    start(opts: EnvironmentPollerOptions): void {
        this.stop();
        this.intervalId = setInterval(() => {
            void this.tick(opts);
        }, POLL_INTERVAL_MS);
    }

    stop(): void {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
        }
    }

    private async tick(opts: EnvironmentPollerOptions): Promise<void> {
        if (!opts.isActive()) return;
        const pos = opts.getPos();
        if (!pos) return;

        try {
            const isWater = await checkIsOnWater(pos.latitude, pos.longitude);
            opts.onWaterStatus(isWater);
            await opts.onZoneRecheck();
        } catch (e) {
            // Best effort — we don't want a tile fetch failure to crash
            // the polling loop. The timer keeps running; next minute
            // we'll try again.
            log.warn('environment tick failed', e);
        }
    }
}
