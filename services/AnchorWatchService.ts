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
import { AnchorSafetyNotificationService } from './AnchorSafetyNotificationService';
import { createLogger } from '../utils/createLogger';
import { calculateDistance, calculateBearing } from '../utils/navigationCalculations';
import { GpsPrecision } from './shiplog/GpsPrecisionTracker';
import { NmeaGpsProvider } from './NmeaGpsProvider';
import { isAnchorGpsStale, GPS_LOST_THRESHOLD_MS, nextDragState } from './anchorGpsWatchdog';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    type AuthIdentityScope,
} from './authIdentityScope';
import { FEATURE_VISIBILITY } from '../utils/featureVisibility';
import { setLiveAnchorSafetyState } from './activeSafetyInterlock';
import { GpsService } from './GpsService';

// ── Local-notification IDs ─────────────────────────────────────────
// The alarm path drops two ordinary/time-sensitive notification layers:
//   1. NOTIF_ID_PRIMARY (fires once, immediately)
//   2. NOTIF_ID_REPEAT_BASE..+19 (fires every 30 s for 10 min)
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
    if (!FEATURE_VISIBILITY.guardian) return;
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

export interface AnchorWatchConfigLimits {
    rodeLength: { min: number; max: number };
    waterDepth: { min: number; max: number };
    scopeRatio: { min: number; max: number };
    safetyMargin: { min: number; max: number };
}

export type AnchorWatchConfigValidation = { ok: true; config: AnchorWatchConfig } | { ok: false; error: string };

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
    /** Actionable reason the most recent arm/restore attempt failed. */
    setupError: string | null;
    /** A live alarm could not confirm its locked-screen notification layer. */
    alarmNotificationError?: string | null;
}

export type AnchorWatchListener = (snapshot: AnchorWatchSnapshot) => void;

// ------- CONSTANTS -------

const GPS_INTERVAL_MS = 3000; // High-frequency GPS when watching
const HISTORY_MAX_POINTS = 500; // Max position trail points
const _JITTER_WINDOW = 5; // Default moving average window (adaptive via GpsPrecision)
// ALARM_CONFIRM_COUNT now lives in ./anchorGpsWatchdog (pure + unit-tested)
const MIN_GPS_ACCURACY = 50; // Ignore readings worse than 50m accuracy
const GPS_WATCHDOG_INTERVAL_MS = 15_000; // How often the blind-watch watchdog polls
const GEOFENCE_ID = 'anchor-swing-radius';
export const MIN_ANCHOR_SWING_RADIUS_M = 20;
/**
 * Deliberately broad yacht-scale limits. They are not UI slider limits: they
 * are the final safety boundary shared by every way configuration can enter
 * the watch (UI, service calls, recovery storage, and native geofencing).
 */
export const ANCHOR_WATCH_CONFIG_LIMITS: AnchorWatchConfigLimits = {
    rodeLength: { min: 1, max: 300 },
    waterDepth: { min: 0.5, max: 100 },
    scopeRatio: { min: 1, max: 20 },
    safetyMargin: { min: 1, max: 100 },
};
const SCOPE_RATIO_TOLERANCE = 0.01;
const ANCHOR_WATCH_KEY = 'thalassa_anchor_watch_state';
/** Device-authoritative crash-recovery envelope for an active physical watch.
 * It deliberately survives logout/session expiry; Weigh Anchor removes it. */
export const ANCHOR_WATCH_DEVICE_RECOVERY_KEY = 'thalassa_anchor_watch_device_recovery_v1';
/** NMEA emits every five seconds; two missed emissions makes it stale. */
const PRIMARY_SOURCE_FRESH_MS = 12_000;
const DEFAULT_ANCHOR_CONFIG: AnchorWatchConfig = {
    rodeLength: 30,
    waterDepth: 5,
    scopeRatio: 6,
    rodeType: 'chain',
    safetyMargin: 10,
};

/** Minimal state persisted for crash recovery */
interface PersistedWatchState {
    anchorPosition: AnchorPosition;
    config: AnchorWatchConfig;
    state: AnchorWatchState;
    watchStartedAt: number;
    alarmTriggeredAt: number | null;
    alarmCause: 'drag' | 'gps-lost' | null;
    identityKey: string;
    savedAt: number;
}

type PersistedWatchValidation =
    | { ok: true; watch: PersistedWatchState }
    | {
          ok: false;
          error: string;
          anchorPosition?: AnchorPosition;
          watchStartedAt?: number;
      };

type GpsSource = 'native' | 'nmea';

// ------- HELPERS -------

/**
 * Haversine distance in meters between two lat/lng points.
 * Delegates to the canonical utils/navigationCalculations haversine
 * (R = 3440.065 NM = 6 371 000.4 m vs the old local 6 371 000 m — a
 * sub-millimetre-per-km drift, irrelevant at geofence scale).
 */
function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    return calculateDistance(lat1, lon1, lat2, lon2) * 1852;
}

