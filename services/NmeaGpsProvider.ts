/**
 * NmeaGpsProvider — Bridge that exposes NMEA GPS as a VesselPosition source.
 *
 * When the vessel is connected to an NMEA backbone (or an external GPS like
 * Bad Elf GPS Pro Plus via Wi-Fi multiplexer), this provider serves the
 * external GPS position in the same VesselPosition format used by
 * AnchorWatchService and ShipLogService.
 *
 * Usage:
 *   if (NmeaGpsProvider.isActive()) {
 *       const pos = NmeaGpsProvider.getPosition();
 *       // Use pos instead of phone GPS
 *   }
 */

import { NmeaStore, type NmeaStoreState } from './NmeaStore';
import { NMEA_LIVE_MAX_AGE_MS, NMEA_USABLE_MAX_AGE_MS } from './nmea/nmeaCadence';

// Re-use the same VesselPosition interface from AnchorWatchService
export interface NmeaGpsPosition {
    latitude: number;
    longitude: number;
    accuracy: number; // Estimated from HDOP (meters)
    heading: number | null; // COG or heading from NMEA (null when unavailable)
    speed: number; // SOG from NMEA (kts)
    timestamp: number; // Epoch ms
    source: 'nmea';
    satellites: number | null;
    hdop: number | null;
    fixQuality: number | null; // 0=invalid, 1=GPS, 2=DGPS, 4=RTK
}

export type NmeaGpsCallback = (pos: NmeaGpsPosition) => void;
export type NmeaGpsFeedStatus = 'live' | 'stale' | 'unavailable';

class NmeaGpsProviderClass {
    private listeners: Set<NmeaGpsCallback> = new Set();
    private unsub: (() => void) | null = null;
    private lastPosition: NmeaGpsPosition | null = null;
    private running = false;

    /** Start listening to NmeaStore for GPS updates */
    start(): void {
        if (this.running) return;
        this.running = true;
        this.unsub = NmeaStore.subscribe((state) => this.onStoreUpdate(state));
    }

    /** Stop listening */
    stop(): void {
        this.running = false;
        if (this.unsub) {
            this.unsub();
            this.unsub = null;
        }
        this.lastPosition = null;
    }

    /**
     * Whether the NMEA GPS feed remains usable for navigation.
     *
     * Uses the same cadence-aware budgets as NmeaStore so The Glass, receiver
     * status and navigation consumers cannot disagree about one healthy feed.
     */
    isActive(): boolean {
        return this.getFeedStatus() !== 'unavailable';
    }

    /** Freshness suitable for receiver-status UI. */
    getFeedStatus(now = Date.now()): NmeaGpsFeedStatus {
        const state = NmeaStore.getState();
        const { latitude, longitude } = state;
        if (
            // The socket, or the Pi over the boat LAN — never the cloud row.
            !NmeaStore.isBoatFeed() ||
            latitude.value === null ||
            longitude.value === null ||
            latitude.lastUpdated <= 0 ||
            longitude.lastUpdated <= 0
        ) {
            return 'unavailable';
        }

        // A position needs both coordinates. Use the older timestamp so a
        // freshly updated latitude cannot mask an old/missing longitude.
        const ageMs = Math.max(0, now - Math.min(latitude.lastUpdated, longitude.lastUpdated));
        if (ageMs <= NMEA_LIVE_MAX_AGE_MS) return 'live';
        if (ageMs <= NMEA_USABLE_MAX_AGE_MS) return 'stale';
        return 'unavailable';
    }

    /** Age of the last valid NMEA position, or null when none exists. */
    getFixAgeMs(now = Date.now()): number | null {
        const state = NmeaStore.getState();
        if (
            state.latitude.value === null ||
            state.longitude.value === null ||
            state.latitude.lastUpdated <= 0 ||
            state.longitude.lastUpdated <= 0
        ) {
            return null;
        }
        return Math.max(0, now - Math.min(state.latitude.lastUpdated, state.longitude.lastUpdated));
    }

