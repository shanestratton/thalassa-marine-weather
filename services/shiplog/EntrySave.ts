/**
 * Entry Save Pipeline — extracted from ShipLogService.
 *
 * Contains the shared "save-to-Supabase-or-queue-offline" pattern,
 * retry-GPS logic, and auto waypoint demotion.
 *
 * The save-or-queue pattern was duplicated 3× in the original service
 * (captureLogEntry, captureImmediateEntry, addManualEntry).
 * This module consolidates it into a single function.
 */

import { supabase, getCurrentUser } from '../supabase';
import { ShipLogEntry } from '../../types';
import { toDbFormat, fromDbFormat, formatPositionDMS, SHIP_LOGS_TABLE } from './helpers';
import { queueOfflineEntry, demoteLatestPositionInQueue, runVoyageCloudMutation } from './OfflineQueue';
import { BgGeoManager, CachedPosition } from '../BgGeoManager';
import { GpsService } from '../GpsService';
import { Capacitor } from '@capacitor/core';
import { createLogger } from '../../utils/createLogger';
import { useSettingsStore } from '../../stores/settingsStore';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, type AuthIdentityScope } from '../authIdentityScope';

const log = createLogger('EntrySave');

function operationIsCurrent(scope: AuthIdentityScope, sessionGuard: () => boolean): boolean {
    return isAuthIdentityScopeCurrent(scope) && sessionGuard();
}

