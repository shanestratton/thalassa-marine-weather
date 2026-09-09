/**
 * NmeaStore — Timestamped NMEA instrument state with stale-data watchdog.
 *
 * Every metric carries a `lastUpdated` epoch timestamp.
 * A 1-second watchdog ticker classifies each metric into three tiers:
 *   Tier 1: LIVE     (0-6.5s)  → Bright, high-contrast
 *   Tier 2: STALE    (6.5-13s) → Muted, 50% opacity
 *   Tier 3: DEAD     (>13s)    → Replace with dashes, red warning
 *
 * Subscribers receive the full store snapshot on every tick or data update.
 */
import type { NmeaDepthReference, NmeaDepthSource, NmeaSample } from '../types';
import { NmeaListenerService, type NmeaConnectionStatus } from './NmeaListenerService';
import { NmeaGpsProvider } from './NmeaGpsProvider';
import { AisStore } from './AisStore';
import { AisHubService } from './AisHubService';
import { NMEA_LIVE_MAX_AGE_MS, NMEA_USABLE_MAX_AGE_MS } from './nmea/nmeaCadence';
import { subscribeAuthIdentityScope } from './authIdentityScope';
import {
    freshWindHistorySummary,
    isWindSpeed,
    validateWindHistorySummary,
    WindHistoryBuffer,
    WIND_HISTORY_WINDOW_MS,
    type WindHistoryPeak,
    type WindHistorySummary,
} from '../utils/windHistory';
export { NMEA_LIVE_MAX_AGE_MS, NMEA_USABLE_MAX_AGE_MS } from './nmea/nmeaCadence';

// ── Freshness tiers ──
export type DataFreshness = 'live' | 'stale' | 'dead';

/** Listener publishes one aggregate every 5 seconds. The live budget includes
 * scheduler/network jitter; dead requires more than two missed windows. */
const WATCHDOG_INTERVAL_MS = 1000; // 1 second tick

/** Helm window: 45s of 5s samples — inside the handover's 30-60s band. */
const HELM_WINDOW_MS = 45_000;
const HELM_WINDOW_MIN_SAMPLES = 6;

// ── Timestamped metric ──
export interface TimestampedMetric<T = number> {
    value: T | null;
    lastUpdated: number; // Epoch ms
    freshness: DataFreshness;
}

export function getNmeaFreshness(lastUpdated: number, now: number = Date.now()): DataFreshness {
    if (!Number.isFinite(lastUpdated) || lastUpdated <= 0 || lastUpdated > now + 1000) return 'dead';
    const age = now - lastUpdated;
    if (age <= NMEA_LIVE_MAX_AGE_MS) return 'live';
    if (age <= NMEA_USABLE_MAX_AGE_MS) return 'stale';
    return 'dead';
}

/**
 * Reconcile one metric with the watchdog clock. Dead readings are retired,
 * not merely tagged, so a consumer cannot accidentally render or act on a
 * >two-sample-window-old numeric value while the socket remains connected.
 */
export function reconcileNmeaMetricFreshness(metric: TimestampedMetric, now: number = Date.now()): boolean {
    if (metric.lastUpdated === 0) return false;
    const freshness = getNmeaFreshness(metric.lastUpdated, now);
    const shouldClear = freshness === 'dead' && metric.value !== null;
    if (freshness === metric.freshness && !shouldClear) return false;
    metric.freshness = freshness;
    if (shouldClear) metric.value = null;
    return true;
}