    /** Get current position, or null if not available / stale */
    getPosition(): NmeaGpsPosition | null {
        if (!this.isActive()) return null;
        return this.lastPosition;
    }

    /** Subscribe to position updates. Returns unsubscribe function. */
    onPosition(cb: NmeaGpsCallback): () => void {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }

    /** Get GPS quality label for UI display */
    getQualityLabel(): string {
        const state = NmeaStore.getState();
        const quality = state.gpsFixQuality;
        if (quality === null) return 'GPS';
        switch (quality) {
            case 1:
                return 'GPS';
            case 2:
                return 'DGPS';
            case 4:
                return 'RTK';
            case 5:
                return 'Float RTK';
            default:
                return 'GPS';
        }
    }

    // ── Internal ──

    private onStoreUpdate(state: NmeaStoreState): void {
        const lat = state.latitude.value;
        const lon = state.longitude.value;
        if (lat === null || lon === null) return;
        if (state.latitude.lastUpdated <= 0 || state.longitude.lastUpdated <= 0) return;

        /* The write gate must match the read gate in getFeedStatus(), and until
           2026-08-30 it did not — which is why the Log page and the Instrument
           Panel could disagree about where the boat was, at the same instant,
           on the same device (Shane 2026-08-30).
           
           Two faults, both here. It tested only `latitude.freshness`, so a
           freshly updated latitude could mask an old or missing longitude —
           precisely the masking getFeedStatus() takes care to avoid by using
           the older of the two stamps. And it demanded 'live', which expires at
           NMEA_LIVE_MAX_AGE_MS (6.5 s) while the aggregate stream only
           publishes every NMEA_SAMPLE_INTERVAL_MS (5 s). That leaves 1.5 s of
           headroom: one late publish — a bridge-queue stall, a GC pause, a
           reconnect — and this returned early and stopped caching. Consumers
           reading through getPosition() (log entries via
           shiplog/PositionResolver.getBestPosition) then fell through to the
           phone GPS, while the Instrument Panel kept reading NmeaStore
           directly, which stays valid to NMEA_USABLE_MAX_AGE_MS (13 s). Same
           device, same second, two different positions — and it healed itself
           on the next good publish, which is what made it look intermittent.

           Accepting 'stale' here is strictly safer than the old behaviour, not
           looser. Refusing to cache never stopped consumers seeing an old fix:
           it froze `lastPosition` at an EARLIER one and let it age silently.
           This caches the newer fix and stamps it with the older coordinate's
           real time, so anything downstream can age it honestly. The fallback
           it displaces — a phone fix accepted up to GPS_STALE_LIMIT_MS (60 s) —
           is both older and from a different receiver. */
        const fixedAt = Math.min(state.latitude.lastUpdated, state.longitude.lastUpdated);
        if (Date.now() - fixedAt > NMEA_USABLE_MAX_AGE_MS) return;

        const hdop = state.hdop.value;
        // Estimate accuracy from HDOP: typical baseline ~5m, better receivers ~2.5m
        // DGPS/RTK get much tighter
        const baseAccuracy = state.gpsFixQuality && state.gpsFixQuality >= 2 ? 1.5 : 5;
        const accuracy = hdop !== null ? hdop * baseAccuracy : 5;

        const pos: NmeaGpsPosition = {
            latitude: lat,
            longitude: lon,
            accuracy,
            // Keep an absent COG/heading absent. Replacing it with 0 would
            // fabricate northbound turns when the next real heading arrives.
            heading: state.cog.value ?? state.heading.value,
            speed: state.sog.value ?? 0,
            timestamp: fixedAt,
            source: 'nmea',
            satellites: state.satellites.value !== null ? Math.round(state.satellites.value) : null,
            hdop,
            fixQuality: state.gpsFixQuality,
        };

        this.lastPosition = pos;
        for (const cb of this.listeners) cb(pos);
    }
}

export const NmeaGpsProvider = new NmeaGpsProviderClass();
