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
import { subscribeAuthIdentityScope } from './authIdentityScope';

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
    private feedIdentity: string | null = null;
    constructor() {
        subscribeAuthIdentityScope(() => {
            this.clear();
            this.feedIdentity = null;
        });
    }
    private clear(): void {
        this.voltage = [];
        this.rpm = [];
        this.depth = [];
        this.lastSampleAt = 0;
    }

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
        this.clear();
        this.feedIdentity = null;
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
        const feed =
            state.instrumentEvidence?.identity ??
            (state.connectionStatus === 'remote' && state.remote
                ? `${state.remote.source}:${state.remote.via}:${state.remote.deviceLabel}`
                : state.connectionStatus === 'connected'
                  ? 'gateway'
                  : null);
        if (feed && feed !== this.feedIdentity) {
            this.clear();
            this.feedIdentity = feed;
        }
        this.prune(now);
        if (!feed) return;
        if (now - this.lastSampleAt < MIN_SAMPLE_INTERVAL_MS) return;
        this.lastSampleAt = now;

        for (const key of ['voltage', 'rpm', 'depth'] as const) {
            const metric = state[key],
                series = this.seriesFor(key),
                rpm = key === 'rpm' ? state.instrumentEvidence?.readings.rpm : undefined;
            // A legacy remote gauge carries receipt time. Only the direct lane
            // guarantees original gauge clocks; other remote RPM needs its
            // matching explicit source reading. Missing clocks stay gaps.
            const at =
                state.connectionStatus === 'remote' && state.remote?.via !== 'signalk'
                    ? rpm?.unit === 'rpm' && rpm.value === metric.value
                        ? rpm.at
                        : null
                    : key === 'rpm' && rpm?.unit === 'rpm' && rpm.value === metric.value
                      ? rpm.at
                      : metric.lastUpdated;
            if (
                metric.freshness !== 'live' ||
                metric.value === null ||
                !Number.isFinite(metric.value) ||
                typeof at !== 'number' ||
                !Number.isFinite(at) ||
                at <= 0 ||
                at > now + 1000 ||
                now - at > 6500 ||
                at < now - HISTORY_WINDOW_MS ||
                (series.at(-1)?.t ?? 0) >= at
            )
                continue;
            series.push({ t: at, value: metric.value });
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