// ── Full store state ──
export interface NmeaStoreState {
    // Navigation
    tws: TimestampedMetric; // True Wind Speed (kts)
    twa: TimestampedMetric; // True Wind Angle off the bow, 0-180 magnitude (°)
    twaSigned: TimestampedMetric; // Same angle, signed, negative to port (°)
    heel: TimestampedMetric; // Heel from XDR Roll (°), positive = starboard
    pitch: TimestampedMetric; // Pitch from XDR (°), positive = bow up
    twd: TimestampedMetric; // True Wind Direction — compass bearing (°T)
    aws: TimestampedMetric; // Apparent Wind Speed (kts)
    awa: TimestampedMetric; // Apparent Wind Angle, signed, negative to port (°)
    stw: TimestampedMetric; // Speed Through Water (kts)
    heading: TimestampedMetric; // Heading (°)
    depth: TimestampedMetric; // Referenced depth (m); see depthReference
    depthSource: NmeaDepthSource | null;
    depthReference: NmeaDepthReference | null;
    depthOffsetM: number | null;
    sog: TimestampedMetric; // Speed Over Ground (kts)
    cog: TimestampedMetric; // Course Over Ground (°)
    waterTemp: TimestampedMetric; // Water Temperature (°C)

    // Steering
    rudder: TimestampedMetric; // Rudder angle (°, + = helm to starboard), from $xxRSA

    // Engine / Systems
    rpm: TimestampedMetric; // Engine RPM
    voltage: TimestampedMetric; // Battery voltage (V)

    // GPS Position (from external NMEA receiver / chartplotter)
    latitude: TimestampedMetric; // Decimal degrees
    longitude: TimestampedMetric; // Decimal degrees
    hdop: TimestampedMetric; // Horizontal dilution (lower = better)
    satellites: TimestampedMetric; // Satellites in use
    gpsFixQuality: number | null; // GGA fix quality (1=GPS, 2=DGPS, 4=RTK)

    // Connection. 'remote' = no gateway socket; the numbers are the boat's
    // own, read from the cloud row the Pi keeps (services/CloudTelemetryService).
    connectionStatus: NmeaConnectionStatus | 'remote';
    remote: RemoteFeed | null;
    lastAnyUpdate: number; // Epoch ms — last time ANY metric was updated
}

/** How a remote feed reached this phone: the Pi over the boat LAN, or the Pi's cloud row. */
export type RemoteVia = 'lan' | 'cloud';

/**
 * While a LAN snapshot has arrived this recently, the cloud may not overwrite
 * it: same numbers, seconds fresher, and no internet in the loop.
 */
export const LAN_REMOTE_HOLD_MS = 15_000;

/** Who is feeding the store without a socket, by which lane, and how old the reading is. */
export interface RemoteFeed {
    source: 'pi' | 'device';
    via: RemoteVia;
    deviceLabel: string | null;
    /** Epoch ms of the instrument reading, as the Pi reported it. */
    reportedAt: number;
    /** Epoch ms when this phone read it. */
    receivedAt: number;
}

/** One cloud snapshot, in the units the store keeps (knots, degrees, metres, °C). */
export interface RemoteInstrumentSnapshot {
    source: 'pi' | 'device';
    /** Which lane it came down; absent means the cloud row. */
    via?: RemoteVia;
    deviceLabel: string | null;
    reportedAt: number;
    lat: number | null;
    lon: number | null;
    sogKts: number | null;
    cogDeg: number | null;
    headingDeg: number | null;
    stwKts: number | null;
    twsKts: number | null;
    /** Signed, negative to port. */
    twaDeg: number | null;
    twdDeg: number | null;
    awsKts: number | null;
    /** Signed, negative to port. */
    awaDeg: number | null;
    depthM: number | null;
    heelDeg: number | null;
    pitchDeg: number | null;
    waterTempC: number | null;
    rudderDeg: number | null;
    rpm: number | null;
    voltageV: number | null;
    /** Original wind-leaf sample time, never a row/GPS/receipt timestamp. */
    windSampleAt?: number;
    /** Physical source of that exact wind leaf, independent of the summary's sampling cycle. */
    windSampleSource?: string;
    /** Stable Pi/boat identity shared by its LAN and cloud lanes. */
    windHistoryIdentity?: string;
    /** Authoritative rolling history collected aboard, including while this app was closed. */
    windHistory?: WindHistorySummary;
}

export type NmeaStoreListener = (state: NmeaStoreState) => void;

