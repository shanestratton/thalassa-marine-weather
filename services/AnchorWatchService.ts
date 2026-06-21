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
import { LocalNotifications } from '@capacitor/local-notifications';
import { Capacitor } from '@capacitor/core';
import { BgGeoManager } from './BgGeoManager';
import { AnchorWatchSyncService } from './AnchorWatchSyncService';
import { AlarmAudioService } from './AlarmAudioService';
import { createLogger } from '../utils/logger';
import { GpsPrecision } from './shiplog/GpsPrecisionTracker';
import { NmeaGpsProvider } from './NmeaGpsProvider';
import { isAnchorGpsStale, GPS_LOST_THRESHOLD_MS, nextDragState } from './anchorGpsWatchdog';

// ── Local-notification IDs ─────────────────────────────────────────
// The alarm path drops THREE flavours of notification to maximise
// the chance one wakes the skipper:
//   1. NOTIF_ID_PRIMARY (fires once, immediately)
//   2. NOTIF_ID_REPEAT_BASE..+19 (fires every 30 s for 10 min)
//   3. (future) a critical-alerts variant — pending Apple entitlement
// Stable IDs let us cancel them all on acknowledge/stop without
// having to remember dynamic IDs across pages/sessions.
const NOTIF_ID_PRIMARY = 99001;
const NOTIF_ID_REPEAT_BASE = 99100; // 99100..99119 = 20 reminders
const NOTIF_REPEAT_COUNT = 20; // 20 × 30 s = 10 min coverage
const NOTIF_REPEAT_INTERVAL_MS = 30_000;

const log = createLogger('AnchorWatch');

// Guardian auto-arm: lazily imported to avoid circular dependency
let _guardianArm: (() => Promise<boolean>) | null = null;
let _guardianDisarm: (() => Promise<boolean>) | null = null;

async function ensureGuardianBridge() {
    if (!_guardianArm) {
        try {
            const { GuardianService } = await import('./GuardianService');
            _guardianArm = () => GuardianService.arm();
            _guardianDisarm = () => GuardianService.disarm();
        } catch {
            // Guardian module unavailable — non-critical
        }
    }
}

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

export type GuardianAutoStatus = 'idle' | 'arming' | 'armed' | 'failed' | 'already_armed';

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
    /** Why the alarm fired — 'drag' (left the swing circle) or 'gps-lost' (watch went blind). */
    alarmCause: 'drag' | 'gps-lost' | null;
    watchStartedAt: number | null;
    gpsAccuracy: number;
    gpsQuality: 'precision' | 'standard' | 'degraded';
    gpsQualityLabel: string;
    /** Guardian auto-arm status for UI badge */
    guardianStatus: GuardianAutoStatus;
}

export type AnchorWatchListener = (snapshot: AnchorWatchSnapshot) => void;

// ------- CONSTANTS -------

const _TRANSISTOR_LICENSE_KEY = import.meta.env.VITE_TRANSISTOR_LICENSE_KEY || '';
const GPS_INTERVAL_MS = 3000; // High-frequency GPS when watching
const HISTORY_MAX_POINTS = 500; // Max position trail points
const _JITTER_WINDOW = 5; // Default moving average window (adaptive via GpsPrecision)
// ALARM_CONFIRM_COUNT now lives in ./anchorGpsWatchdog (pure + unit-tested)
const MIN_GPS_ACCURACY = 50; // Ignore readings worse than 50m accuracy
const GPS_WATCHDOG_INTERVAL_MS = 15_000; // How often the blind-watch watchdog polls
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
function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371000; // Earth radius in meters
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);

    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Bearing from point 1 to point 2 in degrees (0-360) */
