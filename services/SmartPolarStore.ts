/**
 * SmartPolarStore — Local bucket grid for empirical polar data.
 * Fine-grained 2kt TWS × 5° TWA grid persisted to Capacitor Filesystem.
 * Exports to standard PolarData format for chart rendering.
 */
import type { SmartPolarBucket, SmartPolarBucketGrid, PolarData } from '../types';
import { saveLargeData, loadLargeData } from './nativeStorage';

const STORAGE_KEY = 'thalassa_smart_polars_v1';

// ── Grid configuration ──
const TWS_BUCKET_SIZE = 2;   // kts
const TWA_BUCKET_SIZE = 5;   // degrees
const TWS_MIN = 0;
const TWS_MAX = 30;
const TWA_MIN = 40;
const TWA_MAX = 180;

class SmartPolarStoreClass {
    private grid: SmartPolarBucketGrid | null = null;
    private dirty = false;
    private saveTimer: ReturnType<typeof setTimeout> | null = null;

    /** Initialize — load existing data from disk */
    async initialize(): Promise<void> {
        const data = await loadLargeData(STORAGE_KEY);
        if (data && (data as SmartPolarBucketGrid).version === 1) {
            this.grid = data as SmartPolarBucketGrid;
        } else {
            this.grid = this.createEmptyGrid();
        }
    }

    /** Record a clean sailing sample into the appropriate bucket */
    recordSample(tws: number, twa: number, stw: number): void {
        if (!this.grid) return;
        if (tws < TWS_MIN || tws >= TWS_MAX || twa < TWA_MIN || twa > TWA_MAX) return;

        const twsBucket = Math.floor(tws / TWS_BUCKET_SIZE) * TWS_BUCKET_SIZE;
        const twaBucket = Math.floor(twa / TWA_BUCKET_SIZE) * TWA_BUCKET_SIZE;
        const key = `tws_${twsBucket}_twa_${twaBucket}`;

        let bucket = this.grid.buckets[key];
        if (!bucket) {
            bucket = { sumSTW: 0, sumSTW2: 0, count: 0, minSTW: Infinity, maxSTW: 0, lastUpdated: 0 };
            this.grid.buckets[key] = bucket;
        }

        // Outlier rejection: if we have enough samples, reject >3σ outliers
        if (bucket.count >= 10) {
            const mean = bucket.sumSTW / bucket.count;
            const variance = (bucket.sumSTW2 / bucket.count) - (mean * mean);
            const stdDev = Math.sqrt(Math.max(0, variance));
            if (Math.abs(stw - mean) > 3 * stdDev) {
                return; // Reject outlier
            }
        }

        // Record sample
        bucket.sumSTW += stw;
        bucket.sumSTW2 += stw * stw;
        bucket.count++;
        bucket.minSTW = Math.min(bucket.minSTW, stw);
        bucket.maxSTW = Math.max(bucket.maxSTW, stw);
        bucket.lastUpdated = Date.now();
        this.grid.totalSamples++;

        // Schedule debounced save
        this.dirty = true;
        this.scheduleSave();
    }

    /** Export bucket grid to standard PolarData format for chart rendering */
    exportToPolarData(): PolarData | null {
        if (!this.grid) return null;

        // Standard output wind speeds and angles (match factory polar format)
        const windSpeeds = [6, 8, 10, 12, 15, 20, 25];
        const angles = [45, 60, 90, 120, 150, 180];

        const matrix = angles.map(targetAngle => {
            return windSpeeds.map(targetTws => {
                // Find closest bucket(s) and interpolate
                return this.interpolateBucket(targetTws, targetAngle);
            });
        });

        // Check if we have any data at all
        const hasData = matrix.some(row => row.some(v => v > 0));
        if (!hasData) return null;

        return { windSpeeds, angles, matrix };
    }

    /** Get statistics about the current grid */
    getStats(): { totalSamples: number; filledBuckets: number; totalBuckets: number; oldestSample: number | null; newestSample: number | null } {
        if (!this.grid) return { totalSamples: 0, filledBuckets: 0, totalBuckets: 0, oldestSample: null, newestSample: null };

        const entries = Object.values(this.grid.buckets);
        const filled = entries.filter(b => b.count > 0);
        const totalBuckets = ((TWS_MAX - TWS_MIN) / TWS_BUCKET_SIZE) * ((TWA_MAX - TWA_MIN) / TWA_BUCKET_SIZE);

        let oldest: number | null = null;
        let newest: number | null = null;
        for (const b of filled) {
            if (oldest === null || b.lastUpdated < oldest) oldest = b.lastUpdated;
            if (newest === null || b.lastUpdated > newest) newest = b.lastUpdated;
        }

        return {
            totalSamples: this.grid.totalSamples,
            filledBuckets: filled.length,
            totalBuckets,
            oldestSample: oldest,
            newestSample: newest,
        };
    }

    /** Reset all smart polar data */
    async reset(): Promise<void> {
        this.grid = this.createEmptyGrid();
        this.dirty = true;
        await this.save();
    }

    /** Get raw grid (for advanced inspection) */
    getGrid(): SmartPolarBucketGrid | null { return this.grid; }

    // ── Private ──

    /** Interpolate the average STW for a target TWS/TWA from nearby buckets */
    private interpolateBucket(targetTws: number, targetTwa: number): number {
        if (!this.grid) return 0;

        // Look at the primary bucket and its neighbors for weighted average
        const twsBucket = Math.floor(targetTws / TWS_BUCKET_SIZE) * TWS_BUCKET_SIZE;
        const twaBucket = Math.floor(targetTwa / TWA_BUCKET_SIZE) * TWA_BUCKET_SIZE;

        let totalWeight = 0;
        let weightedSum = 0;

        // Search a 3×3 neighborhood
        for (let dw = -TWS_BUCKET_SIZE; dw <= TWS_BUCKET_SIZE; dw += TWS_BUCKET_SIZE) {
            for (let da = -TWA_BUCKET_SIZE; da <= TWA_BUCKET_SIZE; da += TWA_BUCKET_SIZE) {
                const key = `tws_${twsBucket + dw}_twa_${twaBucket + da}`;
                const bucket = this.grid.buckets[key];
                if (bucket && bucket.count >= 3) { // Minimum 3 samples for reliability
                    const avg = bucket.sumSTW / bucket.count;
                    // Weight by distance (closer = heavier) and sample count
                    const dist = Math.sqrt((dw / TWS_BUCKET_SIZE) ** 2 + (da / TWA_BUCKET_SIZE) ** 2) + 0.1;
                    const weight = bucket.count / dist;
                    weightedSum += avg * weight;
                    totalWeight += weight;
                }
            }
        }

        return totalWeight > 0 ? Math.round((weightedSum / totalWeight) * 10) / 10 : 0;
    }

    private createEmptyGrid(): SmartPolarBucketGrid {
        return {
            version: 1,
            twsBucketSize: TWS_BUCKET_SIZE,
            twaBucketSize: TWA_BUCKET_SIZE,
            twsMin: TWS_MIN,
            twsMax: TWS_MAX,
            twaMin: TWA_MIN,
            twaMax: TWA_MAX,
            buckets: {},
            totalSamples: 0,
            createdAt: Date.now(),
        };
    }

    private scheduleSave() {
        if (this.saveTimer) return; // Already scheduled
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            if (this.dirty) this.save();
        }, 5000); // 5s debounce
    }

    private async save(): Promise<void> {
        if (!this.grid) return;
        this.dirty = false;
        await saveLargeData(STORAGE_KEY, this.grid);
    }
}

export const SmartPolarStore = new SmartPolarStoreClass();