/** Bearing from point 1 to point 2 in degrees (0-360) */
function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
    return calculateBearing(lat1, lon1, lat2, lon2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scopeFromIdentityKey(identityKey: unknown, currentScope: AuthIdentityScope): AuthIdentityScope | null {
    if (identityKey === 'anonymous') {
        return {
            key: 'anonymous',
            userId: null,
            generation: currentScope.key === 'anonymous' ? currentScope.generation : -1,
        };
    }
    if (typeof identityKey !== 'string' || !identityKey.startsWith('user:') || identityKey.length <= 5) return null;
    return {
        key: identityKey,
        userId: identityKey.slice(5),
        generation: currentScope.key === identityKey ? currentScope.generation : -1,
    };
}

function fieldError(label: string, min: number, max: number): string {
    return `${label} must be a finite number from ${min} to ${max} metres.`;
}

/**
 * The single configuration boundary for Anchor Watch.
 *
 * `input` may be a partial user/service update when `base` is supplied. For
 * complete recovery records, omit `base`; every persisted field (including
 * the redundant scope ratio) must then be present and internally consistent.
 * The returned scope ratio is always derived from rode/depth so downstream
 * calculations and the native fence cannot disagree with displayed scope.
 */
export function validateAndNormalizeAnchorWatchConfig(
    input: unknown,
    base?: AnchorWatchConfig,
): AnchorWatchConfigValidation {
    if (!isRecord(input)) {
        return { ok: false, error: 'Anchor Watch configuration is missing or corrupt.' };
    }

    const read = (field: keyof AnchorWatchConfig): unknown =>
        Object.prototype.hasOwnProperty.call(input, field) ? input[field] : base?.[field];
    const rodeLength = read('rodeLength');
    const waterDepth = read('waterDepth');
    const safetyMargin = read('safetyMargin');
    const rodeType = read('rodeType');

    const rodeLimits = ANCHOR_WATCH_CONFIG_LIMITS.rodeLength;
    if (
        typeof rodeLength !== 'number' ||
        !Number.isFinite(rodeLength) ||
        rodeLength < rodeLimits.min ||
        rodeLength > rodeLimits.max
    ) {
        return { ok: false, error: fieldError('Rode length', rodeLimits.min, rodeLimits.max) };
    }

    const depthLimits = ANCHOR_WATCH_CONFIG_LIMITS.waterDepth;
    if (
        typeof waterDepth !== 'number' ||
        !Number.isFinite(waterDepth) ||
        waterDepth < depthLimits.min ||
        waterDepth > depthLimits.max
    ) {
        return { ok: false, error: fieldError('Water depth', depthLimits.min, depthLimits.max) };
    }

    const marginLimits = ANCHOR_WATCH_CONFIG_LIMITS.safetyMargin;
    if (
        typeof safetyMargin !== 'number' ||
        !Number.isFinite(safetyMargin) ||
        safetyMargin < marginLimits.min ||
        safetyMargin > marginLimits.max
    ) {
        return { ok: false, error: fieldError('Safety margin', marginLimits.min, marginLimits.max) };
    }

    if (rodeType !== 'chain' && rodeType !== 'rope' && rodeType !== 'mixed') {
        return { ok: false, error: 'Rode type must be chain, rope, or mixed.' };
    }

    const derivedScopeRatio = rodeLength / waterDepth;
    const ratioLimits = ANCHOR_WATCH_CONFIG_LIMITS.scopeRatio;
    if (
        !Number.isFinite(derivedScopeRatio) ||
        derivedScopeRatio < ratioLimits.min ||
        derivedScopeRatio > ratioLimits.max
    ) {
        return {
            ok: false,
            error: `Rode length and water depth must produce a scope ratio from ${ratioLimits.min}:1 to ${ratioLimits.max}:1.`,
        };
    }

    const scopeWasSupplied = Object.prototype.hasOwnProperty.call(input, 'scopeRatio');
    const suppliedScopeRatio = scopeWasSupplied ? input.scopeRatio : undefined;
    if (!base && !scopeWasSupplied) {
        return { ok: false, error: 'Saved Anchor Watch scope ratio is missing.' };
    }
    if (
        scopeWasSupplied &&
        (typeof suppliedScopeRatio !== 'number' ||
            !Number.isFinite(suppliedScopeRatio) ||
            Math.abs(suppliedScopeRatio - derivedScopeRatio) > SCOPE_RATIO_TOLERANCE)
    ) {
        return {
            ok: false,
            error: `Scope ratio is inconsistent with rode length and water depth (expected ${derivedScopeRatio.toFixed(2)}:1).`,
        };
    }

    return {
        ok: true,
        config: {
            rodeLength,
            waterDepth,
            scopeRatio: derivedScopeRatio,
            rodeType,
            safetyMargin,
        },
    };
}

function calculateValidatedSwingRadius(config: AnchorWatchConfig): number {
    const { rodeLength, waterDepth, rodeType, safetyMargin } = config;

    // Horizontal distance from anchor to vessel. The validation boundary
    // guarantees rode >= depth through the minimum 1:1 scope ratio.
    const horizontalProjection = Math.sqrt(Math.max(0, rodeLength * rodeLength - waterDepth * waterDepth));
    const rodeFactor = rodeType === 'chain' ? 0.85 : rodeType === 'rope' ? 0.95 : 0.9;
    return Math.max(horizontalProjection * rodeFactor + safetyMargin, MIN_ANCHOR_SWING_RADIUS_M);
}

/**
 * Calculate swing radius from rode config.
 * Chain catenary sag reduces horizontal distance vs rope.
 */
function calculateSwingRadius(config: AnchorWatchConfig): number {
    const validated = validateAndNormalizeAnchorWatchConfig(config);
    if (!validated.ok) throw new Error(validated.error);
    return calculateValidatedSwingRadius(validated.config);
}

// ------- SERVICE -------

class AnchorWatchServiceClass {
    private state: AnchorWatchState = 'idle';
    private anchorPosition: AnchorPosition | null = null;
    private vesselPosition: VesselPosition | null = null;
    private config: AnchorWatchConfig = { ...DEFAULT_ANCHOR_CONFIG };
    private swingRadius = 0;
    private distanceFromAnchor = 0;
    private maxDistanceRecorded = 0;
    private bearingToAnchor = 0;
    private positionHistory: VesselPosition[] = [];
    private alarmTriggeredAt: number | null = null;
    private alarmCause: 'drag' | 'gps-lost' | null = null;
    private watchStartedAt: number | null = null;
    /**
     * The identity that armed/restored this physical watch. It deliberately
     * stays fixed while the watch is running: an auth switch must not disarm a
     * safety alarm, nor may later config/alarm writes leak its coordinates
     * into the new account's persistence namespace.
     */
    private watchPersistenceScope: AuthIdentityScope | null = null;

    // Guardian bridge state
    private guardianArmedByUs = false;
    private guardianStatus: GuardianAutoStatus = 'idle';

    // GPS jitter filter buffer
    private jitterBuffer: { lat: number; lon: number }[] = [];
    private outsideCircleCount = 0;
    private primaryGpsSource: GpsSource | null = null;
    private lastSourceFixAt: Record<GpsSource, number | null> = { native: null, nmea: null };

    // GPS tracking
    private gpsAccuracy = 0;
    private bgUnsubscribers: (() => void)[] = [];

    // Listeners
    private listeners: Set<AnchorWatchListener> = new Set();

    // Alarm audio
    private alarmInterval: ReturnType<typeof setInterval> | null = null;
    private alarmAudioToken: string | null = null;

    // Blind-watch watchdog: fires if no usable GPS fix arrives while watching
    private gpsWatchdog: ReturnType<typeof setInterval> | null = null;
    private lastUsableFixAt: number | null = null;
    /** True only after this service acquired a BgGeoManager start lease. */
    private bgGeoLeaseHeld = false;
    /** True only after this process installed/replaced the native swing fence. */
    private anchorGeofenceOwned = false;
    private setupError: string | null = null;
    private alarmNotificationError: string | null = null;

    /**
     * Safety mutations are one transaction at a time. App bootstrap and the
     * Anchor Watch page both restore on launch, while native callbacks can
     * arrive during teardown; a single queue prevents duplicate GPS leases,
     * geofences, or an arm racing a stop.
     */
    private operationTail: Promise<void> = Promise.resolve();

    private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
        const previous = this.operationTail;
        let release!: () => void;
        this.operationTail = new Promise<void>((resolve) => {
            release = resolve;
        });

        return previous
            .catch(() => undefined)
            .then(operation)
            .finally(release);
    }

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
        // An armed/possibly-armed physical watch is device-authoritative. It
        // remains visible and stoppable after logout/session expiry; hiding a
        // foreign paused cleanup would strand native GPS/geofence effects.
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
            setupError: this.setupError,
            alarmNotificationError: this.alarmNotificationError,
        };
    }

    /** Actionable failure from the last arm/restore attempt, for setup UI. */
    getLastSetupError(): string | null {
        return this.setupError;
    }

    /**
     * Request iOS local-notification permission. Idempotent. Called
     * before setAnchor so the user grants permission BEFORE they're
     * relying on it during a drag emergency (when there's no time
     * for a permission dialog).
     */
    private async requireNotificationPermission(): Promise<void> {
        if (!Capacitor.isNativePlatform()) return;
        try {
            const current = await LocalNotifications.checkPermissions();
            if (current.display === 'denied') {
                throw new Error(
                    'Locked-screen notifications are denied. Enable Notifications for Thalassa in iOS Settings before dropping anchor.',
                );
            }
            if (current.display !== 'granted') {
                const result = await LocalNotifications.requestPermissions();
                if (result.display !== 'granted') {
                    throw new Error(
                        'Locked-screen notification permission was not granted. Enable Notifications for Thalassa before dropping anchor.',
                    );
                }
            }

            // Generic permission does not prove the native interruption level,
            // sound/alert settings, or room for all 21 requests.
            await AnchorSafetyNotificationService.requireReadiness();
        } catch (e) {
            log.warn('requireNotificationPermission failed:', e);
            if (e instanceof Error && e.message.trim()) throw e;
            throw new Error(
                'Locked-screen notification permission could not be verified. Check iOS Settings and try again.',
            );
        }
    }

    /** Set anchor at current GPS position */
    async setAnchor(config?: Partial<AnchorWatchConfig>): Promise<boolean> {
        return this.runExclusive(() => this.setAnchorLocked(config));
    }

    private async setAnchorLocked(config?: Partial<AnchorWatchConfig>): Promise<boolean> {
        const persistenceScope = getAuthIdentityScope();
        if (this.state !== 'idle') {
            this.setupError = 'Anchor Watch is already active. Stop the current watch before setting a new anchor.';
            this.notify();
            return false;
        }
        const validatedConfig = validateAndNormalizeAnchorWatchConfig(config ?? {}, this.config);
        if (!validatedConfig.ok) {
            this.setupError = `Anchor Watch configuration is invalid. ${validatedConfig.error}`;
            this.notify();
            return false;
        }
        this.config = validatedConfig.config;

        this.setupError = null;
        this.alarmNotificationError = null;
        this.state = 'setting';
        this.notify();

        try {
            // A screen-off alarm is part of the advertised native safety path.
            // Permission must be proved before the skipper can rely on it.
            await this.requireNotificationPermission();
            await BgGeoManager.requireAlwaysLocationAuthorization('anchor-watch');

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
            this.alarmCause = null;
            this.alarmNotificationError = null;

            // Keep screen awake during anchor watch
            try {
                await KeepAwake.keepAwake();
            } catch (e) {
                log.warn('Web fallback:', e);
            }

            // This throws unless a native background-GPS path or a live NMEA
            // feed has actually started. Do not expose/persist "watching"
            // before that proof succeeds.
            await this.startGpsMonitoring();
            this.watchStartedAt = Date.now();
            this.state = 'watching';
            if (this.watchPersistenceScope && this.watchPersistenceScope.key !== persistenceScope.key) {
                this.clearPersistedWatchState(this.watchPersistenceScope);
            }
            this.watchPersistenceScope = persistenceScope;
            this.persistWatchStateRequired();
            this.startGpsWatchdog();

            // Auto-arm Guardian at anchor position (Tier 2 auto-arm)
            this.autoArmGuardian();

            this.notify();
            return true;
        } catch (error) {
            await this.rollbackFailedSetup(persistenceScope, error);
            return false;
        }
    }

    /** Set anchor at a specific position (e.g., from map tap) */
    async setAnchorAt(lat: number, lon: number, config?: Partial<AnchorWatchConfig>): Promise<boolean> {
        return this.runExclusive(() => this.setAnchorAtLocked(lat, lon, config));
    }

    private async setAnchorAtLocked(lat: number, lon: number, config?: Partial<AnchorWatchConfig>): Promise<boolean> {
        const persistenceScope = getAuthIdentityScope();
        if (this.state !== 'idle') {
            this.setupError = 'Anchor Watch is already active. Stop the current watch before setting a new anchor.';
            this.notify();
            return false;
        }
        if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
            this.setupError = 'The selected anchor position is invalid. Choose a valid chart position and try again.';
            this.notify();
            return false;
        }
        const validatedConfig = validateAndNormalizeAnchorWatchConfig(config ?? {}, this.config);
        if (!validatedConfig.ok) {
            this.setupError = `Anchor Watch configuration is invalid. ${validatedConfig.error}`;
            this.notify();
            return false;
        }
        this.config = validatedConfig.config;
        this.setupError = null;
        this.alarmNotificationError = null;
        this.state = 'setting';
        this.notify();
        try {
            await this.requireNotificationPermission();
            await BgGeoManager.requireAlwaysLocationAuthorization('anchor-watch');
            this.anchorPosition = { latitude: lat, longitude: lon, timestamp: Date.now() };
            this.swingRadius = calculateSwingRadius(this.config);
            this.positionHistory = [];
            this.maxDistanceRecorded = 0;
            this.outsideCircleCount = 0;
            this.jitterBuffer = [];
            this.alarmTriggeredAt = null;
            this.alarmCause = null;
            this.alarmNotificationError = null;

            try {
                await KeepAwake.keepAwake();
            } catch (e) {
                log.warn('Web fallback:', e);
            }

            await this.startGpsMonitoring();
            this.watchStartedAt = Date.now();
            this.state = 'watching';
            if (this.watchPersistenceScope && this.watchPersistenceScope.key !== persistenceScope.key) {
                this.clearPersistedWatchState(this.watchPersistenceScope);
            }
            this.watchPersistenceScope = persistenceScope;
            this.persistWatchStateRequired();
            this.startGpsWatchdog();
            this.autoArmGuardian();
            this.notify();
            return true;
        } catch (error) {
            await this.rollbackFailedSetup(persistenceScope, error);
            return false;
        }
    }

    /** Update rode/depth config while watching */
    async updateConfig(config: Partial<AnchorWatchConfig>): Promise<boolean> {
        return this.runExclusive(() => this.updateConfigLocked(config));
    }

    private async updateConfigLocked(config: Partial<AnchorWatchConfig>): Promise<boolean> {
        const previousConfig = { ...this.config };
        const previousRadius = this.swingRadius;
        const validatedConfig = validateAndNormalizeAnchorWatchConfig(config, this.config);
        if (!validatedConfig.ok) {
            this.setupError = `Swing-radius update was rejected. ${validatedConfig.error}`;
            this.notify();
            return false;
        }
        const nextConfig = validatedConfig.config;
        const nextRadius = calculateValidatedSwingRadius(nextConfig);

        if (this.state === 'idle') {
            this.config = nextConfig;
            this.swingRadius = nextRadius;
            this.setupError = null;
            this.notify();
            return true;
        }

        this.config = nextConfig;
        this.swingRadius = nextRadius;
        const failures: Error[] = [];

        try {
            if ((this.state === 'watching' || this.state === 'alarm') && this.anchorPosition) {
                await this.updateGeofence();
            }
            this.persistWatchStateRequired();
            this.setupError = null;
            this.notify();
            return true;
        } catch (error) {
            failures.push(this.asError(error));
            this.config = previousConfig;
            this.swingRadius = previousRadius;

            if ((this.state === 'watching' || this.state === 'alarm') && this.anchorPosition) {
                await this.captureFailure(() => this.updateGeofence(), failures);
            }

            if (failures.length > 1) {
                this.state = this.state === 'alarm' ? 'alarm' : 'paused';
                this.setupError = this.failureMessage(
                    'Swing-radius update failed and the prior native geofence could not be restored. Verified monitoring is blocked.',
                    failures,
                );
            } else {
                this.setupError = this.failureMessage(
                    'Swing-radius update was rejected; the previous verified radius remains active.',
                    failures,
                );
            }
            this.persistWatchState();
            this.notify();
            return false;
        }
    }

    /** Stop watching and return to idle */
    async stopWatch(): Promise<void> {
        return this.runExclusive(() => this.stopWatchLocked());
    }

    private async stopWatchLocked(): Promise<void> {
        if (
            this.state === 'idle' &&
            !this.watchPersistenceScope &&
            !this.bgGeoLeaseHeld &&
            !this.anchorGeofenceOwned &&
            this.bgUnsubscribers.length === 0 &&
            !this.alarmAudioToken
        ) {
            return;
        }

        const previousState = this.state;
        const failures: Error[] = [];
        this.stopGpsWatchdog();

        await this.captureFailure(() => this.stopGpsMonitoring(), failures);
        await this.captureFailure(() => this.stopAlarmOutputs(), failures);
        await this.captureFailure(() => KeepAwake.allowSleep(), failures);

        if (failures.length > 0) {
            this.state = previousState === 'alarm' ? 'alarm' : 'paused';
            const stopError = this.failureMessage(
                'Anchor Watch stop is not confirmed. It may still be armed; retry Weigh Anchor.',
                failures,
            );
            if (previousState === 'alarm') {
                await this.restoreAlarmOutputs(false);
            }
            this.setupError = this.setupError ? `${stopError} ${this.setupError}` : stopError;
            this.persistWatchState();
            this.notify();
            throw new Error(this.setupError);
        }

        try {
            this.clearPersistedWatchStateRequired();
        } catch (error) {
            this.state = previousState === 'alarm' ? 'alarm' : 'paused';
            const persistenceError = this.failureMessage(
                'Anchor Watch stopped its native outputs, but crash-recovery state could not be cleared. Retry Weigh Anchor.',
                [this.asError(error)],
            );
            if (previousState === 'alarm') {
                await this.restoreAlarmOutputs(false);
            }
            this.setupError = this.setupError ? `${persistenceError} ${this.setupError}` : persistenceError;
            this.notify();
            throw new Error(this.setupError);
        }

        this.state = 'idle';
        this.setupError = null;
        this.alarmNotificationError = null;
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
        this.resetPrimaryGpsSource();
        this.watchPersistenceScope = null;

        // Auto-disarm Guardian when anchor watch stops
        this.autoDisarmGuardian();

        this.notify();
    }

    /** Acknowledge alarm (silence it but keep watching) */
    async acknowledgeAlarm(): Promise<void> {
        return this.runExclusive(() => this.acknowledgeAlarmLocked());
    }

    private async acknowledgeAlarmLocked(): Promise<void> {
        if (this.state !== 'alarm') return;

        const previousCause = this.alarmCause;
        const previousTriggeredAt = this.alarmTriggeredAt;
        try {
            await this.stopAlarmOutputs();
        } catch (error) {
            const cancellationError = this.failureMessage(
                'Anchor alarm silence is not confirmed. The alarm remains active; retry Silence Alarm.',
                [this.asError(error)],
            );
            await this.restoreAlarmOutputs(false);
            this.setupError = this.setupError ? `${cancellationError} ${this.setupError}` : cancellationError;
            this.persistWatchState();
            this.notify();
            throw new Error(this.setupError);
        }

        this.outsideCircleCount = 0;
        this.alarmCause = null;
        this.alarmTriggeredAt = null;
        this.state = 'watching';
        this.setupError = null;
        this.alarmNotificationError = null;

        try {
            this.persistWatchStateRequired();
        } catch (error) {
            // A crash must never resurrect an acknowledged alarm. If the
            // acknowledgement cannot be recorded, restore the alarm and its
            // outputs in this process so the user can retry safely.
            this.state = 'alarm';
            this.alarmCause = previousCause;
            this.alarmTriggeredAt = previousTriggeredAt;
            const persistenceError = this.failureMessage(
                'The alarm was silenced, but acknowledgement could not be saved. The alarm has been restarted; retry Silence Alarm.',
                [this.asError(error)],
            );
            await this.restoreAlarmOutputs(false);
            this.setupError = this.setupError ? `${persistenceError} ${this.setupError}` : persistenceError;
            this.notify();
            throw new Error(this.setupError);
        }

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
                heading: nmeaPos.heading ?? 0,
                speed: nmeaPos.speed,
                timestamp: nmeaPos.timestamp,
            };
        }

        // Fall back to an already-authorized foreground phone fix. This method
        // is a passive UI preview; only setAnchor/startGpsMonitoring may
        // initialize the background safety engine or request Always access.
        try {
            const pos = await GpsService.getCurrentPositionIfGranted({ staleLimitMs: 10_000, timeoutSec: 10 });
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
        return this.runExclusive(() => this.restoreWatchStateLocked());
    }

    private async restoreWatchStateLocked(): Promise<boolean> {
        // Already active — the queue makes dual bootstrap/page restores share
        // the first transaction rather than acquiring a second native lease.
        if (this.state === 'watching' || this.state === 'alarm') return true;
        // Cleanup from a previous account is still pending. Keep the blocked
        // state mounted so the only honest action (retry Weigh Anchor) remains
        // available; never look for or adopt account B's record over A's owned
        // native effects.
        if (
            this.state === 'paused' &&
            this.watchPersistenceScope !== null &&
            !isAuthIdentityScopeCurrent(this.watchPersistenceScope)
        ) {
            return true;
        }
        this.setupError = null;
        this.alarmNotificationError = null;
        const currentScope = getAuthIdentityScope();
        let persistenceScope = currentScope;
        let deviceRecovery = false;
        let persisted: PersistedWatchState | null = null;

        try {
            // Prefer the explicit active-device envelope. It is the recovery
            // authority after involuntary sign-out/account loss. Fall back to
            // the old scoped record for migration from earlier beta builds.
            let raw = localStorage.getItem(ANCHOR_WATCH_DEVICE_RECOVERY_KEY);
            if (raw) {
                deviceRecovery = true;
                try {
                    const candidate = JSON.parse(raw) as unknown;
                    const recoveredScope = scopeFromIdentityKey(
                        isRecord(candidate) ? candidate.identityKey : undefined,
                        currentScope,
                    );
                    if (!recoveredScope) {
                        this.markInvalidPersistedWatchBlocked(
                            currentScope,
                            'The saved device recovery owner is missing or corrupt.',
                        );
                        return true;
                    }
                    persistenceScope = recoveredScope;
                } catch {
                    this.markInvalidPersistedWatchBlocked(
                        currentScope,
                        'The saved device recovery record is not valid JSON.',
                    );
                    return true;
                }
            } else {
                raw = localStorage.getItem(authScopedStorageKey(ANCHOR_WATCH_KEY, currentScope));
            }
            if (!raw) return false;

            let parsed: unknown;
            try {
                parsed = JSON.parse(raw) as unknown;
            } catch {
                this.markInvalidPersistedWatchBlocked(persistenceScope, 'The saved recovery record is not valid JSON.');
                return true;
            }
            const validation = this.validatePersistedWatch(parsed, persistenceScope);
            if (!validation.ok) {
                this.markInvalidPersistedWatchBlocked(
                    persistenceScope,
                    validation.error,
                    validation.anchorPosition,
                    validation.watchStartedAt,
                );
                return true;
            }
            persisted = validation.watch;

            if (
                this.state === 'paused' &&
                (this.bgGeoLeaseHeld || this.anchorGeofenceOwned || this.bgUnsubscribers.length > 0)
            ) {
                await this.stopGpsMonitoring();
            }

            await this.requireNotificationPermission();
            await BgGeoManager.requireAlwaysLocationAuthorization('anchor-watch');

            // A legacy scoped restore remains identity-fenced. A device
            // recovery is deliberately independent of auth: session expiry
            // must not prevent a live watch from resuming.
            try {
                await KeepAwake.keepAwake();
            } catch (e) {
                log.warn('Web fallback:', e);
            }
            if (!deviceRecovery && !isAuthIdentityScopeCurrent(persistenceScope)) {
                const cleanupFailures = await this.cleanupAfterIdentityFenceFailure();
                return this.finishIdentityFencedRestore(persistenceScope, cleanupFailures);
            }

            // Restore state only after the identity fence has survived native
            // preflight. Once active, later auth switches intentionally leave
            // this physical safety watch running in memory.
            this.anchorPosition = persisted.anchorPosition;
            this.config = persisted.config;
            this.swingRadius = calculateSwingRadius(this.config);
            this.watchStartedAt = persisted.watchStartedAt;
            this.state = 'setting';
            this.watchPersistenceScope = persistenceScope;
            this.positionHistory = [];
            this.maxDistanceRecorded = 0;
            this.outsideCircleCount = 0;
            this.jitterBuffer = [];
            this.alarmTriggeredAt = persisted.alarmTriggeredAt ?? null;
            this.alarmCause = persisted.alarmCause ?? null;
            this.alarmNotificationError = null;

            await this.startGpsMonitoring();
            if (!deviceRecovery && !isAuthIdentityScopeCurrent(persistenceScope)) {
                throw new Error('Account changed while restoring Anchor Watch.');
            }

            if (persisted.state === 'alarm') {
                this.state = 'alarm';
                this.alarmCause = persisted.alarmCause ?? 'drag';
                this.alarmTriggeredAt = persisted.alarmTriggeredAt ?? persisted.savedAt;
                this.persistWatchState();
                await this.restoreAlarmOutputs(true);
            } else {
                // `paused` is a retained recovery state from a previous
                // transient preflight/teardown failure. A successful retry
                // resumes it as a real, verified watch.
                this.state = 'watching';
                this.alarmCause = null;
                this.alarmTriggeredAt = null;
                this.setupError = null;
                this.persistWatchStateRequired();
                this.startGpsWatchdog();
            }

            this.notify();
            return true;
        } catch (e) {
            log.warn('Restore failed:', String(e));
            if (!persisted) {
                this.markInvalidPersistedWatchBlocked(
                    persistenceScope,
                    `Recovery storage could not be read safely. ${this.asError(e).message}`,
                );
                return true;
            }

            // If the auth identity changed mid-preflight, never expose the
            // previous account's coordinates. Leave its scoped recovery
            // record intact for that account's next launch.
            if (!deviceRecovery && !isAuthIdentityScopeCurrent(persistenceScope)) {
                const cleanupFailures = await this.cleanupAfterIdentityFenceFailure();
                return this.finishIdentityFencedRestore(persistenceScope, cleanupFailures);
            }

            await this.markRestoreBlocked(persisted, persistenceScope, e, deviceRecovery);
            return true;
        }
    }

    // ---- PRIVATE ----

    /** Persist current watch state for crash recovery */
    private persistWatchState(): boolean {
        if (!this.anchorPosition || this.state === 'idle') return false;
        try {
            this.persistWatchStateRequired();
            return true;
        } catch (e) {
            log.warn('Persist failed:', String(e));
            return false;
        }
    }

    /** Safety transitions that must survive a crash use the strict variant. */
    private persistWatchStateRequired(): void {
        if (!this.anchorPosition || this.state === 'idle') {
            throw new Error('Anchor Watch recovery state is unavailable.');
        }
        const validatedConfig = validateAndNormalizeAnchorWatchConfig(this.config);
        if (!validatedConfig.ok) {
            throw new Error(`Anchor Watch recovery configuration is invalid. ${validatedConfig.error}`);
        }
        if (
            !Number.isFinite(this.anchorPosition.latitude) ||
            this.anchorPosition.latitude < -90 ||
            this.anchorPosition.latitude > 90 ||
            !Number.isFinite(this.anchorPosition.longitude) ||
            this.anchorPosition.longitude < -180 ||
            this.anchorPosition.longitude > 180
        ) {
            throw new Error('Anchor Watch recovery position is invalid.');
        }
        this.config = validatedConfig.config;
        const persistenceScope = this.watchPersistenceScope ?? getAuthIdentityScope();
        const data: PersistedWatchState = {
            anchorPosition: this.anchorPosition,
            config: { ...validatedConfig.config },
            state: this.state,
            watchStartedAt: this.watchStartedAt || Date.now(),
            alarmTriggeredAt: this.alarmTriggeredAt,
            alarmCause: this.alarmCause,
            identityKey: persistenceScope.key,
            savedAt: Date.now(),
        };
        // Device envelope first: if the secondary account-scoped write fails,
        // automatic logout/restart recovery still has an authoritative copy.
        localStorage.setItem(ANCHOR_WATCH_DEVICE_RECOVERY_KEY, JSON.stringify(data));
        localStorage.setItem(authScopedStorageKey(ANCHOR_WATCH_KEY, persistenceScope), JSON.stringify(data));
    }

    /** Clear persisted watch state */
    private clearPersistedWatchState(scope = this.watchPersistenceScope ?? getAuthIdentityScope()): void {
        try {
            this.clearPersistedWatchStateRequired(scope);
        } catch (e) {
            log.warn('Clear persist failed:', String(e));
        }
    }

    private clearPersistedWatchStateRequired(scope = this.watchPersistenceScope ?? getAuthIdentityScope()): void {
        // Scoped record first; if its removal throws, retain the device envelope
        // so the physical safety state cannot disappear on restart.
        localStorage.removeItem(authScopedStorageKey(ANCHOR_WATCH_KEY, scope));
        localStorage.removeItem(ANCHOR_WATCH_DEVICE_RECOVERY_KEY);
    }

    private validatePersistedWatch(value: unknown, scope: AuthIdentityScope): PersistedWatchValidation {
        if (!isRecord(value)) {
            return { ok: false, error: 'The saved recovery record is missing or corrupt.' };
        }
        if (value.identityKey !== scope.key) {
            return { ok: false, error: 'The saved recovery record does not belong to the current account.' };
        }

        const anchor = value.anchorPosition;
        if (!isRecord(anchor)) {
            return { ok: false, error: 'The saved anchor position is missing or corrupt.' };
        }
        const latitude = anchor.latitude;
        const longitude = anchor.longitude;
        const timestamp = anchor.timestamp;
        if (
            typeof latitude !== 'number' ||
            !Number.isFinite(latitude) ||
            latitude < -90 ||
            latitude > 90 ||
            typeof longitude !== 'number' ||
            !Number.isFinite(longitude) ||
            longitude < -180 ||
            longitude > 180 ||
            typeof timestamp !== 'number' ||
            !Number.isFinite(timestamp) ||
            timestamp <= 0
        ) {
            return { ok: false, error: 'The saved anchor position is outside valid coordinate bounds.' };
        }
        const safeAnchor: AnchorPosition = {
            latitude,
            longitude,
            timestamp,
        };

        const rawWatchStartedAt = value.watchStartedAt;
        const safeWatchStartedAt =
            typeof rawWatchStartedAt === 'number' && Number.isFinite(rawWatchStartedAt) && rawWatchStartedAt > 0
                ? rawWatchStartedAt
                : undefined;
        const invalid = (error: string): PersistedWatchValidation => ({
            ok: false,
            error,
            anchorPosition: safeAnchor,
            watchStartedAt: safeWatchStartedAt,
        });

        const configValidation = validateAndNormalizeAnchorWatchConfig(value.config);
        if (!configValidation.ok) {
            return invalid(`The saved anchor configuration is invalid. ${configValidation.error}`);
        }
        if (value.state !== 'watching' && value.state !== 'alarm' && value.state !== 'paused') {
            return invalid('The saved Anchor Watch state is invalid.');
        }
        if (!safeWatchStartedAt) return invalid('The saved watch start time is invalid.');
        if (typeof value.savedAt !== 'number' || !Number.isFinite(value.savedAt) || value.savedAt <= 0) {
            return invalid('The saved recovery timestamp is invalid.');
        }
        if (value.alarmCause != null && value.alarmCause !== 'drag' && value.alarmCause !== 'gps-lost') {
            return invalid('The saved alarm cause is invalid.');
        }
        if (
            value.alarmTriggeredAt != null &&
            (typeof value.alarmTriggeredAt !== 'number' ||
                !Number.isFinite(value.alarmTriggeredAt) ||
                value.alarmTriggeredAt <= 0)
        ) {
            return invalid('The saved alarm timestamp is invalid.');
        }

        return {
            ok: true,
            watch: {
                anchorPosition: safeAnchor,
                config: configValidation.config,
                state: value.state,
                watchStartedAt: safeWatchStartedAt,
                alarmTriggeredAt: value.alarmTriggeredAt == null ? null : value.alarmTriggeredAt,
                alarmCause: value.alarmCause == null ? null : value.alarmCause,
                identityKey: scope.key,
                savedAt: value.savedAt,
            },
        };
    }

    /**
     * A corrupt recovery record is evidence of an interrupted/unknown safety
     * state. Keep it visible and removable, but never start GPS or install a
     * fence from its untrusted values.
     */
    private markInvalidPersistedWatchBlocked(
        scope: AuthIdentityScope,
        error: string,
        anchorPosition?: AnchorPosition,
        watchStartedAt?: number,
    ): void {
        this.stopGpsWatchdog();
        this.state = 'paused';
        this.anchorPosition = anchorPosition ? { ...anchorPosition } : null;
        this.vesselPosition = null;
        this.config = { ...DEFAULT_ANCHOR_CONFIG };
        this.swingRadius = 0;
        this.distanceFromAnchor = 0;
        this.maxDistanceRecorded = 0;
        this.bearingToAnchor = 0;
        this.positionHistory = [];
        this.alarmTriggeredAt = null;
        this.alarmCause = null;
        this.watchStartedAt = watchStartedAt ?? null;
        this.lastUsableFixAt = null;
        this.gpsAccuracy = 0;
        this.outsideCircleCount = 0;
        this.jitterBuffer = [];
        this.resetPrimaryGpsSource();
        this.watchPersistenceScope = scope;
        this.setupError = `Saved Anchor Watch is blocked and was not armed. ${error} Use Weigh Anchor to clear it, then set the anchor again.`;
        this.notify();
    }

    private async markRestoreBlocked(
        persisted: PersistedWatchState,
        scope: AuthIdentityScope,
        cause: unknown,
        deviceRecovery = false,
    ): Promise<void> {
        const cleanupFailures: Error[] = [];
        await this.captureFailure(() => this.stopGpsMonitoring(), cleanupFailures);
        await this.captureFailure(() => KeepAwake.allowSleep(), cleanupFailures);

        if (!deviceRecovery && !isAuthIdentityScopeCurrent(scope)) {
            this.finishIdentityFencedRestore(scope, cleanupFailures);
            return;
        }

        const failures = [this.asError(cause), ...cleanupFailures];

        this.anchorPosition = { ...persisted.anchorPosition };
        this.config = { ...persisted.config };
        this.swingRadius = calculateSwingRadius(this.config);
        this.watchStartedAt = persisted.watchStartedAt;
        this.watchPersistenceScope = scope;
        this.positionHistory = [];
        this.vesselPosition = null;
        this.maxDistanceRecorded = 0;
        this.distanceFromAnchor = 0;
        this.outsideCircleCount = 0;
        this.jitterBuffer = [];
        this.resetPrimaryGpsSource();
        this.stopGpsWatchdog();

        if (persisted.state === 'alarm') {
            this.state = 'alarm';
            this.alarmCause = persisted.alarmCause ?? 'drag';
            this.alarmTriggeredAt = persisted.alarmTriggeredAt ?? persisted.savedAt;
        } else {
            this.state = 'paused';
            this.alarmCause = null;
            this.alarmTriggeredAt = null;
        }

        this.setupError = this.failureMessage(
            'Saved Anchor Watch could not resume verified monitoring. Its position is retained; retry recovery or Weigh Anchor.',
            failures,
        );
        this.persistWatchState();

        if (this.state === 'alarm') {
            const recoveryError = this.setupError;
            try {
                await this.restoreAlarmOutputs(true);
                this.setupError = this.setupError ? `${recoveryError} ${this.setupError}` : recoveryError;
            } catch (outputError) {
                this.setupError = this.failureMessage(recoveryError, [this.asError(outputError)]);
            }
        }
        this.notify();
    }

    private async cleanupAfterIdentityFenceFailure(): Promise<Error[]> {
        const failures: Error[] = [];
        await this.captureFailure(() => this.stopGpsMonitoring(), failures);
        await this.captureFailure(() => KeepAwake.allowSleep(), failures);
        if (failures.length > 0) {
            log.error('Identity-fenced Anchor Watch cleanup was not confirmed', failures);
        }
        return failures;
    }

    /**
     * Finish a restore whose auth fence changed while native work was in
     * flight. Successful cleanup can return to idle without touching the
     * original account's recovery record. Failed cleanup must retain both its
     * ownership scope and a visible paused state so stopWatch can retry it.
     */
    private finishIdentityFencedRestore(scope: AuthIdentityScope, cleanupFailures: Error[]): boolean {
        this.stopGpsWatchdog();
        if (cleanupFailures.length > 0) {
            this.state = 'paused';
            this.watchPersistenceScope = scope;
            this.setupError = this.failureMessage(
                'Account changed while restoring Anchor Watch. Native cleanup is not confirmed; the saved watch remains owned by the previous account. Retry Weigh Anchor.',
                cleanupFailures,
            );
            this.notify();
            return true;
        }

        this.state = 'idle';
        this.anchorPosition = null;
        this.vesselPosition = null;
        this.config = { ...DEFAULT_ANCHOR_CONFIG };
        this.swingRadius = 0;
        this.positionHistory = [];
        this.alarmTriggeredAt = null;
        this.alarmCause = null;
        this.watchStartedAt = null;
        this.lastUsableFixAt = null;
        this.maxDistanceRecorded = 0;
        this.distanceFromAnchor = 0;
        this.bearingToAnchor = 0;
        this.gpsAccuracy = 0;
        this.outsideCircleCount = 0;
        this.jitterBuffer = [];
        this.resetPrimaryGpsSource();
        this.watchPersistenceScope = null;
        this.setupError = 'Account changed while restoring Anchor Watch. The saved watch was not discarded.';
        this.notify();
        return false;
    }

    /** Start at least one verified GPS monitoring path or fail closed. */
    private async startGpsMonitoring(): Promise<void> {
        if (this.bgGeoLeaseHeld || this.anchorGeofenceOwned) {
            throw new Error('A previous Anchor Watch GPS lease is still active; recovery must finish before restart.');
        }
        // Revalidate immediately before acquiring any live monitoring effects.
        // This is intentionally redundant with the UI/service boundary: a
        // corrupt in-memory value must never reach even the web/NMEA path.
        this.normalizeOperationalConfigOrThrow();
        this.requireValidAnchorPosition();
        // Remove any leftover subscriptions
        this.cleanupSubscriptions();
        this.resetPrimaryGpsSource();
        let nmeaMonitoringVerified = false;
        let nativeMonitoringVerified = false;

        try {
            // Subscribe to location updates via shared manager (phone GPS)
            const unsubLoc = BgGeoManager.subscribeLocation((pos) => {
                this.handleGpsUpdate(
                    {
                        latitude: pos.latitude,
                        longitude: pos.longitude,
                        accuracy: pos.accuracy,
                        heading: pos.heading ?? 0,
                        speed: pos.speed,
                        timestamp: pos.timestamp,
                    },
                    'native',
                );
            });
            this.bgUnsubscribers.push(unsubLoc);

            // NMEA may be the foreground primary while fresh, but iOS phone
            // GPS continues running as the mandatory locked-screen fallback.
            const unsubNmea = NmeaGpsProvider.onPosition((nmeaPos) => {
                this.handleGpsUpdate(
                    {
                        latitude: nmeaPos.latitude,
                        longitude: nmeaPos.longitude,
                        accuracy: nmeaPos.accuracy,
                        heading: nmeaPos.heading ?? 0,
                        speed: nmeaPos.speed,
                        timestamp: nmeaPos.timestamp,
                    },
                    'nmea',
                );
            });
            this.bgUnsubscribers.push(unsubNmea);
            const initialNmea = NmeaGpsProvider.getPosition();
            nmeaMonitoringVerified = initialNmea !== null;
            if (initialNmea) {
                this.lastSourceFixAt.nmea = Math.min(initialNmea.timestamp, Date.now());
                this.switchPrimaryGpsSource('nmea');
            }

            // Subscribe to geofence events via shared manager
            const unsubGeo = BgGeoManager.subscribeGeofence((event) => {
                if (event.identifier === GEOFENCE_ID && event.action === 'EXIT') {
                    void this.triggerAlarm();
                }
            });
            this.bgUnsubscribers.push(unsubGeo);

            if (Capacitor.isNativePlatform()) {
                await BgGeoManager.ensureReady();
                // A live LAN/NMEA stream is useful supplemental position
                // input, but it does not prove a locked-screen iOS path.
                await BgGeoManager.requireAlwaysLocationAuthorization('anchor-watch');
                await this.updateGeofence();
                const leaseState = await BgGeoManager.requestStart();
                // Even an inactive result may carry a retained retry lease
                // after native cleanup failed. Own it before rejecting setup
                // so the catch path can release rather than orphaning GPS.
                this.bgGeoLeaseHeld = leaseState.activeLeaseCount > 0;
                nativeMonitoringVerified = leaseState.active && leaseState.nativeTrackingEnabled;
                if (!nativeMonitoringVerified) {
                    throw new Error(
                        'Background GPS did not start. Enable Always Location access for Thalassa and try again.',
                    );
                }
            }

            if (Capacitor.getPlatform() === 'ios' && !nativeMonitoringVerified) {
                throw new Error(
                    'Anchor Watch requires verified iOS Always Location monitoring. A live NMEA feed is supplemental and cannot replace the locked-screen phone path.',
                );
            }

            if (!nativeMonitoringVerified && !nmeaMonitoringVerified) {
                throw new Error(
                    Capacitor.isNativePlatform()
                        ? 'No live Anchor Watch monitoring path could be verified. Check Always Location access or connect a live NMEA GPS source.'
                        : 'No live Anchor Watch monitoring path could be verified. Connect a live NMEA GPS source or use the iOS app.',
                );
            }
        } catch (error) {
            throw error;
        }
    }

    /** Create or update the swing-circle geofence */
    private async updateGeofence(): Promise<void> {
        if (!this.anchorPosition) throw new Error('Cannot install an anchor geofence without an anchor position.');

        // Validate before removing the prior verified fence. A rejected update
        // therefore cannot turn a working watch into an unbounded one.
        this.normalizeOperationalConfigOrThrow();
        this.requireValidAnchorPosition();

        // Remove existing geofence first
        await BgGeoManager.removeGeofence(GEOFENCE_ID);
        this.anchorGeofenceOwned = false;

        // Add new geofence centered on anchor with swing radius
        await BgGeoManager.addGeofence({
            identifier: GEOFENCE_ID,
            latitude: this.anchorPosition.latitude,
            longitude: this.anchorPosition.longitude,
            radius: this.swingRadius,
            notifyOnEntry: true,
            notifyOnExit: true,
            notifyOnDwell: false,
        });
        this.anchorGeofenceOwned = true;
    }

    private normalizeOperationalConfigOrThrow(): void {
        const validated = validateAndNormalizeAnchorWatchConfig(this.config);
        if (!validated.ok) {
            throw new Error(`Anchor Watch configuration is invalid. ${validated.error}`);
        }
        const radius = calculateValidatedSwingRadius(validated.config);
        if (!Number.isFinite(radius) || radius < MIN_ANCHOR_SWING_RADIUS_M) {
            throw new Error('Anchor Watch swing radius is invalid and cannot be monitored safely.');
        }
        this.config = validated.config;
        this.swingRadius = radius;
    }

    private requireValidAnchorPosition(): void {
        if (
            !this.anchorPosition ||
            !Number.isFinite(this.anchorPosition.latitude) ||
            this.anchorPosition.latitude < -90 ||
            this.anchorPosition.latitude > 90 ||
            !Number.isFinite(this.anchorPosition.longitude) ||
            this.anchorPosition.longitude < -180 ||
            this.anchorPosition.longitude > 180
        ) {
            throw new Error('Anchor position is invalid and cannot be monitored safely.');
        }
    }

    /** Stop GPS monitoring and clean up */
    private async stopGpsMonitoring(): Promise<void> {
        const failures: Error[] = [];
        if (this.anchorGeofenceOwned) {
            try {
                await BgGeoManager.removeGeofence(GEOFENCE_ID);
                this.anchorGeofenceOwned = false;
            } catch (error) {
                log.warn('stopGpsMonitoring: geofence cleanup failed', error);
                failures.push(this.asError(error));
            }
        }
        if (this.bgGeoLeaseHeld) {
            try {
                await BgGeoManager.requestStop();
                this.bgGeoLeaseHeld = false;
            } catch (error) {
                log.warn('stopGpsMonitoring: GPS lease cleanup failed', error);
                failures.push(this.asError(error));
            }
        }
        if (failures.length > 0) {
            throw new Error(this.failureMessage('Native Anchor Watch GPS teardown was not confirmed.', failures));
        }
        this.cleanupSubscriptions();
    }

    /** Roll back every externally visible effect of a failed arm/restore transaction. */
    private async rollbackFailedSetup(scope: AuthIdentityScope, error: unknown): Promise<void> {
        this.stopGpsWatchdog();
        const cleanupFailures: Error[] = [];
        await this.captureFailure(() => this.stopGpsMonitoring(), cleanupFailures);
        await this.captureFailure(() => KeepAwake.allowSleep(), cleanupFailures);

        if (cleanupFailures.length > 0 && this.anchorPosition) {
            this.state = 'paused';
            this.watchStartedAt ??= Date.now();
            this.watchPersistenceScope = scope;
            this.setupError = this.failureMessage(
                `${this.asError(error).message} Setup rollback is not confirmed; Anchor Watch may still be armed.`,
                cleanupFailures,
            );
            this.persistWatchState();
            this.notify();
            return;
        }

        this.state = 'idle';
        this.anchorPosition = null;
        this.vesselPosition = null;
        this.positionHistory = [];
        this.alarmTriggeredAt = null;
        this.alarmCause = null;
        this.alarmNotificationError = null;
        this.watchStartedAt = null;
        this.lastUsableFixAt = null;
        this.maxDistanceRecorded = 0;
        this.distanceFromAnchor = 0;
        this.outsideCircleCount = 0;
        this.jitterBuffer = [];
        this.resetPrimaryGpsSource();
        this.setupError = this.asError(error).message;
        this.clearPersistedWatchState(scope);
        this.watchPersistenceScope = null;
        this.notify();
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

    private handleGpsUpdate(position: VesselPosition, source: GpsSource): void {
        // Filter poor accuracy readings
        if (
            !Number.isFinite(position.latitude) ||
            !Number.isFinite(position.longitude) ||
            !Number.isFinite(position.accuracy) ||
            position.accuracy <= 0 ||
            position.accuracy > MIN_GPS_ACCURACY
        ) {
            return;
        }

        const now = Date.now();
        const fixMs = Math.min(position.timestamp || now, now);
        if (fixMs <= 0 || now - fixMs > PRIMARY_SOURCE_FRESH_MS) return;
        this.lastSourceFixAt[source] = Math.max(this.lastSourceFixAt[source] ?? 0, fixMs);

        if (!this.shouldUseGpsSource(source, now)) return;

        this.gpsAccuracy = position.accuracy;

        // Watchdog clock: mark that a USABLE fix arrived. Use the fix's own
        // timestamp (clamped to now so a future/clock-skewed stamp can't delay
        // the watchdog) and only ever move it FORWARD, so BgGeo replaying an
        // old fix can't reset the staleness clock and mask a real GPS loss.
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

    private shouldUseGpsSource(source: GpsSource, now: number): boolean {
        if (!this.primaryGpsSource) {
            this.switchPrimaryGpsSource(source);
            return true;
        }
        if (source === this.primaryGpsSource) return true;

        // Prefer a fresh NMEA feed in the foreground. Native phone GPS stays
        // leased/subscribed on iOS, but its fixes are ignored until NMEA has
        // missed two emission windows. This prevents averaging two receivers'
        // offsets into a false drag movement.
        if (source === 'nmea') {
            this.switchPrimaryGpsSource('nmea');
            return true;
        }

        const nmeaFixAt = this.lastSourceFixAt.nmea;
        if (this.primaryGpsSource === 'nmea' && (!nmeaFixAt || now - nmeaFixAt > PRIMARY_SOURCE_FRESH_MS)) {
            this.switchPrimaryGpsSource('native');
            return true;
        }
        return false;
    }

    private switchPrimaryGpsSource(source: GpsSource): void {
        if (this.primaryGpsSource === source) return;
        this.primaryGpsSource = source;
        this.jitterBuffer = [];
        this.outsideCircleCount = 0;
    }

    private resetPrimaryGpsSource(): void {
        this.primaryGpsSource = null;
        this.lastSourceFixAt = { native: null, nmea: null };
        this.jitterBuffer = [];
        this.outsideCircleCount = 0;
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
        if (fire) void this.triggerAlarm('drag');
    }

    private async triggerAlarm(cause: 'drag' | 'gps-lost' = 'drag'): Promise<void> {
        return this.runExclusive(() => this.triggerAlarmLocked(cause));
    }

    private async triggerAlarmLocked(cause: 'drag' | 'gps-lost'): Promise<void> {
        if (this.state !== 'watching') return;

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

        // Start both independent alarm outputs. The visible alarm state is
        // retained if either path fails, with an actionable error for retry.
        await this.restoreAlarmOutputs(false);

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
     * One immediate notification plus 20 repeats spaced 30 s apart. The
     * signed iOS bridge must confirm all 21 as Time Sensitive; that level can
     * be disabled by the user and is not an unconditional Focus bypass.
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

        if (Capacitor.getPlatform() === 'ios') {
            const scheduled = await AnchorSafetyNotificationService.scheduleAlarm(title, body);
            if (!scheduled) throw new Error('The native iOS Time Sensitive notification bridge did not run.');
            this.alarmNotificationError = null;
            return;
        }

        // Non-iOS native fallback: enqueue discrete reminders through the
        // platform LocalNotifications implementation.
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

        await LocalNotifications.schedule({
            notifications: schedules.map(({ id, atMs }) => ({
                id,
                title,
                body,
                schedule: { at: new Date(atMs) },
                sound: 'beep.caf',
                extra: { kind: 'anchor-drag' },
            })),
        });
    }

    /** Cancel every alarm-related local notification (acknowledge + stop). */
    private async cancelAlarmNotifications(): Promise<void> {
        if (!Capacitor.isNativePlatform()) return;
        if (Capacitor.getPlatform() === 'ios') {
            await AnchorSafetyNotificationService.cancelAlarm();
            return;
        }
        const ids = [
            { id: NOTIF_ID_PRIMARY },
            ...Array.from({ length: NOTIF_REPEAT_COUNT }, (_, i) => ({
                id: NOTIF_ID_REPEAT_BASE + i,
            })),
        ];
        await LocalNotifications.cancel({ notifications: ids });
    }

    private async startAlarmSound(): Promise<void> {
        // Use playback-category native alarm audio. Actual audibility remains
        // dependent on the route, system volume, and the pre-arm sound check.
        // The
        // setInterval-based haptic loop that used to live here was
        // removed 2026-05-17 — haptics during full app suspension
        // don't fire on iOS anyway (the JS event loop is frozen), so
        // the loop was wasted code that only produced noise during
        // the brief foreground window where the triple-burst above
        // already covers. The LocalNotification fallback in
        // scheduleAlarmNotifications() handles the during-suspension
        // wake-up signal instead.
        if (this.alarmAudioToken) return;
        this.alarmAudioToken = await AlarmAudioService.acquire('anchor-watch');
    }

    private async stopAlarmOutputs(): Promise<void> {
        if (this.alarmInterval) {
            clearInterval(this.alarmInterval);
            this.alarmInterval = null;
        }

        const failures: Error[] = [];
        if (this.alarmAudioToken) {
            const token = this.alarmAudioToken;
            try {
                await AlarmAudioService.release(token);
                this.alarmAudioToken = null;
            } catch (error) {
                failures.push(this.asError(error));
            }
        }
        await this.captureFailure(() => this.cancelAlarmNotifications(), failures);

        if (failures.length > 0) {
            throw new Error(this.failureMessage('Anchor alarm output cancellation was not confirmed.', failures));
        }
    }

    private async restoreAlarmOutputs(recoveringPersistedAlarm: boolean): Promise<void> {
        const failures: Error[] = [];

        if (recoveringPersistedAlarm) {
            // A WebView reload can lose the JS lease while the native player
            // remains alive. `acquire` deliberately calls native start when
            // JS has no leases; native start is idempotent and reclaims that
            // player without introducing a silent stop/restart gap. Never use
            // forceStop here because it would also erase valid leases held by
            // Shore Watch or Calypso after they have initialized.
            this.alarmAudioToken = null;
        }

        await this.captureFailure(() => this.startAlarmSound(), failures);
        try {
            await this.scheduleAlarmNotifications();
            this.alarmNotificationError = null;
        } catch (error) {
            const detail = this.asError(error).message;
            this.alarmNotificationError = `Locked-screen fallback unavailable: ${detail}`;
            failures.push(this.asError(error));
        }

        if (failures.length > 0) {
            this.setupError = this.failureMessage(
                'Anchor alarm is active, but one or more warning paths failed.',
                failures,
            );
            log.error('Anchor Watch alarm output failed closed', failures);
        } else {
            this.setupError = null;
        }
    }

    private async captureFailure(operation: () => Promise<unknown>, failures: Error[]): Promise<void> {
        try {
            await operation();
        } catch (error) {
            failures.push(this.asError(error));
        }
    }

    private asError(error: unknown): Error {
        if (error instanceof Error && error.message.trim()) return error;
        if (typeof error === 'string' && error.trim()) return new Error(error);
        return new Error('Unknown native safety error.');
    }

    private failureMessage(summary: string, failures: Error[]): string {
        const details = [...new Set(failures.map((failure) => failure.message.trim()).filter(Boolean))];
        return details.length > 0 ? `${summary} ${details.join(' ')}` : summary;
    }

    private notify(): void {
        setLiveAnchorSafetyState(this.state !== 'idle');
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
                    generatedAt: Date.now(),
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
        if (!FEATURE_VISIBILITY.guardian) {
            this.guardianArmedByUs = false;
            this.guardianStatus = 'idle';
            return;
        }
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
        if (!FEATURE_VISIBILITY.guardian) {
            this.guardianArmedByUs = false;
            this.guardianStatus = 'idle';
            return;
        }
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
