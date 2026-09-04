/**
 * @filesize-justified Service class with 6 sub-modules (shiplog/helpers, EntrySave, OfflineQueue, EntryCrud, GpsTrackBuffer, waterDetection). Core orchestrator cannot be further decomposed.
 */
/**
 * Ship's Log Service
 * Automatic GPS-based logging for maritime navigation
 *
 * Features:
 * - 15-minute automatic position tracking
 * - Distance/speed calculations (Haversine formula)
 * - Weather snapshots per entry
 * - Auto-pause when anchored (no movement for 1 hour)
 * - Manual entry support
 *
 * GPS Engine: @transistorsoft/capacitor-background-geolocation (Premium)
 * - Bulletproof background tracking (survives app kill, screen lock)
 * - Native SQLite persistence (zero data loss on crash)
 * - Explicit voyage-scoped lease and sampling control (no motion permission)
 * - Works with screen locked, app backgrounded, or terminated
 */

import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { ShipLogEntry } from '../types';
import { BgGeoManager, CachedPosition } from './BgGeoManager';
import { EnvironmentService } from './EnvironmentService';
import { createLogger } from '../utils/createLogger';
import { crumb } from '../utils/flightRecorder';
import { calculateDistance } from '../utils/navigationCalculations';

// --- Extracted modules ---
import { savePassagePlanToLogbook as _savePassagePlanToLogbook } from './shiplog/PassagePlanSave';
import { getPlottingProfile, type PlottingProfile } from './shiplog/helpers';
import { GpsTrackBuffer } from './shiplog/GpsTrackBuffer';
import { GpsPrecision } from './shiplog/GpsPrecisionTracker';
import {
    loadTrackingState,
    saveTrackingState as _saveTrackingState,
    clearVoyageState as _clearVoyageState,
    decideInitTrackingAction,
    activeBoatIdFromTrackingState,
    activeVoyageIdFromTrackingState,
    suspendTrackingStateForIdentityChange,
    type TrackingState,
} from './shiplog/TrackingStateStore';
import { flushPlanLinkIntents } from './shiplog/planLinkIntent';
import { CourseChangeDetector } from './shiplog/CourseChangeDetector';
import { EnvironmentPoller } from './shiplog/EnvironmentPoller';
import { ShoreZoneResolver } from './shiplog/ShoreZoneResolver';
import type { WaterCheckResult } from './shiplog/waterDetection';
import { AdaptiveScheduler } from './shiplog/AdaptiveScheduler';
import { GpsSubscriptionManager } from './shiplog/GpsSubscriptionManager';
import {
    captureImmediate as _captureImmediate,
    captureLog as _captureLog,
    addManual as _addManual,
    flushBufferedTrack as _flushBufferedTrack,
    drainBufferedTrackForHandoff,
    type CaptureContext,
    type CaptureLogOptions,
    type AddManualOptions,
    type FlushBufferedTrackResult,
} from './shiplog/CapturePipeline';
import { getGpsStatus as _getGpsStatus, getGpsNavData as _getGpsNavData } from './shiplog/PositionResolver';
import { isCaptureLocalOnly, setCaptureLocalOnly } from './shiplog/EntrySave';
import {
    startLiveTrickle,
    stopLiveTrickle,
    retireLiveTrackVoyage,
    disarmLiveTrickleForIdentityChange,
} from './shiplog/LiveTrickle';
import {
    syncOfflineQueue as _syncOfflineQueue,
    getOfflineQueueCount as _getOfflineQueueCount,
    getOfflineEntries as _getOfflineEntries,
    deleteVoyageFromOfflineQueue as _deleteVoyageFromOfflineQueue,
} from './shiplog/OfflineQueue';
import { setCachedVoyageTrack } from './shiplog/VoyageTrackCache';
import {
    getLogEntries as _getLogEntries,
    getArchivedEntries as _getArchivedEntries,
    getAllEntriesForCareer as _getAllEntriesForCareer,
    archiveVoyage as _archiveVoyage,
    unarchiveVoyage as _unarchiveVoyage,
    deleteVoyage as _deleteVoyage,
    deleteEntry as _deleteEntry,
    importGPXVoyage as _importGPXVoyage,
    type ImportGPXOptions,
} from './shiplog/EntryCrud';
import {
    getVoyageSummaries as _getVoyageSummaries,
    getCachedVoyageSummaries as _getCachedVoyageSummaries,
    getVoyageEntries as _getVoyageEntries,
    EMPTY_TRACK_NM,
    type VoyageSummary,
} from './shiplog/VoyageSummary';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from './authIdentityScope';
// Both are safe as static imports — neither module imports this service, so
// no cycle. (publishFollowedRoute DOES, which is why the public link is
// cleared through VoyageLogService directly rather than through it.)
import { useFollowRouteStore } from '../stores/followRouteStore';

const log = createLogger('ShipLog');

// --- CONSTANTS still owned by the orchestrator ---
//
// Constants used only inside the capture pipeline (DEDUP_THRESHOLD_NM,
// STATIONARY_THRESHOLD_NM, MAX_PLAUSIBLE_SPEED_KTS, MAX_ACCELERATION_KTS,
// GPS_STALE_LIMIT_MS) live in CapturePipeline.ts now. Storage keys +
// state interfaces live in TrackingStateStore.ts. Helper functions, DB
// mapping, and zone detection live in helpers.ts.

const TRACKING_INTERVAL_MS = 3 * 1000; // land / inshore safe fallback
const RAPID_INTERVAL_MS = 3 * 1000; // manual marina override matches dense geographic profile
const VOYAGE_STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000; // 6 hours — start new voyage instead of resuming
/**
 * Cold-start fast-lock (distanceFilter:0) duration for a new voyage.
 *
 * MUST OUTLIVE GpsSubscriptionManager's COLD_START_FALLBACK_MS (60 s), which is
 * when the opening-fix accuracy bar finally relaxes from 35 m to 100 m. At 30 s
 * these were misordered: fast-lock switched off at t=30 s, so from t=30 s to
 * t=60 s the engine was back on distanceFilter:1 and emitting almost nothing
 * while stationary — and then the accuracy bar dropped at exactly the moment
 * there were no fixes left flowing to take advantage of it. A poor-sky dock
 * could sit there until the boat physically moved.
 *
 * 65 s costs nothing in the normal case: settleFastLock() reverts the instant a
 * vetted fix opens the track, so this ceiling only ever applies while we are
 * still starving — which is precisely when we want it.
 */
const FAST_LOCK_MS = 65 * 1000;
/**
 * Re-arm ceiling for the gate-closed fast-lock loop (~10 min total). Staying
 * in fast-lock while the first-fix gate is closed is deliberate (2026-08-02:
 * "acquiring GPS fix… for hours"), but an unopenable gate — persistent >100 m
 * accuracy, a wedged corroboration stream — must not latch distanceFilter:0
 * (emit on EVERY chip update) for the whole session: that is a maximum-rate
 * Capacitor-bridge flood. The accuracy ceiling relaxes at 60 s, so ten
 * minutes is ample; past the cap the 1 m filter still lets the gate open,
 * just more slowly.
 */
const FAST_LOCK_MAX_REARMS = 8;
const CAPTURE_HANDOFF_KEY = 'ship_log_capture_handoff';
const CAPTURE_HANDOFF_VERSION = 1;

// ── Device-local stop record ────────────────────────────────────────
// voyageId → when THIS DEVICE stopped it. The empty-track sweep holds
// recently-active voyages for 15 min because another device might still be
// recording into them — but a voyage this device just stopped has no such
// ambiguity, and holding it anyway is why a nowhere-track's card lingered
// after an end from the Vessel hub (Shane 2026-08-12: "taking too long to
// show up"). Persisted so an app relaunch between stop and sweep still
// knows; pruned at read so it cannot grow.
const DEVICE_STOPS_KEY = 'thalassa.recent_device_stops';
const DEVICE_STOPS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function readDeviceStops(): Record<string, number> {
    try {
        const raw = localStorage.getItem(DEVICE_STOPS_KEY);
        const parsed = raw ? (JSON.parse(raw) as Record<string, number>) : {};
        const cutoff = Date.now() - DEVICE_STOPS_MAX_AGE_MS;
        return Object.fromEntries(Object.entries(parsed).filter(([, at]) => typeof at === 'number' && at >= cutoff));
    } catch {
        return {};
    }
}

function recordDeviceStop(voyageId: string): void {
    try {
        localStorage.setItem(DEVICE_STOPS_KEY, JSON.stringify({ ...readDeviceStops(), [voyageId]: Date.now() }));
    } catch {
        // Quota/private mode: the sweep just falls back to the 15-min hold.
    }
}

/** Voyages this device stopped in the last 24 h — the sweep may prune these
 *  without waiting out the cross-device recency hold. */
export function getRecentDeviceStops(): Set<string> {
    return new Set(Object.keys(readDeviceStops()));
}

interface CaptureHandoffBatch {
    id: string;
    voyageId: string;
    points: CachedPosition[];
}

interface CaptureHandoffStore {
    version: typeof CAPTURE_HANDOFF_VERSION;
    ownerKey: string;
    ownerUserId: string | null;
    batches: CaptureHandoffBatch[];
}

class StartTrackingCancelledError extends Error {
    constructor() {
        super('Voyage tracking start was cancelled before it completed.');
        this.name = 'StartTrackingCancelledError';
    }
}

// --- MAIN SERVICE CLASS ---

/**
 * The requested voyage does not hold GPS logging — a DIFFERENT voyage does.
 * Exported so endVoyage can archive a voyage that has no tracking to tear
 * down (the Cast Off zombie trap, Shane 2026-08-26: a 26-July row stayed
 * active for a month because stopTracking threw on the id mismatch and
 * Retry GPS silently no-opped, dead-ending BOTH buttons).
 */
export class DifferentVoyageTrackingError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DifferentVoyageTrackingError';
    }
}

class ShipLogServiceClass {
    // Platform detection: native (iOS/Android) uses Transistorsoft BgGeo;
    // web uses navigator.geolocation + setInterval fallbacks.
    private readonly isNative = Capacitor.isNativePlatform();
    // Tick scheduling lives in AdaptiveScheduler — it owns the
    // alignment-timeout + recurring-interval pair and exposes isRunning().
    private scheduler = new AdaptiveScheduler();
    private syncIntervalId?: NodeJS.Timeout;
    private rapidModeTimeoutId?: NodeJS.Timeout; // 15-minute auto-disable for rapid mode
    private precisionModeTimeoutId?: NodeJS.Timeout; // 60-minute auto-disable for precision mode (battery guard)
    // Cold-start fast-lock (distanceFilter:0) auto-revert. Armed only for
    // a GENUINELY new voyage; reverted after FAST_LOCK_MS. Stored on the
    // instance + cleared in stop/pause + an idempotent same-voyage check
    // in the callback so a late/stale fire (stop within 30 s, iOS
    // background-throttled timer, reload race) is always a clean no-op.
    private fastLockTimeoutId?: NodeJS.Timeout;
    private fastLockArmedForVoyageId?: string;
    private fastLockRearmCount = 0;
    /** False until the GPS subscription has admitted a first vetted track fix. */
    private trackGpsGateOpen = false;
    // (envCheckIntervalId moved into EnvironmentPoller — see this.envPoller below)
    // GPS subscriptions, fix-acceptance gate, speed-tier debounce, and
    // heartbeat all live in GpsSubscriptionManager.
    private gpsSubs = new GpsSubscriptionManager();
    private trackingState: TrackingState = { isTracking: false, isPaused: false, isRapidMode: false };
    /** Exact auth generation that owns the visible/armed voyage. */
    private trackingOwnerScope: AuthIdentityScope | null = null;
    /** Invalidates overlapping start calls within one auth generation. */
    private startAttempt = 0;
    /** Same-scope callers join one transactional voyage start. */
    private startOperation: {
        scope: AuthIdentityScope;
        voyageId?: string;
        promise: Promise<void>;
    } | null = null;
    /** Same-scope callers join one complete, bridge-verified voyage stop. */
    private stopOperation: {
        scope: AuthIdentityScope;
        voyageId?: string;
        promise: Promise<void>;
    } | null = null;
    /** One ref-counted native GPS lease held by this service, if any. */
    private nativeLeaseScope: AuthIdentityScope | null = null;
    /** Every path releasing this service's native lease joins the same bridge transition. */
    private nativeLeaseReleaseOperation: { scope: AuthIdentityScope; promise: Promise<void> } | null = null;
    /** Joins strict-read → reclaim → release → durable marker clear as one transaction. */
    private pendingNativeReleaseOperation: {
        scope: AuthIdentityScope;
        state: TrackingState;
        promise: Promise<void>;
    } | null = null;
    /** Final voyage work completed, but native GPS teardown still needs retry. */
    private pendingStop: { scope: AuthIdentityScope; state: TrackingState; voyageId?: string } | null = null;
    /** Serialises durable raw-fix handoffs independently per account. */
    private captureHandoffTails = new Map<string, Promise<void>>();
    /**
     * Serialises all writes that advance a voyage's durable position anchor.
     * Immediate selected-point flushes and a user-created manual entry can
     * otherwise both read the same last position then race to overwrite it,
     * corrupting the following leg's distance/speed. A weak key keeps a
     * completed voyage state collectable after a new session replaces it.
     */
    private captureWriteTails = new WeakMap<TrackingState, Promise<void>>();
    /**
     * In-memory copy retained until Preferences confirms the write. It is
     * scoped by owner and never exposed through the live buffer of another
     * account.
     */
    private pendingCaptureHandoffs = new Map<string, CaptureHandoffBatch[]>();

    // Cached water detection status — updated by bounded environment polling.
    // Stamped onto every log entry so career totals can filter out land tracks.
    private lastWaterStatus: boolean | undefined = undefined;
    /** Structured water confidence for ShoreZoneResolver; fail-open is never offshore evidence. */
    private lastWaterCheck: WaterCheckResult | undefined = undefined;

    // --- BATTLE-HARDENED GPS STREAMING ---
    // onLocation continuously caches the latest position. Timers decide WHEN to log,
    // but never block on getCurrentPosition. This survives background, suspension,
    // and cold starts — the position is always available. The GpsSubscriptionManager
    // keeps this in sync via its `onFix` callback.
    private lastBgLocation: CachedPosition | null = null;
    /**
     * Last location that cleared GpsSubscriptionManager's full acceptance
     * gate. Unlike `lastBgLocation`, this is safe for plotting decisions,
     * shoreline classification, and non-buffered capture fallbacks.
     */
    private lastAcceptedLocation: CachedPosition | null = null;

    // --- GEOGRAPHIC PLOT-POINT BUFFER ---
    // GpsSubscriptionManager keeps raw GPS live for UI and alarms, then retains
    // vetted vertices at the active 3s / 30s / 5min geographic profile.
    private trackBuffer = new GpsTrackBuffer();

