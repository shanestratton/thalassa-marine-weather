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

import { supabase } from '../supabase';
import { ShipLogEntry } from '../../types';
import { toDbFormat, fromDbFormat, formatPositionDMS, SHIP_LOGS_TABLE } from './helpers';
import { queueOfflineEntry } from './OfflineQueue';
import { BgGeoManager, CachedPosition } from '../BgGeoManager';
import { GpsService } from '../GpsService';
import { Capacitor } from '@capacitor/core';
import { createLogger } from '../../utils/logger';

const log = createLogger('EntrySave');

/**
 * Check if satellite mode is enabled (sync read from settings).
 * When true, all Supabase sync is suppressed — entries queue on-device.
 * Conserves bandwidth for Iridium GO! / metered satellite connections.
 */
export function isSatelliteMode(): boolean {
    try {
        const raw = localStorage.getItem('CapacitorStorage.thalassa_settings');
        if (!raw) return false;
        const settings = JSON.parse(raw);
        return !!settings?.satelliteMode;
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
): Promise<{ saved: ShipLogEntry | null; entryId: string | null; wasOffline: boolean }> {
    const isOnline = isOnlineAndNotSatellite();

    if (supabase && isOnline) {
        try {
            const saveResult = await Promise.race([
                (async () => {
                    const {
                        data: { user },
                    } = await supabase.auth.getUser();
                    if (user) {
                        const { data, error } = await supabase
                            .from(SHIP_LOGS_TABLE)
                            .insert(toDbFormat({ ...entry, userId: user.id }))
                            .select()
                            .single();

                        if (error) return 'offline' as const;
                        return { data: fromDbFormat(data), id: data.id as string };
                    }
                    return 'offline' as const;
                })(),
                new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5000)),
            ]);

            if (saveResult === 'offline' || saveResult === 'timeout') {
                await queueOfflineEntry(entry);
                return { saved: null, entryId: null, wasOffline: true };
            }

            return { saved: saveResult.data, entryId: saveResult.id, wasOffline: false };
        } catch (_networkError) {
            await queueOfflineEntry(entry);
            return { saved: null, entryId: null, wasOffline: true };
        }
    } else {
        await queueOfflineEntry(entry);
        return { saved: null, entryId: null, wasOffline: true };
    }
}

/**
 * Background GPS retry — attempts to get GPS position and update a saved entry.
 * Retries every 5 seconds for up to 30 seconds total.
 */
export async function retryGpsAndUpdateEntry(entryId: string): Promise<void> {
    const isNative = Capacitor.isNativePlatform();
    const maxRetries = 6;
    const retryDelayMs = 5000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));

        try {
            const pos = isNative ? await BgGeoManager.getFreshPosition(5000, 10) : await webGetFreshPosition();
            if (!pos) continue;

            const { latitude, longitude, heading } = pos;
            const positionFormatted = formatPositionDMS(latitude, longitude);

            if (supabase) {
                const updateData = toDbFormat({
                    latitude,
                    longitude,
                    positionFormatted,
                });
                if (heading !== null && heading !== undefined && heading !== 0) {
                    updateData.course_deg = Math.round(heading);
                }

                const { error } = await supabase.from(SHIP_LOGS_TABLE).update(updateData).eq('id', entryId);

                if (!error) {
                    log.info(`retryGpsAndUpdateEntry: updated entry ${entryId} on attempt ${attempt}`);
                }
            }
            return; // Success - stop retrying
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
export async function demotePreviousAutoWaypoint(voyageId: string): Promise<void> {
    if (!supabase || !voyageId) return;
    try {
        const {
            data: { user },
        } = await supabase.auth.getUser();
        if (!user) return;

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

        if (rows && rows.length > 0) {
            await supabase
                .from(SHIP_LOGS_TABLE)
                .update({ entry_type: 'auto', waypoint_name: null })
                .eq('id', rows[0].id);
        }
    } catch (e) {
        log.warn('[EntrySave] demotePreviousAutoWaypoint failed:', e);
        // Best effort — demotion is non-critical
    }
}
