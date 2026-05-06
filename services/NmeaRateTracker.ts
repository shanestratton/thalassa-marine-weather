/**
 * NmeaRateTracker — rolling per-sentence arrival rate for diagnostic display.
 *
 * The standard NmeaStore aggregates over 5-second windows for clean UI.
 * When the user is debugging "why does my GPS keep flickering on the System
 * Status page?", the 5s aggregate hides the actual sentence-arrival pattern
 * — a GPS that's broadcasting evenly at 1 Hz looks identical in NmeaStore
 * to one that's bursting 5 sentences in 1 second then silent for 4. This
 * tracker preserves the raw arrival timestamps so the diagnostic UI can
 * show the actual data-feed health.
 *
 * Wired into NmeaListenerService.parseNmeaSentence — the tracker is called
 * with the sentence type after each successful parse. We bucket two
 * categories independently:
 *
 *   - 'gps' — position-bearing sentences (RMC, GGA, GLL) — what the user
 *     cares about when the External GPS row flaps
 *   - 'all' — every NMEA sentence — useful for distinguishing "GPS is
 *     slow" from "the whole Wi-Fi feed is dropping"
 *
 * Memory bounded: only timestamps within the rolling window (5 min default)
 * are retained. Old entries are pruned on every record() call so there's
 * no separate housekeeping timer.
 */

type RateCategory = 'gps' | 'all';
type Listener = () => void;

/** Sentence types that carry a GPS position fix. */
const GPS_POSITION_TYPES = new Set(['RMC', 'GGA', 'GLL']);

/** Window we retain timestamps for (the longest the diagnostic chart shows). */
const WINDOW_MS = 5 * 60 * 1000;

class NmeaRateTrackerClass {
    private gpsTimestamps: number[] = [];
    private allTimestamps: number[] = [];
    private listeners = new Set<Listener>();
    /** Throttle UI notifications — we don't need a re-render per sentence. */
    private lastNotifyAt = 0;
    private static readonly NOTIFY_THROTTLE_MS = 250;

    /**
     * Record arrival of a sentence. Called by NmeaListenerService for every
     * sentence it successfully parses.
     */
    record(type: string): void {
        const now = Date.now();

        // Prune old entries (binary-search would be marginal here — list
        // grows at ~10-20 entries/sec so a linear scan is fine and the
        // amortised cost is tiny).
        const cutoff = now - WINDOW_MS;
        while (this.allTimestamps.length > 0 && this.allTimestamps[0] < cutoff) {
            this.allTimestamps.shift();
        }
        while (this.gpsTimestamps.length > 0 && this.gpsTimestamps[0] < cutoff) {
            this.gpsTimestamps.shift();
        }

        this.allTimestamps.push(now);
        if (GPS_POSITION_TYPES.has(type)) {
            this.gpsTimestamps.push(now);
        }

        // Throttled notify so UI re-renders at ~4 Hz max
        if (now - this.lastNotifyAt >= NmeaRateTrackerClass.NOTIFY_THROTTLE_MS) {
            this.lastNotifyAt = now;
            this.listeners.forEach((cb) => cb());
        }
    }

    /**
     * Bucket the recorded timestamps for a sparkline. Returns an array of
     * sentence counts where index 0 is the oldest bucket and the last
     * index is the most recent (right-now-ish) bucket.
     *
     * Example: getBuckets('gps', 10_000, 30) → 30 buckets × 10 seconds each
     * = 5 minutes total, each bucket showing how many GPS sentences
     * arrived in that 10-second window.
     */
    getBuckets(category: RateCategory, bucketMs: number, bucketCount: number): number[] {
        const now = Date.now();
        const totalSpan = bucketMs * bucketCount;
        const startTime = now - totalSpan;
        const source = category === 'gps' ? this.gpsTimestamps : this.allTimestamps;

        const buckets = new Array<number>(bucketCount).fill(0);
        for (const ts of source) {
            if (ts < startTime) continue;
            const offset = ts - startTime;
            const idx = Math.min(bucketCount - 1, Math.floor(offset / bucketMs));
            buckets[idx]++;
        }
        return buckets;
    }

    /**
     * Get the average sentences-per-second rate over the last `windowSec`
     * seconds. Returns 0 if no sentences in window. Used for the headline
     * "current rate" readout next to the sparkline.
     */
    getRate(category: RateCategory, windowSec: number = 60): number {
        const now = Date.now();
        const cutoff = now - windowSec * 1000;
        const source = category === 'gps' ? this.gpsTimestamps : this.allTimestamps;
        let count = 0;
        for (let i = source.length - 1; i >= 0; i--) {
            if (source[i] < cutoff) break;
            count++;
        }
        return count / windowSec;
    }

    /** Get the timestamp of the last recorded sentence in this category. */
    getLastTimestamp(category: RateCategory): number | null {
        const source = category === 'gps' ? this.gpsTimestamps : this.allTimestamps;
        return source.length > 0 ? source[source.length - 1] : null;
    }

    /**
     * Subscribe to record() events (throttled to ~4 Hz). UI components use
     * this to re-render the sparkline as new data arrives.
     */
    subscribe(cb: Listener): () => void {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }

    /** Reset all tracked data — used by tests and by a manual UI clear button. */
    reset(): void {
        this.gpsTimestamps = [];
        this.allTimestamps = [];
        this.lastNotifyAt = 0;
        this.listeners.forEach((cb) => cb());
    }
}

export const NmeaRateTracker = new NmeaRateTrackerClass();
