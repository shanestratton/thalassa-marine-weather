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