class NmeaStoreClass {
    private state: NmeaStoreState = this.createEmptyState();
    private helmRing: Array<{ t: number; mean: number; swing: number }> = [];
    private listeners: Set<NmeaStoreListener> = new Set();
    private watchdogTimer: ReturnType<typeof setInterval> | null = null;
    private unsubSample: (() => void) | null = null;
    private unsubStatus: (() => void) | null = null;
    private running = false;
    private windHistory = new WindHistoryBuffer();
    private windHistoryIdentity: string | null = null;
    private windHistorySource = 'Gateway wind samples';
    private remoteWindHistory: WindHistorySummary | null = null;
    private remoteWindSensor: string | null = null;
    private remoteWindSensorAt = 0;

    constructor() {
        // A singleton survives account changes. Previous crews' history must not.
        subscribeAuthIdentityScope(() => {
            this.clearWindHistory();
            this.notify();
        });
    }

    // ── Public API ──

    /** Start the store — subscribes to NmeaListenerService and starts the watchdog */
    start(): void {
        if (this.running) return;
        this.running = true;

        // Subscribe to raw NMEA data
        this.unsubSample = NmeaListenerService.onSample((sample) => this.ingestSample(sample));
        this.unsubStatus = NmeaListenerService.onStatusChange((status) => {
            if (status !== 'connected' && this.state.remote) {
                // The socket is down but the cloud is feeding us: stay remote.
                this.state.connectionStatus = 'remote';
                this.notify();
                return;
            }
            this.state.connectionStatus = status;
            if (status === 'connected') this.state.remote = null; // the boat itself wins
            if (status !== 'connected') this.retireAllMetrics();
            this.notify();
        });
        this.state.connectionStatus = NmeaListenerService.getStatus();

        // Start 1-second watchdog
        this.watchdogTimer = setInterval(() => this.tick(), WATCHDOG_INTERVAL_MS);

        // Start GPS provider so it can bridge NMEA GPS to other services
        NmeaGpsProvider.start();

        // Start AIS vessel tracking store
        AisStore.start();

        // Initialize the fail-closed AISHub boundary. It retires any remembered
        // legacy opt-in and never opens an outbound UDP transport in this beta.
        AisHubService.init();
    }

    /** Stop the store */
    stop(): void {
        this.running = false;
        this.clearWindHistory();
        // Reset connection status and notify UI before unsubscribing
        this.state.connectionStatus = 'disconnected';
        this.retireAllMetrics();
        this.notify();
        if (this.unsubSample) {
            this.unsubSample();
            this.unsubSample = null;
        }
        if (this.unsubStatus) {
            this.unsubStatus();
            this.unsubStatus = null;
        }
        if (this.watchdogTimer) {
            clearInterval(this.watchdogTimer);
            this.watchdogTimer = null;
        }
        NmeaGpsProvider.stop();
        AisStore.stop();
        AisHubService.destroy();
    }

    /** Get current snapshot */
    getState(): NmeaStoreState {
        return this.state;
    }

    /** Page-independent, source-timestamped rolling peaks; null means no observed history. */
    getWindHistory(now: number = Date.now()): WindHistorySummary | null {
        const authoritative = freshWindHistorySummary(this.remoteWindHistory, now);
        const known = this.windHistory.summary(this.windHistorySource, now);
        if (authoritative) {
            const newer = this.windHistory.summary(this.windHistorySource, now, authoritative.latestAt);
            const strongest = (pi: WindHistoryPeak | null, observed: WindHistoryPeak | null): WindHistoryPeak | null =>
                observed && (!pi || observed.kts > pi.kts || (observed.kts === pi.kts && observed.at > pi.at))
                    ? observed
                    : pi;
            const max1h = strongest(authoritative.max1h, known?.max1h ?? null);
            const gust10m = strongest(authoritative.gust10m, known?.gust10m ?? null);
            if (!newer && max1h === authoritative.max1h && gust10m === authoritative.gust10m) return authoritative;
            const asOf = Math.max(authoritative.asOf, newer?.latestAt ?? 0);
            return {
                ...authoritative,
                asOf,
                latestAt: Math.max(authoritative.latestAt, newer?.latestAt ?? 0),
                since: Math.max(
                    Math.min(authoritative.since, known?.since ?? authoritative.since),
                    asOf - WIND_HISTORY_WINDOW_MS,
                ),
                // Between Pi summaries we know these observations, but cannot
                // recalculate the Pi's full count without its complete ring.
                sampleCount: known?.sampleCount ?? authoritative.sampleCount,
                // An app sample can catch a peak between Pi sampling ticks.
                // Later Pi summaries must not erase that observed same-sensor
                // peak just because their latest sample is newer than it.
                max1h,
                gust10m,
            };
        }
        if (!known) return null;
        // Partial evidence after a dropout is not a newly received Pi summary.
        return { ...known, asOf: Math.max(this.remoteWindHistory?.asOf ?? 0, known.latestAt) };
    }

