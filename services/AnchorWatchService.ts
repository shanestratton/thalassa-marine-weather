/**
 * AnchorWatchService — Core anchor watch engine (Premium)
 * 
 * Handles:
 * - Anchor position management
 * - Swing radius calculation from rode length + depth + scope
 * - GPS monitoring with jitter filtering (moving average)
 * - Drag detection via hardware geofencing (EXIT event)
 * - Position history for track visualization
 * - Alarm state management with haptic + audio feedback
 * - Screen wake-lock via @capacitor-community/keep-awake
 * 
 * Architecture:
 * - Uses @transistorsoft/capacitor-background-geolocation for bulletproof
 *   background GPS and native hardware geofencing
 * - Geofence EXIT event on the swing circle triggers drag alarm
 *   even when app is terminated or screen is locked
 * - KeepAwake prevents screen sleep during active foreground monitoring
 * - Emits events via callback pattern for UI reactivity
 */

import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { KeepAwake } from '@capacitor-community/keep-awake';
import { BgGeoManager } from './BgGeoManager';
import { AnchorWatchSyncService } from './AnchorWatchSyncService';
import { createLogger } from '../utils/logger';

const log = createLogger('AnchorWatch');

// ------- TYPES -------

export interface AnchorPosition {
    latitude: number;
    longitude: number;
    timestamp: number;
}

export interface VesselPosition {
    latitude: number;
    longitude: number;
    accuracy: number;
    heading: number;
    speed: number;
    timestamp: number;
}

export interface AnchorWatchConfig {
    /** Rode deployed in meters */
    rodeLength: number;
    /** Water depth in meters */
    waterDepth: number;
    /** Scope ratio (typically 5:1 to 7:1) */
    scopeRatio: number;
    /** Rode type affects catenary calculation */
    rodeType: 'chain' | 'rope' | 'mixed';
    /** Extra safety margin in meters added to swing radius */
    safetyMargin: number;
}

export type AnchorWatchState = 'idle' | 'setting' | 'watching' | 'alarm' | 'paused';

export interface AnchorWatchSnapshot {
    state: AnchorWatchState;
    anchorPosition: AnchorPosition | null;
    vesselPosition: VesselPosition | null;
    swingRadius: number;
    distanceFromAnchor: number;
    maxDistanceRecorded: number;
    bearingToAnchor: number;
    config: AnchorWatchConfig;
    positionHistory: VesselPosition[];
    alarmTriggeredAt: number | null;
    watchStartedAt: number | null;
    gpsAccuracy: number;
}

export type AnchorWatchListener = (snapshot: AnchorWatchSnapshot) => void;

// ------- CONSTANTS -------

const TRANSISTOR_LICENSE_KEY = import.meta.env.VITE_TRANSISTOR_LICENSE_KEY || '';
const GPS_INTERVAL_MS = 3000;       // High-frequency GPS when watching
const HISTORY_MAX_POINTS = 500;     // Max position trail points
const JITTER_WINDOW = 5;            // Moving average window size
const ALARM_CONFIRM_COUNT = 3;      // # consecutive readings outside circle before alarm
const MIN_GPS_ACCURACY = 50;        // Ignore readings worse than 50m accuracy
const GEOFENCE_ID = 'anchor-swing-radius';
const ANCHOR_WATCH_KEY = 'thalassa_anchor_watch_state';

/** Minimal state persisted for crash recovery */
interface PersistedWatchState {
    anchorPosition: AnchorPosition;
    config: AnchorWatchConfig;
    state: AnchorWatchState;
    watchStartedAt: number;
    savedAt: number;
}

// ------- HELPERS -------

/** Haversine distance in meters between two lat/lng points */
function haversineDistance(
    lat1: number, lon1: number,
    lat2: number, lon2: number
): number {
    const R = 6371000; // Earth radius in meters
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
        Math.cos(φ1) * Math.cos(φ2) *
        Math.sin(Δλ / 2) * Math.sin(Δλ / 2);

    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Bearing from point 1 to point 2 in degrees (0-360) */
function bearing(
    lat1: number, lon1: number,
    lat2: number, lon2: number
): number {
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) -
        Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);

    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/**
 * Calculate swing radius from rode config.
 * Chain catenary sag reduces horizontal distance vs rope.
 */