function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;

    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);

    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
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
        horizontalDistance = Math.sqrt(rodeLength * rodeLength - waterDepth * waterDepth) * 0.9;
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
    private alarmCause: 'drag' | 'gps-lost' | null = null;
    private watchStartedAt: number | null = null;

    // Guardian bridge state
    private guardianArmedByUs = false;
    private guardianStatus: GuardianAutoStatus = 'idle';

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

    // Blind-watch watchdog: fires if no usable GPS fix arrives while watching
    private gpsWatchdog: ReturnType<typeof setInterval> | null = null;
    private lastUsableFixAt: number | null = null;

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
            alarmCause: this.alarmCause,
            watchStartedAt: this.watchStartedAt,
            gpsAccuracy: this.gpsAccuracy,
            gpsQuality: GpsPrecision.getQuality(),
            gpsQualityLabel: GpsPrecision.getAdaptedThresholds().qualityLabel,
            guardianStatus: this.guardianStatus,
        };
    }

    /**
     * Request iOS local-notification permission. Idempotent. Called
     * before setAnchor so the user grants permission BEFORE they're
     * relying on it during a drag emergency (when there's no time
     * for a permission dialog).
     */
    private async ensureNotificationPermission(): Promise<boolean> {
        if (!Capacitor.isNativePlatform()) return false;
        try {
            const current = await LocalNotifications.checkPermissions();
            if (current.display === 'granted') return true;
            if (current.display === 'denied') return false; // user said no — don't re-prompt every set
            const result = await LocalNotifications.requestPermissions();
            return result.display === 'granted';
        } catch (e) {
            log.warn('ensureNotificationPermission failed:', e);
            return false;
        }
    }

    /** Set anchor at current GPS position */
    async setAnchor(config?: Partial<AnchorWatchConfig>): Promise<boolean> {
        if (config) {
            this.config = { ...this.config, ...config };
        }

        this.state = 'setting';
        this.notify();

        // Pre-flight: request notification permission while we still
        // have the user's attention. Don't BLOCK on the result — if
        // they deny, the audio alarm + push-to-shore is still in play.
        void this.ensureNotificationPermission();

        try {
            // Prefer NMEA/external GPS if available (more accurate)
            const nmeaPos = NmeaGpsProvider.getPosition();
            let anchorLat: number;
            let anchorLon: number;
            let anchorTs: number;

            if (nmeaPos) {
                log.info('setAnchor: using NMEA GPS position');
                anchorLat = nmeaPos.latitude;
                anchorLon = nmeaPos.longitude;
                anchorTs = nmeaPos.timestamp;
            } else {
                // Fall back to phone GPS
                await BgGeoManager.ensureReady();
                const pos = await BgGeoManager.getFreshPosition(5_000, 15);
                if (!pos) throw new Error('Could not acquire GPS position for anchor');
                anchorLat = pos.latitude;
                anchorLon = pos.longitude;
                anchorTs = pos.timestamp;
            }

            this.anchorPosition = {
                latitude: anchorLat,
                longitude: anchorLon,
                timestamp: anchorTs,
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
            try {
                await KeepAwake.keepAwake();
            } catch (e) {
                log.warn('Web fallback:', e);
            }

            await this.startGpsMonitoring();
            this.startGpsWatchdog();

            // Auto-arm Guardian at anchor position (Tier 2 auto-arm)
            this.autoArmGuardian();

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
        try {
            await KeepAwake.keepAwake();
        } catch (e) {
            log.warn('Web fallback:', e);
        }

        await BgGeoManager.ensureReady();
        await this.startGpsMonitoring();
        this.startGpsWatchdog();

        // Auto-arm Guardian at anchor position (Tier 2 auto-arm)
        this.autoArmGuardian();

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
        this.stopGpsWatchdog();
        this.stopAlarm();

        // Allow screen to sleep again
        try {
            await KeepAwake.allowSleep();
        } catch (e) {
            log.warn('Web fallback:', e);
        }

        this.state = 'idle';
        this.anchorPosition = null;
        this.positionHistory = [];
        this.alarmTriggeredAt = null;
        this.alarmCause = null;
        this.lastUsableFixAt = null;
        this.watchStartedAt = null;
        this.maxDistanceRecorded = 0;
        this.distanceFromAnchor = 0;
        this.outsideCircleCount = 0;
        this.jitterBuffer = [];

        // Clear persisted state — user explicitly stopped
        this.clearPersistedWatchState();

        // Auto-disarm Guardian when anchor watch stops
        this.autoDisarmGuardian();

        this.notify();
    }

    /** Acknowledge alarm (silence it but keep watching) */
    acknowledgeAlarm(): void {
        this.stopAlarm();
        this.outsideCircleCount = 0;
        this.alarmCause = null;
        this.state = 'watching';
        // Re-arm the blind-watch watchdog with a fresh grace window — if GPS is
        // still gone it will re-alarm after the staleness budget.
        this.startGpsWatchdog();
        this.notify();
    }

    /** Get the current GPS position once (for UI display before anchoring) */
    async getCurrentPosition(): Promise<VesselPosition | null> {
        // Prefer NMEA/external GPS if available
        const nmeaPos = NmeaGpsProvider.getPosition();
        if (nmeaPos) {
            return {
                latitude: nmeaPos.latitude,
                longitude: nmeaPos.longitude,
                accuracy: nmeaPos.accuracy,
                heading: nmeaPos.heading,
                speed: nmeaPos.speed,
                timestamp: nmeaPos.timestamp,
            };
        }

        // Fall back to phone GPS
        try {
            await BgGeoManager.ensureReady();
            const pos = await BgGeoManager.getFreshPosition(10_000, 10);
            if (!pos) return null;
            return {
                latitude: pos.latitude,
                longitude: pos.longitude,
                accuracy: pos.accuracy,
                heading: pos.heading ?? 0,
                speed: pos.speed,
                timestamp: pos.timestamp,
            };
        } catch (e) {
            log.warn('Web fallback:', String(e));
            return null;
        }
    }

    /**
     * Restore anchor watch state after app restart/crash.
     * Re-establishes GPS monitoring and geofencing.
     * Returns true if a watch session was restored.
     */
    async restoreWatchState(): Promise<boolean> {
        // Already active — nothing to restore (idempotent for dual-call from App + AnchorWatchPage)
        if (this.state === 'watching' || this.state === 'alarm') return true;

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
            try {
                await KeepAwake.keepAwake();
            } catch (e) {
                log.warn('Web fallback:', e);
            }
            await BgGeoManager.ensureReady();
            await this.startGpsMonitoring();
            this.startGpsWatchdog();

            this.notify();
            return true;
        } catch (e) {
            log.warn('Restore failed:', String(e));
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
        } catch (e) {
            log.warn('Persist failed:', String(e));
            // Non-critical
        }
    }

    /** Clear persisted watch state */
    private clearPersistedWatchState(): void {
        try {
            localStorage.removeItem(ANCHOR_WATCH_KEY);
        } catch (e) {
            log.warn('Clear persist failed:', String(e));
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

            // Subscribe to location updates via shared manager (phone GPS)
            const unsubLoc = BgGeoManager.subscribeLocation((pos) => {
                this.handleGpsUpdate({
                    latitude: pos.latitude,
                    longitude: pos.longitude,
                    accuracy: pos.accuracy,
                    heading: pos.heading ?? 0,
                    speed: pos.speed,
                    timestamp: pos.timestamp,
                });
            });
            this.bgUnsubscribers.push(unsubLoc);

            // Also subscribe to NMEA GPS (preferred when active)
            const unsubNmea = NmeaGpsProvider.onPosition((nmeaPos) => {
                this.handleGpsUpdate({
                    latitude: nmeaPos.latitude,
                    longitude: nmeaPos.longitude,
                    accuracy: nmeaPos.accuracy,
                    heading: nmeaPos.heading,
                    speed: nmeaPos.speed,
                    timestamp: nmeaPos.timestamp,
                });
            });
            this.bgUnsubscribers.push(unsubNmea);

            // Subscribe to geofence events via shared manager
            const unsubGeo = BgGeoManager.subscribeGeofence((event) => {
                if (event.identifier === GEOFENCE_ID && event.action === 'EXIT') {
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
        this.bgUnsubscribers.forEach((unsub) => {
            try {
                unsub();
            } catch (e) {
                log.warn('already cleaned:', e);
            }
        });
        this.bgUnsubscribers = [];
    }

    private handleGpsUpdate(position: VesselPosition): void {
        // Filter poor accuracy readings
        if (position.accuracy > MIN_GPS_ACCURACY) return;

        this.gpsAccuracy = position.accuracy;

        // Watchdog clock: mark that a USABLE fix arrived. Use the fix's own
        // timestamp (clamped to now so a future/clock-skewed stamp can't delay
        // the watchdog) and only ever move it FORWARD, so BgGeo replaying an
        // old fix can't reset the staleness clock and mask a real GPS loss.
        const fixMs = Math.min(position.timestamp || Date.now(), Date.now());
        this.lastUsableFixAt = Math.max(this.lastUsableFixAt ?? 0, fixMs);

        // Feed accuracy into precision tracker
        GpsPrecision.feed(position.accuracy);

        // Adaptive jitter filter window: tighter with precision GPS
        const jitterWindow = GpsPrecision.getAdaptedThresholds().jitterFilterWindow;

        // Apply jitter filter (moving average)
        this.jitterBuffer.push({ lat: position.latitude, lon: position.longitude });
        if (this.jitterBuffer.length > jitterWindow) {
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
        const shouldRecord =
            !lastHistoryPoint ||
            position.timestamp - lastHistoryPoint.timestamp > GPS_INTERVAL_MS ||
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
                filtered.lat,
                filtered.lon,
                this.anchorPosition.latitude,
                this.anchorPosition.longitude,
            );
            this.bearingToAnchor = bearing(
                filtered.lat,
                filtered.lon,
                this.anchorPosition.latitude,
                this.anchorPosition.longitude,
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
        const sum = this.jitterBuffer.reduce((acc, p) => ({ lat: acc.lat + p.lat, lon: acc.lon + p.lon }), {
            lat: 0,
            lon: 0,
        });
        return {
            lat: sum.lat / this.jitterBuffer.length,
            lon: sum.lon / this.jitterBuffer.length,
        };
    }

    /**
     * Start the blind-watch watchdog. Seeds the staleness clock from "now"
     * (the anchor was just set from a fresh fix) and polls on an interval.
     * Idempotent — safe to call on every transition into 'watching'.
     */
    private startGpsWatchdog(): void {
        this.stopGpsWatchdog();
        this.lastUsableFixAt = Date.now();
        this.gpsWatchdog = setInterval(() => this.checkGpsStaleness(), GPS_WATCHDOG_INTERVAL_MS);
    }

    private stopGpsWatchdog(): void {
        if (this.gpsWatchdog) {
            clearInterval(this.gpsWatchdog);
            this.gpsWatchdog = null;
        }
    }

    /**
     * Independent of the GPS callback: if no usable fix has arrived within the
     * staleness budget while watching, the watch is blind and drag detection
     * is frozen — so raise a distinct GPS-lost alarm rather than silently
     * holding the last distance.
     */
    private checkGpsStaleness(): void {
        if (this.state !== 'watching') return;
        if (isAnchorGpsStale(Date.now(), this.lastUsableFixAt, GPS_LOST_THRESHOLD_MS)) {
            log.warn('GPS lost while watching — raising blind-watch alarm');
            void this.triggerAlarm('gps-lost');
        }
    }

    private checkForDrag(): void {
        if (this.state !== 'watching') return;

        const { outsideCount, fire } = nextDragState(
            this.outsideCircleCount,
            this.distanceFromAnchor,
            this.swingRadius,
        );
        this.outsideCircleCount = outsideCount;
        if (fire) this.triggerAlarm('drag');
    }

    private async triggerAlarm(cause: 'drag' | 'gps-lost' = 'drag'): Promise<void> {
        if (this.state === 'alarm') return; // Already alarming

        this.state = 'alarm';
        this.alarmCause = cause;
        this.alarmTriggeredAt = Date.now();

        // Persist alarm state — crash during alarm should restore to alarm, not watching
        this.persistWatchState();

        // Haptic burst (fires in the brief wake window iOS gives us when
        // the geofence event arrives; haptics during full suspension are
        // unreliable — that's what the local notification below is for).
        try {
            await Haptics.impact({ style: ImpactStyle.Heavy });
            // Triple vibrate
            setTimeout(() => Haptics.impact({ style: ImpactStyle.Heavy }), 200);
            setTimeout(() => Haptics.impact({ style: ImpactStyle.Heavy }), 400);
        } catch (e) {
            log.warn('No haptics on web:', e);
        }

        // Start repeating alarm
        this.startAlarmSound();

        // ── Local-notification fallback (added 2026-05-17) ──────────
        // The native AlarmAudioService.startAlarm() opens an AVAudio
        // session in .playback mode which CAN survive backgrounding —
        // but iOS thermal/battery throttling can kill the audio thread
        // before the skipper notices. A LocalNotification with
        // `interruptionLevel: timeSensitive` (a) breaks through Focus
        // / DND, (b) wakes the screen, and (c) doesn't depend on the
        // audio session staying alive. Schedule one IMMEDIATE alert +
        // 20 repeats at 30 s intervals so the user gets a notification
        // every 30 s for the next 10 min until they acknowledge.
        //
        // Future: switch interruptionLevel to 'critical' once Apple
        // grants the com.apple.developer.usernotifications.critical-
        // alerts entitlement (it bypasses the silent switch too).
        void this.scheduleAlarmNotifications();

        // Send push notification to shore devices via Supabase
        AnchorWatchSyncService.sendAlarmPush({
            distance: this.distanceFromAnchor,
            swingRadius: this.swingRadius,
            vesselLat: this.vesselPosition?.latitude,
            vesselLon: this.vesselPosition?.longitude,
        });

        this.notify();
    }

    /**
     * Schedule the on-device local-notification fallback that wakes
     * the skipper if the audio alarm goes quiet (iOS thermal throttle,
     * audio-session interruption, etc).
     *
     * One immediate notification + 20 repeats spaced 30 s apart. All
     * use timeSensitive interruption level so they break through Focus
     * / Do Not Disturb. They're cancelled the moment the user
     * acknowledges (see cancelAlarmNotifications).
     */
    private async scheduleAlarmNotifications(): Promise<void> {
        if (!Capacitor.isNativePlatform()) return;
        const distance = Math.round(this.distanceFromAnchor ?? 0);
        const radius = Math.round(this.swingRadius ?? 0);
        const isGpsLost = this.alarmCause === 'gps-lost';
        const title = isGpsLost ? '⚠️ Anchor Watch Blind — GPS Lost' : '⚠️ Anchor Dragging';
        const body = isGpsLost
            ? `No GPS fix for over ${Math.round(GPS_LOST_THRESHOLD_MS / 1000)}s — the anchor watch can't detect dragging. Check your position.`
            : `${distance}m from anchor (swing radius ${radius}m). Check vessel position.`;

        // Build the immediate + repeat schedule. iOS LocalNotifications
        // can't loop indefinitely, so we enqueue 20 discrete reminders.
        const now = Date.now();
        const schedules = [
            // Immediate (~100 ms in the future so iOS treats it as scheduled,
            // not display-while-the-event-loop-is-still-running)
            { id: NOTIF_ID_PRIMARY, atMs: now + 100 },
            ...Array.from({ length: NOTIF_REPEAT_COUNT }, (_, i) => ({
                id: NOTIF_ID_REPEAT_BASE + i,
                atMs: now + NOTIF_REPEAT_INTERVAL_MS * (i + 1),
            })),
        ];

        try {
            await LocalNotifications.schedule({
                notifications: schedules.map(({ id, atMs }) => ({
                    id,
                    title,
                    body,
                    schedule: { at: new Date(atMs) },
                    sound: 'beep.caf', // capacitor default tone; replace once anchor-alarm.caf ships
                    // Apple iOS extras — these are tolerated as extras by the
                    // plugin and read by the iOS bridge. timeSensitive breaks
                    // through Focus / DND.
                    extra: { interruptionLevel: 'timeSensitive', kind: 'anchor-drag' },
                })),
            });
        } catch (e) {
            log.warn('scheduleAlarmNotifications failed:', e);
        }
    }

    /** Cancel every alarm-related local notification (acknowledge + stop). */
    private async cancelAlarmNotifications(): Promise<void> {
        if (!Capacitor.isNativePlatform()) return;
        const ids = [
            { id: NOTIF_ID_PRIMARY },
            ...Array.from({ length: NOTIF_REPEAT_COUNT }, (_, i) => ({
                id: NOTIF_ID_REPEAT_BASE + i,
            })),
        ];
        try {
            await LocalNotifications.cancel({ notifications: ids });
        } catch (e) {
            log.warn('cancelAlarmNotifications failed:', e);
        }
    }

    private startAlarmSound(): void {
        // Use native alarm audio that bypasses iOS mute switch. The
        // setInterval-based haptic loop that used to live here was
        // removed 2026-05-17 — haptics during full app suspension
        // don't fire on iOS anyway (the JS event loop is frozen), so
        // the loop was wasted code that only produced noise during
        // the brief foreground window where the triple-burst above
        // already covers. The LocalNotification fallback in
        // scheduleAlarmNotifications() handles the during-suspension
        // wake-up signal instead.
        AlarmAudioService.startAlarm().catch((err) => {
            log.warn('startAlarmSound: native alarm failed', err);
        });
    }

    private stopAlarm(): void {
        if (this.alarmInterval) {
            clearInterval(this.alarmInterval);
            this.alarmInterval = null;
        }
        AlarmAudioService.stopAlarm().catch((e) => {
            log.warn(`[AnchorWatchService]`, e);
        });
        // Belt-and-braces: cancel every queued local notification so
        // we don't keep buzzing the user after they've acknowledged.
        // Safe to call on web — short-circuits inside the method.
        void this.cancelAlarmNotifications();
    }

    private notify(): void {
        const snapshot = this.getSnapshot();
        this.listeners.forEach((listener) => {
            try {
                listener(snapshot);
            } catch (e) {
                // Listener threw — don't crash the notify loop
                log.warn('notify: listener error', e);
            }
        });
        // Forward a slim version of the snapshot to the paired Apple Watch
        // (no-op on web/Android/missing watch). Lazy import keeps the
        // capacitor plugin off the web bundle's critical path.
        void this.pushToWatch(snapshot);
    }

    private pushToWatch(snapshot: AnchorWatchSnapshot): Promise<void> {
        // Trim the snapshot — positionHistory + nested objects can balloon
        // the payload, and WatchConnectivity has tight size limits. The
        // watch only needs the live numbers + alarm state.
        return import('./native/watchBridge')
            .then(({ pushAnchorState }) =>
                pushAnchorState({
                    state: snapshot.state,
                    anchor: snapshot.anchorPosition
                        ? {
                              lat: snapshot.anchorPosition.latitude,
                              lon: snapshot.anchorPosition.longitude,
                          }
                        : null,
                    vessel: snapshot.vesselPosition
                        ? {
                              lat: snapshot.vesselPosition.latitude,
                              lon: snapshot.vesselPosition.longitude,
                              accuracy: snapshot.vesselPosition.accuracy,
                          }
                        : null,
                    swingRadius: snapshot.swingRadius,
                    distanceFromAnchor: snapshot.distanceFromAnchor,
                    maxDistanceRecorded: snapshot.maxDistanceRecorded,
                    bearingFromAnchor: snapshot.bearingToAnchor,
                    watchStartedAt: snapshot.watchStartedAt,
                    alarmTriggeredAt: snapshot.alarmTriggeredAt,
                }),
            )
            .catch(() => {
                /* watchBridge missing or no watch paired — silent ok */
            });
    }

    // ── Guardian Auto-Arm Bridge ──

    /**
     * Auto-arm Guardian when anchor watch starts.
     * Tier 2: anchor watch users get Guardian protection automatically.
     */
    private async autoArmGuardian(): Promise<void> {
        this.guardianStatus = 'arming';
        this.notify();

        try {
            await ensureGuardianBridge();
            if (!_guardianArm) {
                this.guardianStatus = 'idle';
                this.notify();
                return;
            }

            // Check if Guardian is already armed (manually by user)
            try {
                const { GuardianService } = await import('./GuardianService');
                const state = GuardianService.getState();
                if (state.armed) {
                    // Already armed — don't overwrite, and don't disarm on weigh anchor
                    this.guardianArmedByUs = false;
                    this.guardianStatus = 'already_armed';
                    log.info('Guardian already armed (manual) — skipping auto-arm');
                    this.notify();
                    return;
                }
            } catch {
                /* proceed with arm attempt */
            }

            const armed = await _guardianArm();
            if (armed) {
                this.guardianArmedByUs = true;
                this.guardianStatus = 'armed';
                log.info('Guardian auto-armed via anchor watch');
            } else {
                this.guardianArmedByUs = false;
                this.guardianStatus = 'failed';
                log.warn('Guardian auto-arm failed (no profile or GPS)');
            }
        } catch (e) {
            this.guardianArmedByUs = false;
            this.guardianStatus = 'failed';
            log.warn('Guardian auto-arm error:', e);
        }

        this.notify();
    }

    /**
     * Auto-disarm Guardian when anchor watch stops.
     * Only disarms if WE were the ones who armed it — prevents
     * killing a manually-armed Guardian when the user weighs anchor.
     */
    private async autoDisarmGuardian(): Promise<void> {
        if (!this.guardianArmedByUs) {
            log.info('Guardian was not auto-armed by us — skipping auto-disarm');
            this.guardianStatus = 'idle';
            this.notify();
            return;
        }

        try {
            await ensureGuardianBridge();
            if (_guardianDisarm) {
                const disarmed = await _guardianDisarm();
                if (disarmed) {
                    log.info('Guardian auto-disarmed — anchor watch stopped');
                }
            }
        } catch (e) {
            log.warn('Guardian auto-disarm error:', e);
        }

        this.guardianArmedByUs = false;
        this.guardianStatus = 'idle';
        this.notify();
    }
}

// Export singleton + helpers
export const AnchorWatchService = new AnchorWatchServiceClass();
export { haversineDistance, bearing, calculateSwingRadius };