function newClientOperationId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return `shipop_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

async function boundedRequest<T>(
    operation: (signal: AbortSignal) => PromiseLike<T>,
    timeoutMs: number,
): Promise<T | null> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
        return await Promise.race([
            Promise.resolve(operation(controller.signal)).catch((error) => {
                if (controller.signal.aborted) return null;
                throw error;
            }),
            new Promise<null>((resolve) => {
                timer = setTimeout(() => {
                    controller.abort();
                    resolve(null);
                }, timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * Check if satellite mode is enabled (sync read from settings).
 * When true, all Supabase sync is suppressed — entries queue on-device.
 * Conserves bandwidth for Iridium GO! / metered satellite connections.
 */
export function isSatelliteMode(): boolean {
    try {
        return !!useSettingsStore.getState().settings.satelliteMode;
    } catch {
        return false;
    }
}

/**
 * Determine if the device is currently online and NOT in satellite mode.
 */
export function isOnlineAndNotSatellite(): boolean {
    return typeof navigator !== 'undefined' && navigator.onLine && !isSatelliteMode();
}

// ── LOCAL-ONLY CAPTURE MODE ─────────────────────────────────────────
// While a voyage is actively recording, every captured point is written
// to the DEVICE only (offline queue) — zero network on the capture path.
// The whole voyage uploads to Supabase in the background once tracking
// stops. This is "satellite mode, automatically, for the duration of a
// log": capture latency stays flat regardless of connectivity, the radio
// isn't hammered every few seconds for hours, and a dropout mid-passage
// can't stall or reorder the pipeline.
//
// ShipLogService.startTracking() turns it on; stopTracking() turns it
// off and fires syncOfflineQueue() in the background.
//
// The state itself lives in OfflineQueue (so syncOfflineQueue can refuse
// to touch the queue mid-voyage without a circular import); re-exported
// here for the existing callers.
export { setCaptureLocalOnly, isCaptureLocalOnly } from './OfflineQueue';
import { isCaptureLocalOnly as captureIsLocalOnly } from './OfflineQueue';
import { noteLiveTrickleHeartbeat } from './LiveTrickle';

/**
 * Save-or-Queue Pipeline.
 *
 * Attempts to save an entry to Supabase with a 5-second timeout.
 * Falls back to offline queue on any failure (network, auth, timeout).
 *
 * @returns The saved entry (with DB-generated id) if online, or the input entry if queued.
 */
export async function saveEntryOnlineOrOffline(
    entry: Partial<ShipLogEntry>,
    scope: AuthIdentityScope = getAuthIdentityScope(),
    sessionGuard: () => boolean = () => true,
): Promise<{ saved: ShipLogEntry | null; entryId: string | null; wasOffline: boolean }> {
    const rejected = { saved: null, entryId: null, wasOffline: true } as const;
    if (!operationIsCurrent(scope, sessionGuard)) return rejected;
    // Created before the first network attempt and preserved if that attempt
    // times out but commits late. The database unique key makes every replay
    // of this logical capture converge on one row.
    const operationId = newClientOperationId();

    const queueForReplay = async () => {
        if (!operationIsCurrent(scope, sessionGuard)) return rejected;
        const rollingVoyageId =
            entry.entryType === 'waypoint' && entry.waypointName === 'Latest Position'
                ? entry.voyageId || 'default_voyage'
                : undefined;
        await queueOfflineEntry(entry, {
            operationId,
            expectedScope: scope,
            demotePreviousLatestForVoyage: rollingVoyageId,
        });
        if (!operationIsCurrent(scope, sessionGuard)) return rejected;
        return { saved: null, entryId: null, wasOffline: true } as const;
    };

    // Active voyage → device only. No Supabase attempt, no 5 s timeout
    // race, no auth resolution — just an instant local append. The voyage
    // syncs as one batch when tracking stops.
    if (captureIsLocalOnly()) {
        const queued = await queueForReplay();
        if (!operationIsCurrent(scope, sessionGuard)) return rejected;
        // Live-trickle heartbeat rides the capture callback: in the
        // background JS timers are suspended but native GPS callbacks keep
        // arriving, so this is what keeps the public "live tail" moving on
        // passage. Throttled + read-only inside; no-op unless sharing is on.
        noteLiveTrickleHeartbeat(scope);
        return queued;
    }

    const isOnline = isOnlineAndNotSatellite();

    if (supabase && isOnline) {
        const database = supabase;
        let saveResult: { data: ShipLogEntry; id: string } | 'offline' | null;
        try {
            saveResult = await runVoyageCloudMutation(
                entry.voyageId || 'default_voyage',
                scope,
                5000,
                async (signal) => {
                    const user = await getCurrentUser(scope);
                    if (signal.aborted) return 'offline' as const;
                    if (user && user.id === scope.userId && operationIsCurrent(scope, sessionGuard)) {
                        const row = toDbFormat({ ...entry, userId: user.id });
                        delete row.id;
                        row.client_operation_id = operationId;
                        const { data, error } = await database
                            .from(SHIP_LOGS_TABLE)
                            .upsert(row, {
                                onConflict: 'user_id,client_operation_id',
                            })
                            .abortSignal(signal)
                            .select()
                            .single();

                        if (error || signal.aborted || !operationIsCurrent(scope, sessionGuard)) {
                            return 'offline' as const;
                        }
                        return { data: fromDbFormat(data), id: data.id as string } as const;
                    }
                    return 'offline' as const;
                },
                entry.timestamp,
            );
        } catch (_networkError) {
            saveResult = 'offline';
        }

        if (saveResult === 'offline' || saveResult === null) return queueForReplay();
        if (!operationIsCurrent(scope, sessionGuard)) return rejected;
        return { saved: saveResult.data, entryId: saveResult.id, wasOffline: false };
    } else {
        return queueForReplay();
    }
}

/**
 * Background GPS retry — attempts to get GPS position and update a saved entry.
 * Retries every 5 seconds for up to 30 seconds total.
 */
export async function retryGpsAndUpdateEntry(
    entryId: string,
    scope: AuthIdentityScope = getAuthIdentityScope(),
    sessionGuard: () => boolean = () => true,
): Promise<void> {
    if (!scope.userId || !operationIsCurrent(scope, sessionGuard)) return;
    const isNative = Capacitor.isNativePlatform();
    const maxRetries = 6;
    const retryDelayMs = 5000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        if (!operationIsCurrent(scope, sessionGuard)) return;

        try {
            const pos = isNative ? await BgGeoManager.getFreshPosition(5000, 10) : await webGetFreshPosition();
            if (!operationIsCurrent(scope, sessionGuard)) return;
            if (!pos) continue;

            const { latitude, longitude, heading } = pos;
            const positionFormatted = formatPositionDMS(latitude, longitude);

            if (supabase) {
                const database = supabase;
                const updateData = toDbFormat({
                    latitude,
                    longitude,
                    positionFormatted,
                });
                if (typeof heading === 'number' && Number.isFinite(heading)) {
                    updateData.course_deg = Math.round(heading);
                }

                const response = await boundedRequest(
                    (signal) =>
                        database
                            .from(SHIP_LOGS_TABLE)
                            .update(updateData)
                            .eq('user_id', scope.userId)
                            .eq('id', entryId)
                            .abortSignal(signal),
                    5000,
                );
                const error = response?.error ?? (response ? null : new Error('update timed out'));

                if (!error && operationIsCurrent(scope, sessionGuard)) {
                    log.info(`retryGpsAndUpdateEntry: updated entry ${entryId} on attempt ${attempt}`);
                    return; // Persisted successfully — stop retrying.
                }
                if (!operationIsCurrent(scope, sessionGuard)) return;
                log.warn(`retryGpsAndUpdateEntry: update failed on attempt ${attempt}`, error);
                continue;
            }
            return;
        } catch (gpsError: unknown) {
            log.warn('retryGpsAndUpdateEntry: GPS retry failed', gpsError);
        }
    }
}

/**
 * Web fallback for BgGeoManager.getFreshPosition() — uses GpsService
 * which calls navigator.geolocation.getCurrentPosition with permission prompt.
 */
export async function webGetFreshPosition(): Promise<CachedPosition | null> {
    const pos = await GpsService.getCurrentPosition({ staleLimitMs: 10_000, timeoutSec: 10 });
    if (!pos) return null;
    return {
        latitude: pos.latitude,
        longitude: pos.longitude,
        accuracy: pos.accuracy,
        altitude: pos.altitude,
        heading: pos.heading ?? 0,
        speed: pos.speed,
        timestamp: pos.timestamp,
        receivedAt: Date.now(),
    } as CachedPosition;
}

/**
 * Demote the previous auto-promoted waypoint ('Latest Position') back to 'auto'.
 * Only demotes entries with waypointName === 'Latest Position' — turn waypoints,
 * manual entries, and user-placed waypoints are never demoted.
 */
export async function demotePreviousAutoWaypoint(
    voyageId: string,
    scope: AuthIdentityScope = getAuthIdentityScope(),
    sessionGuard: () => boolean = () => true,
): Promise<void> {
    if (!voyageId || !operationIsCurrent(scope, sessionGuard)) return;

    // Local-only capture: the previous 'Latest Position' entry is sitting
    // in the offline queue, not the DB — demote it there (instant, no
    // network). syncOfflineQueue also normalises duplicates per voyage at
    // upload time as a belt-and-braces.
    if (captureIsLocalOnly()) {
        await demoteLatestPositionInQueue(voyageId);
        return;
    }

    if (!supabase) return;
    try {
        const user = await getCurrentUser();
        if (!user || user.id !== scope.userId || !operationIsCurrent(scope, sessionGuard)) return;

        // Find the most recent 'Latest Position' waypoint in this voyage
        const { data: rows } = await supabase
            .from(SHIP_LOGS_TABLE)
            .select('id')
            .eq('user_id', user.id)
            .eq('voyage_id', voyageId)
            .eq('entry_type', 'waypoint')
            .eq('waypoint_name', 'Latest Position')
            .order('timestamp', { ascending: false })
            .limit(1);

        if (operationIsCurrent(scope, sessionGuard) && rows && rows.length > 0) {
            await supabase
                .from(SHIP_LOGS_TABLE)
                .update({ entry_type: 'auto', waypoint_name: null })
                .eq('user_id', scope.userId)
                .eq('voyage_id', voyageId)
                .eq('id', rows[0].id);
        }
    } catch (e) {
        log.warn('[EntrySave] demotePreviousAutoWaypoint failed:', e);
        // Best effort — demotion is non-critical
    }
}
