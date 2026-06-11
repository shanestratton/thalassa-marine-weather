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
import { createLogger } from '../../utils/logger';
import type { LoggingZone } from './helpers';

const log = createLogger('ShipLog.Store');

const TRACKING_STATE_KEY = 'ship_log_tracking_state';
const LAST_POSITION_KEY = 'ship_log_last_position';
const VOYAGE_START_KEY = 'ship_log_voyage_start';

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
export async function loadTrackingState(): Promise<TrackingState | null> {
    try {
        const { value } = await Preferences.get({ key: TRACKING_STATE_KEY });
        if (!value) return null;
        return JSON.parse(value) as TrackingState;
    } catch (e) {
        log.warn('loadTrackingState parse failed', e);
        return null;
    }
}

export async function saveTrackingState(state: TrackingState): Promise<void> {
    await Preferences.set({
        key: TRACKING_STATE_KEY,
        value: JSON.stringify(state),
    });
}

export async function getLastPosition(): Promise<StoredPosition | null> {
    try {
        const { value } = await Preferences.get({ key: LAST_POSITION_KEY });
        return value ? (JSON.parse(value) as StoredPosition) : null;
    } catch (e) {
        log.warn('getLastPosition parse failed', e);
        return null;
    }
}

export async function saveLastPosition(position: StoredPosition): Promise<void> {
    await Preferences.set({
        key: LAST_POSITION_KEY,
        value: JSON.stringify(position),
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
export async function clearVoyageState(): Promise<void> {
    await Preferences.remove({ key: LAST_POSITION_KEY });
    await Preferences.remove({ key: VOYAGE_START_KEY });
}
