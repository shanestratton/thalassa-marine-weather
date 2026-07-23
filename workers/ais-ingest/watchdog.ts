/**
 * Guardian Watchdog — BOLO + Geofence Monitor
 *
 * Runs inside the Railway AIS ingest worker on a 30-second loop.
 * Monitors armed vessels for movement (BOLO) and geofence breaches.
 *
 * Flow:
 * 1. Query all armed vessels from guardian_profiles
 * 2. For each, compare latest AIS position against armed_location
 * 3. If distance > 50m → broadcast BOLO alert via push notification queue
 * 4. Also check geofence violations for vessels with home_coordinate
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

const BOLO_THRESHOLD_M = 50;
const WATCHDOG_INTERVAL_MS = 30_000;

// Track which vessels we've already alerted for (prevent duplicate BOLOs)
const boloAlerted = new Set<string>();
const geofenceAlerted = new Set<string>();
const geofenceResolvedInside = new Set<string>();

interface ArmedVessel {
    user_id: string;
    mmsi: number;
    vessel_name: string | null;
    armed_at: string;
}

interface GeofenceVessel {
    user_id: string;
    mmsi: number;
    vessel_name: string | null;
    home_radius_m: number;
}

interface WatchdogPosition {
    distanceM: number;
    lat: number;
    lon: number;
}

export function parseWatchdogPosition(value: unknown): WatchdogPosition | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

    const candidate = value as Record<string, unknown>;
    const distanceM = candidate.distance_m;
    const lat = candidate.lat;
    const lon = candidate.lon;
    const updatedAt = candidate.updated_at;

    if (
        typeof distanceM !== 'number' ||
        !Number.isFinite(distanceM) ||
        distanceM < 0 ||
        typeof lat !== 'number' ||
        !Number.isFinite(lat) ||
        lat < -90 ||
        lat > 90 ||
        typeof lon !== 'number' ||
        !Number.isFinite(lon) ||
        lon < -180 ||
        lon > 180 ||
        typeof updatedAt !== 'string' ||
        !Number.isFinite(Date.parse(updatedAt))
    ) {
        return null;
    }

    return { distanceM, lat, lon };
}

export function shouldTriggerGeofenceAlert(
    alertedEpisodes: Set<string>,
    alertKey: string,
    distanceM: number,
    radiusM: number,
): boolean {
    if (!Number.isFinite(distanceM) || distanceM < 0 || !Number.isFinite(radiusM) || radiusM <= 0) {
        return false;
    }

    if (distanceM <= radiusM) {
        // Returning inside closes the current breach episode, allowing a
        // genuinely later departure to create a new alert.
        alertedEpisodes.delete(alertKey);
        return false;
    }

    return !alertedEpisodes.has(alertKey);
}

async function getWatchdogPosition(
    supabase: SupabaseClient,
    userId: string,
    mmsi: number,
    kind: 'bolo' | 'geofence_breach',
): Promise<WatchdogPosition | null> {
    const { data, error } = await supabase.rpc('guardian_watchdog_position', {
        p_user_id: userId,
        p_vessel_mmsi: mmsi,
        p_kind: kind,
    });
    if (error) {
        console.error(`[Watchdog] Failed to read ${kind} position for ${mmsi}:`, error.message);
        return null;
    }
    return parseWatchdogPosition(data);
}

export function startWatchdog(supabaseUrl: string, supabaseKey: string): ReturnType<typeof setInterval> {
    const supabase = createClient(supabaseUrl, supabaseKey);
    let tickInFlight = false;

    console.log('[Watchdog] Starting BOLO + Geofence monitor (30s loop)');

    const tick = async () => {
        // A slow database/push round must never overlap the next interval:
        // overlapping ticks can both observe an unlatch and enqueue the same
        // critical alert before either has recorded success.
        if (tickInFlight) return;
        tickInFlight = true;
        try {
            await checkBolo(supabase);
            await checkGeofences(supabase);
        } catch (e) {
            console.error('[Watchdog] Tick error:', e);
        } finally {
            tickInFlight = false;
        }
    };

    // Run immediately, then every 30 seconds
    tick();
    return setInterval(tick, WATCHDOG_INTERVAL_MS);
}

// ── BOLO: Armed vessel movement detection ──

async function checkBolo(supabase: SupabaseClient): Promise<void> {
    // 1. Get all armed vessels
    const { data: armed, error: armError } = await supabase
        .from('guardian_profiles')
        .select('user_id, mmsi, vessel_name, armed_at')
        .eq('armed', true)
        .not('mmsi', 'is', null)
        .not('armed_location', 'is', null);

    if (armError) {
        console.error('[Watchdog] Failed to load armed vessels:', armError.message);
        return;
    }
    if (!armed || armed.length === 0) {
        boloAlerted.clear();
        return;
    }

    for (const vessel of armed as ArmedVessel[]) {
        if (!vessel.mmsi) continue;
        const alertKey = `${vessel.user_id}:${vessel.mmsi}:${vessel.armed_at}`;
        if (boloAlerted.has(alertKey)) continue; // Already alerted for this arming episode

        // The owner-scoped RPC rejects AIS positions older than 15 minutes and
        // returns coordinates from PostGIS without relying on client-side
        // geography decoding.
        const position = await getWatchdogPosition(supabase, vessel.user_id, vessel.mmsi, 'bolo');
        if (!position) continue;

        if (position.distanceM > BOLO_THRESHOLD_M) {
            const episodeKey = `${vessel.mmsi}:${vessel.armed_at}`;
            const { data: notified, error: notificationError } = await supabase.rpc('queue_guardian_watchdog_alert', {
                p_user_id: vessel.user_id,
                p_alert_kind: 'bolo',
                p_episode_key: episodeKey,
                p_lat: position.lat,
                p_lon: position.lon,
                p_radius_nm: 5,
                p_title: '🚨 BOLO — Armed Vessel Moving',
                p_body: `${vessel.vessel_name || 'MMSI ' + vessel.mmsi} has moved ${position.distanceM.toFixed(0)}m while armed. Be on the lookout!`,
                p_owner_title: '🚨 Your Vessel Is Moving!',
                p_owner_body: `${vessel.vessel_name || 'Your vessel'} has moved ${position.distanceM.toFixed(0)}m while armed.`,
                p_data: {
                    mmsi: vessel.mmsi,
                    distance_m: position.distanceM,
                    vessel_name: vessel.vessel_name,
                },
            });

            if (notificationError) {
                console.error(`[Watchdog] BOLO notification failed for ${vessel.mmsi}:`, notificationError.message);
                continue;
            }

            // The database claim is restart-safe. A zero means this process
            // rediscovered an already-queued episode after a restart.
            boloAlerted.add(alertKey);
            if (typeof notified === 'number' && notified > 0) {
                console.log(
                    `[Watchdog] 🚨 BOLO TRIGGERED: ${vessel.vessel_name || 'MMSI ' + vessel.mmsi} ` +
                        `moved ${position.distanceM.toFixed(0)}m; queued ${notified} notification(s)`,
                );
            }
        }
    }

    // Clean up: remove alerts for vessels that are no longer armed
    const activeAlertKeys = new Set(
        (armed as ArmedVessel[]).filter((v) => v.mmsi).map((v) => `${v.user_id}:${v.mmsi}:${v.armed_at}`),
    );
    for (const key of boloAlerted) {
        if (!activeAlertKeys.has(key)) boloAlerted.delete(key);
    }
}

// ── Geofence: Home coordinate breach detection ──

async function checkGeofences(supabase: SupabaseClient): Promise<void> {
    // 1. Get all vessels with home coordinates
    const { data: geofenced, error } = await supabase
        .from('guardian_profiles')
        .select('user_id, mmsi, vessel_name, home_radius_m')
        .not('mmsi', 'is', null)
        .not('home_coordinate', 'is', null);

    if (error) {
        console.error('[Watchdog] Failed to load geofenced vessels:', error.message);
        return;
    }
    if (!geofenced || geofenced.length === 0) {
        geofenceAlerted.clear();
        geofenceResolvedInside.clear();
        return;
    }

    for (const vessel of geofenced as GeofenceVessel[]) {
        if (!vessel.mmsi) continue;
        const alertKey = `${vessel.user_id}:${vessel.mmsi}`;
        const episodeKey = `${vessel.mmsi}`;

        const position = await getWatchdogPosition(supabase, vessel.user_id, vessel.mmsi, 'geofence_breach');
        if (
            !position ||
            typeof vessel.home_radius_m !== 'number' ||
            !Number.isFinite(vessel.home_radius_m) ||
            vessel.home_radius_m <= 0
        ) {
            continue;
        }

        if (position.distanceM <= vessel.home_radius_m) {
            shouldTriggerGeofenceAlert(geofenceAlerted, alertKey, position.distanceM, vessel.home_radius_m);
            if (!geofenceResolvedInside.has(alertKey)) {
                const { error: resolveError } = await supabase.rpc('resolve_guardian_watchdog_episode', {
                    p_user_id: vessel.user_id,
                    p_alert_kind: 'geofence_breach',
                    p_episode_key: episodeKey,
                });
                if (resolveError) {
                    console.error(
                        `[Watchdog] Failed to resolve geofence episode for ${vessel.mmsi}:`,
                        resolveError.message,
                    );
                } else {
                    geofenceResolvedInside.add(alertKey);
                }
            }
            continue;
        }

        geofenceResolvedInside.delete(alertKey);
        if (!shouldTriggerGeofenceAlert(geofenceAlerted, alertKey, position.distanceM, vessel.home_radius_m)) {
            continue;
        }

        console.log(
            `[Watchdog] 🏠 GEOFENCE BREACH: ${vessel.vessel_name || 'MMSI ' + vessel.mmsi} ` +
                `is ${position.distanceM.toFixed(0)}m from home (limit: ${vessel.home_radius_m}m)`,
        );

        const { error: notificationError } = await supabase.rpc('queue_guardian_watchdog_alert', {
            p_user_id: vessel.user_id,
            p_alert_kind: 'geofence_breach',
            p_episode_key: episodeKey,
            p_lat: position.lat,
            p_lon: position.lon,
            p_radius_nm: Math.min(5, Math.max(0.1, vessel.home_radius_m / 1852)),
            p_title: '🏠 Digital Tripwire Triggered',
            p_body: `${vessel.vessel_name || 'Your vessel'} has moved ${position.distanceM.toFixed(0)}m from home base.`,
            p_owner_title: '🏠 Digital Tripwire Triggered',
            p_owner_body: `${vessel.vessel_name || 'Your vessel'} has moved ${position.distanceM.toFixed(0)}m from home base.`,
            p_data: {
                mmsi: vessel.mmsi,
                distance_m: position.distanceM,
                home_radius_m: vessel.home_radius_m,
            },
        });

        if (notificationError) {
            console.error(
                `[Watchdog] Geofence owner notification failed for ${vessel.mmsi}:`,
                notificationError.message,
            );
            continue;
        }

        geofenceAlerted.add(alertKey);
    }

    // Clean up stale alerts
    const activeKeys = new Set(geofenced.map((v) => `${v.user_id}:${v.mmsi}`));
    for (const key of geofenceAlerted) {
        if (!activeKeys.has(key)) geofenceAlerted.delete(key);
    }
    for (const key of geofenceResolvedInside) {
        if (!activeKeys.has(key)) geofenceResolvedInside.delete(key);
    }
}
