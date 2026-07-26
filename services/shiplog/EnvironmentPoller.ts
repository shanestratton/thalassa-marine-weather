/**
 * EnvironmentPoller — 60-second loop that re-checks "is the boat on water"
 * and refreshes the shoreline-zone resolver.
 *
 * Why decouple this from the GPS-fix stream:
 *  - Water/land detection is a network lookup; it is bounded to an initial
 *    post-lock check plus at most once per minute.
 *  - Shore-distance work is performed from cached OSM geometry by the
 *    resolver, never by blocking every raw GPS callback.
 *
 * Coupling: the poller calls into `getPos()`, `isActive()`,
 * `onWaterStatus()` (cache + UI fan-out), and `onZoneRecheck()` (the
 * orchestrator's GPS-coordinate shoreline refresh). It owns its own timer
 * and nothing else.
 */
import { createLogger } from '../../utils/createLogger';
import type { CachedPosition } from '../BgGeoManager';
import { checkWaterStatus, type WaterCheckResult } from './waterDetection';

const log = createLogger('ShipLog.Env');

const POLL_INTERVAL_MS = 60_000;

export interface EnvironmentPollerOptions {
    getPos: () => CachedPosition | null;
    isActive: () => boolean;
    /** Called with the result of the water check. Caller caches it for log entries. */
    onWaterStatus: (status: WaterCheckResult) => void;
    /** Called once per tick after the water check, using the same actual GPS coordinate. */
    onZoneRecheck: (pos: CachedPosition, status: WaterCheckResult) => Promise<void> | void;
}

export class EnvironmentPoller {
    private intervalId?: ReturnType<typeof setInterval>;
    private options?: EnvironmentPollerOptions;
    private checkInFlight = false;
    private lastCheckStartedAt: number | null = null;

    /**
     * Start the 60s polling loop. Subsequent calls clear the existing
     * timer first, so re-calling on resume is safe.
     */
    start(opts: EnvironmentPollerOptions): void {
        this.stop();
        this.options = opts;
        this.intervalId = setInterval(() => {
            void this.tick(opts);
        }, POLL_INTERVAL_MS);
    }

    /**
     * Ask for the first water/shore refresh as soon as GPS has opened a
     * vetted track. Repeated raw fixes cannot hammer the API: normal polling
     * still owns the one-minute minimum cadence.
     */
    requestCheck(): void {
        const opts = this.options;
        if (!opts || this.checkInFlight) return;
        if (this.lastCheckStartedAt !== null && Date.now() - this.lastCheckStartedAt < POLL_INTERVAL_MS) return;
        void this.tick(opts);
    }

    stop(): void {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
        }
        this.options = undefined;
        this.checkInFlight = false;
        this.lastCheckStartedAt = null;
    }

    private async tick(opts: EnvironmentPollerOptions): Promise<void> {
        if (this.checkInFlight) return;
        this.checkInFlight = true;
        this.lastCheckStartedAt = Date.now();
        try {
            if (!opts.isActive()) return;
            const pos = opts.getPos();
            if (!pos) return;

            const waterStatus = await checkWaterStatus(pos.latitude, pos.longitude);
            opts.onWaterStatus(waterStatus);
            await opts.onZoneRecheck(pos, waterStatus);
        } catch (e) {
            // Best effort — we don't want a tile fetch failure to crash
            // the polling loop. The timer keeps running; next minute
            // we'll try again.
            log.warn('environment tick failed', e);
        } finally {
            this.checkInFlight = false;
        }
    }
}
