/**
 * NmeaStore — Timestamped NMEA instrument state with stale-data watchdog.
 *
 * Every metric carries a `lastUpdated` epoch timestamp.
 * A 1-second watchdog ticker classifies each metric into three tiers:
 *   Tier 1: LIVE     (0-3s)   → Bright, high-contrast
 *   Tier 2: STALE    (3-10s)  → Muted, 50% opacity
 *   Tier 3: DEAD     (>10s)   → Replace with dashes, red warning
 *
 * Subscribers receive the full store snapshot on every tick or data update.
 */
import type { NmeaSample } from '../types';
import { NmeaListenerService, type NmeaConnectionStatus } from './NmeaListenerService';

// ── Freshness tiers ──
export type DataFreshness = 'live' | 'stale' | 'dead';

const STALE_THRESHOLD_MS = 3000;   // 3 seconds
const DEAD_THRESHOLD_MS = 10000;   // 10 seconds
const WATCHDOG_INTERVAL_MS = 1000; // 1 second tick

// ── Timestamped metric ──
export interface TimestampedMetric<T = number> {
    value: T | null;
    lastUpdated: number; // Epoch ms
    freshness: DataFreshness;
}

// ── Full store state ──
export interface NmeaStoreState {
    // Navigation
    tws: TimestampedMetric;         // True Wind Speed (kts)
    twa: TimestampedMetric;         // True Wind Angle (°)
    stw: TimestampedMetric;         // Speed Through Water (kts)
    heading: TimestampedMetric;     // Heading (°)
    depth: TimestampedMetric;       // Depth Below Transducer (m)
    sog: TimestampedMetric;         // Speed Over Ground (kts)
    cog: TimestampedMetric;         // Course Over Ground (°)
    waterTemp: TimestampedMetric;   // Water Temperature (°C)

    // Engine / Systems
    rpm: TimestampedMetric;         // Engine RPM
    voltage: TimestampedMetric;     // Battery voltage (V)

    // Connection
    connectionStatus: NmeaConnectionStatus;
    lastAnyUpdate: number;          // Epoch ms — last time ANY metric was updated
}

export type NmeaStoreListener = (state: NmeaStoreState) => void;

class NmeaStoreClass {
    private state: NmeaStoreState = this.createEmptyState();
    private listeners: Set<NmeaStoreListener> = new Set();
    private watchdogTimer: ReturnType<typeof setInterval> | null = null;
    private unsubSample: (() => void) | null = null;
    private unsubStatus: (() => void) | null = null;
    private running = false;

    // ── Public API ──

    /** Start the store — subscribes to NmeaListenerService and starts the watchdog */
    start(): void {
        if (this.running) return;
        this.running = true;

        // Subscribe to raw NMEA data
        this.unsubSample = NmeaListenerService.onSample(sample => this.ingestSample(sample));
        this.unsubStatus = NmeaListenerService.onStatusChange(status => {
            this.state.connectionStatus = status;
            this.notify();
        });
        this.state.connectionStatus = NmeaListenerService.getStatus();

        // Start 1-second watchdog
        this.watchdogTimer = setInterval(() => this.tick(), WATCHDOG_INTERVAL_MS);
    }

    /** Stop the store */
    stop(): void {
        this.running = false;
        if (this.unsubSample) { this.unsubSample(); this.unsubSample = null; }
        if (this.unsubStatus) { this.unsubStatus(); this.unsubStatus = null; }
        if (this.watchdogTimer) { clearInterval(this.watchdogTimer); this.watchdogTimer = null; }
    }

    /** Get current snapshot */
    getState(): NmeaStoreState { return this.state; }

    /** Subscribe to state changes. Returns unsubscribe function. */
    subscribe(cb: NmeaStoreListener): () => void {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }

    /** Get freshness tier for a given timestamp */
    static getFreshness(lastUpdated: number): DataFreshness {
        const age = Date.now() - lastUpdated;
        if (age <= STALE_THRESHOLD_MS) return 'live';
        if (age <= DEAD_THRESHOLD_MS) return 'stale';
        return 'dead';
    }

    // ── Internals ──

    /** Ingest an NmeaSample from the listener */
    private ingestSample(sample: NmeaSample): void {
        const now = sample.timestamp;
        this.state.lastAnyUpdate = now;

        if (sample.tws !== null) this.updateMetric(this.state.tws, sample.tws, now);
        if (sample.twa !== null) this.updateMetric(this.state.twa, sample.twa, now);
        if (sample.stw !== null) this.updateMetric(this.state.stw, sample.stw, now);
        if (sample.heading !== null) this.updateMetric(this.state.heading, sample.heading, now);
        if (sample.rpm !== null) this.updateMetric(this.state.rpm, sample.rpm, now);
        if (sample.voltage !== null) this.updateMetric(this.state.voltage, sample.voltage, now);
        if (sample.depth !== null) this.updateMetric(this.state.depth, sample.depth, now);
        if (sample.sog !== null) this.updateMetric(this.state.sog, sample.sog, now);
        if (sample.cog !== null) this.updateMetric(this.state.cog, sample.cog, now);
        if (sample.waterTemp !== null) this.updateMetric(this.state.waterTemp, sample.waterTemp, now);

        this.notify();
    }

    /** Update a single metric */
    private updateMetric(metric: TimestampedMetric, value: number, timestamp: number): void {
        metric.value = value;
        metric.lastUpdated = timestamp;
        metric.freshness = 'live';
    }

    /** Watchdog tick — re-evaluate all metric freshness tiers */
    private tick(): void {
        let changed = false;

        const metrics: TimestampedMetric[] = [
            this.state.tws, this.state.twa, this.state.stw, this.state.heading,
            this.state.depth, this.state.sog, this.state.cog, this.state.waterTemp,
            this.state.rpm, this.state.voltage,
        ];

        for (const m of metrics) {
            if (m.lastUpdated === 0) continue; // Never received
            const newFreshness = NmeaStoreClass.getFreshness(m.lastUpdated);
            if (newFreshness !== m.freshness) {
                m.freshness = newFreshness;
                changed = true;
            }
        }

        if (changed) this.notify();
    }

    private notify(): void {
        for (const cb of this.listeners) cb(this.state);
    }

    private createEmptyState(): NmeaStoreState {
        const emptyMetric = (): TimestampedMetric => ({
            value: null,
            lastUpdated: 0,
            freshness: 'dead',
        });

        return {
            tws: emptyMetric(),
            twa: emptyMetric(),
            stw: emptyMetric(),
            heading: emptyMetric(),
            depth: emptyMetric(),
            sog: emptyMetric(),
            cog: emptyMetric(),
            waterTemp: emptyMetric(),
            rpm: emptyMetric(),
            voltage: emptyMetric(),
            connectionStatus: 'disconnected',
            lastAnyUpdate: 0,
        };
    }
}

export const NmeaStore = new NmeaStoreClass();