    /** Subscribe to state changes. Returns unsubscribe function. */
    subscribe(cb: NmeaStoreListener): () => void {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }

    /**
     * Feed the store from the cloud snapshot. Refused while a gateway socket is
     * connected — the boat's own bus always wins — and never touches the
     * socket's own status machine otherwise. Every metric is stamped with the
     * time this phone read it, so the watchdog ages a feed that stops arriving.
     */
    ingestRemote(snapshot: RemoteInstrumentSnapshot): boolean {
        if (NmeaListenerService.getStatus() === 'connected' || this.state.connectionStatus === 'connected')
            return false;
        const now = Date.now();
        const via: RemoteVia = snapshot.via ?? 'cloud';
        // The Pi over the boat LAN outranks its own cloud row (Shane
        // 2026-09-07: phones read the Pi; the socket only when there is no Pi).
        if (
            via === 'cloud' &&
            this.state.remote?.via === 'lan' &&
            now - this.state.remote.receivedAt <= LAN_REMOTE_HOLD_MS
        )
            return false;
        this.ingestRemoteWind(snapshot, now);
        const put = (metric: TimestampedMetric, value: number | null) => {
            if (value !== null && Number.isFinite(value)) this.updateMetric(metric, value, now);
        };
        put(this.state.tws, snapshot.twsKts);
        put(this.state.twa, snapshot.twaDeg === null ? null : Math.abs(snapshot.twaDeg));
        put(this.state.twaSigned, snapshot.twaDeg);
        put(this.state.heel, snapshot.heelDeg);
        put(this.state.pitch, snapshot.pitchDeg);
        put(this.state.twd, snapshot.twdDeg);
        put(this.state.aws, snapshot.awsKts);
        put(this.state.awa, snapshot.awaDeg);
        put(this.state.stw, snapshot.stwKts);
        put(this.state.heading, snapshot.headingDeg);
        put(this.state.depth, snapshot.depthM);
        put(this.state.sog, snapshot.sogKts);
        put(this.state.cog, snapshot.cogDeg);
        put(this.state.waterTemp, snapshot.waterTempC);
        put(this.state.rudder, snapshot.rudderDeg);
        put(this.state.rpm, snapshot.rpm);
        put(this.state.voltage, snapshot.voltageV);
        put(this.state.latitude, snapshot.lat);
        put(this.state.longitude, snapshot.lon);
        this.state.remote = {
            source: snapshot.source,
            via,
            deviceLabel: snapshot.deviceLabel,
            reportedAt: snapshot.reportedAt,
            receivedAt: now,
        };
        this.state.connectionStatus = 'remote';
        this.state.lastAnyUpdate = now;
        this.notify();
        return true;
    }

    /**
     * A remote feed has stopped or gone stale: back to whatever the socket says.
     * A lane names itself so it clears only its own feed — the cloud poller
     * going stale must not empty gauges the LAN is still filling, and vice
     * versa. No lane given clears whatever is there.
     */
    clearRemote(via?: RemoteVia): void {
        if (!this.state.remote && this.state.connectionStatus !== 'remote') return;
        if (via && this.state.remote && this.state.remote.via !== via) return;
        this.state.remote = null;
        this.retireAllMetrics();
        this.state.connectionStatus = NmeaListenerService.getStatus();
        this.notify();
    }

