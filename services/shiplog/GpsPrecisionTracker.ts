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

export type GpsQuality = 'precision' | 'standard' | 'degraded';

// ── Constants ───────────────────────────────────────────────────

/** Rolling window size — 10 samples for faster detection */
const ROLLING_WINDOW = 10;

/**
 * Threshold: if rolling average accuracy < this, precision GPS detected.
 * Bad Elf GPS Pro+ typically reports 1-3m, but can hit 4-5m in
 * urban canyons or under tree cover. Phone GPS is usually 5-15m.
 * 5m cleanly separates external GPS from phone GPS.
 */
const PRECISION_THRESHOLD_M = 5.0;

/** Threshold: if rolling average accuracy > this, GPS is degraded */
const DEGRADED_THRESHOLD_M = 20.0;

/**
 * Asymmetric hysteresis — easy to enter precision, sticky to leave.
 * This prevents the badge from flickering when GPS is borderline.
 *   Enter precision: 3 consecutive readings (fast detection ~15s)
 *   Leave precision: 5 consecutive readings (doesn't drop on one bad sample)
 */
const HYSTERESIS_ENTER = 3;
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
        this.samples = this.samples.filter(
            s => (now - s.timestamp) < GpsPrecisionTrackerClass.SAMPLE_MAX_AGE_MS
        );

        // Push to rolling window
        this.samples.push({ accuracy: accuracyMeters, timestamp: now });
        if (this.samples.length > ROLLING_WINDOW) {
            this.samples.shift();
        }

        // Need minimum samples before evaluating
        if (this.samples.length < 3) return;

        const avg = this.getAverageAccuracy();
        const detected = this.classifyQuality(avg);

        // Asymmetric hysteresis: faster to enter precision, slower to leave
        if (detected !== this.currentQuality) {
            if (detected === this.pendingQuality) {
                this.confirmationCount++;
                // Use lower threshold to ENTER precision, higher to LEAVE
                const threshold = (detected === 'precision')
                    ? HYSTERESIS_ENTER   // Easy to detect
                    : (this.currentQuality === 'precision')
                        ? HYSTERESIS_LEAVE  // Sticky — don't drop easily
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

    private classifyQuality(avgAccuracy: number): GpsQuality {
        if (avgAccuracy <= PRECISION_THRESHOLD_M) return 'precision';
        if (avgAccuracy >= DEGRADED_THRESHOLD_M) return 'degraded';
        return 'standard';
    }

    private notifyListeners(avgAccuracy: number): void {
        this.listeners.forEach(cb => {
            try { cb(this.currentQuality, avgAccuracy); } catch { /* isolated */ }
        });
    }
}

// ── Singleton Export ─────────────────────────────────────────────

export const GpsPrecision = new GpsPrecisionTrackerClass();