function calculateSwingRadius(config: AnchorWatchConfig): number {
    const { rodeLength, waterDepth, rodeType, safetyMargin } = config;

    if (rodeLength <= waterDepth) return safetyMargin; // No horizontal room

    // Horizontal distance from anchor to vessel
    let horizontalDistance: number;

    if (rodeType === 'chain') {
        // Chain catenary: horizontal reach is less than straight-line
        // Simplified catenary approximation: ~85% of hypotenuse horizontal projection
        horizontalDistance = Math.sqrt(rodeLength * rodeLength - waterDepth * waterDepth) * 0.85;
    } else if (rodeType === 'rope') {
        // Rope with no weight: nearly straight line
        horizontalDistance = Math.sqrt(rodeLength * rodeLength - waterDepth * waterDepth) * 0.95;
    } else {
        // Mixed: between chain and rope
        horizontalDistance = Math.sqrt(rodeLength * rodeLength - waterDepth * waterDepth) * 0.90;
    }

    return horizontalDistance + safetyMargin;
}

// ------- SERVICE -------

class AnchorWatchServiceClass {
    private state: AnchorWatchState = 'idle';
    private anchorPosition: AnchorPosition | null = null;
    private vesselPosition: VesselPosition | null = null;
    private config: AnchorWatchConfig = {
        rodeLength: 30,
        waterDepth: 5,
        scopeRatio: 5,
        rodeType: 'chain',
        safetyMargin: 10,
    };
    private swingRadius = 0;
    private distanceFromAnchor = 0;
    private maxDistanceRecorded = 0;
    private bearingToAnchor = 0;
    private positionHistory: VesselPosition[] = [];
    private alarmTriggeredAt: number | null = null;
    private watchStartedAt: number | null = null;

    // GPS jitter filter buffer
    private jitterBuffer: { lat: number; lon: number }[] = [];
    private outsideCircleCount = 0;

    // GPS tracking
    private gpsAccuracy = 0;
    private bgUnsubscribers: (() => void)[] = [];

    // Listeners
    private listeners: Set<AnchorWatchListener> = new Set();

    // Alarm audio
    private alarmInterval: ReturnType<typeof setInterval> | null = null;

    // ---- PUBLIC API ----

    /** Subscribe to state updates */
    subscribe(listener: AnchorWatchListener): () => void {
        this.listeners.add(listener);
        // Immediately push current state
        listener(this.getSnapshot());
        return () => this.listeners.delete(listener);
    }

    /** Get current state snapshot */
    getSnapshot(): AnchorWatchSnapshot {
        return {
            state: this.state,
            anchorPosition: this.anchorPosition,
            vesselPosition: this.vesselPosition,
            swingRadius: this.swingRadius,
            distanceFromAnchor: this.distanceFromAnchor,
            maxDistanceRecorded: this.maxDistanceRecorded,
            bearingToAnchor: this.bearingToAnchor,
            config: { ...this.config },
            positionHistory: [...this.positionHistory],
            alarmTriggeredAt: this.alarmTriggeredAt,
            watchStartedAt: this.watchStartedAt,
            gpsAccuracy: this.gpsAccuracy,
        };
    }

    /** Set anchor at current GPS position */
    async setAnchor(config?: Partial<AnchorWatchConfig>): Promise<boolean> {
        if (config) {
            this.config = { ...this.config, ...config };
        }

        this.state = 'setting';
        this.notify();

        try {
            // Ensure BackgroundGeolocation is ready (shared manager)
            await BgGeoManager.ensureReady();

            // Get current position via BgGeoManager (fresh, not cached — high accuracy for anchor set)
            const pos = await BgGeoManager.getFreshPosition(5_000, 15);
            if (!pos) throw new Error('Could not acquire GPS position for anchor');

            this.anchorPosition = {
                latitude: pos.latitude,
                longitude: pos.longitude,
                timestamp: pos.timestamp,
            };

            this.swingRadius = calculateSwingRadius(this.config);
            this.positionHistory = [];
            this.maxDistanceRecorded = 0;
            this.outsideCircleCount = 0;
            this.jitterBuffer = [];
            this.alarmTriggeredAt = null;
            this.watchStartedAt = Date.now();
            this.state = 'watching';

            // Persist state for crash recovery
            this.persistWatchState();

            // Keep screen awake during anchor watch
            try { await KeepAwake.keepAwake(); } catch { /* Web fallback */ }

            // Start GPS monitoring + geofence
            await this.startGpsMonitoring();

            this.notify();
            return true;
        } catch (error) {
            this.state = 'idle';
            this.notify();
            return false;
        }
    }

