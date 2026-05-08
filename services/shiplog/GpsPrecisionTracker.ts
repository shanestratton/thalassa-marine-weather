/**
 * GpsPrecisionTracker — Adaptive Precision GPS Detection
 * ────────────────────────────────────────────────────────
 * Detects when a high-accuracy external GPS (e.g. Bad Elf GPS Pro+)
 * is connected by monitoring the rolling average of horizontalAccuracy.
 *
 * External GPS units typically report 1-3m accuracy vs phone GPS at 5-15m.
 * When precision mode is detected, downstream systems tighten their thresholds:
 *
 *   - Track thinning: halved RDP epsilon → more detail in curves
 *   - Course change detection: halved MIN_MOVEMENT_M → finer manoeuvres captured
 *   - Anchor watch: can reliably alarm at 5m vs 15m with phone GPS
 *
 * No user configuration needed — just connect the device and it adapts.
 *
 * Usage:
 *   import { GpsPrecision } from './GpsPrecisionTracker';
 *   GpsPrecision.feed(pos.accuracy);
 *   if (GpsPrecision.isPrecision()) { ... }
 */

import { createLogger } from '../../utils/createLogger';

const log = createLogger('GpsPrecisionTracker');
export type GpsQuality = 'precision' | 'standard' | 'degraded';

// ── Constants ───────────────────────────────────────────────────

/** Rolling window size — 10 samples for faster detection */
const ROLLING_WINDOW = 10;

/**
 * Threshold: rolling average accuracy must be tighter than this to count
 * as "precision".
 *
 * Tightened from 6.0m → 3.0m on 2026-05-08 because modern iPhones
 * (iPhone 12+ with dual-band L1+L5 GPS) routinely hit 4-6m horizontal
 * accuracy outdoors under clear sky. Users without any external GPS
 * connected were getting the External GPS row in System Status falsely
 * lit. The original 6.0m threshold dated from when phone GPS was
 * reliably 8-15m — that assumption no longer holds.
 *
 * Reference: Bad Elf GPS Pro+ → 2.5m typical (datasheet), 1-3m in
 * practice. Bad Elf XGNSS w/ SBAS → 0.5-2m. Ship's NMEA GPS → typically
 * 1-5m depending on antenna mount. Modern iPhone → 3-15m, with a long
 * tail of occasional sub-3m fixes that the variance check below
 * filters out.
 */
const PRECISION_THRESHOLD_M = 3.0;

/** Threshold: if rolling average accuracy > this, GPS is degraded */
const DEGRADED_THRESHOLD_M = 20.0;

/**
 * Stability gate — Bad Elf and NMEA GPS sources are characteristically
 * STABLE: accuracy values change slowly and stay within a narrow band.
 * iPhone GPS jitters a lot frame-to-frame even when the average is
 * good (a single fix can be 4m, the next 11m, the next 6m). Requiring
 * the rolling-window range (max - min) to be ≤ this value separates
 * "consistently precise external receiver" from "iPhone got a good
 * sample run by luck".
 */
const PRECISION_STABILITY_RANGE_M = 2.0;

/**
 * Asymmetric hysteresis — easy to enter precision, sticky to leave.
 * Prevents flicker when GPS is borderline.
 *
 *   Enter precision: 8 consecutive readings (~40s) — bumped from 3
 *     because the previous count let a single string of good iPhone
 *     fixes flip the state. 8 samples × ~5s GPS cadence is enough
 *     to be confident an actual external receiver is connected, not
 *     just a temporary good sky view.
 *   Leave precision: 5 consecutive readings — unchanged. Once we've
 *     committed to "precision", let it stick through transient
 *     accuracy degradations (e.g. boat moving through a marina).
 */
const HYSTERESIS_ENTER = 8;
const HYSTERESIS_LEAVE = 5;

// ── Service ─────────────────────────────────────────────────────

class GpsPrecisionTrackerClass {
    private samples: { accuracy: number; timestamp: number }[] = [];
    private currentQuality: GpsQuality = 'standard';
    private pendingQuality: GpsQuality | null = null;
    private confirmationCount = 0;
    private lastFeedTime = 0;
    private listeners = new Set<(quality: GpsQuality, avgAccuracy: number) => void>();

    /** Max age for a sample before it's purged from the window (30s) */
    private static readonly SAMPLE_MAX_AGE_MS = 30_000;

    /** If no samples received within this time, reset to standard (30s) */
    private static readonly STALENESS_TIMEOUT_MS = 30_000;

    /**
     * Feed a new accuracy sample (horizontalAccuracy in meters).
     * Called on every GPS fix from BgGeoManager.subscribeLocation.
     */
    feed(accuracyMeters: number): void {
        if (accuracyMeters <= 0 || !isFinite(accuracyMeters)) return;

        const now = Date.now();
        this.lastFeedTime = now;

        // Purge stale samples (older than 30s)
        this.samples = this.samples.filter((s) => now - s.timestamp < GpsPrecisionTrackerClass.SAMPLE_MAX_AGE_MS);

        // Push to rolling window
        this.samples.push({ accuracy: accuracyMeters, timestamp: now });
        if (this.samples.length > ROLLING_WINDOW) {
            this.samples.shift();
        }

        // Need minimum samples before evaluating. Bumped from 3 to 5
        // alongside the threshold tightening — gives the variance check
        // (used by classifyQuality below) a meaningful sample to work
        // with. 5 samples × ~5s cadence ≈ 25s to first classification.
        if (this.samples.length < 5) return;

        const avg = this.getAverageAccuracy();
        const range = this.getAccuracyRange();
        const detected = this.classifyQuality(avg, range);

        // Asymmetric hysteresis: faster to enter precision, slower to leave
        if (detected !== this.currentQuality) {
            if (detected === this.pendingQuality) {
                this.confirmationCount++;
                // Use lower threshold to ENTER precision, higher to LEAVE
                const threshold =
                    detected === 'precision'
                        ? HYSTERESIS_ENTER // Easy to detect
                        : this.currentQuality === 'precision'
                          ? HYSTERESIS_LEAVE // Sticky — don't drop easily
                          : HYSTERESIS_ENTER; // Other transitions are fast
                if (this.confirmationCount >= threshold) {
                    this.currentQuality = detected;
                    this.pendingQuality = null;
                    this.confirmationCount = 0;
                    this.notifyListeners(avg);
                }
            } else {
                this.pendingQuality = detected;
                this.confirmationCount = 1;
            }
        } else {
            // Matches current — reset pending
            this.pendingQuality = null;
            this.confirmationCount = 0;
        }
    }

