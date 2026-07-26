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

// The NMEA listener intentionally emits aggregated samples every 5 seconds,
// while NmeaStore's visual "live" treatment turns muted after 3 seconds.
// A GPS source must remain usable across that gap or ship-log / status logic
// will flap between vessel GPS and phone GPS on a perfectly healthy feed.
const GPS_LIVE_MAX_AGE_MS = 3_000;
const GPS_USABLE_MAX_AGE_MS = 12_000;

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
     * This is deliberately broader than NmeaStore's 3-second *visual* live
     * tier because the listener emits at a 5-second cadence. A source becomes
     * unavailable only after two missed sample windows (12 seconds).
     */
    isActive(): boolean {
        return this.getFeedStatus() !== 'unavailable';
    }

    /** Freshness suitable for receiver-status UI. */
    getFeedStatus(now = Date.now()): NmeaGpsFeedStatus {
        const state = NmeaStore.getState();
        const { latitude, longitude } = state;
        if (
            state.connectionStatus !== 'connected' ||
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
        if (ageMs <= GPS_LIVE_MAX_AGE_MS) return 'live';
        if (ageMs <= GPS_USABLE_MAX_AGE_MS) return 'stale';
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
        if (state.latitude.freshness !== 'live') return;

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
            timestamp: state.latitude.lastUpdated,
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