    // --- POSITION-BASED COURSE CHANGE DETECTION ---
    // Implementation lives in ./shiplog/CourseChangeDetector.ts. This
    // orchestrator just owns the instance and wires the callbacks.
    private courseDetector = new CourseChangeDetector();

    // --- 60s ENVIRONMENT POLLING ---
    // Implementation lives in ./shiplog/EnvironmentPoller.ts. Same pattern.
    private envPoller = new EnvironmentPoller();
    /** Position-scoped OSM shoreline resolver — never reads dashboard weather. */
    private shoreZoneResolver = new ShoreZoneResolver();

    /**
     * Initialize the ship log service. Sets up GPS listeners, app lifecycle
     * handlers, and restores persisted tracking state from Preferences.
     * Safe to call multiple times — subsequent calls are no-ops.
     */
    private initializedGeneration: number | null = null;
    private initialization: { scope: AuthIdentityScope; promise: Promise<void> } | null = null;
    private lifecycleHandlersRegistered = false;
    private initializeWasRequested = false;

    constructor() {
        subscribeAuthIdentityScope((next, previous) => {
            this.handleIdentityTransition(next, previous);
        });
    }

    private sameScope(left: AuthIdentityScope | null, right: AuthIdentityScope): boolean {
        return left !== null && left.key === right.key && left.generation === right.generation;
    }

    private ownerIsCurrent(scope: AuthIdentityScope, state: TrackingState = this.trackingState): boolean {
        return (
            isAuthIdentityScopeCurrent(scope) &&
            this.sameScope(this.trackingOwnerScope, scope) &&
            state === this.trackingState
        );
    }

    /**
     * Release the one BgGeo lease owned by ShipLogService.
     *
     * BgGeoManager retains its final logical lease when native stop cannot be
     * verified. Keep `nativeLeaseScope` just as durable in memory: clearing the
     * owner before the bridge succeeds lets another account increment the
     * shared count and strands the first account's retry ownership. All pause,
     * stop, rollback, and identity-transition paths join this operation so one
     * logical lease can never be decremented twice by overlapping teardown.
     */
    private async releaseNativeLease(scope: AuthIdentityScope): Promise<void> {
        if (!this.isNative || !this.sameScope(this.nativeLeaseScope, scope)) return;

        const inFlight = this.nativeLeaseReleaseOperation;
        if (inFlight && this.sameScope(inFlight.scope, scope)) {
            await inFlight.promise;
            return;
        }

        const promise = BgGeoManager.requestStop().then(() => {
            if (this.sameScope(this.nativeLeaseScope, scope)) this.nativeLeaseScope = null;
        });
        this.nativeLeaseReleaseOperation = { scope, promise };
        try {
            await promise;
        } finally {
            if (this.nativeLeaseReleaseOperation?.promise === promise) this.nativeLeaseReleaseOperation = null;
        }
    }

    /**
     * Complete a persisted ShipLog native teardown without performing any
     * voyage-level work. Resume/Retry calls this directly; End Voyage calls it
     * before (and separately from) terminal finalization.
     *
     * A fresh WebView has no logical lease count. Only the durable marker may
     * authorize reclaiming exactly one shared lease, and only a strict bridge
     * read may prove that no reclaim is needed. A reclaimed retry lease is
     * released in this same operation—initialize never holds it speculatively.
     */
    private async completePendingNativeRelease(scope: AuthIdentityScope, state: TrackingState): Promise<void> {
        const inFlight = this.pendingNativeReleaseOperation;
        if (inFlight) {
            if (this.sameScope(inFlight.scope, scope) && inFlight.state === state) {
                await inFlight.promise;
                return;
            }
            await inFlight.promise;
            return this.completePendingNativeRelease(scope, state);
        }
        if (!state.nativeTeardownPending) return;

        const promise = this.performPendingNativeRelease(scope, state);
        this.pendingNativeReleaseOperation = { scope, state, promise };
        try {
            await promise;
        } finally {
            if (this.pendingNativeReleaseOperation?.promise === promise) {
                this.pendingNativeReleaseOperation = null;
            }
        }
    }

    private async performPendingNativeRelease(scope: AuthIdentityScope, state: TrackingState): Promise<void> {
        const pendingIntent = state.nativeTeardownPending;
        if (!pendingIntent) return;
        if (!this.ownerIsCurrent(scope, state)) {
            throw new Error('Pending voyage GPS teardown was superseded by another account session.');
        }
        let releasedRetainedLease = false;
        const retainedLeaseScope = this.nativeLeaseScope;
        if (retainedLeaseScope && !this.sameScope(retainedLeaseScope, scope)) {
            if (retainedLeaseScope.key !== scope.key) {
                throw new Error('Pending voyage GPS teardown belongs to a different account session.');
            }
            // Auth generations fence stale callbacks, but the logical native
            // lease survives A→B→A. Release it through its captured generation
            // so we join an old transition operation instead of issuing a
            // second requestStop or incrementing the retained logical lease.
            await this.releaseNativeLease(retainedLeaseScope);
            releasedRetainedLease = true;
            if (!this.ownerIsCurrent(scope, state)) {
                throw new Error('Pending voyage GPS teardown was superseded by another account session.');
            }
        }

        const releasing = this.nativeLeaseReleaseOperation;
        if (releasing && this.sameScope(releasing.scope, scope)) {
            await releasing.promise;
            if (!this.ownerIsCurrent(scope, state)) {
                throw new Error('Pending voyage GPS teardown was superseded by another account session.');
            }
        }

        if (this.sameScope(this.nativeLeaseScope, scope)) {
            await this.releaseNativeLease(scope);
        } else if (!releasedRetainedLease) {
            // The UI-friendly helper maps bridge errors to false. Cleanup must
            // propagate unknown state and retain the durable marker instead.
            const nativeTrackingEnabled = await BgGeoManager.getNativeTrackingEnabledStrict();
            if (nativeTrackingEnabled) {
                await BgGeoManager.requestStart();
                // Even an inactive return can represent BgGeoManager's one
                // retained retry lease. Own it before release so no later call
                // can increment over an unverified native effect.
                this.nativeLeaseScope = scope;
                await this.releaseNativeLease(scope);
            }
        }

        if (!this.ownerIsCurrent(scope, state)) {
            throw new Error('Pending voyage GPS teardown was superseded by another account session.');
        }
        state.nativeTeardownPending = undefined;
        try {
            await _saveTrackingState(state, scope);
        } catch (error) {
            state.nativeTeardownPending = pendingIntent;
            throw error;
        }
        if (!this.ownerIsCurrent(scope, state)) {
            state.nativeTeardownPending = pendingIntent;
            throw new Error('Pending voyage GPS teardown was superseded by another account session.');
        }
    }

    private captureHandoffStorageKey(scope: AuthIdentityScope): string {
        return authScopedStorageKey(CAPTURE_HANDOFF_KEY, scope);
    }

    private parseCaptureHandoffStore(value: string | null, scope: AuthIdentityScope): CaptureHandoffStore {
        if (!value) {
            return {
                version: CAPTURE_HANDOFF_VERSION,
                ownerKey: scope.key,
                ownerUserId: scope.userId,
                batches: [],
            };
        }

        const parsed = JSON.parse(value) as Partial<CaptureHandoffStore>;
        if (
            parsed.version !== CAPTURE_HANDOFF_VERSION ||
            parsed.ownerKey !== scope.key ||
            parsed.ownerUserId !== scope.userId ||
            !Array.isArray(parsed.batches)
        ) {
            throw new Error('Ship-log capture handoff owner/version mismatch');
        }

        const batches: CaptureHandoffBatch[] = [];
        for (const rawBatch of parsed.batches) {
            if (
                !rawBatch ||
                typeof rawBatch.id !== 'string' ||
                typeof rawBatch.voyageId !== 'string' ||
                !Array.isArray(rawBatch.points)
            ) {
                throw new Error('Malformed ship-log capture handoff batch');
            }
            const points = rawBatch.points.filter(
                (point) =>
                    point &&
                    Number.isFinite(point.latitude) &&
                    Number.isFinite(point.longitude) &&
                    Number.isFinite(point.timestamp) &&
                    Number.isFinite(point.receivedAt),
            );
            if (points.length !== rawBatch.points.length) {
                throw new Error('Malformed position in ship-log capture handoff');
            }
            batches.push({
                id: rawBatch.id,
                voyageId: rawBatch.voyageId,
                points: points.map((point) => ({ ...point })),
            });
        }
        return {
            version: CAPTURE_HANDOFF_VERSION,
            ownerKey: scope.key,
            ownerUserId: scope.userId,
            batches,
        };
    }

    private async appendCaptureHandoffBatch(scope: AuthIdentityScope, batch: CaptureHandoffBatch): Promise<void> {
        const key = this.captureHandoffStorageKey(scope);
        const { value } = await Preferences.get({ key });
        const store = this.parseCaptureHandoffStore(value, scope);
        if (!store.batches.some((stored) => stored.id === batch.id)) {
            store.batches.push({
                ...batch,
                points: batch.points.map((point) => ({ ...point })),
            });
            await Preferences.set({ key, value: JSON.stringify(store) });
        }
    }

    /**
     * Persist accepted raw fixes even after the auth generation has moved on.
     * This is an explicit transition write under the previous owner's scoped
     * key, equivalent to TrackingStateStore's paused-state handoff.
     */
    private queueCaptureHandoff(
        scope: AuthIdentityScope,
        voyageId: string | undefined,
        points: CachedPosition[],
    ): Promise<void> {
        if (!voyageId || points.length === 0) return Promise.resolve();
        const batch: CaptureHandoffBatch = {
            id:
                typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
                    ? crypto.randomUUID()
                    : `capture_${Date.now()}_${Math.random().toString(36).slice(2)}`,
            voyageId,
            points: points.map((point) => ({ ...point })),
        };
        const pending = this.pendingCaptureHandoffs.get(scope.key) ?? [];
        pending.push(batch);
        this.pendingCaptureHandoffs.set(scope.key, pending);

        const prior = this.captureHandoffTails.get(scope.key) ?? Promise.resolve();
        const operation = prior
            .catch(() => undefined)
            .then(() => this.appendCaptureHandoffBatch(scope, batch))
            .then(() => {
                const current = this.pendingCaptureHandoffs.get(scope.key) ?? [];
                const remaining = current.filter((candidate) => candidate.id !== batch.id);
                if (remaining.length > 0) this.pendingCaptureHandoffs.set(scope.key, remaining);
                else this.pendingCaptureHandoffs.delete(scope.key);
            });
        this.captureHandoffTails.set(scope.key, operation);
        return operation;
    }

    private async retryPendingCaptureHandoffs(scope: AuthIdentityScope): Promise<void> {
        const pending = [...(this.pendingCaptureHandoffs.get(scope.key) ?? [])];
        for (const batch of pending) {
            const prior = this.captureHandoffTails.get(scope.key) ?? Promise.resolve();
            const operation = prior
                .catch(() => undefined)
                .then(() => this.appendCaptureHandoffBatch(scope, batch))
                .then(() => {
                    const current = this.pendingCaptureHandoffs.get(scope.key) ?? [];
                    const remaining = current.filter((candidate) => candidate.id !== batch.id);
                    if (remaining.length > 0) this.pendingCaptureHandoffs.set(scope.key, remaining);
                    else this.pendingCaptureHandoffs.delete(scope.key);
                });
            this.captureHandoffTails.set(scope.key, operation);
            await operation;
        }
    }

    private async removeCaptureHandoffBatch(scope: AuthIdentityScope, batchId: string): Promise<void> {
        const prior = this.captureHandoffTails.get(scope.key) ?? Promise.resolve();
        const operation = prior
            .catch(() => undefined)
            .then(async () => {
                if (!isAuthIdentityScopeCurrent(scope)) return;
                const key = this.captureHandoffStorageKey(scope);
                const { value } = await Preferences.get({ key });
                if (!isAuthIdentityScopeCurrent(scope) || !value) return;
                const store = this.parseCaptureHandoffStore(value, scope);
                store.batches = store.batches.filter((batch) => batch.id !== batchId);
                if (!isAuthIdentityScopeCurrent(scope)) return;
                if (store.batches.length === 0) await Preferences.remove({ key });
                else await Preferences.set({ key, value: JSON.stringify(store) });
            });
        this.captureHandoffTails.set(scope.key, operation);
        await operation;
    }

    private async replayCaptureHandoffs(
        scope: AuthIdentityScope,
        state: TrackingState,
        voyageId: string,
    ): Promise<void> {
        await this.retryPendingCaptureHandoffs(scope);
        if (!this.ownerIsCurrent(scope, state)) return;

        const { value } = await Preferences.get({ key: this.captureHandoffStorageKey(scope) });
        if (!this.ownerIsCurrent(scope, state) || !value) return;
        const store = this.parseCaptureHandoffStore(value, scope);
        const batches = store.batches.filter((batch) => batch.voyageId === voyageId);

        for (const batch of batches) {
            if (!this.ownerIsCurrent(scope, state)) return;
            const replayBuffer = new GpsTrackBuffer(Math.max(1200, batch.points.length));
            for (const point of batch.points) replayBuffer.push(point);
            const result = await this.enqueueCaptureWrite(scope, state, (ctx) =>
                _flushBufferedTrack({ ...ctx, trackBuffer: replayBuffer }),
            );
            if (!this.ownerIsCurrent(scope, state) || result !== 'complete') return;
            await this.removeCaptureHandoffBatch(scope, batch.id);
            if (!this.ownerIsCurrent(scope, state)) return;
        }
    }

