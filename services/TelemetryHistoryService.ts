/**
 * TelemetryHistoryService — Rolling 30-min ring buffer of NMEA metrics.
 *
 * NmeaStore only carries the current snapshot. To answer "how's the
 * battery been trending?" / "fuel burn since I left dock?" we need a
 * lightweight history. This service subscribes to NmeaStore and keeps
 * a 30-minute rolling buffer of voltage, RPM, and depth.
 *
 * Memory budget: at one sample per second × 30 min × 4 metrics × 16
 * bytes ≈ 120 KB. Negligible against the 5 MB localStorage cap and we
 * don't persist this — pure in-memory, lost on app restart (which is
 * fine; trends only matter during a session).
 *
 * Started lazily when AlertMonitorService starts or when a telemetry
 * tool is first invoked. Stopped on the same tear-down to avoid
 * subscribing forever.
 */

import { NmeaStore, type NmeaStoreState } from './NmeaStore';

interface TimestampedSample {
    t: number;
    value: number;
}

const HISTORY_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
const MIN_SAMPLE_INTERVAL_MS = 1000; // Don't sample faster than 1 Hz

class TelemetryHistoryClass {
    private voltage: TimestampedSample[] = [];
    private rpm: TimestampedSample[] = [];
    private depth: TimestampedSample[] = [];

    private unsub: (() => void) | null = null;
    private running = false;
    private lastSampleAt = 0;

    start(): void {
        if (this.running) return;
        this.running = true;
        this.unsub = NmeaStore.subscribe((state) => this.ingest(state));
        // Capture an initial sample if NmeaStore already has data.
        this.ingest(NmeaStore.getState());
    }

    stop(): void {
        if (!this.running) return;
        this.running = false;
        if (this.unsub) {
            this.unsub();
            this.unsub = null;
        }
        this.voltage = [];
        this.rpm = [];
        this.depth = [];
    }

    isRunning(): boolean {
        return this.running;
    }

    /** Snapshot of the last `windowSec` seconds for a given metric. */
    getHistory(metric: 'voltage' | 'rpm' | 'depth', windowSec: number): TimestampedSample[] {
        const cutoff = Date.now() - windowSec * 1000;
        const series = this.seriesFor(metric);
        return series.filter((s) => s.t >= cutoff);
    }

    /** Trend summary: latest value, value at start of window, delta. */
    summary(
        metric: 'voltage' | 'rpm' | 'depth',
        windowMin: number,
    ): { latest: number | null; earliest: number | null; delta: number | null; samples: number } {
        const samples = this.getHistory(metric, windowMin * 60);
        if (samples.length === 0) return { latest: null, earliest: null, delta: null, samples: 0 };
        const latest = samples[samples.length - 1].value;
        const earliest = samples[0].value;
        return { latest, earliest, delta: latest - earliest, samples: samples.length };
    }

    // ── Internals ──────────────────────────────────────────────────

    private ingest(state: NmeaStoreState): void {
        const now = Date.now();
        if (now - this.lastSampleAt < MIN_SAMPLE_INTERVAL_MS) return;
        this.lastSampleAt = now;

        if (state.voltage.freshness === 'live' && state.voltage.value !== null) {
            this.voltage.push({ t: now, value: state.voltage.value });
        }
        if (state.rpm.freshness === 'live' && state.rpm.value !== null) {
            this.rpm.push({ t: now, value: state.rpm.value });
        }
        if (state.depth.freshness === 'live' && state.depth.value !== null) {
            this.depth.push({ t: now, value: state.depth.value });
        }

        this.prune(now);
    }

    private prune(now: number): void {
        const cutoff = now - HISTORY_WINDOW_MS;
        this.voltage = this.voltage.filter((s) => s.t >= cutoff);
        this.rpm = this.rpm.filter((s) => s.t >= cutoff);
        this.depth = this.depth.filter((s) => s.t >= cutoff);
    }

    private seriesFor(metric: 'voltage' | 'rpm' | 'depth'): TimestampedSample[] {
        if (metric === 'voltage') return this.voltage;
        if (metric === 'rpm') return this.rpm;
        return this.depth;
    }
}

export const TelemetryHistoryService = new TelemetryHistoryClass();
