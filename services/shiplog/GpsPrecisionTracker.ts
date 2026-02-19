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

/** Rolling window size — 20 samples at ~1Hz = ~20 seconds of data */
const ROLLING_WINDOW = 20;

/** Threshold: if rolling average accuracy < this, precision GPS detected */
const PRECISION_THRESHOLD_M = 3.0;

/** Threshold: if rolling average accuracy > this, GPS is degraded */
const DEGRADED_THRESHOLD_M = 20.0;

/**
 * Hysteresis: require N consecutive readings in a zone before switching.
 * Prevents flickering when GPS accuracy is borderline.
 */
const HYSTERESIS_COUNT = 5;

// ── Service ─────────────────────────────────────────────────────

class GpsPrecisionTrackerClass {
    private samples: number[] = [];
    private currentQuality: GpsQuality = 'standard';
    private pendingQuality: GpsQuality | null = null;
    private confirmationCount = 0;
    private listeners = new Set<(quality: GpsQuality, avgAccuracy: number) => void>();

    /**
     * Feed a new accuracy sample (horizontalAccuracy in meters).
     * Called on every GPS fix from BgGeoManager.subscribeLocation.
     */
    feed(accuracyMeters: number): void {
        if (accuracyMeters <= 0 || !isFinite(accuracyMeters)) return;

        // Push to rolling window
        this.samples.push(accuracyMeters);
        if (this.samples.length > ROLLING_WINDOW) {
            this.samples.shift();
        }

        // Need minimum samples before evaluating
        if (this.samples.length < 5) return;

        const avg = this.getAverageAccuracy();
        const detected = this.classifyQuality(avg);

        // Hysteresis: only switch after HYSTERESIS_COUNT consecutive same detections
        if (detected !== this.currentQuality) {
            if (detected === this.pendingQuality) {
                this.confirmationCount++;
                if (this.confirmationCount >= HYSTERESIS_COUNT) {
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
        return this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
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

    /** Reset (e.g. when tracking stops) */
    reset(): void {
        this.samples = [];
        this.currentQuality = 'standard';
        this.pendingQuality = null;
        this.confirmationCount = 0;
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