    /**
     * The auth fence invokes this synchronously before B is exposed to app
     * state. Hide A immediately and tear down every callback that could emit a
     * fix. A's voyage is persisted as paused under A's key; there is no Voyage
     * End pin, upload, purge, or queue deletion on an account transition.
     */
    private handleIdentityTransition(next: AuthIdentityScope, previous: AuthIdentityScope): void {
        const previousState = this.trackingState;
        const ownedPrevious = this.sameScope(this.trackingOwnerScope, previous);
        const releaseNativeLease = this.sameScope(this.nativeLeaseScope, previous);
        this.startAttempt += 1;
        if (this.pendingStop && this.sameScope(this.pendingStop.scope, previous)) this.pendingStop = null;

        this.scheduler.stop();
        this.gpsSubs.stop();
        this.trackGpsGateOpen = false;
        this.courseDetector.stop();
        this.courseDetector.reset();
        this.envPoller.stop();
        const acceptedPoints = drainBufferedTrackForHandoff(this.trackBuffer);
        if (ownedPrevious && previousState.currentVoyageId && acceptedPoints.length > 0) {
            void this.queueCaptureHandoff(previous, previousState.currentVoyageId, acceptedPoints).catch((error) => {
                // The batch remains in pendingCaptureHandoffs and is retried
                // when this owner returns; it is never exposed to `next`.
                log.warn('failed to persist identity capture handoff:', error);
            });
        }
        this.lastBgLocation = null;
        this.lastAcceptedLocation = null;
        this.lastWaterStatus = undefined;
        this.lastWaterCheck = undefined;
        if (this.rapidModeTimeoutId) {
            clearTimeout(this.rapidModeTimeoutId);
            this.rapidModeTimeoutId = undefined;
        }
        if (this.precisionModeTimeoutId) {
            clearTimeout(this.precisionModeTimeoutId);
            this.precisionModeTimeoutId = undefined;
        }
        this.clearFastLock();
        setCaptureLocalOnly(false);
        disarmLiveTrickleForIdentityChange(previous);
        GpsPrecision.reset();

        if (ownedPrevious && previousState.currentVoyageId) {
            void suspendTrackingStateForIdentityChange({ ...previousState }, previous).catch((error) => {
                log.warn('failed to persist identity-suspended voyage:', error);
            });
        }

        this.trackingOwnerScope = null;
        this.trackingState = { isTracking: false, isPaused: false, isRapidMode: false };
        this.initializedGeneration = null;
        this.initialization = null;
        this.notifyTrackingChanged();

        if (releaseNativeLease && this.isNative) {
            // requestStop is ref-counted by BgGeoManager. This is a safety
            // disarm only; it deliberately does not run stopTracking(). Keep
            // ownership until the bridge verifies release so the next account
            // can join/retry this exact lease instead of incrementing over it.
            void this.releaseNativeLease(previous)
                .then(() =>
                    suspendTrackingStateForIdentityChange(
                        { ...previousState, nativeTeardownPending: undefined },
                        previous,
                    ),
                )
                .catch((error) => {
                    // Persist the failed native stop under A's key even though
                    // B is already current. On a fresh WebView, only this
                    // marker authorizes ShipLog to reclaim one shared lease.
                    void suspendTrackingStateForIdentityChange(
                        { ...previousState, nativeTeardownPending: 'release-only' },
                        previous,
                    ).catch((persistError) => {
                        log.warn('failed to persist identity GPS teardown marker:', persistError);
                    });
                    log.warn('native tracking stop on identity transition failed:', error);
                });
        }
        // Reset a mode only when this service really owned a native GPS lease.
        // Merely signing out or switching accounts must not initialize the
        // background plugin (and potentially surface Motion permission UI).
        if (releaseNativeLease) {
            void BgGeoManager.setSamplingMode('default').catch(() => {});
        }

        if (this.initializeWasRequested && isAuthIdentityScopeCurrent(next)) {
            void this.initialize().catch((error) => {
                log.warn('new-account ship-log hydration failed:', error);
            });
        }
    }

    async initialize(): Promise<void> {
        // The docstring always promised idempotency; now it's true. Without
        // this guard every Log-page mount re-ran the state reconcile,
        // re-awaited an offline-queue upload, and registered ANOTHER
        // appStateChange + visibilitychange listener — duplicate
        // checkMissedEntries captures on every foreground resume.
        this.initializeWasRequested = true;
        const scope = getAuthIdentityScope();
        if (this.initializedGeneration === scope.generation) return;
        if (this.initialization && this.sameScope(this.initialization.scope, scope)) {
            return this.initialization.promise;
        }

        const promise = this.initializeForScope(scope);
        this.initialization = { scope, promise };
        await promise;
        if (this.initialization?.promise === promise) this.initialization = null;
    }

    private async initializeForScope(scope: AuthIdentityScope): Promise<void> {
        try {
            const persisted = await loadTrackingState(scope);
            if (!isAuthIdentityScopeCurrent(scope)) return;
            if (persisted) {
                this.trackingState = persisted;
                this.trackingOwnerScope =
                    persisted.currentVoyageId && (persisted.isTracking || persisted.isPaused) ? scope : null;

                // Reconcile a persisted "tracking" state against this
                // (possibly fresh) JS context. The decision is pure +
                // unit-tested in TrackingStateStore.decideInitTrackingAction.
                //
                // The case that bit us: iOS suspends/reloads the WebView
                // mid-voyage (an hour on another page / backgrounded) while
                // the native GPS engine keeps recording. The old code blindly
                // marked the voyage STOPPED + stamped an end time — which
                // stranded the already-recorded track under a dead voyage id
                // (the "missing start / 986 pts / it cut out / log says
                // not-running" bug) and showed a false "not tracking" in the
                // UI. We now ask the native engine whether it's still live and
                // CONTINUE the same voyage in place when it is.
                //
                // When navigating between pages within an active session the
                // scheduler IS running, so the decision is 'none' and active
                // tracking is untouched.
                // A UI availability read maps bridge errors to false; lifecycle
                // reconciliation cannot. Unknown native state must leave the
                // persisted voyage untouched and retryable, never mark it
                // stopped or clear teardown ownership.
                const nativeTrackingEnabled = await BgGeoManager.getNativeTrackingEnabledStrict();
                if (!isAuthIdentityScopeCurrent(scope)) return;
                if (this.trackingState.nativeTeardownPending) {
                    if (!nativeTrackingEnabled) {
                        // Strict false is proof the requested native end state
                        // already holds. Clear only the marker; a normal pause
                        // stays paused and resumable.
                        this.trackingState.nativeTeardownPending = undefined;
                        await this.saveTrackingState(scope);
                        if (!isAuthIdentityScopeCurrent(scope)) return;
                    } else if (
                        this.trackingState.nativeTeardownPending === 'end-voyage' &&
                        this.trackingState.currentVoyageId
                    ) {
                        // Only an interrupted terminal End reconstructs voyage
                        // finalization. Pause/identity/start rollback markers
                        // remain release-only until an explicit Resume or End.
                        this.pendingStop = {
                            scope,
                            state: this.trackingState,
                            voyageId: this.trackingState.currentVoyageId,
                        };
                    }
                }
                const decision = decideInitTrackingAction({
                    persistedIsTracking: this.trackingState.isTracking,
                    persistedIsPaused: this.trackingState.isPaused,
                    schedulerRunning: this.scheduler.isRunning(),
                    nativeTrackingEnabled,
                    currentVoyageId: this.trackingState.currentVoyageId,
                });

                if (decision.action === 'resume') {
                    // Native GPS never stopped — re-arm the JS side onto the
                    // SAME voyage. startTracking() guards on isTracking, so
                    // release the (in-memory only) flag first; we deliberately
                    // do NOT persist a stopped state or an end time here.
                    log.warn(
                        `[init] native GPS still live after JS reload — resuming voyage ${decision.voyageId.slice(0, 12)} in place (no stop, no new id)`,
                    );
                    this.trackingState.isTracking = false;
                    this.trackingOwnerScope = null;
                    await this.startTracking(true, decision.voyageId, scope);
                    if (!isAuthIdentityScopeCurrent(scope)) return;
                } else if (decision.action === 'mark-stopped') {
                    // Genuine cold start / force-close — mark stopped so the
                    // Start button shows correctly; autoStartIfEnabled() will
                    // restart if the user's setting is on.
                    this.trackingState = {
                        isTracking: false,
                        isPaused: false,
                        isRapidMode: false,
                        // Preserve voyage info so autoStartIfEnabled can decide.
                        currentVoyageId: this.trackingState.currentVoyageId,
                        voyageStartTime: this.trackingState.voyageStartTime,
                        voyageEndTime: this.trackingState.voyageEndTime || new Date().toISOString(),
                    };
                    this.trackingOwnerScope = null;
                    await _saveTrackingState(this.trackingState, scope);
                    if (!isAuthIdentityScopeCurrent(scope)) return;
                    this.notifyTrackingChanged();
                }
                // decision.action === 'none' → active in-session, leave as-is.
            }

            // Start sync interval to process offline queue
            this.startSyncInterval();

            // Try initial sync — but NOT if a voyage resumed recording (or
            // sits paused) above. Local-first capture: the queue is the live
            // store mid-voyage; it uploads as one batch when the voyage stops.
            // FIRE-AND-FORGET: the Log page awaits initialize() before its
            // first data load — awaiting a whole-voyage upload here was the
            // single biggest source of the "open Log → spinner for ages →
            // can't start a track" report. syncOfflineQueue now also has its
            // own in-flight latch + live-voyage refusal, and the 2-minute
            // interval retries anything this pass doesn't land.
            if (!this.trackingState.isTracking && !this.trackingState.isPaused) {
                void this.syncOfflineQueueForScope(scope).catch((e) =>
                    log.warn('initial queue sync failed (will retry):', e),
                );
            }

            // Flush plan-link intents a previous process left behind. The
            // ledger is durable but its retry timer and online listener died
            // with the old process, and a session that starts online never
            // fires 'online' — so without this, a link/clear queued in a dead
            // spot stayed orphaned forever (audit 2026-08-02). Unconditional:
            // intents are single tiny writes and last-intent-wins, safe even
            // mid-voyage.
            void flushPlanLinkIntents().catch((e) => log.warn('plan-link intent flush failed (will retry):', e));

            this.registerLifecycleHandlers();
            if (isAuthIdentityScopeCurrent(scope)) this.initializedGeneration = scope.generation;
        } catch (error) {
            log.error('initialize failed', error);
        }
    }