    /**
     * Is the store fed by a receiver ON THE BOAT — the gateway socket, or the
     * Pi over the boat LAN? Both are the boat's own GPS at bus latency and may
     * steer Anchor Watch and the Ship's Log. The Pi's cloud row is not: it is
     * the boat seen from a distance, up to a minute old, read by a phone that
     * may be a hundred miles from her.
     */
    isBoatFeed(): boolean {
        if (this.state.connectionStatus === 'connected') return true;
        return this.state.connectionStatus === 'remote' && this.state.remote?.via === 'lan';
    }

    /** Whether the boat's GPS has a live fix (lat/lon updated within the live budget) */
    hasGpsFix(): boolean {
        // The Pi over the boat LAN is a receiver on the boat; the Pi's cloud
        // row is not — the GPS chain has its own rungs for the distance.
        if (!this.isBoatFeed()) return false;
        return (
            this.state.latitude.freshness === 'live' &&
            this.state.longitude.freshness === 'live' &&
            this.state.latitude.value !== null &&
            this.state.longitude.value !== null
        );
    }

    /** Get freshness tier for a given timestamp */
    static getFreshness(lastUpdated: number): DataFreshness {
        return getNmeaFreshness(lastUpdated);
    }

    // ── Internals ──

    /** Ingest an NmeaSample from the listener */
    private ingestSample(sample: NmeaSample): void {
        const now = sample.timestamp;
        const config = NmeaListenerService.getSavedConfig?.();
        this.selectWindHistorySource(
            `gateway:${config?.host ?? 'default'}:${config?.port ?? ''}`,
            'Gateway wind samples',
        );
        this.windHistory.add(sample.tws, sample.timestamp);
        this.state.lastAnyUpdate = now;

        if (sample.tws !== null) this.updateMetric(this.state.tws, sample.tws, now);
        if (sample.twa !== null) this.updateMetric(this.state.twa, sample.twa, now);
        // Optional on the sample for backward compatibility with saved/test
        // fixtures written before the wind rose existed.
        if (sample.twaSigned != null) this.updateMetric(this.state.twaSigned, sample.twaSigned, now);
        if (sample.heel != null) this.updateMetric(this.state.heel, sample.heel, now);
        if (sample.pitch != null) this.updateMetric(this.state.pitch, sample.pitch, now);
        if (sample.twd != null) this.updateMetric(this.state.twd, sample.twd, now);
        if (sample.aws != null) this.updateMetric(this.state.aws, sample.aws, now);
        if (sample.awa != null) this.updateMetric(this.state.awa, sample.awa, now);
        if (sample.stw !== null) this.updateMetric(this.state.stw, sample.stw, now);
        if (sample.heading !== null) this.updateMetric(this.state.heading, sample.heading, now);
        if (sample.rpm !== null) this.updateMetric(this.state.rpm, sample.rpm, now);
        if (sample.rudder !== null) {
            this.updateMetric(this.state.rudder, sample.rudder, now);
            // 60s helm window ring — the serene helm-balance advice requires
            // a 30-60s MEAN (instantaneous rudder makes it flicker with
            // every wave) and ACTIVITY (which averaging destroys, so the 5s
            // swings ride along separately).
            this.helmRing.push({ t: now, mean: sample.rudder, swing: sample.rudderSwing ?? 0 });
            while (this.helmRing.length > 0 && now - this.helmRing[0].t > HELM_WINDOW_MS) this.helmRing.shift();
        }
        if (sample.voltage !== null) this.updateMetric(this.state.voltage, sample.voltage, now);
        if (sample.depth !== null && Number.isFinite(sample.depth)) {
            this.updateMetric(this.state.depth, sample.depth, now);
            this.state.depthSource = sample.depthSource ?? null;
            this.state.depthReference = sample.depthReference ?? 'below-transducer';
            this.state.depthOffsetM = sample.depthOffsetM ?? null;
        }
        if (sample.sog !== null) this.updateMetric(this.state.sog, sample.sog, now);
        if (sample.cog !== null) this.updateMetric(this.state.cog, sample.cog, now);
        if (sample.waterTemp !== null) this.updateMetric(this.state.waterTemp, sample.waterTemp, now);

        // GPS position
        if (sample.latitude !== null) this.updateMetric(this.state.latitude, sample.latitude, now);
        if (sample.longitude !== null) this.updateMetric(this.state.longitude, sample.longitude, now);
        if (sample.hdop !== null) this.updateMetric(this.state.hdop, sample.hdop, now);
        if (sample.satellites !== null) this.updateMetric(this.state.satellites, sample.satellites, now);
        if (sample.gpsFixQuality !== null) this.state.gpsFixQuality = sample.gpsFixQuality;

        this.notify();
    }

