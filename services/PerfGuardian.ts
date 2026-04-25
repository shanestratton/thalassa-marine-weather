/**
 * PerfGuardian — silent FPS watchdog that auto-downtiers the device
 * classification when the chart screen is struggling.
 *
 * Runs ALWAYS (regardless of ?perf=1) but is essentially free — one
 * rAF callback per frame, exponential-moving-average bookkeeping, no
 * DOM. When the rolling average drops below SUSTAINED_LOW_FPS for
 * SUSTAINED_LOW_FPS_MS continuously, we write a forced `low` tier to
 * localStorage so the next launch's particle layers come up at 40%
 * count instead of 100%.
 *
 * This is what gives us the "iPhone 8 stays smooth" claim genuinely:
 * the device tunes itself without user intervention. The user gets
 * a one-time toast on next launch ("graphics quality reduced for
 * smoother performance") so they're not surprised by the change.
 *
 * Mid-session downtiering is intentionally NOT done — Mapbox custom
 * layers can't easily change their particle count without a full
 * teardown/reinit, which would be more jarring than the small frame-
 * rate hitch the user already feels. Next-launch tuning is the right
 * pace.
 */
import { createLogger } from '../utils/createLogger';

const log = createLogger('PerfGuardian');

const STORAGE_TIER_KEY = 'thalassa_device_tier';
const STORAGE_TOAST_KEY = 'thalassa_perf_toast_pending';

/** Down-tier when sustained FPS is below this for the full SUSTAINED
 *  window. 35 chosen as the threshold where particle motion starts to
 *  visibly stutter on iOS. */
const SUSTAINED_LOW_FPS = 35;
const SUSTAINED_LOW_FPS_MS = 8000; // 8 seconds at low FPS = real problem
const SAMPLE_WARMUP_MS = 5000; // ignore the first 5s — startup hitches

class PerfGuardianImpl {
    private fpsAvg = 60;
    private rafId: number | null = null;
    private lastFrameMs = 0;
    private sustainedLowSince = 0;
    private startedAt = 0;
    private downshifted = false;

    /** Start the watchdog. Idempotent — safe to call multiple times. */
    start(): void {
        if (this.rafId !== null) return;
        this.startedAt = performance.now();
        this.lastFrameMs = this.startedAt;
        this.fpsAvg = 60;
        this.sustainedLowSince = 0;
        this.downshifted = false;
        this.tick(performance.now());
    }

    stop(): void {
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
    }

    private tick = (now: number): void => {
        const dt = now - this.lastFrameMs;
        this.lastFrameMs = now;

        // EMA on instantaneous FPS — rejects single hitches but tracks
        // sustained problems within a few seconds.
        if (dt > 0 && dt < 1000) {
            const instantFps = 1000 / dt;
            this.fpsAvg = this.fpsAvg * 0.94 + instantFps * 0.06;
        }

        // Skip the warmup period — first-mount layer additions, tile
        // fetches, GFS GRIB decode all hit at the start and look like
        // perf problems but resolve quickly.
        const elapsed = now - this.startedAt;
        if (elapsed < SAMPLE_WARMUP_MS) {
            this.rafId = requestAnimationFrame(this.tick);
            return;
        }

        if (this.fpsAvg < SUSTAINED_LOW_FPS) {
            if (this.sustainedLowSince === 0) {
                this.sustainedLowSince = now;
            } else if (now - this.sustainedLowSince >= SUSTAINED_LOW_FPS_MS && !this.downshifted) {
                this.downshift();
                this.downshifted = true;
            }
        } else {
            // Recovered — reset the timer
            this.sustainedLowSince = 0;
        }

        this.rafId = requestAnimationFrame(this.tick);
    };

    private downshift(): void {
        try {
            const current = localStorage.getItem(STORAGE_TIER_KEY);
            // Only downshift one step. high → mid, mid → low. Already
            // low? leave it alone.
            let next: string | null = null;
            if (current === null || current === 'high') next = 'mid';
            else if (current === 'mid') next = 'low';
            if (next) {
                localStorage.setItem(STORAGE_TIER_KEY, next);
                localStorage.setItem(STORAGE_TOAST_KEY, '1');
                log.warn(
                    `[PerfGuardian] Sustained FPS ${Math.round(this.fpsAvg)} for ${SUSTAINED_LOW_FPS_MS / 1000}s — ` +
                        `downtiered ${current ?? 'high'} → ${next} (will apply next launch)`,
                );
            }
        } catch {
            /* localStorage full / unavailable */
        }
    }
}

export const PerfGuardian = new PerfGuardianImpl();

/** Call once on app boot (or chart-screen mount). Returns whether a
 *  downshift was applied since last launch — caller can show a toast
 *  if true. Toast flag is cleared atomically so we don't re-toast. */
export function consumePerfDowntierToast(): boolean {
    try {
        const v = localStorage.getItem(STORAGE_TOAST_KEY);
        if (v === '1') {
            localStorage.removeItem(STORAGE_TOAST_KEY);
            return true;
        }
    } catch {
        /* unavailable */
    }
    return false;
}
