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
 * - Battery-conscious motion detection
 * - Works with screen locked, app backgrounded, or terminated
 */

import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { ShipLogEntry } from '../types';
import { BgGeoManager, CachedPosition } from './BgGeoManager';
import { EnvironmentService } from './EnvironmentService';
import { createLogger } from '../utils/createLogger';

// --- Extracted modules ---
import { savePassagePlanToLogbook as _savePassagePlanToLogbook } from './shiplog/PassagePlanSave';
import { determineLoggingZone, getIntervalForZone, getIntervalForSpeed, type LoggingZone } from './shiplog/helpers';
import { GpsTrackBuffer } from './shiplog/GpsTrackBuffer';
import { GpsPrecision } from './shiplog/GpsPrecisionTracker';
import {
    loadTrackingState,
    saveTrackingState as _saveTrackingState,
    clearVoyageState as _clearVoyageState,
    decideInitTrackingAction,
    suspendTrackingStateForIdentityChange,
    type TrackingState,
} from './shiplog/TrackingStateStore';
import { CourseChangeDetector } from './shiplog/CourseChangeDetector';
import { EnvironmentPoller } from './shiplog/EnvironmentPoller';
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
import { setCaptureLocalOnly } from './shiplog/EntrySave';
import {
    startLiveTrickle,
    stopLiveTrickle,
    purgeLiveTrack,
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

const log = createLogger('ShipLog');

// --- CONSTANTS still owned by the orchestrator ---
//
// Constants used only inside the capture pipeline (DEDUP_THRESHOLD_NM,
// STATIONARY_THRESHOLD_NM, MAX_PLAUSIBLE_SPEED_KTS, MAX_ACCELERATION_KTS,
// GPS_STALE_LIMIT_MS) live in CapturePipeline.ts now. Storage keys +
// state interfaces live in TrackingStateStore.ts. Helper functions, DB
// mapping, and zone detection live in helpers.ts.

const TRACKING_INTERVAL_MS = 60 * 1000; // 60 seconds (fallback / offshore default)
const RAPID_INTERVAL_MS = 10 * 1000; // 10 seconds for marina/shore navigation (manual override)
const VOYAGE_STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000; // 6 hours — start new voyage instead of resuming
const FAST_LOCK_MS = 30 * 1000; // cold-start fast-lock (distanceFilter:0) duration for a new voyage
const CAPTURE_HANDOFF_KEY = 'ship_log_capture_handoff';
const CAPTURE_HANDOFF_VERSION = 1;

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

// --- MAIN SERVICE CLASS ---

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
    // (envCheckIntervalId moved into EnvironmentPoller — see this.envPoller below)
    // GPS subscriptions, fix-acceptance gate, speed-tier debounce, and
    // heartbeat all live in GpsSubscriptionManager.
    private gpsSubs = new GpsSubscriptionManager();
    private trackingState: TrackingState = { isTracking: false, isPaused: false, isRapidMode: false };
    /** Exact auth generation that owns the visible/armed voyage. */
    private trackingOwnerScope: AuthIdentityScope | null = null;
    /** Invalidates overlapping start calls within one auth generation. */
    private startAttempt = 0;
    /** One ref-counted native GPS lease held by this service, if any. */
    private nativeLeaseScope: AuthIdentityScope | null = null;
    /** Serialises durable raw-fix handoffs independently per account. */
    private captureHandoffTails = new Map<string, Promise<void>>();
    /**
     * In-memory copy retained until Preferences confirms the write. It is
     * scoped by owner and never exposed through the live buffer of another
     * account.
     */
    private pendingCaptureHandoffs = new Map<string, CaptureHandoffBatch[]>();

    // Cached water detection status — updated every 60s by environment polling.
    // Stamped onto every log entry so career totals can filter out land tracks.
    private lastWaterStatus: boolean | undefined = undefined;

    // --- BATTLE-HARDENED GPS STREAMING ---
    // onLocation continuously caches the latest position. Timers decide WHEN to log,
    // but never block on getCurrentPosition. This survives background, suspension,
    // and cold starts — the position is always available. The GpsSubscriptionManager
    // keeps this in sync via its `onFix` callback.
    private lastBgLocation: CachedPosition | null = null;

    // --- HIGH-FREQUENCY GPS BUFFER ---
    // Captures every GPS fix at device rate (1–10 Hz). On each interval tick,
    // the buffer is drained and RDP-thinned to keep only significant points.
    private trackBuffer = new GpsTrackBuffer();

    // --- POSITION-BASED COURSE CHANGE DETECTION ---
    // Implementation lives in ./shiplog/CourseChangeDetector.ts. This
    // orchestrator just owns the instance and wires the callbacks.
    private courseDetector = new CourseChangeDetector();

    // --- 60s ENVIRONMENT POLLING ---
    // Implementation lives in ./shiplog/EnvironmentPoller.ts. Same pattern.
    private envPoller = new EnvironmentPoller();

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
            const result = await _flushBufferedTrack({
                ...this._captureCtx(scope),
                trackBuffer: replayBuffer,
            });
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
        if (releaseNativeLease) this.nativeLeaseScope = null;

        this.scheduler.stop();
        this.gpsSubs.stop();
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
        this.lastWaterStatus = undefined;
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
            // disarm only; it deliberately does not run stopTracking().
            void BgGeoManager.requestStop().catch((error) => {
                log.warn('native tracking stop on identity transition failed:', error);
            });
        }
        void BgGeoManager.setSamplingMode('default').catch(() => {});

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
                const nativeTrackingEnabled = await BgGeoManager.isNativeTrackingEnabled();
                if (!isAuthIdentityScopeCurrent(scope)) return;
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

    /**
     * Check if any quarter-hour entries were missed while backgrounded and catch up
     */
    private async checkMissedEntries(scope: AuthIdentityScope): Promise<void> {
        const state = this.trackingState;
        if (!this.ownerIsCurrent(scope, state)) return;
        if (!state.lastEntryTime) return;

        const lastEntry = new Date(state.lastEntryTime);
        const now = new Date();
        const msSinceLast = now.getTime() - lastEntry.getTime();

        // If more than 15 minutes since last entry, we missed at least one
        if (msSinceLast >= TRACKING_INTERVAL_MS) {
            const _missedCount = Math.floor(msSinceLast / TRACKING_INTERVAL_MS);

            // Capture ONE entry now (at current time, not backdated)
            // We don't backfill because GPS data from the past isn't available
            try {
                const entry = await this.captureLogEntry();
                if (!this.ownerIsCurrent(scope, state)) return;
                if (entry) {
                    log.info('checkMissedEntries: catch-up entry saved');
                }
            } catch (err: unknown) {
                log.error('checkMissedEntries: catch-up entry failed', err);
            }
        }

        // Reschedule to next quarter-hour
        void this.rescheduleAdaptiveInterval(scope, state);
    }

    /**
     * Reschedule the logging interval based on current speed (primary)
     * or shore proximity (fallback).
     * Called after each GPS fix and from environment polling.
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

        // PRIMARY: Speed-adaptive interval (if we have GPS speed)
        const pos = this.lastBgLocation;
        if (pos && pos.speed != null && pos.speed >= 0) {
            const { interval } = getIntervalForSpeed(pos.speed);
            const currentInterval = state.currentIntervalMs;

            // Only reschedule if interval actually changed
            if (interval !== currentInterval || !this.scheduler.isRunning()) {
                state.currentIntervalMs = interval;
                state.loggingZone = undefined; // Speed-based, not zone-based
                await this.saveTrackingState(scope);
                if (!this.ownerIsCurrent(scope, state)) return;
                this.scheduler.scheduleClockAligned(interval, () => this.flushBufferedTrack(scope, state));
            }
            return;
        }

        // FALLBACK: Zone-based interval (no speed data yet — cold start)
        const newZone = determineLoggingZone();
        const newInterval = getIntervalForZone(newZone);
        const oldZone = state.loggingZone || 'offshore';

        // Only reschedule if zone actually changed
        if (newZone === oldZone && this.scheduler.isRunning()) return;

        // Update state
        state.loggingZone = newZone;
        state.currentIntervalMs = newInterval;
        await this.saveTrackingState(scope);
        if (!this.ownerIsCurrent(scope, state)) return;

        // Use clock-aligned scheduling
        this.scheduler.scheduleClockAligned(newInterval, () => this.flushBufferedTrack(scope, state));
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
    ): Promise<void> {
        if (!isAuthIdentityScopeCurrent(scope)) return;
        if (this.trackingState.isTracking) {
            return;
        }
        const attempt = ++this.startAttempt;
        const startIsCurrent = () => attempt === this.startAttempt && isAuthIdentityScopeCurrent(scope);

        // Initialize GPS engine (native-only: Transistorsoft BgGeo).
        // On web, GPS is started via navigator.geolocation in gpsSubs.start().
        if (this.isNative) {
            const tg = performance.now();
            await BgGeoManager.ensureReady();
            if (!startIsCurrent()) return;
            const tReady = performance.now();
            await BgGeoManager.requestStart();
            if (!startIsCurrent()) {
                await BgGeoManager.requestStop().catch(() => {});
                return;
            }
            this.nativeLeaseScope = scope;
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
        let voyageId: string;
        if (continueVoyageId) {
            voyageId = continueVoyageId;
        } else if (resume && this.trackingState.currentVoyageId) {
            voyageId = this.trackingState.currentVoyageId;
        } else {
            voyageId = `voyage_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        }
        // GENUINELY new voyage = the mint branch above. Resume (JS-context
        // reload, continueVoyageId) and autoStart-resume must NOT re-arm
        // fast-lock 30+ min into a passage — that would re-spike sampling
        // mid-voyage (the disturbance the 60-min precision auto-shutoff
        // removal was meant to kill).
        const isNewVoyage = !continueVoyageId && !(resume && this.trackingState.currentVoyageId);

        this.trackingOwnerScope = scope;
        this.trackingState = {
            isTracking: true,
            isPaused: false,
            isRapidMode: false, // Rapid Mode (5 s flush cadence) — kept off
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
            currentVoyageId: voyageId,
            voyageStartTime: resume || continueVoyageId ? this.trackingState.voyageStartTime : new Date().toISOString(),
            lastMovementTime: new Date().toISOString(),
        };
        const sessionState = this.trackingState;

        await this.saveTrackingState(scope);
        if (!startIsCurrent() || !this.ownerIsCurrent(scope, sessionState)) return;

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
        if (!startIsCurrent() || !this.ownerIsCurrent(scope, sessionState)) return;

        // Live position sharing (public Voyage Log "live tail") — a
        // read-only shadow of the offline queue, gated on
        // settings.liveTrackShare. Never touches the capture path.
        startLiveTrickle(sessionState.currentVoyageId ?? null, scope);

        this.notifyTrackingChanged();

        // COLD-START FAST-LOCK (new voyages only). distanceFilter:0 emits
        // a fix on every chip update even while stationary at the dock,
        // so the first-fix consistency gate gets its corroborating 2nd
        // fix in seconds instead of waiting for 1 m of movement — the
        // "Acquiring GPS fix…" banner clears sooner. Reverts to the
        // steady 1 m filter after FAST_LOCK_MS. On resume / mid-voyage
        // reload we stay at the steady mode (no re-spike).
        if (this.isNative && isNewVoyage) {
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
            isPrecisionMode: () => this.ownerIsCurrent(scope, sessionState) && sessionState.isPrecisionMode === true,
            getIntervalMs: () =>
                this.ownerIsCurrent(scope, sessionState)
                    ? (sessionState.currentIntervalMs ?? TRACKING_INTERVAL_MS)
                    : TRACKING_INTERVAL_MS,
            getLastEntryTime: () => (this.ownerIsCurrent(scope, sessionState) ? sessionState.lastEntryTime : undefined),
            onFix: (pos) => {
                if (!this.ownerIsCurrent(scope, sessionState)) return;
                this.lastBgLocation = pos;
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
        });

        // IMMEDIATE ENTRY: Fire-and-forget — GPS acquisition runs in background
        // so the UI is not blocked by the 3s GPS warm-up loop.
        this.captureImmediateEntry(undefined, 'Voyage Start', scope).catch((e) => {
            log.warn(``, e);
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

        // ADAPTIVE SCHEDULING: Always start at nearshore (30s) — the safest default.
        // rescheduleAdaptiveInterval() runs after every GPS fix and will refine the
        // zone once weather-cache data is available (e.g. coastal → 2min, offshore → 15min).
        const initialZone: LoggingZone = 'nearshore';
        const initialInterval = getIntervalForZone(initialZone);
        sessionState.loggingZone = initialZone;
        sessionState.currentIntervalMs = initialInterval;
        await this.saveTrackingState(scope);
        if (!this.ownerIsCurrent(scope, sessionState)) return;

        // Schedule clock-aligned entries (30s → fires at xx:xx:00, xx:xx:30)
        this.scheduler.scheduleClockAligned(initialInterval, () => this.flushBufferedTrack(scope, sessionState));

        // Kick off async zone refinement in the background — won't block UI
        this.rescheduleAdaptiveInterval(scope, sessionState).catch((e) => {
            log.warn(``, e);
        });

        // --- 60-SECOND ENVIRONMENT POLLING ---
        // Checks water/land status and re-evaluates logging zone every minute.
        // This lets GPS interval adapt faster when transitioning environments
        // (e.g. leaving marina → offshore, or driving from land to coast).
        this.envPoller.start({
            getPos: () => this.lastBgLocation,
            isActive: () =>
                this.ownerIsCurrent(scope, sessionState) && sessionState.isTracking && !sessionState.isPaused,
            onWaterStatus: (isWater) => {
                if (!this.ownerIsCurrent(scope, sessionState)) return;
                // Cache for stamping onto subsequent log entries.
                this.lastWaterStatus = isWater;
                // Update EnvironmentService for UI consumers.
                EnvironmentService.updateWaterStatus(isWater);
            },
            onZoneRecheck: () => this.rescheduleAdaptiveInterval(scope, sessionState),
        });
    }

    // Fix-acceptance gate, GPS subscription wiring, NMEA ingest, heartbeat,
    // speed-tier debounce, cold-start warm-up, and cleanup all moved to
    // ./shiplog/GpsSubscriptionManager.ts. The orchestrator just owns
    // `lastBgLocation` (updated via the manager's `onFix` callback).
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
     * auto-revert to the steady 1 m filter after FAST_LOCK_MS.
     *
     * The revert callback is idempotent: it only acts if we're still
     * tracking THIS voyage, so a stale fire (stop within 30 s, an
     * iOS-throttled background timer, or a stop+new-start race) is a
     * clean no-op. The timer is also cleared in stop/pause.
     */
    private armFastLock(voyageId: string, scope: AuthIdentityScope, state: TrackingState): void {
        this.clearFastLock();
        this.fastLockArmedForVoyageId = voyageId;
        BgGeoManager.setSamplingMode('fastlock').catch((e) => {
            log.warn('failed to enter fast-lock sampling on track start:', e);
        });
        this.fastLockTimeoutId = setTimeout(() => {
            this.fastLockTimeoutId = undefined;
            if (
                this.ownerIsCurrent(scope, state) &&
                state.isTracking &&
                state.currentVoyageId === this.fastLockArmedForVoyageId
            ) {
                BgGeoManager.setSamplingMode('default').catch((e) => {
                    log.warn('fast-lock revert failed:', e);
                });
            }
        }, FAST_LOCK_MS);
    }

    /** Cancel a pending fast-lock revert timer (no engine change). */
    private clearFastLock(): void {
        if (this.fastLockTimeoutId) {
            clearTimeout(this.fastLockTimeoutId);
            this.fastLockTimeoutId = undefined;
        }
    }

    async pauseTracking(): Promise<void> {
        const scope = this.trackingOwnerScope;
        if (!scope || !this.ownerIsCurrent(scope)) return;
        this.startAttempt += 1;
        this.scheduler.stop();
        this.clearFastLock();

        // Stop course change detection + environment polling while paused
        this.courseDetector.stop();
        this.envPoller.stop();

        // Clear GPS buffer — no points to log while paused
        this.trackBuffer.clear();

        // Clean up GPS subscriptions to save battery while paused
        this.gpsSubs.stop();

        this.trackingState.isTracking = false;
        this.trackingState.isPaused = true;
        await this.saveTrackingState(scope);
        if (!this.ownerIsCurrent(scope)) return;
        await stopLiveTrickle(false, scope);
        if (!this.ownerIsCurrent(scope)) return;
        if (this.isNative && this.sameScope(this.nativeLeaseScope, scope)) {
            this.nativeLeaseScope = null;
            await BgGeoManager.requestStop();
            if (!this.ownerIsCurrent(scope)) return;
        }
        this.notifyTrackingChanged();
    }

    /**
     * Stop tracking and end voyage
     * Responds instantly - final entry capture happens in background
     */
    async stopTracking(): Promise<void> {
        const scope = this.trackingOwnerScope;
        const activeState = this.trackingState;
        if (!scope || !this.ownerIsCurrent(scope, activeState)) return;
        const stopAttempt = ++this.startAttempt;
        const stopIsCurrent = (state: TrackingState) =>
            stopAttempt === this.startAttempt && this.ownerIsCurrent(scope, state);
        const previousVoyageId = activeState.currentVoyageId;
        this.scheduler.stop();

        // Flush before exposing a stopped state. If an older scheduler flush
        // was invalidated by the stop token, its suffix goes to the durable
        // owner-scoped handoff and is replayed here.
        try {
            await this.flushBufferedTrack(scope, activeState);
        } catch (e) {
            log.warn('[ShipLog] final buffer flush deferred to durable handoff:', e);
        }
        if (!stopIsCurrent(activeState)) return;
        if (previousVoyageId) {
            await this.replayCaptureHandoffs(scope, activeState, previousVoyageId).catch((error) => {
                log.warn('final capture handoff remains durable for later replay:', error);
            });
            if (!stopIsCurrent(activeState)) return;
        }

        // No callback may append after the final drain.
        this.gpsSubs.stop();
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
            if (!stopIsCurrent(activeState)) return;
            if (finalFlush !== 'complete' && this.trackBuffer.length > 0 && previousVoyageId) {
                const retained = drainBufferedTrackForHandoff(this.trackBuffer);
                await this.queueCaptureHandoff(scope, previousVoyageId, retained);
                if (!stopIsCurrent(activeState)) return;
            }
        }

        await BgGeoManager.setSamplingMode('default');
        if (!stopIsCurrent(activeState)) return;
        GpsPrecision.reset();

        await this.captureImmediateEntry(previousVoyageId, 'Voyage End', scope).catch((err) => {
            log.warn(``, err);
        });
        if (!stopIsCurrent(activeState)) return;

        // Clear the old voyage anchor while a new same-account start is still
        // blocked by activeState.isTracking. It can never erase a new
        // voyage's first position.
        await _clearVoyageState(scope);
        if (!stopIsCurrent(activeState)) return;

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
                if (!stopIsCurrent(activeState)) return;
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
                    if (!stopIsCurrent(activeState)) return;
                    // A discarded voyage never uploads to ship_logs, so any
                    // dock points it trickled to live_track would linger as a
                    // stale public "live" tail that nothing supersedes — pull
                    // them too. (Fire-and-forget; prune is the backstop.)
                    void purgeLiveTrack(scope).catch(() => {
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
            this.nativeLeaseScope = null;
            await BgGeoManager.requestStop();
            if (!stopIsCurrent(activeState)) return;
        }

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
        if (!stopIsCurrent(stoppedState)) return;
        this.notifyTrackingChanged();

        void stopLiveTrickle(true, scope).catch((e) => log.warn('[ShipLog] live-trickle final flush failed:', e));

        // Voyage complete → exit local-only capture and upload the whole
        // recorded voyage to Supabase in the background. Fire-and-forget:
        // the UI never waits on this, and if it fails (offshore, no link)
        // the 2-minute sync interval + app-launch sync retry until it lands.
        setCaptureLocalOnly(false);
        void this.syncOfflineQueueForScope(scope)
            .then((n) => {
                if (n > 0) {
                    log.warn(`[ShipLog] voyage upload complete: ${n} entries synced in background`);
                    if (isAuthIdentityScopeCurrent(scope)) this.notifyTrackingChanged();
                }
            })
            .catch((e) => log.warn('[ShipLog] background voyage upload failed (will retry on interval):', e));
        if (stopIsCurrent(stoppedState)) this.trackingOwnerScope = null;
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
        return _captureImmediate(this._captureCtx(scope), voyageId, waypointLabel);
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
        const opts: CaptureLogOptions = {
            entryType,
            notes,
            waypointName,
            eventCategory,
            engineStatus,
            voyageId,
            skipDedup,
        };
        return _captureLog(this._captureCtx(scope), opts);
    }

    /**
     * Flush the high-frequency GPS buffer.
     *
     * Called on every interval tick instead of captureLogEntry().
     * Drains all buffered GPS fixes, runs RDP thinning to extract only
     * significant positions (turns ≥22.5°, speed changes, signal recovery),
     * then creates a log entry for each kept point.
     *
     * Falls back to standard captureLogEntry() when the buffer is empty
     * (e.g., heartbeat catch-up when backgrounded).
     */
    private flushBufferedTrack(
        scope: AuthIdentityScope,
        state: TrackingState = this.trackingState,
    ): Promise<FlushBufferedTrackResult> {
        if (!this.ownerIsCurrent(scope, state)) return Promise.resolve('stale');
        return _flushBufferedTrack(this._captureCtx(scope));
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
        const opts: AddManualOptions = { notes, waypointName, eventCategory, engineStatus, voyageId };
        return _addManual(this._captureCtx(scope), opts);
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
            getCachedFix: () => this.lastBgLocation,
            setCachedFix: (pos) => {
                if (!isAuthIdentityScopeCurrent(scope) || state !== this.trackingState) return;
                this.lastBgLocation = pos;
            },
            trackBuffer: this.trackBuffer,
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
     * Toggle rapid GPS mode (5-second intervals for marina/shore navigation)
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
            // RAPID MODE: 5-second intervals for high-precision marina navigation

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

            // Capture first entry immediately when entering rapid mode
            this.captureLogEntry().catch((err) => {
                log.warn(``, err);
            });

            // 5-second non-aligned cadence — marina navigation cares about
            // density, not clock marks.
            this.scheduler.scheduleEvery(RAPID_INTERVAL_MS, () =>
                this.ownerIsCurrent(scope, state) ? this.captureLogEntry() : null,
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

    async deleteVoyage(voyageId: string): Promise<boolean> {
        return _deleteVoyage(voyageId);
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
        return _archiveVoyage(voyageId);
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