    private registerLifecycleHandlers(): void {
        if (this.lifecycleHandlersRegistered) return;
        this.lifecycleHandlersRegistered = true;

        App.addListener('appStateChange', async ({ isActive }) => {
            const owner = this.trackingOwnerScope;
            if (
                isActive &&
                owner &&
                this.ownerIsCurrent(owner) &&
                this.trackingState.isTracking &&
                !this.trackingState.isPaused
            ) {
                await this.checkMissedEntries(owner);
            }
            if (!isActive) {
                const scope = getAuthIdentityScope();
                const { flushOfflineQueueToDisk } = await import('./shiplog/OfflineQueue');
                if (isAuthIdentityScopeCurrent(scope)) {
                    await flushOfflineQueueToDisk().catch(() => {});
                }
            }
        });

        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', async () => {
                const owner = this.trackingOwnerScope;
                if (
                    document.visibilityState === 'visible' &&
                    owner &&
                    this.ownerIsCurrent(owner) &&
                    this.trackingState.isTracking &&
                    !this.trackingState.isPaused
                ) {
                    await this.checkMissedEntries(owner);
                }
            });
        }
    }

    /**
     * Automatically resume tracking if the user has auto-track enabled
     * and there's a non-stale voyage in progress.
     * @param autoTrackEnabled - Whether the user's settings allow auto-tracking
     */
    async autoStartIfEnabled(autoTrackEnabled: boolean): Promise<void> {
        const scope = getAuthIdentityScope();
        if (!autoTrackEnabled) return;
        if (!isAuthIdentityScopeCurrent(scope)) return;
        if (this.trackingState.isTracking) return;

        const lastVoyageEnd = this.trackingState.voyageEndTime;
        const lastVoyageId = this.trackingState.currentVoyageId;

        if (lastVoyageEnd && lastVoyageId) {
            const elapsed = Date.now() - new Date(lastVoyageEnd).getTime();
            if (elapsed < VOYAGE_STALE_THRESHOLD_MS) {
                // Recent voyage — resume it
                await this.startTracking(true, lastVoyageId, scope);
                return;
            }
        }

        // No recent voyage or too stale — start fresh
        await this.startTracking(false, undefined, scope);
    }

    /** Check whether the active geographic plotting profile missed a capture while backgrounded. */
    private async checkMissedEntries(scope: AuthIdentityScope): Promise<void> {
        const state = this.trackingState;
        if (!this.ownerIsCurrent(scope, state)) return;
        if (!state.lastEntryTime) return;

        const lastEntry = new Date(state.lastEntryTime);
        const now = new Date();
        const msSinceLast = now.getTime() - lastEntry.getTime();

        const interval = state.currentIntervalMs ?? TRACKING_INTERVAL_MS;
        if (msSinceLast >= interval) {
            // Flush a selected GPS vertex if one is waiting. Never use the
            // raw UI cache as a synthetic catch-up point: the geographic
            // sampler is the authority for plotted-track density.
            try {
                const result = await this.flushBufferedTrack(scope, state);
                if (!this.ownerIsCurrent(scope, state)) return;
                if (result === 'complete') {
                    log.info('checkMissedEntries: selected track buffer flushed');
                }
            } catch (err: unknown) {
                log.error('checkMissedEntries: catch-up entry failed', err);
            }
        }

        // Restore the current position's geographic profile.
        void this.rescheduleAdaptiveInterval(scope, state);
    }

    /**
     * Reschedule the flush cadence from the current vessel-position profile.
     * The GPS manager independently controls which raw fixes become vertices;
     * this timer only decides when a selected batch is persisted.
     * Does NOT apply when rapid mode is active.
     *
     * Timer ownership lives in `this.scheduler` (AdaptiveScheduler).
     * This method just decides the new `intervalMs` and asks the
     * scheduler to align to it.
     */
    private async rescheduleAdaptiveInterval(
        scope: AuthIdentityScope | null = this.trackingOwnerScope,
        state: TrackingState = this.trackingState,
    ): Promise<void> {
        if (!scope || !this.ownerIsCurrent(scope, state)) return;
        // Don't interfere with rapid mode
        if (state.isRapidMode) return;
        if (!state.isTracking || state.isPaused) return;

        await this.applyPlottingProfile(this.plottingProfileFor(this.lastAcceptedLocation), scope, state);
    }

    /**
     * Read the current profile synchronously for one incoming GPS fix. The
     * resolver returns the dense profile until it has real, position-matched
     * water + coastline evidence, so a slow/offline lookup cannot thin a
     * coastal track by mistake.
     */
    private plottingProfileFor(pos: CachedPosition | null): PlottingProfile {
        const zone = pos ? this.shoreZoneResolver.profileFor(pos.latitude, pos.longitude) : 'nearshore';
        return getPlottingProfile(zone);
    }

    /**
     * Resolve shore evidence asynchronously without blocking GPS intake. A
     * newer raw fix supersedes older requests inside ShoreZoneResolver.
     */
    private async refreshShoreZone(
        pos: CachedPosition,
        scope: AuthIdentityScope,
        state: TrackingState,
        waterStatus: WaterCheckResult | undefined = this.waterStatusFor(pos),
    ): Promise<void> {
        if (!this.ownerIsCurrent(scope, state)) return;
        // EnvironmentPoller captures a coordinate before its network request.
        // If newer accepted GPS fixes arrive before that request returns, its
        // old water result must not move the live voyage back to an earlier
        // shoreline profile.
        if (this.lastAcceptedLocation && pos.timestamp < this.lastAcceptedLocation.timestamp) return;
        const zone = await this.shoreZoneResolver.observe({
            latitude: pos.latitude,
            longitude: pos.longitude,
            waterStatus,
        });
        if (zone === null || !this.ownerIsCurrent(scope, state)) return;
        await this.applyPlottingProfile(getPlottingProfile(zone), scope, state);
    }

    /** Only use a water response near the coordinate it actually checked. */
    private waterStatusFor(pos: CachedPosition): WaterCheckResult | undefined {
        const status = this.lastWaterCheck;
        if (!status) return undefined;
        const distanceNm = calculateDistance(status.lat, status.lon, pos.latitude, pos.longitude);
        return distanceNm <= 1 ? status : undefined;
    }

    /** Persist the selected profile and optionally publish a boundary vertex immediately. */
    private async applyPlottingProfile(
        profile: PlottingProfile,
        scope: AuthIdentityScope,
        state: TrackingState,
        flushBoundary = false,
    ): Promise<void> {
        if (
            !this.ownerIsCurrent(scope, state) ||
            !state.isTracking ||
            state.isPaused ||
            state.isRapidMode ||
            !this.trackGpsGateOpen
        ) {
            return;
        }

        const changed = state.loggingZone !== profile.zone || state.currentIntervalMs !== profile.intervalMs;
        // `isRunning()` intentionally excludes a clock-alignment timeout.
        // Raw GPS can arrive several times during that short window, so use
        // isScheduled() here or each harmless position refresh would keep
        // pushing the first flush forward.
        if (changed || !this.scheduler.isScheduled()) {
            state.loggingZone = profile.zone;
            state.currentIntervalMs = profile.intervalMs;
            await this.saveTrackingState(scope);
            if (!this.ownerIsCurrent(scope, state)) return;
            this.scheduler.scheduleClockAligned(profile.intervalMs, () => this.flushBufferedTrack(scope, state));
        }

        if (flushBoundary) {
            this.flushBufferedTrack(scope, state).catch((error) => {
                log.warn('failed to flush geographic profile boundary:', error);
            });
        }
    }

    private async rollbackFailedTrackingStart(options: {
        scope: AuthIdentityScope;
        attempt: number;
        previousState: TrackingState;
        previousOwnerScope: AuthIdentityScope | null;
        previousNativeLeaseScope: AuthIdentityScope | null;
        previousCaptureLocalOnly: boolean;
        previousLastBgLocation: CachedPosition | null;
        previousLastAcceptedLocation: CachedPosition | null;
        previousLastWaterStatus: boolean | undefined;
        previousLastWaterCheck: WaterCheckResult | undefined;
        previousTrackGpsGateOpen: boolean;
        attemptedVoyageId: string;
        nativeLeaseAcquired: boolean;
        liveTrickleStarted: boolean;
    }): Promise<void> {
        const {
            scope,
            attempt,
            previousState,
            previousOwnerScope,
            previousNativeLeaseScope,
            previousCaptureLocalOnly,
            previousLastBgLocation,
            previousLastAcceptedLocation,
            previousLastWaterStatus,
            previousLastWaterCheck,
            previousTrackGpsGateOpen,
            attemptedVoyageId,
            nativeLeaseAcquired,
            liveTrickleStarted,
        } = options;

        // Identity transition or stopTracking may already own teardown. Never
        // overwrite its newer state. There is one narrow handoff case: auth
        // can change while requestStart() is inside the native bridge, before
        // the identity handler can see this lease. If it is still registered
        // to the failed attempt, release it here; the shared release operation
        // joins any handler/stop path already tearing down the same lease.
        if (attempt !== this.startAttempt || !isAuthIdentityScopeCurrent(scope)) {
            if (nativeLeaseAcquired && this.isNative && this.sameScope(this.nativeLeaseScope, scope)) {
                try {
                    await this.releaseNativeLease(scope);
                } catch (error) {
                    log.error('failed to release stale native GPS start lease:', error);
                }
            }
            return;
        }

        this.scheduler.stop();
        this.gpsSubs.stop();
        this.courseDetector.stop();
        this.courseDetector.reset();
        this.envPoller.stop();
        this.clearFastLock();
        this.trackBuffer.clear();

        if (liveTrickleStarted) {
            await stopLiveTrickle(false, scope).catch((error) => {
                log.warn('failed to roll back live tracking after voyage start failed:', error);
            });
        }

        let nativeLeaseReleased = !nativeLeaseAcquired;
        if (nativeLeaseAcquired && this.isNative && this.sameScope(this.nativeLeaseScope, scope)) {
            try {
                await this.releaseNativeLease(scope);
                nativeLeaseReleased = true;
            } catch (error) {
                // BgGeoManager deliberately retains the final lease on an
                // unverified stop. Keep our ownership marker as well so a
                // retry can reuse/release it rather than leak an orphan count.
                log.error('native GPS lease could not be released after voyage start failed:', error);
            }
        }

        const retainedFailedStartLease = nativeLeaseAcquired && !nativeLeaseReleased;
        const rollbackState: TrackingState = retainedFailedStartLease
            ? {
                  ...previousState,
                  isTracking: false,
                  isPaused: true,
                  isRapidMode: false,
                  isPrecisionMode: false,
                  nativeTeardownPending: 'release-only',
                  currentVoyageId: attemptedVoyageId,
                  voyageStartTime:
                      previousState.currentVoyageId === attemptedVoyageId ? previousState.voyageStartTime : undefined,
                  voyageEndTime: undefined,
              }
            : previousState;

        this.trackingState = rollbackState;
        this.trackingOwnerScope = retainedFailedStartLease ? scope : previousOwnerScope;
        if (nativeLeaseReleased) this.nativeLeaseScope = previousNativeLeaseScope;
        this.lastBgLocation = previousLastBgLocation;
        this.lastAcceptedLocation = previousLastAcceptedLocation;
        this.lastWaterStatus = previousLastWaterStatus;
        this.lastWaterCheck = previousLastWaterCheck;
        this.trackGpsGateOpen = previousTrackGpsGateOpen;
        setCaptureLocalOnly(previousCaptureLocalOnly);
        this.shoreZoneResolver.reset();

        // The active snapshot may already have reached Preferences before a
        // later subscription/timer setup failed. Restore the exact pre-start
        // state so a WebView reload cannot resurrect a voyage that never armed.
        let rollbackPersistenceError: unknown;
        try {
            await _saveTrackingState(rollbackState, scope);
        } catch (error) {
            log.error('failed to restore persisted voyage state after start rollback:', error);
            if (retainedFailedStartLease) {
                try {
                    // A failed native stop leaves a real background lease to
                    // recover. Give its durable release-only marker one more
                    // bridge attempt before surfacing a fail-closed error.
                    await _saveTrackingState(rollbackState, scope);
                } catch (retryError) {
                    rollbackPersistenceError = retryError;
                    log.error('failed again to persist pending voyage GPS teardown:', retryError);
                }
            }
        }
        if (retainedFailedStartLease) {
            this.notifyTrackingChanged();
            if (rollbackPersistenceError) {
                throw new Error(
                    `Background GPS cleanup remains pending, but its recovery state could not be saved. Keep Thalassa open and retry End Voyage. ${rollbackPersistenceError instanceof Error ? rollbackPersistenceError.message : ''}`.trim(),
                );
            }
        }
    }

    /**
     * Begin GPS tracking for a new or resumed voyage.
     * Creates a voyage ID, aligns to the next quarter-hour, and starts
     * the position logging interval. On native, activates background GPS
     * via Transistorsoft; on web, uses navigator.geolocation.watchPosition.
     * @param resume - If true, continues the current voyage rather than starting fresh
     * @param continueVoyageId - Optional voyage ID to resume (e.g. after app restart)
     */
    async startTracking(
        resume: boolean = false,
        continueVoyageId?: string,
        scope: AuthIdentityScope = getAuthIdentityScope(),
        /**
         * "This voyage was just created — treat it as a cold departure."
         *
         * RETAINED FOR THE CALL SIGNATURE, no longer read. It existed to tell
         * a mint apart from a resume so fast-lock could be armed only on the
         * former; fast-lock is now armed on the first-fix GATE instead, which
         * answers that question directly and stays correct for resumes and
         * WebView reloads too. CastOffPanel still passes `true` and is welcome
         * to — removing the parameter would be a signature change for no gain.
         */
        _freshDeparture: boolean = false,
    ): Promise<void> {
        if (!isAuthIdentityScopeCurrent(scope)) return;
        const stopping = this.stopOperation;
        if (stopping && this.sameScope(stopping.scope, scope)) {
            // A restart must never overtake the stop's final persistence/native
            // release. Apart from corrupting the stored active state, doing so
            // lets an End Voyage caller observe a successful stop while a new
            // lease is already being acquired for the same passage.
            await stopping.promise;
            if (!isAuthIdentityScopeCurrent(scope)) return;
        }
        const inFlight = this.startOperation;
        if (inFlight && this.sameScope(inFlight.scope, scope)) return inFlight.promise;

        const requestedVoyageId = continueVoyageId ?? (resume ? this.trackingState.currentVoyageId : undefined);
        const promise = this.performStartTracking(resume, continueVoyageId, scope, _freshDeparture);
        this.startOperation = { scope, voyageId: requestedVoyageId, promise };
        try {
            await promise;
        } finally {
            if (this.startOperation?.promise === promise) this.startOperation = null;
        }
    }

    private async performStartTracking(
        resume: boolean,
        continueVoyageId: string | undefined,
        scope: AuthIdentityScope,
        _freshDeparture: boolean,
    ): Promise<void> {
        if (!isAuthIdentityScopeCurrent(scope)) return;
        const stateBeforeStart = this.trackingState;
        if (stateBeforeStart.isTracking) {
            // Id-aware (Shane 2026-08-26): a silent return here while a
            // DIFFERENT voyage holds GPS made the Cast Off panel's Retry
            // unwinnable — the retry "succeeded", the post-check saw the
            // other voyage id, and the skipper was told to fix location
            // access. Same-voyage (or untargeted) start stays an idempotent
            // success; a targeted mismatch is now an honest error.
            const requestedVoyageId = continueVoyageId ?? (resume ? stateBeforeStart.currentVoyageId : undefined);
            if (!requestedVoyageId || stateBeforeStart.currentVoyageId === requestedVoyageId) return;
            throw new DifferentVoyageTrackingError(
                'GPS logging is already recording a different voyage. End that voyage, or stop its track on the Log page, before retrying this one.',
            );
        }
        const pendingStop = this.pendingStop;
        if (pendingStop && this.sameScope(pendingStop.scope, scope)) {
            throw new Error('Finish the pending End Voyage GPS teardown before starting or resuming a voyage.');
        }
        const attempt = ++this.startAttempt;
        const startIsCurrent = () => attempt === this.startAttempt && isAuthIdentityScopeCurrent(scope);
        if (stateBeforeStart.nativeTeardownPending === 'release-only') {
            const requestedVoyageId = continueVoyageId ?? (resume ? stateBeforeStart.currentVoyageId : undefined);
            if (!requestedVoyageId || requestedVoyageId !== stateBeforeStart.currentVoyageId) {
                throw new Error('Finish the pending voyage GPS teardown before starting a different voyage.');
            }
            await this.completePendingNativeRelease(scope, stateBeforeStart);
            if (!startIsCurrent()) return;
        }
        const previousState = { ...this.trackingState };
        const previousOwnerScope = this.trackingOwnerScope;
        let previousNativeLeaseScope = this.nativeLeaseScope;
        const attemptedVoyageId =
            continueVoyageId ??
            (resume && previousState.currentVoyageId
                ? previousState.currentVoyageId
                : `voyage_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`);
        const previousCaptureLocalOnly = isCaptureLocalOnly();
        const previousLastBgLocation = this.lastBgLocation;
        const previousLastAcceptedLocation = this.lastAcceptedLocation;
        const previousLastWaterStatus = this.lastWaterStatus;
        const previousLastWaterCheck = this.lastWaterCheck;
        const previousTrackGpsGateOpen = this.trackGpsGateOpen;
        let nativeLeaseAcquired = false;
        let liveTrickleStarted = false;

        try {
            // Initialize GPS engine (native-only: Transistorsoft BgGeo).
            // On web, GPS is started via navigator.geolocation in gpsSubs.start().
            if (this.isNative) {
                const tg = performance.now();
                await BgGeoManager.ensureReady();
                if (!startIsCurrent()) return;
                const pendingRelease = this.nativeLeaseReleaseOperation;
                if (pendingRelease) {
                    try {
                        await pendingRelease.promise;
                    } catch (error) {
                        throw new Error(
                            `Voyage logging is waiting for background GPS from the previous session to stop. Retry Cast Off. ${error instanceof Error ? error.message : ''}`.trim(),
                        );
                    }
                    if (!startIsCurrent()) return;
                }

                const retainedLeaseScope = this.nativeLeaseScope;
                if (retainedLeaseScope && !this.sameScope(retainedLeaseScope, scope)) {
                    try {
                        await this.releaseNativeLease(retainedLeaseScope);
                    } catch (error) {
                        throw new Error(
                            `Voyage logging could not release background GPS from the previous session. Retry Cast Off. ${error instanceof Error ? error.message : ''}`.trim(),
                        );
                    }
                    if (!startIsCurrent()) return;
                }
                // A foreign retained lease may just have been released. Capture
                // the real pre-start state for transactional rollback only now.
                previousNativeLeaseScope = this.nativeLeaseScope;
                const tReady = performance.now();
                await BgGeoManager.requireAlwaysLocationAuthorization('voyage-log');
                if (!startIsCurrent()) return;
                let leaseState = this.sameScope(previousNativeLeaseScope, scope)
                    ? await BgGeoManager.getLeaseState()
                    : null;
                if (leaseState && leaseState.activeLeaseCount > 0 && !leaseState.active) {
                    leaseState = await BgGeoManager.revalidateExistingLease();
                }
                if (!leaseState?.active || !leaseState.nativeTrackingEnabled) {
                    // A prior final-stop failure deliberately leaves this
                    // service's ownership marker intact. Reuse a verified live
                    // lease; only acquire a new one when no such lease exists.
                    this.nativeLeaseScope = null;
                    leaseState = await BgGeoManager.requestStart();
                    nativeLeaseAcquired = true;
                    this.nativeLeaseScope = scope;
                }
                if (!leaseState.active || !leaseState.nativeTrackingEnabled) {
                    throw new Error('Voyage logging could not verify that background GPS is active. Please try again.');
                }
                if (!startIsCurrent()) throw new StartTrackingCancelledError();
                log.warn(
                    `[perf] startTracking GPS: ensureReady ${Math.round(tReady - tg)}ms + ` +
                        `requestStart ${Math.round(performance.now() - tReady)}ms`,
                );
            }

            // GPS engine confirmed running — NOW commit tracking state.
            // Determine voyage ID:
            // 1. If continueVoyageId is provided, use that
            // 2. If resume and currentVoyageId exists, use that
            // 3. Otherwise, generate new
            const voyageId = attemptedVoyageId;
            // WHY FAST-LOCK EXISTS AT ALL (kept from the 2026-07-28 work, because
            // the reasoning outlived the condition it was written for): at the dock
            // distanceFilter stays at 1 m, a stationary boat never travels 1 m, so
            // the GPS emits almost nothing and the first-fix consistency gate
            // starves waiting for a corroborating second fix that cannot arrive.
            // That was Shane's "takes a very long time" — never the satellite lock.
            //
            // This used to be decided by an `isNewVoyage` predicate that tried to
            // enumerate which starts deserved a re-spike (mint vs resume vs the
            // helm's Cast Off, which passes its fresh id as `continueVoyageId` and
            // so read FALSE on the one path that needed it most). The gate itself
            // answers the question directly and cannot drift out of sync with it —
            // see the arm site below.

            // Bind the selected vessel ONCE at cast-off. Do not look this up
            // again from the currently selected fleet profile after a track has
            // started: a delivery skipper can switch the default for tomorrow
            // without moving today's live track to another yacht.
            const isResumingRecordedVoyage =
                (resume || Boolean(continueVoyageId)) && this.trackingState.currentVoyageId === voyageId;
            let boatId = isResumingRecordedVoyage ? this.trackingState.boatId : undefined;
            if (!boatId && !isResumingRecordedVoyage) {
                try {
                    const { useSettingsStore } = await import('../stores/settingsStore');
                    const fleetState = useSettingsStore.getState();
                    boatId =
                        fleetState.activeVesselId ??
                        (fleetState.vesselFleet.length === 1 ? fleetState.vesselFleet[0]?.id : undefined);

                    // A brand-new device can reach Cast Off before the settings
                    // provider finishes its initial fleet pull. Take one bounded
                    // direct look at the cloud selection so this voyage is still
                    // permanently bound at cast-off rather than being assigned by
                    // whichever yacht is active when its offline queue uploads.
                    if (!boatId && scope.userId) {
                        const { loadOwnedVesselFleet } = await import('./VesselFleetService');
                        let timeoutId: ReturnType<typeof setTimeout> | undefined;
                        const fleet = await Promise.race([
                            loadOwnedVesselFleet(scope).catch(() => null),
                            new Promise<null>((resolve) => {
                                timeoutId = setTimeout(() => resolve(null), 1_200);
                            }),
                        ]);
                        if (timeoutId) clearTimeout(timeoutId);
                        boatId =
                            fleet?.activeBoatId ?? (fleet?.vessels.length === 1 ? fleet.vessels[0]?.id : undefined);
                    }
                } catch (error) {
                    // A first-ever offline voyage may pre-date the fleet pull.
                    // The entry remains locally durable; the database's legacy
                    // fallback assigns its active boat when it later syncs.
                    log.warn('could not resolve vessel at cast-off:', error);
                }
            }
            if (!startIsCurrent()) throw new StartTrackingCancelledError();

            this.trackingOwnerScope = scope;
            this.trackingState = {
                isTracking: true,
                isPaused: false,
                isRapidMode: false, // Rapid Mode (3 s selected-vertex cadence) — kept off
                // by default; the adaptive scheduler + live decimation cover
                // the same density requirement more efficiently.
                // ── 2026-05-17: Precision Mode is now ON BY DEFAULT ──
                // User feedback: "we have two modes of tracking, one works
                // and one doesn't". 2 Hz capture + live decimation is the
                // canonical tracking experience now — no toggle needed.
                // Assumption: user is on charger when actively tracking a
                // voyage (their explicit acknowledgement). 60-minute auto-
                // shutoff also removed; tracking sessions stay at hi-fi
                // for the duration.
                isPrecisionMode: true,
                boatId: boatId,
                currentVoyageId: voyageId,
                voyageStartTime:
                    resume || continueVoyageId ? this.trackingState.voyageStartTime : new Date().toISOString(),
                lastMovementTime: new Date().toISOString(),
            };
            const sessionState = this.trackingState;
            const initialProfile = getPlottingProfile('nearshore');
            sessionState.loggingZone = initialProfile.zone;
            sessionState.currentIntervalMs = initialProfile.intervalMs;
            // The UI may show raw incoming GPS during acquisition, but no raw
            // sample from a prior/cold session may become a persisted track point
            // before GpsSubscriptionManager opens its vetted gate.
            this.lastBgLocation = null;
            this.lastAcceptedLocation = null;
            this.lastWaterStatus = undefined;
            this.lastWaterCheck = undefined;
            this.shoreZoneResolver.reset();
            this.trackGpsGateOpen = false;

            await this.saveTrackingState(scope);
            if (!startIsCurrent() || !this.ownerIsCurrent(scope, sessionState)) {
                throw new StartTrackingCancelledError();
            }

            // LOCAL-FIRST CAPTURE: while this voyage records, every entry is
            // written to the device only (offline queue) — zero network on the
            // capture path. The whole voyage uploads in the background at stop.
            setCaptureLocalOnly(true);

            // If this account was switched away mid-fix, replay its transition
            // batches before accepting fresh GPS points. A different account can
            // never read this scoped store, and a different voyage never adopts it.
            try {
                await this.replayCaptureHandoffs(scope, sessionState, voyageId);
            } catch (error) {
                log.warn('capture handoff replay deferred:', error);
            }
            if (!startIsCurrent() || !this.ownerIsCurrent(scope, sessionState)) {
                throw new StartTrackingCancelledError();
            }

            // Live position sharing (public Voyage Log "live tail") — a
            // read-only shadow of the offline queue, gated on
            // settings.liveTrackShare. Never touches the capture path.
            startLiveTrickle(sessionState.currentVoyageId ?? null, scope, sessionState.boatId);
            liveTrickleStarted = true;

            // COLD-START FAST-LOCK (new voyages only). distanceFilter:0 emits
            // a fix on every chip update even while stationary at the dock,
            // so the first-fix consistency gate gets its corroborating 2nd
            // fix in seconds instead of waiting for 1 m of movement — the
            // "Acquiring GPS fix…" banner clears sooner. Reverts to the
            // steady 1 m filter after FAST_LOCK_MS. On resume / mid-voyage
            // reload we stay at the steady mode (no re-spike).
            // Arm on the GATE, not on newness. GpsSubscriptionManager.start()
            // resets its first-fix bookkeeping on EVERY start and this service
            // clears trackGpsGateOpen alongside it, so a resume — or a WebView
            // reload mid-voyage, which happens — re-closes the gate with exactly
            // the same stationary-vessel problem and, under the old condition, no
            // mitigation at all. The original intent ("no re-spike mid-voyage")
            // is preserved: once the gate is open this is false and we stay at the
            // steady filter.
            if (this.isNative && !this.trackGpsGateOpen) {
                this.armFastLock(voyageId, scope, sessionState);
            } else {
                BgGeoManager.setSamplingMode('default').catch((e) => {
                    log.warn('failed to set GPS sampling on track start:', e);
                });
            }

            // --- BATTLE-HARDENED GPS STREAMING ---
            // Wire up continuous position caching + the speed-tier debounce +
            // fix-acceptance gate. The timer decides WHEN to log; the
            // subscription manager ensures GPS is ALWAYS fresh.
            this.gpsSubs.start({
                isNative: this.isNative,
                trackBuffer: this.trackBuffer,
                isActive: () =>
                    this.ownerIsCurrent(scope, sessionState) && sessionState.isTracking && !sessionState.isPaused,
                isRapidMode: () => this.ownerIsCurrent(scope, sessionState) && sessionState.isRapidMode === true,
                isPrecisionMode: () =>
                    this.ownerIsCurrent(scope, sessionState) && sessionState.isPrecisionMode === true,
                getIntervalMs: () =>
                    this.ownerIsCurrent(scope, sessionState)
                        ? (sessionState.currentIntervalMs ?? TRACKING_INTERVAL_MS)
                        : TRACKING_INTERVAL_MS,
                getLastEntryTime: () =>
                    this.ownerIsCurrent(scope, sessionState) ? sessionState.lastEntryTime : undefined,
                getPlottingProfile: (pos) =>
                    this.ownerIsCurrent(scope, sessionState)
                        ? sessionState.isRapidMode
                            ? getPlottingProfile('nearshore')
                            : this.plottingProfileFor(pos)
                        : getPlottingProfile('nearshore'),
                onFix: (pos) => {
                    if (!this.ownerIsCurrent(scope, sessionState)) return;
                    this.lastBgLocation = pos;
                },
                onAcceptedFix: (pos) => {
                    if (!this.ownerIsCurrent(scope, sessionState)) return;
                    this.lastAcceptedLocation = pos;
                    this.refreshShoreZone(pos, scope, sessionState).catch((error) => {
                        log.warn('shore-zone refresh failed:', error);
                    });
                },
                onSpeedTierChanged: () => {
                    this.rescheduleAdaptiveInterval(scope, sessionState).catch((e) => {
                        log.warn(``, e);
                    });
                },
                onHeartbeatTick: () => {
                    this.flushBufferedTrack(scope, sessionState).catch((e) => {
                        log.warn(``, e);
                    });
                },
                onTrackOpened: () => {
                    if (!this.ownerIsCurrent(scope, sessionState)) return;
                    this.trackGpsGateOpen = true;
                    // Fast-lock exists only to obtain the corroborating opening
                    // fix. Keeping distanceFilter:0 active for a fixed 30 s
                    // afterwards records stationary GPS wander at the dock.
                    this.settleFastLock(voyageId, scope, sessionState);
                    this.envPoller.requestCheck();
                },
                onPlottingProfileChanged: (profile) => {
                    this.applyPlottingProfile(profile, scope, sessionState, true).catch((error) => {
                        log.warn('failed to apply geographic plotting profile:', error);
                    });
                },
                onPlotPointBuffered: () => {
                    // Persist each selected vertex promptly. The clock-aligned
                    // scheduler remains a background/heartbeat safety net, but
                    // a vertex retained just after a tick must not live only in
                    // JavaScript memory until the next 30-second or 5-minute mark.
                    this.flushBufferedTrack(scope, sessionState).catch((error) => {
                        log.warn('failed to flush selected plot point:', error);
                    });
                },
            });

            // Reset position-based bearing tracker for new voyage
            this.courseDetector.reset();
            // AUTO TURN-PIN GENERATION DISABLED 2026-06-12 (Shane: "do away
            // with the wayward waypoints — we will address that later").
            // The midpoint pins landed visibly off-route and cluttered the
            // track. The detector, the TurnEvent.timestamp plumbing, and
            // captureLog's positionOverride all remain — re-wire the block
            // below when the waypoint feature is redesigned.
            //
            // this.courseDetector.start({
            //     getPos: () => this.lastBgLocation,
            //     isActive: () => this.trackingState.isTracking && !this.trackingState.isPaused,
            //     onTurn: ({ oldCardinal, newCardinal, lat, lon, timestamp }) => {
            //         _captureLog(this._captureCtx(), {
            //             entryType: 'waypoint',
            //             notes: `Auto: COG ${oldCardinal} → ${newCardinal}`,
            //             waypointName: `COG ${oldCardinal} → ${newCardinal}`,
            //             eventCategory: 'navigation',
            //             positionOverride: { lat, lon, timestamp },
            //         }).catch(() => {
            //             /* best effort */
            //         });
            //     },
            // });

            // Start dense until actual GPS-position shoreline evidence proves a
            // less detailed profile is safe. We never use the dashboard weather
            // location for a live voyage.
            this.scheduler.scheduleClockAligned(initialProfile.intervalMs, () =>
                this.flushBufferedTrack(scope, sessionState),
            );

            // Kick off async zone refinement in the background — won't block UI.
            this.rescheduleAdaptiveInterval(scope, sessionState).catch((e) => {
                log.warn(``, e);
            });

            // --- 60-SECOND ENVIRONMENT POLLING ---
            // Checks water/land status at a bounded cadence and hands the same
            // actual GPS coordinate to the OSM shoreline resolver.
            this.envPoller.start({
                getPos: () => this.lastAcceptedLocation,
                isActive: () =>
                    this.ownerIsCurrent(scope, sessionState) && sessionState.isTracking && !sessionState.isPaused,
                onWaterStatus: (waterStatus) => {
                    if (!this.ownerIsCurrent(scope, sessionState)) return;
                    // Cache for stamping onto subsequent log entries.
                    this.lastWaterStatus = waterStatus.isWater;
                    this.lastWaterCheck = waterStatus;
                    // Update EnvironmentService for UI consumers.
                    EnvironmentService.updateWaterStatus(waterStatus.isWater);
                },
                onZoneRecheck: (pos, waterStatus) => this.refreshShoreZone(pos, scope, sessionState, waterStatus),
            });
            // If the track opened before the poller was wired, request its first
            // real water check now; otherwise onTrackOpened does this.
            if (this.trackGpsGateOpen) this.envPoller.requestCheck();
            this.notifyTrackingChanged();

            // No startup operation below this point can fail synchronously. Only
            // now may the durable Voyage Start entry be launched; otherwise a
            // subscription/timer setup exception could leave an orphan start pin
            // for a voyage whose tracking transaction was rolled back.
            this.captureImmediateEntry(undefined, 'Voyage Start', scope).catch((e) => {
                log.warn(``, e);
            });
        } catch (error) {
            await this.rollbackFailedTrackingStart({
                scope,
                attempt,
                previousState,
                previousOwnerScope,
                previousNativeLeaseScope,
                previousCaptureLocalOnly,
                previousLastBgLocation,
                previousLastAcceptedLocation,
                previousLastWaterStatus,
                previousLastWaterCheck,
                previousTrackGpsGateOpen,
                attemptedVoyageId,
                nativeLeaseAcquired,
                liveTrickleStarted,
            });
            if (error instanceof StartTrackingCancelledError || !isAuthIdentityScopeCurrent(scope)) return;
            throw error;
        }
    }

    // Fix-acceptance gate, GPS subscription wiring, NMEA ingest, heartbeat,
    // speed-tier debounce, cold-start warm-up, and cleanup all moved to
    // ./shiplog/GpsSubscriptionManager.ts. The orchestrator just owns
    // `lastBgLocation` (updated via the manager's raw `onFix` callback) and
    // `lastAcceptedLocation` (updated only after the full GPS gate).
    //
    // startCourseChangeDetection moved to ./shiplog/CourseChangeDetector.ts.

    // GPS resolution lives in ./shiplog/PositionResolver.ts. CapturePipeline
    // calls getBestPosition() directly; the orchestrator only exposes the
    // two read-only convenience views (status + nav data) since the
    // Dashboard / SystemStatus components want them as instance methods.

    getGpsStatus(): 'locked' | 'stale' | 'none' {
        return _getGpsStatus(this.lastBgLocation, this.isNative);
    }

    getGpsNavData(): { sogKts: number | null; cogDeg: number | null } {
        return _getGpsNavData(this.lastBgLocation, this.isNative);
    }

    /**
     * Pause tracking (user initiated)
     */
    /**
     * Arm cold-start fast-lock for a new voyage: flip the GPS engine to
     * distanceFilter:0 (emit on every chip update, even stationary) so
     * the first-fix consistency gate opens the track promptly, then
     * immediately revert to the steady 1 m filter once that gate opens
     * (with FAST_LOCK_MS as a safety fallback).
     *
     * The revert callback is idempotent: it only acts if we're still
     * tracking THIS voyage, so a stale fire (stop within 30 s, an
     * iOS-throttled background timer, or a stop+new-start race) is a
     * clean no-op. The timer is also cleared in stop/pause.
     */
    private armFastLock(voyageId: string, scope: AuthIdentityScope, state: TrackingState): void {
        this.clearFastLock();
        this.fastLockArmedForVoyageId = voyageId;
        this.fastLockRearmCount = 0;
        BgGeoManager.setSamplingMode('fastlock').catch((e) => {
            log.warn('failed to enter fast-lock sampling on track start:', e);
        });
        const revert = () => {
            this.fastLockTimeoutId = undefined;
            if (this.fastLockArmedForVoyageId !== voyageId) return;
            if (!this.ownerIsCurrent(scope, state) || !state.isTracking || state.currentVoyageId !== voyageId) {
                this.fastLockArmedForVoyageId = undefined;
                return;
            }

            // THE FIX FOR "acquiring GPS fix… for hours" (Shane 2026-08-02).
            //
            // This timer used to revert unconditionally, and on a vessel that
            // is not moving that closed the only door to a first fix. iOS has
            // no fix-rate lever but distanceFilter, so back at the steady 1 m
            // filter a boat on a mooring emits almost no onLocation events.
            // The first-fix gate needs TWO fixes within 15 s to agree before
            // ANY point is persisted, so it never closed its pair, nothing was
            // recorded, and every surface keyed on "has a recorded fix" span
            // forever. The accuracy ceiling only relaxes at 60 s and this timer
            // fired at 65 s — a five-second window in which the whole thing had
            // to succeed.
            //
            // settleFastLock (called from onTrackOpened) is the correct exit
            // and already gate-aware. Until the gate opens, staying in
            // fast-lock is the entire point of fast-lock: keep sampling —
            // but bounded by FAST_LOCK_MAX_REARMS so an unopenable gate
            // cannot latch the max-rate bridge flood for a whole session.
            if (!this.trackGpsGateOpen) {
                if (this.fastLockRearmCount < FAST_LOCK_MAX_REARMS) {
                    this.fastLockRearmCount += 1;
                    this.fastLockTimeoutId = setTimeout(revert, FAST_LOCK_MS);
                    return;
                }
                log.warn('fast-lock cap reached with first-fix gate still closed — reverting to default sampling');
            }

            BgGeoManager.setSamplingMode('default').catch((e) => {
                log.warn('fast-lock revert failed:', e);
            });
            this.fastLockArmedForVoyageId = undefined;
        };
        this.fastLockTimeoutId = setTimeout(revert, FAST_LOCK_MS);
    }

    /**
     * Leave high-frequency cold-start sampling as soon as a vetted fix opens
     * this exact voyage. Late callbacks and old account/voyage generations
     * are intentionally ignored.
     */
    private settleFastLock(voyageId: string, scope: AuthIdentityScope, state: TrackingState): void {
        if (this.fastLockArmedForVoyageId !== voyageId) return;
        if (!this.ownerIsCurrent(scope, state) || !state.isTracking || state.currentVoyageId !== voyageId) return;

        this.clearFastLock();
        BgGeoManager.setSamplingMode('default').catch((e) => {
            log.warn('fast-lock early revert failed:', e);
        });
    }

    /** Cancel a pending fast-lock revert timer and disarm its voyage token. */
    private clearFastLock(): void {
        if (this.fastLockTimeoutId) {
            clearTimeout(this.fastLockTimeoutId);
            this.fastLockTimeoutId = undefined;
        }
        // Put the sampling mode back if WE armed it. setSamplingMode writes the
        // plugin's PERSISTENT config, so it outlives both the timer and the
        // engine: pauseTracking clears fast-lock and returns, and without this
        // distanceFilter 0 stayed latched for whatever ran next — typically
        // tonight's anchor watch, which is armed for hours and whose own
        // comment says the 1 m filter is what stops stationary GPS jitter from
        // generating fixes at anchor. stopTracking (:1392) already restores;
        // pause and identity-change did not.
        const wasArmed = this.fastLockArmedForVoyageId !== undefined;
        this.fastLockArmedForVoyageId = undefined;
        if (wasArmed) {
            void BgGeoManager.setSamplingMode('default').catch(() => {
                /* engine may not be running — ready() re-applies the default */
            });
        }
    }

    async pauseTracking(): Promise<void> {
        const scope = this.trackingOwnerScope;
        if (!scope || !this.ownerIsCurrent(scope)) return;
        const pauseAttempt = ++this.startAttempt;
        const pauseIsCurrent = () => pauseAttempt === this.startAttempt && this.ownerIsCurrent(scope);
        if (this.trackingState.nativeTeardownPending === 'end-voyage') {
            throw new Error('Finish the pending End Voyage GPS teardown before pausing this voyage.');
        }
        if (this.trackingState.nativeTeardownPending === 'release-only') {
            await this.completePendingNativeRelease(scope, this.trackingState);
            if (!pauseIsCurrent()) return;
        }
        this.scheduler.stop();
        this.clearFastLock();
        this.trackGpsGateOpen = false;

        // Stop course change detection + environment polling while paused
        this.courseDetector.stop();
        this.envPoller.stop();

        // Clear GPS buffer — no points to log while paused
        this.trackBuffer.clear();

        // Clean up GPS subscriptions to save battery while paused
        this.gpsSubs.stop();
        this.trackGpsGateOpen = false;

        this.trackingState.isTracking = false;
        this.trackingState.isPaused = true;
        await this.saveTrackingState(scope);
        if (!pauseIsCurrent()) return;
        await stopLiveTrickle(false, scope);
        if (!pauseIsCurrent()) return;
        if (this.isNative && this.sameScope(this.nativeLeaseScope, scope)) {
            try {
                await this.releaseNativeLease(scope);
            } catch (error) {
                this.trackingState.nativeTeardownPending = 'release-only';
                await this.saveTrackingState(scope).catch((persistError) => {
                    log.error('failed to persist pending Pause GPS teardown:', persistError);
                });
                this.notifyTrackingChanged();
                throw new Error(
                    `Voyage recording is paused, but background GPS could not be stopped. Retry Pause before leaving the app. ${error instanceof Error ? error.message : ''}`.trim(),
                );
            }
            if (!pauseIsCurrent()) return;
        }
        this.notifyTrackingChanged();
    }

    private async finalizeStoppedTracking(
        scope: AuthIdentityScope,
        activeState: TrackingState,
        previousVoyageId: string | undefined,
        stopAttempt: number,
    ): Promise<void> {
        this.assertStopCurrent(scope, activeState, stopAttempt);
        const stoppedState: TrackingState = {
            isTracking: false,
            isPaused: false,
            isRapidMode: false,
            isPrecisionMode: false,
            currentVoyageId: previousVoyageId,
            voyageStartTime: activeState.voyageStartTime,
            voyageEndTime: new Date().toISOString(),
        };
        this.trackingState = stoppedState;
        await this.saveTrackingState(scope);
        this.assertStopCurrent(scope, stoppedState, stopAttempt);
        this.pendingStop = null;
        this.notifyTrackingChanged();

        void stopLiveTrickle(true, scope).catch((e) => log.warn('[ShipLog] live-trickle final flush failed:', e));
        setCaptureLocalOnly(false);
        void this.syncOfflineQueueForScope(scope)
            .then((n) => {
                if (n > 0) {
                    log.warn(`[ShipLog] voyage upload complete: ${n} entries synced in background`);
                    if (isAuthIdentityScopeCurrent(scope)) this.notifyTrackingChanged();
                }
            })
            .catch((e) => log.warn('[ShipLog] background voyage upload failed (will retry on interval):', e));
        this.trackingOwnerScope = null;
    }

    private assertStopCurrent(scope: AuthIdentityScope, state: TrackingState, stopAttempt: number): void {
        if (stopAttempt === this.startAttempt && this.ownerIsCurrent(scope, state)) return;
        throw new Error(
            'Voyage stop was superseded before background GPS teardown could be verified. Retry End Voyage.',
        );
    }

    /**
     * Stop tracking and end voyage
     * Responds instantly - final entry capture happens in background
     */
    async stopTracking(expectedVoyageId?: string): Promise<void> {
        const requestScope = getAuthIdentityScope();
        const starting = this.startOperation;
        if (starting && isAuthIdentityScopeCurrent(starting.scope)) {
            if (expectedVoyageId && starting.voyageId !== expectedVoyageId) {
                throw new DifferentVoyageTrackingError(
                    'A different voyage GPS start is still pending. Retry End Voyage when it settles.',
                );
            }
            try {
                await starting.promise;
            } catch {
                // A failed start completes its transactional rollback before
                // rejecting. Inspect the resulting exact-voyage state below:
                // it may be idle, or a durable release-only teardown that End
                // must verify before the remote voyage can be archived.
            }
            if (!isAuthIdentityScopeCurrent(starting.scope)) {
                throw new Error('Voyage GPS start changed account session before End Voyage could verify it.');
            }
        }

        let scope = this.trackingOwnerScope;
        if ((!scope || !this.ownerIsCurrent(scope)) && expectedVoyageId) {
            // A fast A→anonymous→A return synchronously clears the visible
            // owner before A's paused state can hydrate. The stable account
            // key alone cannot prove which voyage owns a retained lease, so
            // exact End waits for hydration before it may release or archive.
            await this.initialize();
            if (!isAuthIdentityScopeCurrent(requestScope)) {
                throw new Error('Account session changed before End Voyage could verify voyage GPS ownership.');
            }
            if (this.initializedGeneration !== requestScope.generation) {
                throw new Error(
                    'Voyage remains active because local GPS ownership could not be verified. Retry End Voyage.',
                );
            }
            scope = this.trackingOwnerScope;
        }
        const inFlight = this.stopOperation;
        if (
            inFlight &&
            ((scope && this.sameScope(inFlight.scope, scope)) || (!scope && isAuthIdentityScopeCurrent(inFlight.scope)))
        ) {
            if (expectedVoyageId && inFlight.voyageId !== expectedVoyageId) {
                throw new Error('A different voyage is already completing GPS teardown. End Voyage was not applied.');
            }
            await inFlight.promise;
            return;
        }
        if (!scope || !this.ownerIsCurrent(scope)) {
            const retainedLeaseScope = this.nativeLeaseScope;
            if (
                expectedVoyageId &&
                retainedLeaseScope &&
                retainedLeaseScope.key === requestScope.key &&
                isAuthIdentityScopeCurrent(requestScope)
            ) {
                try {
                    // A fast A→anonymous→A return can reach End Voyage before
                    // A's paused tracking state rehydrates. The native lease is
                    // still real: join/retry its old-generation release and do
                    // not let the remote row archive on an unverified stop.
                    await this.releaseNativeLease(retainedLeaseScope);
                } catch (error) {
                    throw new Error(
                        `Voyage remains active because background GPS from this account session could not be stopped. Retry End Voyage. ${error instanceof Error ? error.message : ''}`.trim(),
                    );
                }
                if (!isAuthIdentityScopeCurrent(requestScope)) {
                    throw new Error('Account session changed before End Voyage could verify background GPS teardown.');
                }
            }
            return;
        }
        if (expectedVoyageId && this.trackingState.currentVoyageId !== expectedVoyageId) {
            throw new DifferentVoyageTrackingError(
                'A different voyage is currently using GPS logging for this device.',
            );
        }
        const retainedLeaseScope = this.nativeLeaseScope;
        if (
            expectedVoyageId &&
            !this.trackingState.nativeTeardownPending &&
            retainedLeaseScope &&
            !this.sameScope(retainedLeaseScope, scope) &&
            retainedLeaseScope.key === scope.key
        ) {
            try {
                // Hydration proved the exact voyage. Join the retained lease's
                // captured generation before terminal work; final teardown
                // must not skip it merely because A returned as a new gen.
                await this.releaseNativeLease(retainedLeaseScope);
            } catch (error) {
                throw new Error(
                    `Voyage remains active because background GPS from this account session could not be stopped. Retry End Voyage. ${error instanceof Error ? error.message : ''}`.trim(),
                );
            }
            if (!this.ownerIsCurrent(scope) || this.trackingState.currentVoyageId !== expectedVoyageId) {
                throw new Error('Voyage GPS ownership changed before End Voyage could verify teardown.');
            }
        }

        const promise = this.performStopTracking(scope);
        this.stopOperation = { scope, voyageId: this.trackingState.currentVoyageId, promise };
        try {
            await promise;
        } finally {
            if (this.stopOperation?.promise === promise) this.stopOperation = null;
        }
    }

    private async performStopTracking(scope: AuthIdentityScope): Promise<void> {
        // The native teardown is the prime suspect for a process death: it
        // stops background geolocation and flushes the queue, and none of that
        // is JS the error boundary could catch.
        crumb('stop:native-in');
        // FINE-GRAINED, because the death is one millisecond into this
        // function and never reaches its end. Each of these is a synchronous
        // localStorage write, so whichever statement is fatal, the crumb
        // before it survives.
        const pending = this.pendingStop;
        crumb('stop:n1', pending ? 'pending' : 'none');
        if (pending && this.sameScope(pending.scope, scope) && this.ownerIsCurrent(scope, pending.state)) {
            const retryAttempt = ++this.startAttempt;
            try {
                crumb('stop:n2-release-in');
                await this.completePendingNativeRelease(scope, pending.state);
                crumb('stop:n2-release-out');
            } catch (error) {
                crumb('stop:n2-threw');
                throw new Error(
                    `Voyage remains paused because background GPS teardown is still pending. Retry End Voyage. ${error instanceof Error ? error.message : ''}`.trim(),
                );
            }
            crumb('stop:n3-finalize-in');
            await this.finalizeStoppedTracking(scope, pending.state, pending.voyageId, retryAttempt);
            crumb('stop:n3-finalize-out');
            return;
        }
        const activeState = this.trackingState;
        crumb('stop:n4-state', `buf=${this.trackBuffer.length}`);
        if (!this.ownerIsCurrent(scope, activeState)) return;
        const stopAttempt = ++this.startAttempt;
        const assertStopCurrent = (state: TrackingState) => this.assertStopCurrent(scope, state, stopAttempt);
        if (activeState.nativeTeardownPending) {
            try {
                crumb('stop:n5-release-in');
                await this.completePendingNativeRelease(scope, activeState);
                crumb('stop:n5-release-out');
            } catch (error) {
                throw new Error(
                    `Voyage remains paused because background GPS teardown is still pending. Retry End Voyage. ${error instanceof Error ? error.message : ''}`.trim(),
                );
            }
            assertStopCurrent(activeState);
        }
        const previousVoyageId = activeState.currentVoyageId;

        // Following a route is a CHILD of this passage, not a peer of it: the
        // route was being followed FOR this voyage, and the voyage is over.
        // Left armed it kept leg grading, ETAs, arrival alerts and the public
        // page all computing against a passage that had ended — and the next
        // voyage started life inheriting stale following state.
        //
        // Synchronous and fire-and-forget on purpose. A first cut awaited two
        // dynamic imports plus clearFollowedRoute() here, which pushed the
        // whole teardown behind two chunk loads and measurably delayed the
        // stopped state (ShipLogTrackingIdentity caught it). Writing the
        // public link through VoyageLogService directly also sidesteps
        // clearFollowedRoute()'s `isTracking` guard, so ordering against the
        // state flip below stops mattering at all.
        useFollowRouteStore.getState().stopFollowing();
        if (previousVoyageId) {
            // Durable-intent clear (hardening 2026-08-01): the direct one-shot
            // delete meant an offline stop at the anchorage left the ENDED
            // passage still publishing its route/destination/ETA until some
            // later successful write. The ledger records the clear intent and
            // retries on reconnect; last-intent-per-voyage wins, so a queued
            // link write from cast-off can never resurrect after this.
            void import('./shiplog/planLinkIntent')
                .then(({ setPlanLinkWithRetry }) => setPlanLinkWithRetry(previousVoyageId, null))
                .catch((error) => {
                    log.warn('[ShipLog] public followed-route link not cleared:', error);
                });
        }

        this.scheduler.stop();

        // The geographic sampler may have accepted a recent raw fix that was
        // not yet due at the current cadence. Preserve it before the final
        // drain so the voyage ends at the actual last known position.
        this.gpsSubs.bufferFinalPoint();
        // Prevent a late zone callback from re-arming the scheduler while the
        // stop path owns its final drain. Buffered accepted tail points remain
        // eligible because flushBufferedTrack only blocks an empty fallback.
        this.trackGpsGateOpen = false;

        // Flush before exposing a stopped state. If an older scheduler flush
        // was invalidated by the stop token, its suffix goes to the durable
        // owner-scoped handoff and is replayed here.
        try {
            crumb('stop:n6-flush-in', `buf=${this.trackBuffer.length}`);
            await this.flushBufferedTrack(scope, activeState);
            crumb('stop:n6-flush-out');
        } catch (e) {
            log.warn('[ShipLog] final buffer flush deferred to durable handoff:', e);
        }
        assertStopCurrent(activeState);
        if (previousVoyageId) {
            await this.replayCaptureHandoffs(scope, activeState, previousVoyageId).catch((error) => {
                log.warn('final capture handoff remains durable for later replay:', error);
            });
            assertStopCurrent(activeState);
        }

        // No callback may append after the final drain.
        this.gpsSubs.stop();
        this.trackGpsGateOpen = false;
        this.courseDetector.stop();
        this.courseDetector.reset();
        this.envPoller.stop();
        if (this.precisionModeTimeoutId) {
            clearTimeout(this.precisionModeTimeoutId);
            this.precisionModeTimeoutId = undefined;
        }
        this.clearFastLock();

        // Pick up the tiny tail that may have arrived between the first flush
        // and subscription teardown.
        if (this.trackBuffer.length > 0) {
            const finalFlush = await this.flushBufferedTrack(scope, activeState);
            assertStopCurrent(activeState);
            if (finalFlush !== 'complete' && this.trackBuffer.length > 0 && previousVoyageId) {
                const retained = drainBufferedTrackForHandoff(this.trackBuffer);
                await this.queueCaptureHandoff(scope, previousVoyageId, retained);
                assertStopCurrent(activeState);
            }
        }

        await BgGeoManager.setSamplingMode('default');
        assertStopCurrent(activeState);
        GpsPrecision.reset();

        await this.captureImmediateEntry(previousVoyageId, 'Voyage End', scope).catch((err) => {
            log.warn(``, err);
        });
        assertStopCurrent(activeState);

        // Clear the old voyage anchor while a new same-account start is still
        // blocked by activeState.isTracking. It can never erase a new
        // voyage's first position.
        await _clearVoyageState(scope);
        assertStopCurrent(activeState);

        // EMPTY-VOYAGE DISCARD + LOCAL TRACK CACHE. The voyage's points are
        // still ONLY in the offline queue here (local-first capture never
        // synced them). So this is the one safe place to bin an empty
        // track — delete it from the queue NOW, before the upload below
        // can ship it to the cloud. Doing it later (UI prune) races that
        // upload: the queue snapshot is taken here, uploads in the
        // background, and re-inserts the voyage after any delete. Killing
        // it pre-upload means there's nothing to resurrect.
        //
        // "Empty" = never went anywhere (max cumulative < EMPTY_TRACK_NM,
        // i.e. the card's "0.0 NM") AND no deliberate manual entry.
        let voyageWasEmpty = false;
        let voyageTrack: ShipLogEntry[] = [];
        if (previousVoyageId) {
            try {
                const queued = await _getOfflineEntries();
                assertStopCurrent(activeState);
                voyageTrack = queued.filter(
                    (entry) =>
                        entry.voyageId === previousVoyageId &&
                        (entry as ShipLogEntry & { owner_user_id?: string }).owner_user_id === scope.userId,
                );
                const maxCumNM = voyageTrack.length
                    ? Math.max(0, ...voyageTrack.map((e) => e.cumulativeDistanceNM || 0))
                    : 0;
                const hasManual = voyageTrack.some((e) => e.entryType === 'manual');
                voyageWasEmpty = maxCumNM < EMPTY_TRACK_NM && !hasManual;

                if (voyageWasEmpty) {
                    await _deleteVoyageFromOfflineQueue(previousVoyageId);
                    assertStopCurrent(activeState);
                    // A discarded voyage never uploads to ship_logs, so any
                    // dock points it trickled to live_track would linger as a
                    // stale public "live" tail that nothing supersedes. Retire
                    // this exact voyage (rather than every live row for the
                    // account) so an immediately-started next voyage is safe.
                    void retireLiveTrackVoyage(previousVoyageId, 'discarded', scope).catch(() => {
                        /* best effort */
                    });
                    log.warn(`[ShipLog] empty voyage discarded at stop (${maxCumNM.toFixed(3)} NM) — not uploaded`);
                } else {
                    // Cache the real track so viewing it is instant/offline.
                    void setCachedVoyageTrack(previousVoyageId, voyageTrack, scope).catch(() => {
                        /* best effort */
                    });
                }
            } catch (e) {
                log.warn('empty-voyage check / track cache snapshot failed:', e);
            }
        }

        // Release exactly the lease owned by this stopping session before a
        // same-account start can acquire its own lease.
        if (this.isNative && this.sameScope(this.nativeLeaseScope, scope)) {
            try {
                await this.releaseNativeLease(scope);
            } catch (error) {
                assertStopCurrent(activeState);
                // All JS capture paths are already disarmed. Represent that
                // truthfully as a paused, retryable stop rather than leaving
                // isTracking=true with no subscriptions while native GPS still
                // holds the retained lease.
                activeState.isTracking = false;
                activeState.isPaused = true;
                activeState.isPrecisionMode = false;
                activeState.nativeTeardownPending = 'end-voyage';
                this.pendingStop = { scope, state: activeState, voyageId: previousVoyageId };
                await this.saveTrackingState(scope);
                await stopLiveTrickle(false, scope).catch(() => {});
                this.notifyTrackingChanged();
                throw new Error(
                    `Voyage recording is paused, but background GPS is still active. Retry End Voyage to finish stopping. ${error instanceof Error ? error.message : ''}`.trim(),
                );
            }
            assertStopCurrent(activeState);
        }

        // Reached only when native teardown verified — the stop is real.
        // Recording it lets the Log page's empty-track sweep skip the 15-min
        // cross-device hold for this voyage, whichever door stopped it.
        if (previousVoyageId) recordDeviceStop(previousVoyageId);
        await this.finalizeStoppedTracking(scope, activeState, previousVoyageId, stopAttempt);
    }

    /**
     * Create an immediate log entry without waiting for GPS
     * The entry is created instantly with timestamp, GPS position is fetched async
     * This ensures the card appears in the UI immediately
     */
    async captureImmediateEntry(
        voyageId?: string,
        waypointLabel: string = 'Voyage Start',
        scope: AuthIdentityScope = this.trackingOwnerScope ?? getAuthIdentityScope(),
    ): Promise<ShipLogEntry | null> {
        if (!isAuthIdentityScopeCurrent(scope)) return null;
        // Voyage Start performs its own bounded GPS-acquisition wait. It no
        // longer advances last-position, and its heartbeat update is
        // monotonic, so holding the position-write queue for up to 30s would
        // only delay the first selected vertex. Every other immediate marker
        // can advance the anchor and therefore shares the queue.
        if (waypointLabel === 'Voyage Start') {
            return _captureImmediate(this._captureCtx(scope), voyageId, waypointLabel);
        }
        const state = this.trackingState;
        return this.enqueueCaptureWrite(scope, state, (ctx) => _captureImmediate(ctx, voyageId, waypointLabel));
    }

    /**
     * Capture a single log entry
     * Auto-pause detection: If vessel hasn't moved >0.05nm in 1 hour, pause tracking
     */
    async captureLogEntry(
        entryType: 'auto' | 'manual' | 'waypoint' = 'auto',
        notes?: string,
        waypointName?: string,
        eventCategory?:
            | 'navigation'
            | 'weather'
            | 'equipment'
            | 'crew'
            | 'arrival'
            | 'departure'
            | 'safety'
            | 'observation',
        engineStatus?: 'running' | 'stopped' | 'maneuvering',
        voyageId?: string,
        skipDedup?: boolean,
    ): Promise<ShipLogEntry | null> {
        const scope = this.trackingOwnerScope ?? getAuthIdentityScope();
        if (!isAuthIdentityScopeCurrent(scope)) return null;
        const state = this.trackingState;
        if (entryType === 'auto' && state.isTracking && !this.trackGpsGateOpen) return null;
        const opts: CaptureLogOptions = {
            entryType,
            notes,
            waypointName,
            eventCategory,
            engineStatus,
            voyageId,
            skipDedup,
        };
        return this.enqueueCaptureWrite(scope, state, (ctx) => _captureLog(ctx, opts));
    }

    /**
     * Flush the high-frequency GPS buffer.
     *
     * Called by the selected-point callback and as a timer safety net.
     * Drains only the GPS vertices admitted by the geographic sampler, then
     * creates a log entry for each selected point.
     *
     * Empty ticks intentionally do not invent a position from the live raw
     * GPS cache; only the geographic sampler's selected vertices are saved.
     */
    private flushBufferedTrack(
        scope: AuthIdentityScope,
        state: TrackingState = this.trackingState,
    ): Promise<FlushBufferedTrackResult> {
        if (!this.ownerIsCurrent(scope, state)) return Promise.resolve('stale');
        // Before the first vetted GPS point, the raw UI cache is explicitly
        // untrusted and there cannot be a legitimate in-flight selected-point
        // flush yet.
        if (!this.trackGpsGateOpen && this.trackBuffer.length === 0) return Promise.resolve('complete');
        // The geographic sampler is the sole authority on persisted vertices.
        // CapturePipeline receives allowEmptyBufferFallback:false through the
        // context below, so an empty scheduler/heartbeat tick is a no-op—not
        // a raw-cache capture—while an in-flight durable flush can still be
        // joined by stopTracking.
        return this.enqueueCaptureWrite(scope, state, (ctx) => _flushBufferedTrack(ctx));
    }

    /**
     * Add a manual log entry (user-initiated)
     * Creates the entry immediately - GPS position is fetched async
     * IMPORTANT: Requires an active voyage (tracking or explicitly passed voyageId)
     */
    async addManualEntry(
        notes?: string,
        waypointName?: string,
        eventCategory?:
            | 'navigation'
            | 'weather'
            | 'equipment'
            | 'crew'
            | 'arrival'
            | 'departure'
            | 'safety'
            | 'observation',
        engineStatus?: 'running' | 'stopped' | 'maneuvering',
        voyageId?: string,
    ): Promise<ShipLogEntry | null> {
        const scope = this.trackingOwnerScope ?? getAuthIdentityScope();
        if (!isAuthIdentityScopeCurrent(scope)) return null;
        const state = this.trackingState;
        const opts: AddManualOptions = { notes, waypointName, eventCategory, engineStatus, voyageId };
        return this.enqueueCaptureWrite(scope, state, (ctx) => _addManual(ctx, opts));
    }

    /** Queue one durable position-anchor operation behind earlier writes in this exact voyage session. */
    private enqueueCaptureWrite<T>(
        scope: AuthIdentityScope,
        state: TrackingState,
        operation: (ctx: CaptureContext) => Promise<T>,
    ): Promise<T> {
        // Snapshot the capture context before queueing so a stale callback
        // cannot wake later and accidentally adopt a replacement session.
        const ctx = this._captureCtx(scope);
        const prior = this.captureWriteTails.get(state) ?? Promise.resolve();
        const next = prior.catch(() => undefined).then(() => operation(ctx));
        this.captureWriteTails.set(
            state,
            next.then(
                () => undefined,
                () => undefined,
            ),
        );
        return next;
    }

    /**
     * Build the CaptureContext bag the pipeline functions consume.
     * Lives on `this` so each capture-invocation gets the live state +
     * the right hooks; the pipeline mutates `trackingState` in place.
     */
    private _captureCtx(scope: AuthIdentityScope): CaptureContext {
        const state = this.trackingState;
        const sessionAttempt = this.startAttempt;
        return {
            identityScope: scope,
            isSessionCurrent: () =>
                isAuthIdentityScopeCurrent(scope) &&
                sessionAttempt === this.startAttempt &&
                state === this.trackingState &&
                (!this.trackingOwnerScope || this.sameScope(this.trackingOwnerScope, scope)),
            trackingState: state,
            saveTrackingState: () => _saveTrackingState(state, scope),
            isNative: this.isNative,
            // Unlike the raw UI cache, this location cleared the full GPS
            // acceptance gate. Voyage Start may use it if an immediate
            // selected-point flush has already drained the live buffer.
            getAcceptedFix: () => this.lastAcceptedLocation,
            // Prefer a vetted location for capture paths. The raw cache is
            // still available before any accepted GPS point exists (e.g. a
            // user-created manual note during initial acquisition), but it
            // can never displace an established voyage track vertex.
            getCachedFix: () => this.lastAcceptedLocation ?? this.lastBgLocation,
            setCachedFix: (pos) => {
                if (!isAuthIdentityScopeCurrent(scope) || state !== this.trackingState) return;
                this.lastBgLocation = pos;
            },
            trackBuffer: this.trackBuffer,
            allowEmptyBufferFallback: false,
            handoffBufferedPoints: (points) =>
                this.queueCaptureHandoff(scope, state.currentVoyageId, points).catch((error) => {
                    log.warn('failed to persist stale capture suffix:', error);
                    throw error;
                }),
            getLastWaterStatus: () => this.lastWaterStatus,
            setLastWaterStatus: (v) => {
                if (!isAuthIdentityScopeCurrent(scope) || state !== this.trackingState) return;
                this.lastWaterStatus = v;
            },
            rescheduleAdaptiveInterval: () => this.rescheduleAdaptiveInterval(scope, state),
        };
    }

    /**
     * Get tracking status
     */
    getTrackingStatus(): TrackingState {
        return { ...this.trackingState };
    }

    /**
     * The latest fix that cleared the FULL shiplog acceptance gate
     * (accuracy, monotonic own-timestamp, anti-replay), or null. While a
     * voyage is recording this is the most-trustworthy position in the
     * app — consumers pinning user content mid-voyage (diary entries)
     * should prefer it over a one-shot platform fetch, which can hand
     * back a cached berth fix wearing a fresh timestamp.
     */
    getLastAcceptedFix(): CachedPosition | null {
        return this.lastAcceptedLocation;
    }

    /**
     * Declare the engine on/off while tracking. Sticky — stamped onto
     * subsequent auto track points (CapturePipeline) so the voyage's
     * sail/motor split is real data, not a guess. No-op when not tracking.
     */
    async setEngineRunning(running: boolean): Promise<void> {
        const scope = this.trackingOwnerScope;
        const state = this.trackingState;
        if (!scope || !this.ownerIsCurrent(scope, state)) return;
        if (!state.isTracking) return;
        if (state.engineRunning === running) return;
        state.engineRunning = running;
        await this.saveTrackingState(scope);
        if (!this.ownerIsCurrent(scope, state)) return;
        this.notifyTrackingChanged();
    }

    getEngineRunning(): boolean | undefined {
        return this.trackingState.engineRunning;
    }

    /**
     * Toggle rapid GPS mode (3-second intervals for marina/shore navigation)
     * Activated by 3-second long-press on tracking indicator
     */
    async setRapidMode(enabled: boolean): Promise<void> {
        const scope = this.trackingOwnerScope;
        const state = this.trackingState;
        if (!scope || !this.ownerIsCurrent(scope, state)) return;
        if (!state.isTracking) {
            return;
        }

        if (state.isRapidMode === enabled) {
            return;
        }

        // Update state
        state.isRapidMode = enabled;
        await this.saveTrackingState(scope);
        if (!this.ownerIsCurrent(scope, state)) return;

        // Always stop the existing scheduler chain — both modes restart it.
        this.scheduler.stop();

        if (enabled) {
            // RAPID MODE: 3-second selected-vertex cadence for marina navigation.

            // Clear any existing rapid mode timeout
            if (this.rapidModeTimeoutId) {
                clearTimeout(this.rapidModeTimeoutId);
                this.rapidModeTimeoutId = undefined;
            }

            // AUTO-DISABLE: Set 15-minute timeout to revert to normal mode
            const RAPID_AUTO_DISABLE_MS = 15 * 60 * 1000; // 15 minutes
            this.rapidModeTimeoutId = setTimeout(async () => {
                if (!this.ownerIsCurrent(scope, state)) return;
                await this.setRapidMode(false);
            }, RAPID_AUTO_DISABLE_MS);

            // Flush any already-selected vertex immediately. Raw UI fixes
            // remain deliberately ineligible for a plotted track.
            this.flushBufferedTrack(scope, state).catch((err) => {
                log.warn('rapid-mode initial selected-point flush failed', err);
            });

            // 3-second non-aligned backup flush — marina navigation cares
            // about density, not clock marks. The GPS manager also flushes
            // each retained point immediately.
            this.scheduler.scheduleEvery(RAPID_INTERVAL_MS, () =>
                this.ownerIsCurrent(scope, state) ? this.flushBufferedTrack(scope, state) : null,
            );
        } else {
            // ADAPTIVE MODE: Restore zone-based intervals

            // Clear rapid mode timeout if it exists
            if (this.rapidModeTimeoutId) {
                clearTimeout(this.rapidModeTimeoutId);
                this.rapidModeTimeoutId = undefined;
            }

            // Re-evaluate zone and set adaptive interval
            await this.rescheduleAdaptiveInterval(scope, state);
        }
    }

    /**
     * Toggle Precision Mode — hi-fi GPS sampling at ~2 Hz with live
     * decimation in GpsTrackBuffer.pushWithLiveFilter.
     *
     * 2026-05-17 update: Precision Mode is now ON BY DEFAULT for every
     * tracking session (see `startTracking`). The toggle is preserved
     * as a public API for two reasons:
     *   1. Future paywall gating — if we ever ship Precision as a
     *      Skipper-tier-only feature, we'll need to flip it off for
     *      free users from a feature-gate boundary.
     *   2. Test isolation — unit tests still need a programmatic way
     *      to swap between modes.
     *
     * The earlier 60-minute auto-shutoff was REMOVED. It was a battery
     * guard from when Precision was a user-toggled "I'll just turn it
     * on for harbour entry" mode. With Precision always-on for a full
     * voyage, the auto-disable would silently revert to lower-fidelity
     * sampling mid-passage — exactly wrong. Assumption: user is on
     * charger when tracking (their explicit ack).
     *
     * Reverts to default sampling on stopTracking — Precision Mode is
     * voyage-scoped, not app-scoped.
     */
    async setPrecisionMode(enabled: boolean): Promise<void> {
        const scope = this.trackingOwnerScope;
        const state = this.trackingState;
        if (!scope || !this.ownerIsCurrent(scope, state)) return;
        if (!state.isTracking) return;
        if ((state.isPrecisionMode === true) === enabled) return;

        state.isPrecisionMode = enabled;
        await this.saveTrackingState(scope);
        if (!this.ownerIsCurrent(scope, state)) return;

        // Reconfigure Transistor BgGeo at runtime — no engine restart.
        await BgGeoManager.setSamplingMode(enabled ? 'precision' : 'default');
        if (!this.ownerIsCurrent(scope, state)) return;

        // Clear any legacy auto-shutoff timer (preserved for crash-
        // recovery from older app versions where the timer may have
        // been pending in memory).
        if (this.precisionModeTimeoutId) {
            clearTimeout(this.precisionModeTimeoutId);
            this.precisionModeTimeoutId = undefined;
        }

        log.info(`Precision Mode ${enabled ? 'ENABLED' : 'DISABLED'}`);
    }

    /** Read accessor for Precision Mode — used by the UI toggle. */
    isPrecisionMode(): boolean {
        return this.trackingState.isPrecisionMode === true;
    }

    /**
     * Get current voyage ID (only if actively tracking)
     */
    getCurrentVoyageId(): string | undefined {
        // Only return voyage ID if actively tracking - prevents stale "active" status
        return this.trackingState.isTracking ? this.trackingState.currentVoyageId : undefined;
    }

    /**
     * Resolve the active recording voyage across both a warm app session and
     * a cold WebView launch. Diary creation can happen before the Log page
     * hydrates this service; in that case the persisted tracking state is the
     * authoritative local signal. This deliberately performs no GPS/native
     * side effects — it only reads the account-scoped tracking record.
     */
    async resolveActiveVoyageId(): Promise<string | undefined> {
        const scope = getAuthIdentityScope();
        if (this.ownerIsCurrent(scope)) {
            return activeVoyageIdFromTrackingState(this.trackingState);
        }

        const persisted = await loadTrackingState(scope);
        if (!isAuthIdentityScopeCurrent(scope)) return undefined;
        return activeVoyageIdFromTrackingState(persisted);
    }

    /**
     * Resolve the vessel that was bound at cast-off. A selected fleet vessel
     * is only a fallback when no track is active; an old tracking record
     * without a boat id must remain unassigned rather than being silently
     * moved onto a vessel selected after the voyage began.
     */
    async resolveActiveBoatId(): Promise<string | undefined> {
        const scope = getAuthIdentityScope();
        const state = this.ownerIsCurrent(scope) ? this.trackingState : await loadTrackingState(scope);
        if (!isAuthIdentityScopeCurrent(scope)) return undefined;

        const trackingBoatId = activeBoatIdFromTrackingState(state);
        if (trackingBoatId) return trackingBoatId;

        // An active legacy track has no immutable boat binding. Never use the
        // current fleet choice for it: the skipper may have switched vessels
        // since casting off. The database migration's legacy fallback can
        // handle those historic rows safely.
        if (state?.isTracking === true && state.isPaused !== true) return undefined;

        try {
            const { useSettingsStore } = await import('../stores/settingsStore');
            const activeVesselId = useSettingsStore.getState().activeVesselId;
            return typeof activeVesselId === 'string' && activeVesselId.trim() ? activeVesselId.trim() : undefined;
        } catch (error) {
            // A diary entry is still locally durable if fleet hydration has
            // not completed on a cold launch. It can remain legacy/unbound.
            log.warn('could not resolve active vessel for diary association:', error);
            return undefined;
        }
    }

    /** Whether GPS trip-logging is currently active. Mirrors
     *  trackingState.isTracking — exposed publicly so the Nav Station
     *  hero band can distinguish "voyage marked active in DB" from
     *  "boat is actually moving / recording right now". */
    isTracking(): boolean {
        return this.trackingState.isTracking === true;
    }

    // ── Tracking-state listeners ──
    // Lightweight pub/sub so the Nav Station hero band can react to
    // start/stop/pause without polling. Fires on every state mutation
    // that flips `isTracking` or `isPaused`. Returns an unsubscribe.
    private trackingListeners = new Set<(tracking: boolean, paused: boolean) => void>();

    onTrackingStateChange(listener: (tracking: boolean, paused: boolean) => void): () => void {
        this.trackingListeners.add(listener);
        // Fire once with the current state so subscribers don't have
        // to read it separately on mount.
        listener(this.trackingState.isTracking === true, this.trackingState.isPaused === true);
        return () => {
            this.trackingListeners.delete(listener);
        };
    }

    private notifyTrackingChanged(): void {
        const tracking = this.trackingState.isTracking === true;
        const paused = this.trackingState.isPaused === true;
        this.trackingListeners.forEach((fn) => {
            try {
                fn(tracking, paused);
            } catch {
                /* listener errors don't poison the loop */
            }
        });
    }

    // --- DELEGATED CRUD METHODS (implementation in ./shiplog/EntryCrud.ts) ---

    async deleteVoyage(voyageId: string, onAccepted?: () => void): Promise<boolean> {
        return _deleteVoyage(voyageId, onAccepted);
    }

    async deleteEntry(entryId: string): Promise<boolean> {
        return _deleteEntry(entryId);
    }

    async getLogEntries(limit: number = 50): Promise<ShipLogEntry[]> {
        return _getLogEntries(limit);
    }

    async importGPXVoyage(
        entries: Partial<ShipLogEntry>[],
        options?: ImportGPXOptions,
    ): Promise<{ voyageId: string; savedCount: number }> {
        return _importGPXVoyage(entries, options);
    }

    async getArchivedEntries(limit?: number): Promise<ShipLogEntry[]> {
        return _getArchivedEntries(limit);
    }

    async getAllEntriesForCareer(): Promise<ShipLogEntry[]> {
        return _getAllEntriesForCareer();
    }

    /**
     * One aggregated row per voyage (no individual track points) — the
     * Log list's data source. Server-side RPC with a lightweight
     * client-side fallback. See services/shiplog/VoyageSummary.ts.
     */
    async getVoyageSummaries(includeArchived = false): Promise<VoyageSummary[]> {
        return _getVoyageSummaries(includeArchived);
    }

    /** INSTANT local read of cached summaries (no network) — Log boot path. */
    async getCachedVoyageSummaries(): Promise<VoyageSummary[]> {
        return _getCachedVoyageSummaries();
    }

    /** Lazy-load the FULL entry list for one voyage (expand / map open). */
    async getVoyageEntries(voyageId: string, includeArchived = false): Promise<ShipLogEntry[]> {
        return _getVoyageEntries(voyageId, includeArchived);
    }

    async archiveVoyage(voyageId: string): Promise<boolean> {
        const archived = await _archiveVoyage(voyageId);
        if (archived) {
            // The durable DB trigger is the offline fallback. This eager
            // client retirement makes the public map disappear immediately
            // when signal is available, and synchronously disarms a matching
            // in-memory live session before its next flush.
            void retireLiveTrackVoyage(voyageId, 'archived').catch(() => {
                /* the archive outbox/DB trigger retries the server fence */
            });
        }
        return archived;
    }

    async unarchiveVoyage(voyageId: string): Promise<boolean> {
        return _unarchiveVoyage(voyageId);
    }

    // --- PRIVATE METHODS ---
    // saveTrackingState delegates to TrackingStateStore.ts. The pipeline
    // calls getLastPosition / saveLastPosition directly from the same
    // module, so we no longer wrap them on the orchestrator.

    private async saveTrackingState(scope: AuthIdentityScope): Promise<void> {
        const state = this.trackingState;
        await _saveTrackingState(state, scope);
    }

    // --- DELEGATED OFFLINE QUEUE METHODS (implementation in ./shiplog/OfflineQueue.ts) ---

    async syncOfflineQueue(): Promise<number> {
        return this.syncOfflineQueueForScope(getAuthIdentityScope());
    }

    private async syncOfflineQueueForScope(scope: AuthIdentityScope): Promise<number> {
        if (!isAuthIdentityScopeCurrent(scope)) return 0;
        const count = await _syncOfflineQueue();
        return isAuthIdentityScopeCurrent(scope) ? count : 0;
    }

    private startSyncInterval(): void {
        if (this.syncIntervalId) return;
        this.syncIntervalId = setInterval(
            () => {
                const scope = getAuthIdentityScope();
                // While a voyage is RECORDING (or paused mid-voyage) the
                // queue is the live store (local-first capture) — don't
                // upload an incomplete voyage. The flush happens at
                // stopTracking; this interval is the retry net for
                // completed voyages that failed to sync.
                if (this.trackingState.isTracking || this.trackingState.isPaused) return;
                void this.syncOfflineQueueForScope(scope);
            },
            2 * 60 * 1000,
        );
    }

    async getOfflineQueueCount(): Promise<number> {
        const scope = getAuthIdentityScope();
        const count = await _getOfflineQueueCount();
        return isAuthIdentityScopeCurrent(scope) ? count : 0;
    }

    /** Delegate to extracted module */
    async savePassagePlanToLogbook(plan: import('../types').VoyagePlan): Promise<string | null> {
        return _savePassagePlanToLogbook(plan);
    }

    async getOfflineEntries(): Promise<ShipLogEntry[]> {
        const scope = getAuthIdentityScope();
        const entries = await _getOfflineEntries();
        return isAuthIdentityScopeCurrent(scope) ? entries : [];
    }
}

// Export singleton instance
export const ShipLogService = new ShipLogServiceClass();