    /** Set anchor at a specific position (e.g., from map tap) */
    async setAnchorAt(lat: number, lon: number, config?: Partial<AnchorWatchConfig>): Promise<boolean> {
        if (config) {
            this.config = { ...this.config, ...config };
        }

        this.anchorPosition = {
            latitude: lat,
            longitude: lon,
            timestamp: Date.now(),
        };

        this.swingRadius = calculateSwingRadius(this.config);
        this.positionHistory = [];
        this.maxDistanceRecorded = 0;
        this.outsideCircleCount = 0;
        this.jitterBuffer = [];
        this.alarmTriggeredAt = null;
        this.watchStartedAt = Date.now();
        this.state = 'watching';

        // Persist state for crash recovery
        this.persistWatchState();

        // Keep screen awake during anchor watch
        try { await KeepAwake.keepAwake(); } catch { /* Web fallback */ }

        await BgGeoManager.ensureReady();
        await this.startGpsMonitoring();

        this.notify();
        return true;
    }

    /** Update rode/depth config while watching */
    updateConfig(config: Partial<AnchorWatchConfig>): void {
        this.config = { ...this.config, ...config };
        this.swingRadius = calculateSwingRadius(this.config);

        // Update the geofence with new swing radius
        if (this.state === 'watching' && this.anchorPosition) {
            this.updateGeofence();
            // Persist updated config
            this.persistWatchState();
        }

        this.notify();
    }

    /** Stop watching and return to idle */
    async stopWatch(): Promise<void> {
        await this.stopGpsMonitoring();
        this.stopAlarm();

        // Allow screen to sleep again
        try { await KeepAwake.allowSleep(); } catch { /* Web fallback */ }

        this.state = 'idle';
        this.anchorPosition = null;
        this.positionHistory = [];
        this.alarmTriggeredAt = null;
        this.watchStartedAt = null;
        this.maxDistanceRecorded = 0;
        this.distanceFromAnchor = 0;
        this.outsideCircleCount = 0;
        this.jitterBuffer = [];

        // Clear persisted state — user explicitly stopped
        this.clearPersistedWatchState();

        this.notify();
    }

    /** Acknowledge alarm (silence it but keep watching) */
    acknowledgeAlarm(): void {
        this.stopAlarm();
        this.outsideCircleCount = 0;
        this.state = 'watching';
        this.notify();
    }

    /** Get the current GPS position once (for UI display before anchoring) */
    async getCurrentPosition(): Promise<VesselPosition | null> {
        try {
            await BgGeoManager.ensureReady();
            const pos = await BgGeoManager.getFreshPosition(10_000, 10);
            if (!pos) return null;
            return {
                latitude: pos.latitude,
                longitude: pos.longitude,
                accuracy: pos.accuracy,
                heading: pos.heading,
                speed: pos.speed,
                timestamp: pos.timestamp,
            };
        } catch {
            /* GPS timeout or hardware failure — return null to indicate no fix */
            return null;
        }
    }

    /**
     * Restore anchor watch state after app restart/crash.
     * Re-establishes GPS monitoring and geofencing.
     * Returns true if a watch session was restored.
     */
    async restoreWatchState(): Promise<boolean> {
        try {
            const raw = localStorage.getItem(ANCHOR_WATCH_KEY);
            if (!raw) return false;

            const persisted: PersistedWatchState = JSON.parse(raw);

            // Validate
            if (!persisted.anchorPosition || !persisted.config) {
                this.clearPersistedWatchState();
                return false;
            }

            // Sessions older than 24 hours are stale
            const ageMs = Date.now() - (persisted.savedAt || 0);
            if (ageMs > 24 * 60 * 60 * 1000) {
                this.clearPersistedWatchState();
                return false;
            }

            // Restore state
            this.anchorPosition = persisted.anchorPosition;
            this.config = persisted.config;
            this.swingRadius = calculateSwingRadius(this.config);
            this.watchStartedAt = persisted.watchStartedAt;
            this.state = 'watching';
            this.positionHistory = [];
            this.maxDistanceRecorded = 0;
            this.outsideCircleCount = 0;
            this.jitterBuffer = [];
            this.alarmTriggeredAt = null;

            // Re-establish GPS monitoring and geofence
            try { await KeepAwake.keepAwake(); } catch { /* Web fallback */ }
            await BgGeoManager.ensureReady();
            await this.startGpsMonitoring();

            this.notify();
            return true;
        } catch {
            /* Corrupted persisted data — clear and start fresh */
            this.clearPersistedWatchState();
            return false;
        }
    }

