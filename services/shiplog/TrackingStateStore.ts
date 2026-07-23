/**
 * TrackingStateStore — Capacitor Preferences persistence for the ship-log
 * tracking lifecycle.
 *
 * Three keys live here:
 *   - `ship_log_tracking_state`: the live `TrackingState` (whether
 *     tracking is on, voyage id, last entry time, current logging zone…)
 *   - `ship_log_last_position`: the last position we saved with cumulative
 *     distance, used for distance/speed deltas and voyage stats.
 *   - `ship_log_voyage_start`: legacy key from earlier versions; we still
 *     clear it in `clearVoyageState()` for upgrade hygiene.
 *
 * Pure I/O — no GPS, no timers. The orchestrator owns the in-memory copy
 * of `TrackingState` and pushes/pulls through these helpers.
 */
import { Preferences } from '@capacitor/preferences';
import { createLogger } from '../../utils/createLogger';
import type { LoggingZone } from './helpers';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    type AuthIdentityScope,
} from '../authIdentityScope';

const log = createLogger('ShipLog.Store');

const TRACKING_STATE_KEY = 'ship_log_tracking_state';
const LAST_POSITION_KEY = 'ship_log_last_position';
const VOYAGE_START_KEY = 'ship_log_voyage_start';
const STORE_VERSION = 1;

interface OwnedValue<T> {
    version: typeof STORE_VERSION;
    ownerKey: string;
    ownerUserId: string | null;
    value: T;
}

/**
 * Preferences has no compare-and-swap primitive. Serialising operations per
 * account prevents an old A write that was already inside the native bridge
 * from landing after a newer A write when the user switches A→B→A quickly.
 */
const operationTails = new Map<string, Promise<void>>();

function scopedKey(base: string, scope: AuthIdentityScope): string {
    return authScopedStorageKey(base, scope);
}

function ownedValue<T>(value: T, scope: AuthIdentityScope): OwnedValue<T> {
    return {
        version: STORE_VERSION,
        ownerKey: scope.key,
        ownerUserId: scope.userId,
        value,
    };
}

function parseOwnedValue<T>(raw: string, scope: AuthIdentityScope): T | null {
    const parsed = JSON.parse(raw) as Partial<OwnedValue<T>>;
    if (
        parsed.version !== STORE_VERSION ||
        parsed.ownerKey !== scope.key ||
        parsed.ownerUserId !== scope.userId ||
        !Object.prototype.hasOwnProperty.call(parsed, 'value')
    ) {
        return null;
    }
    return parsed.value as T;
}

function withScopeLock<T>(
    scope: AuthIdentityScope,
    staleValue: T,
    operation: () => Promise<T>,
    allowTransitionWrite = false,
): Promise<T> {
    const prior = operationTails.get(scope.key) ?? Promise.resolve();
    const result = prior.then(
        () => {
            if (!allowTransitionWrite && !isAuthIdentityScopeCurrent(scope)) return staleValue;
            return operation();
        },
        () => {
            if (!allowTransitionWrite && !isAuthIdentityScopeCurrent(scope)) return staleValue;
            return operation();
        },
    );
    operationTails.set(
        scope.key,
        result.then(
            () => undefined,
            () => undefined,
        ),
    );
    return result;
}

export interface TrackingState {
    isTracking: boolean;
    isPaused: boolean;
    isRapidMode: boolean;
    /**
     * Precision Mode (added 2026-05-17) — hi-fi GPS capture at ~2 Hz
     * with live decimation in GpsTrackBuffer.pushWithLiveFilter to
     * keep storage sane. Auto-shuts-off after 60 min to bound the
     * battery cost. Distinct from Rapid Mode (which only changes the
     * adaptive flush interval) — Precision changes the SAMPLE rate.
     */
    isPrecisionMode?: boolean;
    currentVoyageId?: string;
    voyageStartTime?: string;
    voyageEndTime?: string;
    lastMovementTime?: string;
    lastEntryTime?: string;
    loggingZone?: LoggingZone;
    currentIntervalMs?: number;
    /** Timestamp of the last position-check (whether saved or deduped) */
    lastCheckTime?: number;
    /** True if the last position-check was deduped (vessel hasn't moved) */
    lastCheckDeduped?: boolean;
    /**
     * User-set engine state, stamped onto subsequent auto track points so
     * the sail/motor split is real. undefined = not yet declared this
     * voyage (split shows that span as "unknown"). The GPS pipeline never
     * sets this — only the live "engine on/off" control does.
     */
    engineRunning?: boolean;
}

export interface StoredPosition {
    latitude: number;
    longitude: number;
    timestamp: string;
    cumulativeDistanceNM: number;
    /** Last recorded speed — used for acceleration-based spike filtering */
    speedKts?: number;
    /**
     * Voyage this position belongs to. captureLog ignores a stored
     * position from a DIFFERENT voyage (no distance/speed deltas across
     * voyage boundaries), and captureImmediate uses the match to decide
     * whether to carry the cumulative-distance accumulator forward
     * (resume / Voyage End) or start it at zero (new voyage).
     */
    voyageId?: string;
}