    /**
     * Check for staleness — call periodically (e.g. every 1s from UI poll).
     * If no fresh samples have been received in 30 seconds, the external GPS
     * is assumed disconnected and quality resets to 'standard'.
     */
    checkStaleness(): void {
        if (this.currentQuality !== 'standard' && this.lastFeedTime > 0) {
            const elapsed = Date.now() - this.lastFeedTime;
            if (elapsed > GpsPrecisionTrackerClass.STALENESS_TIMEOUT_MS) {
                this.reset();
            }
        }
    }

    /** Current GPS quality classification */
    getQuality(): GpsQuality {
        return this.currentQuality;
    }

    /** Is a precision GPS (e.g. Bad Elf) detected? */
    isPrecision(): boolean {
        return this.currentQuality === 'precision';
    }

    /** Current rolling average accuracy in meters */
    getAverageAccuracy(): number {
        if (this.samples.length === 0) return 999;
        return this.samples.reduce((a, b) => a + b.accuracy, 0) / this.samples.length;
    }

    /** Range (max - min) of the rolling window. Cheap stand-in for
     *  variance — a tight range means the receiver is consistent; a
     *  wide range means it's bouncing around like a phone GPS does. */
    getAccuracyRange(): number {
        if (this.samples.length < 2) return 999;
        let min = Infinity;
        let max = -Infinity;
        for (const s of this.samples) {
            if (s.accuracy < min) min = s.accuracy;
            if (s.accuracy > max) max = s.accuracy;
        }
        return max - min;
    }

    /**
     * Get adapted thresholds based on current GPS quality.
     * Downstream systems use these instead of hardcoded constants.
     */
    getAdaptedThresholds() {
        const q = this.currentQuality;
        return {
            /** Minimum movement for course change detection (meters) */
            courseChangeMinMovementM: q === 'precision' ? 5 : q === 'standard' ? 10 : 20,

            /** RDP epsilon multiplier — applied to speed-adaptive epsilon */
            trackThinningMultiplier: q === 'precision' ? 0.5 : q === 'standard' ? 1.0 : 1.5,

            /** Minimum useful anchor watch alarm radius (meters) */
            minAnchorAlarmRadiusM: q === 'precision' ? 5 : q === 'standard' ? 15 : 30,

            /** GPS jitter filter window size — fewer samples needed with precision */
            jitterFilterWindow: q === 'precision' ? 3 : q === 'standard' ? 5 : 7,

            /** Quality label for UI display */
            qualityLabel: q === 'precision' ? 'Precision GPS' : q === 'standard' ? 'Standard GPS' : 'Degraded GPS',

            /** Quality color for UI */
            qualityColor: q === 'precision' ? '#34d399' : q === 'standard' ? '#38bdf8' : '#f59e0b',
        };
    }

    /** Subscribe to quality changes */
    onQualityChange(cb: (quality: GpsQuality, avgAccuracy: number) => void): () => void {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }

    /** Reset (e.g. when tracking stops or staleness detected) */
    reset(): void {
        this.samples = [];
        this.currentQuality = 'standard';
        this.pendingQuality = null;
        this.confirmationCount = 0;
        this.lastFeedTime = 0;
    }

    // ── Private ─────────────────────────────────────────────────

    /**
     * Two-gate classification: BOTH the average AND the variance must
     * indicate an external receiver. iPhone GPS can hit good accuracy
     * occasionally but never STABLE accuracy — its values swing around
     * frame-to-frame even when the mean is low. Bad Elf and NMEA GPS
     * sources are characteristically tight and consistent.
     *
     *   precision  →  avg ≤ 3m   AND  range ≤ 2m
     *   degraded   →  avg ≥ 20m
     *   standard   →  everything else (including iPhone with good fix
     *                 but high jitter, which previously fooled this)
     */
    private classifyQuality(avgAccuracy: number, accuracyRange: number): GpsQuality {
        if (avgAccuracy <= PRECISION_THRESHOLD_M && accuracyRange <= PRECISION_STABILITY_RANGE_M) {
            return 'precision';
        }
        if (avgAccuracy >= DEGRADED_THRESHOLD_M) return 'degraded';
        return 'standard';
    }

    private notifyListeners(avgAccuracy: number): void {
        this.listeners.forEach((cb) => {
            try {
                cb(this.currentQuality, avgAccuracy);
            } catch (e) {
                log.warn('[GpsPrecisionTracker] isolated:', e);
            }
        });
    }
}

// ── Singleton Export ─────────────────────────────────────────────

export const GpsPrecision = new GpsPrecisionTrackerClass();