    // ---- PRIVATE ----

    /** Persist current watch state for crash recovery */
    private persistWatchState(): void {
        if (!this.anchorPosition || this.state === 'idle') return;
        try {
            const data: PersistedWatchState = {
                anchorPosition: this.anchorPosition,
                config: { ...this.config },
                state: this.state,
                watchStartedAt: this.watchStartedAt || Date.now(),
                savedAt: Date.now(),
            };
            localStorage.setItem(ANCHOR_WATCH_KEY, JSON.stringify(data));
        } catch {
            // Non-critical
        }
    }

    /** Clear persisted watch state */
    private clearPersistedWatchState(): void {
        try {
            localStorage.removeItem(ANCHOR_WATCH_KEY);
        } catch {
            // Non-critical
        }
    }

    /** Ensure BackgroundGeolocation is ready via shared manager */
    private async ensureBgGeoReady(): Promise<void> {
        await BgGeoManager.ensureReady();
    }

    /** Start GPS monitoring with BgGeoManager + set up geofence */
    private async startGpsMonitoring(): Promise<void> {
        try {
            // Remove any leftover subscriptions
            this.cleanupSubscriptions();

            // Subscribe to location updates via shared manager
            const unsubLoc = BgGeoManager.subscribeLocation((pos) => {
                this.handleGpsUpdate({
                    latitude: pos.latitude,
                    longitude: pos.longitude,
                    accuracy: pos.accuracy,
                    heading: pos.heading,
                    speed: pos.speed,
                    timestamp: pos.timestamp,
                });
            });
            this.bgUnsubscribers.push(unsubLoc);

            // Subscribe to geofence events via shared manager
            const unsubGeo = BgGeoManager.subscribeGeofence((event) => {
                if (event.identifier === GEOFENCE_ID && event.action === 'EXIT') {
                    // Vessel has exited the swing circle! Trigger alarm.
                    this.triggerAlarm();
                }
            });
            this.bgUnsubscribers.push(unsubGeo);

            // Add the swing-circle geofence
            await this.updateGeofence();

            // Start tracking (ref-counted)
            await BgGeoManager.requestStart();

        } catch (error) {
            log.warn('startGpsMonitoring: failed to start GPS', error);
        }
    }

    /** Create or update the swing-circle geofence */
    private async updateGeofence(): Promise<void> {
        if (!this.anchorPosition) return;

        // Remove existing geofence first
        await BgGeoManager.removeGeofence(GEOFENCE_ID);

        // Add new geofence centered on anchor with swing radius
        const radius = Math.max(this.swingRadius, 20); // Min 20m to avoid GPS noise triggers

        await BgGeoManager.addGeofence({
            identifier: GEOFENCE_ID,
            latitude: this.anchorPosition.latitude,
            longitude: this.anchorPosition.longitude,
            radius: radius,
            notifyOnEntry: true,
            notifyOnExit: true,
            notifyOnDwell: false,
        });

    }

    /** Stop GPS monitoring and clean up */
    private async stopGpsMonitoring(): Promise<void> {
        try {
            this.cleanupSubscriptions();
            await BgGeoManager.removeGeofence(GEOFENCE_ID);
            await BgGeoManager.requestStop();
        } catch (error) {
            log.warn('stopGpsMonitoring: cleanup failed', error);
        }
    }

    /** Remove all event subscriptions */
    private cleanupSubscriptions(): void {
        this.bgUnsubscribers.forEach(unsub => {
            try { unsub(); } catch { /* already cleaned */ }
        });
        this.bgUnsubscribers = [];
    }