    private clearWindHistory(): void {
        this.windHistory.clear();
        this.windHistoryIdentity = null;
        this.remoteWindHistory = null;
        this.remoteWindSensor = null;
        this.remoteWindSensorAt = 0;
    }

    private selectWindHistorySource(identity: string, source: string): void {
        if (identity !== this.windHistoryIdentity) {
            this.clearWindHistory();
            this.windHistoryIdentity = identity;
        }
        this.windHistorySource = source;
    }

    private ingestRemoteWind(snapshot: RemoteInstrumentSnapshot, now: number): void {
        const identity = snapshot.windHistoryIdentity?.trim() || snapshot.deviceLabel?.trim() || 'unidentified';
        this.selectWindHistorySource(
            `${snapshot.source}:${identity}`,
            snapshot.source === 'pi' ? 'Pi wind samples' : 'Device wind samples',
        );
        let summary =
            snapshot.source === 'pi' && snapshot.windHistory
                ? validateWindHistorySummary(snapshot.windHistory, now)
                : null;
        const sampleSource =
            typeof snapshot.windSampleSource === 'string' &&
            snapshot.windSampleSource.length <= 120 &&
            !/\p{Cc}/u.test(snapshot.windSampleSource)
                ? snapshot.windSampleSource.trim() || undefined
                : undefined;
        // The leaf may already be from a new sensor while the five-second
        // summary still describes the old one. Never merge their histories.
        if (sampleSource && summary && sampleSource !== summary.source) summary = null;
        const sensor = sampleSource || summary?.source;
        const at = snapshot.windSampleAt;
        const sourceMaxAge = snapshot.via === 'lan' ? 20_000 : 60_000;
        const validSampleAt =
            sampleSource &&
            typeof at === 'number' &&
            Number.isFinite(at) &&
            at > 0 &&
            at <= now + 1_000 &&
            now - at <= sourceMaxAge &&
            isWindSpeed(snapshot.twsKts)
                ? at
                : 0;
        const sensorAt = Math.max(validSampleAt, summary?.latestAt ?? 0);
        if (sensor && this.remoteWindSensor && this.remoteWindSensor !== sensor) {
            // LAN can see a replacement sensor before the cloud publisher's
            // next cycle. A delayed old-sensor row must not revive its peaks,
            // even when its HTTP/report/summary timestamp is freshly stamped.
            if (sensorAt <= this.remoteWindSensorAt) return;
            this.windHistory.clear();
            this.remoteWindHistory = null;
            this.remoteWindSensorAt = 0;
        }
        if (sensor && sensorAt > 0) {
            this.remoteWindSensor = sensor;
            this.remoteWindSensorAt = Math.max(this.remoteWindSensorAt, sensorAt);
        }
        if (summary) {
            // An older/repeated cloud answer must not replace newer source-time history.
            if (!this.remoteWindHistory || summary.asOf > this.remoteWindHistory.asOf) {
                this.remoteWindHistory = summary;
                // Preserve only actual known peaks, never the unobserved count
                // from the Pi. Their individual windows keep aging on dropout.
                this.windHistory.addKnownPeak(summary.max1h, now);
                this.windHistory.addKnownPeak(summary.gust10m, now);
            }
        }
        // reportedAt describes the whole row: fresh GPS can coexist with stale
        // wind. Only an explicit original wind-leaf timestamp proves a sample.
        if (validSampleAt) this.windHistory.add(snapshot.twsKts, validSampleAt, now);
    }