/**
 * What `ShipLogService.initialize()` should do with a persisted tracking
 * state on app start / JS-context reload.
 *
 * The hard case (root cause of the "track cut out / missing start / log
 * says not-running after backgrounding" bug): the persisted state says we
 * were tracking, but no scheduler is running in this fresh JS context.
 * That happens BOTH when the app was genuinely force-closed long ago AND
 * when iOS merely suspended/reloaded the WebView while the native GPS
 * engine kept recording. We tell them apart by asking the native engine
 * whether it's still enabled:
 *
 *   - native still enabled + we have a voyage id → `resume` the SAME
 *     voyage in place (re-arm the JS side, do NOT mint a new id, do NOT
 *     stamp an end time). Stranding the track under an ended voyage id is
 *     exactly what dropped the start of the recorded track.
 *   - otherwise (cold start / force-close, or no voyage id) →
 *     `mark-stopped`, and let `autoStartIfEnabled()` decide whether to
 *     resume.
 *   - scheduler already running (in-session page nav) or simply
 *     not-tracking/paused → `none` (nothing to reconcile).
 *
 * Pure — no I/O, no native calls — so the lifecycle branch is unit-tested.
 */
export type InitTrackingAction =
    | { action: 'none' }
    | { action: 'resume'; voyageId: string }
    | { action: 'mark-stopped' };

export function decideInitTrackingAction(opts: {
    persistedIsTracking: boolean;
    persistedIsPaused: boolean;
    schedulerRunning: boolean;
    nativeTrackingEnabled: boolean;
    currentVoyageId?: string | null;
}): InitTrackingAction {
    const { persistedIsTracking, persistedIsPaused, schedulerRunning, nativeTrackingEnabled, currentVoyageId } = opts;
    if (!persistedIsTracking || persistedIsPaused || schedulerRunning) {
        return { action: 'none' };
    }
    if (nativeTrackingEnabled && currentVoyageId) {
        return { action: 'resume', voyageId: currentVoyageId };
    }
    return { action: 'mark-stopped' };
}

/** Hydrate the persisted tracking state. Returns null if absent or unreadable. */
export function loadTrackingState(scope: AuthIdentityScope = getAuthIdentityScope()): Promise<TrackingState | null> {
    return withScopeLock(scope, null, async () => {
        try {
            const { value } = await Preferences.get({ key: scopedKey(TRACKING_STATE_KEY, scope) });
            if (!isAuthIdentityScopeCurrent(scope) || !value) return null;
            return parseOwnedValue<TrackingState>(value, scope);
        } catch (e) {
            log.warn('loadTrackingState parse failed', e);
            return null;
        }
    });
}

export function saveTrackingState(
    state: TrackingState,
    scope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<void> {
    const snapshot = { ...state };
    return withScopeLock(scope, undefined, async () => {
        if (!isAuthIdentityScopeCurrent(scope)) return;
        await Preferences.set({
            key: scopedKey(TRACKING_STATE_KEY, scope),
            value: JSON.stringify(ownedValue(snapshot, scope)),
        });
    });
}

/**
 * Account transitions are a deliberate safety event, not a stale capture
 * callback. Persist A as paused under A's own key so its voyage can be
 * resumed when A returns, without stamping an end or uploading it as B.
 *
 * The transition write is queued behind any A write already in the native
 * bridge. A later A write (after A returns) queues behind this one and wins.
 */
export function suspendTrackingStateForIdentityChange(
    state: TrackingState,
    previousScope: AuthIdentityScope,
): Promise<void> {
    const suspended: TrackingState =
        state.isTracking || state.isPaused
            ? {
                  ...state,
                  isTracking: false,
                  isPaused: Boolean(state.currentVoyageId),
                  isRapidMode: false,
                  isPrecisionMode: false,
                  voyageEndTime: undefined,
              }
            : { ...state };
    return withScopeLock(
        previousScope,
        undefined,
        async () => {
            await Preferences.set({
                key: scopedKey(TRACKING_STATE_KEY, previousScope),
                value: JSON.stringify(ownedValue(suspended, previousScope)),
            });
        },
        true,
    );
}

export function getLastPosition(scope: AuthIdentityScope = getAuthIdentityScope()): Promise<StoredPosition | null> {
    return withScopeLock(scope, null, async () => {
        try {
            const { value } = await Preferences.get({ key: scopedKey(LAST_POSITION_KEY, scope) });
            if (!isAuthIdentityScopeCurrent(scope) || !value) return null;
            return parseOwnedValue<StoredPosition>(value, scope);
        } catch (e) {
            log.warn('getLastPosition parse failed', e);
            return null;
        }
    });
}

export function saveLastPosition(
    position: StoredPosition,
    scope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<void> {
    const snapshot = { ...position };
    return withScopeLock(scope, undefined, async () => {
        if (!isAuthIdentityScopeCurrent(scope)) return;
        await Preferences.set({
            key: scopedKey(LAST_POSITION_KEY, scope),
            value: JSON.stringify(ownedValue(snapshot, scope)),
        });
    });
}

/**
 * Clear voyage-scoped persistence. Called from `stopTracking()` so a fresh
 * voyage doesn't inherit stats from the previous one.
 *
 * `VOYAGE_START_KEY` is legacy — earlier versions wrote to it; nothing
 * does anymore but the remove keeps installs upgrading from those builds
 * clean.
 */
export function clearVoyageState(scope: AuthIdentityScope = getAuthIdentityScope()): Promise<void> {
    return withScopeLock(scope, undefined, async () => {
        if (!isAuthIdentityScopeCurrent(scope)) return;
        await Preferences.remove({ key: scopedKey(LAST_POSITION_KEY, scope) });
        if (!isAuthIdentityScopeCurrent(scope)) return;
        await Preferences.remove({ key: scopedKey(VOYAGE_START_KEY, scope) });
    });
}