    private handleGpsUpdate(position: VesselPosition): void {
        // Filter poor accuracy readings
        if (position.accuracy > MIN_GPS_ACCURACY) return;

        this.gpsAccuracy = position.accuracy;

        // Apply jitter filter (moving average)
        this.jitterBuffer.push({ lat: position.latitude, lon: position.longitude });
        if (this.jitterBuffer.length > JITTER_WINDOW) {
            this.jitterBuffer.shift();
        }

        // Use filtered position
        const filtered = this.getFilteredPosition();
        const filteredPosition: VesselPosition = {
            ...position,
            latitude: filtered.lat,
            longitude: filtered.lon,
        };

        this.vesselPosition = filteredPosition;

        // Add to history (throttled — every 3rd reading or if moved > 2m)
        const lastHistoryPoint = this.positionHistory[this.positionHistory.length - 1];
        const shouldRecord = !lastHistoryPoint ||
            (position.timestamp - lastHistoryPoint.timestamp > GPS_INTERVAL_MS) ||
            haversineDistance(filtered.lat, filtered.lon, lastHistoryPoint.latitude, lastHistoryPoint.longitude) > 2;

        if (shouldRecord) {
            this.positionHistory.push(filteredPosition);
            if (this.positionHistory.length > HISTORY_MAX_POINTS) {
                this.positionHistory.shift();
            }
        }

        // Calculate distance from anchor
        if (this.anchorPosition) {
            this.distanceFromAnchor = haversineDistance(
                filtered.lat, filtered.lon,
                this.anchorPosition.latitude, this.anchorPosition.longitude
            );
            this.bearingToAnchor = bearing(
                filtered.lat, filtered.lon,
                this.anchorPosition.latitude, this.anchorPosition.longitude
            );
            this.maxDistanceRecorded = Math.max(this.maxDistanceRecorded, this.distanceFromAnchor);

            // Software-level drag detection (double-check alongside hardware geofence)
            this.checkForDrag();
        }

        this.notify();
    }

    private getFilteredPosition(): { lat: number; lon: number } {
        if (this.jitterBuffer.length === 0) return { lat: 0, lon: 0 };
        if (this.jitterBuffer.length === 1) return this.jitterBuffer[0];

        // Moving average
        const sum = this.jitterBuffer.reduce(
            (acc, p) => ({ lat: acc.lat + p.lat, lon: acc.lon + p.lon }),
            { lat: 0, lon: 0 }
        );
        return {
            lat: sum.lat / this.jitterBuffer.length,
            lon: sum.lon / this.jitterBuffer.length,
        };
    }

    private checkForDrag(): void {
        if (this.state !== 'watching') return;

        const isOutside = this.distanceFromAnchor > this.swingRadius;

        if (isOutside) {
            this.outsideCircleCount++;
            if (this.outsideCircleCount >= ALARM_CONFIRM_COUNT) {
                this.triggerAlarm();
            }
        } else {
            // Reset counter if back inside
            this.outsideCircleCount = Math.max(0, this.outsideCircleCount - 1);
        }
    }

    private async triggerAlarm(): Promise<void> {
        if (this.state === 'alarm') return; // Already alarming

        this.state = 'alarm';
        this.alarmTriggeredAt = Date.now();

        // Haptic burst
        try {
            await Haptics.impact({ style: ImpactStyle.Heavy });
            // Triple vibrate
            setTimeout(() => Haptics.impact({ style: ImpactStyle.Heavy }), 200);
            setTimeout(() => Haptics.impact({ style: ImpactStyle.Heavy }), 400);
        } catch { /* No haptics on web */ }

        // Start repeating alarm
        this.startAlarmSound();

        // Send push notification to shore devices via Supabase
        AnchorWatchSyncService.sendAlarmPush({
            distance: this.distanceFromAnchor,
            swingRadius: this.swingRadius,
            vesselLat: this.vesselPosition?.latitude,
            vesselLon: this.vesselPosition?.longitude,
        });

        this.notify();
    }

    private startAlarmSound(): void {
        // Use Web Audio API for alarm tone
        try {
            const AudioCtx = window.AudioContext || ('webkitAudioContext' in window ? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext : AudioContext);
            const ctx = new AudioCtx();
            const playAlarmTone = () => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.frequency.value = 880; // High A
                osc.type = 'square';
                gain.gain.setValueAtTime(0.3, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
                osc.start(ctx.currentTime);
                osc.stop(ctx.currentTime + 0.5);
            };

            playAlarmTone();
            this.alarmInterval = setInterval(() => {
                playAlarmTone();
                // Also re-trigger haptics
                Haptics.impact({ style: ImpactStyle.Heavy }).catch(() => { });
            }, 2000);
        } catch (e) {
            log.warn('startAlarmSound: audio init failed', e);
        }
    }

    private stopAlarm(): void {
        if (this.alarmInterval) {
            clearInterval(this.alarmInterval);
            this.alarmInterval = null;
        }
    }

    private notify(): void {
        const snapshot = this.getSnapshot();
        this.listeners.forEach(listener => {
            try {
                listener(snapshot);
            } catch (e) {
                // Listener threw — don't crash the notify loop
                log.warn('notify: listener error', e);
            }
        });
    }
}

// Export singleton + helpers
export const AnchorWatchService = new AnchorWatchServiceClass();
export { haversineDistance, bearing, calculateSwingRadius };