    /**
     * The 30-60s helm window the serene helm-balance advice requires.
     * Null until at least HELM_WINDOW_MIN_SAMPLES 5s samples sit inside the
     * window, or when the rudder metric has gone dead — a stale mean is
     * worse than no verdict.
     */
    helmWindow(): { mean: number; max: number; activity: number } | null {
        if (this.state.rudder.freshness === 'dead') return null;
        const now = Date.now();
        const window = this.helmRing.filter((entry) => now - entry.t <= HELM_WINDOW_MS);
        if (window.length < HELM_WINDOW_MIN_SAMPLES) return null;
        const mean = window.reduce((sum, entry) => sum + entry.mean, 0) / window.length;
        const max = Math.max(...window.map((entry) => Math.abs(entry.mean)));
        const activity = window.reduce((sum, entry) => sum + entry.swing, 0) / window.length;
        return { mean, max, activity };
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
            this.state.tws,
            this.state.twa,
            this.state.twaSigned,
            this.state.heel,
            this.state.pitch,
            this.state.twd,
            this.state.aws,
            this.state.awa,
            this.state.stw,
            this.state.heading,
            this.state.depth,
            this.state.sog,
            this.state.cog,
            this.state.waterTemp,
            this.state.rudder,
            this.state.rpm,
            this.state.voltage,
            this.state.latitude,
            this.state.longitude,
            this.state.hdop,
            this.state.satellites,
        ];

        for (const m of metrics) changed = reconcileNmeaMetricFreshness(m) || changed;

        if (this.state.depth.value === null && this.state.depthReference !== null) {
            this.clearDepthMetadata();
            changed = true;
        }
        if (
            (this.state.latitude.value === null || this.state.longitude.value === null) &&
            this.state.gpsFixQuality !== null
        ) {
            this.state.gpsFixQuality = null;
            changed = true;
        }

        if (changed) this.notify();
    }

    private notify(): void {
        // React state setters bail out on Object.is equality. The store mutates
        // metric objects in place, so publish a new root snapshot on every
        // notification or freshness/data changes never repaint the panel.
        const snapshot = { ...this.state };
        for (const cb of this.listeners) cb(snapshot);
    }

    private retireAllMetrics(): void {
        const metrics: TimestampedMetric[] = [
            this.state.tws,
            this.state.twa,
            this.state.twaSigned,
            this.state.heel,
            this.state.pitch,
            this.state.twd,
            this.state.aws,
            this.state.awa,
            this.state.stw,
            this.state.heading,
            this.state.depth,
            this.state.sog,
            this.state.cog,
            this.state.waterTemp,
            this.state.rpm,
            this.state.voltage,
            this.state.latitude,
            this.state.longitude,
            this.state.hdop,
            this.state.satellites,
        ];
        for (const metric of metrics) {
            metric.value = null;
            metric.lastUpdated = 0;
            metric.freshness = 'dead';
        }
        this.state.gpsFixQuality = null;
        this.clearDepthMetadata();
    }

    private clearDepthMetadata(): void {
        this.state.depthSource = null;
        this.state.depthReference = null;
        this.state.depthOffsetM = null;
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
            twaSigned: emptyMetric(),
            heel: emptyMetric(),
            pitch: emptyMetric(),
            twd: emptyMetric(),
            aws: emptyMetric(),
            awa: emptyMetric(),
            stw: emptyMetric(),
            heading: emptyMetric(),
            depth: emptyMetric(),
            depthSource: null,
            depthReference: null,
            depthOffsetM: null,
            sog: emptyMetric(),
            cog: emptyMetric(),
            waterTemp: emptyMetric(),
            rudder: emptyMetric(),
            rpm: emptyMetric(),
            voltage: emptyMetric(),
            latitude: emptyMetric(),
            longitude: emptyMetric(),
            hdop: emptyMetric(),
            satellites: emptyMetric(),
            gpsFixQuality: null,
            connectionStatus: 'disconnected',
            remote: null,
            lastAnyUpdate: 0,
        };
    }
}

export const NmeaStore = new NmeaStoreClass();
