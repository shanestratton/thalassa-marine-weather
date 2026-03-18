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
const boloAlerted = new Set<number>();
const geofenceAlerted = new Set<string>();

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

export function startWatchdog(supabaseUrl: string, supabaseKey: string): ReturnType<typeof setInterval> {
    const supabase = createClient(supabaseUrl, supabaseKey);

    console.log('[Watchdog] Starting BOLO + Geofence monitor (30s loop)');

    const tick = async () => {
        try {
            await checkBolo(supabase);
            await checkGeofences(supabase);
        } catch (e) {
            console.error('[Watchdog] Tick error:', e);
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

    if (armError || !armed || armed.length === 0) return;

    for (const vessel of armed as ArmedVessel[]) {
        if (!vessel.mmsi) continue;
        if (boloAlerted.has(vessel.mmsi)) continue; // Already alerted

        // 2. Get latest AIS position for this MMSI
        const { data: aisData, error: aisError } = await supabase
            .from('vessels')
            .select('latitude, longitude')
            .eq('mmsi', vessel.mmsi)
            .maybeSingle();

        if (aisError || !aisData || !aisData.latitude || !aisData.longitude) continue;

        // 3. Compare against armed position using PostGIS
        const { data: distResult } = await supabase.rpc('check_bolo_distance', {
            vessel_mmsi: vessel.mmsi,
        });

        const distanceM = distResult as number | null;
        if (distanceM === null || distanceM === undefined) continue;

        if (distanceM > BOLO_THRESHOLD_M) {
            console.log(
                `[Watchdog] 🚨 BOLO TRIGGERED: ${vessel.vessel_name || 'MMSI ' + vessel.mmsi} ` +
                    `moved ${distanceM.toFixed(0)}m while armed!`,
            );

            // 4. Broadcast BOLO alert
            const { data: notified } = await supabase.rpc('broadcast_guardian_alert', {
                sender_user_id: vessel.user_id,
                p_alert_type: 'bolo',
                lat: aisData.latitude,
                lon: aisData.longitude,
                radius_nm: 5,
                p_title: '🚨 BOLO — Armed Vessel Moving',
                p_body: `${vessel.vessel_name || 'MMSI ' + vessel.mmsi} has moved ${distanceM.toFixed(0)}m while armed. Be on the lookout!`,
                alert_data: JSON.stringify({
                    mmsi: vessel.mmsi,
                    distance_m: distanceM,
                    vessel_name: vessel.vessel_name,
                }),
            });

            // Also notify the vessel owner directly
            await supabase.from('push_notification_queue').insert({
                recipient_user_id: vessel.user_id,
                notification_type: 'bolo_alert',
                title: '🚨 Your Vessel Is Moving!',
                body: `${vessel.vessel_name || 'Your vessel'} has moved ${distanceM.toFixed(0)}m while armed.`,
                data: { mmsi: vessel.mmsi, distance_m: distanceM },
            });

            boloAlerted.add(vessel.mmsi);
            console.log(`[Watchdog] BOLO broadcast to ${notified ?? 0} nearby users`);
        }
    }

    // Clean up: remove alerts for vessels that are no longer armed
    const armedMmsis = new Set(armed.map((v) => v.mmsi).filter(Boolean));
    for (const mmsi of boloAlerted) {
        if (!armedMmsis.has(mmsi)) {
            boloAlerted.delete(mmsi);
        }
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

    if (error || !geofenced || geofenced.length === 0) return;

    for (const vessel of geofenced as GeofenceVessel[]) {
        if (!vessel.mmsi) continue;
        const alertKey = `${vessel.mmsi}`;
        if (geofenceAlerted.has(alertKey)) continue;

        // 2. Check if vessel has moved outside geofence
        const { data: distResult } = await supabase.rpc('check_geofence_distance', {
            vessel_mmsi: vessel.mmsi,
        });

        const distanceM = distResult as number | null;
        if (distanceM === null || distanceM === undefined) continue;

        if (distanceM > vessel.home_radius_m) {
            console.log(
                `[Watchdog] 🏠 GEOFENCE BREACH: ${vessel.vessel_name || 'MMSI ' + vessel.mmsi} ` +
                    `is ${distanceM.toFixed(0)}m from home (limit: ${vessel.home_radius_m}m)`,
            );

            // Get current AIS position
            const { data: aisData } = await supabase
                .from('vessels')
                .select('latitude, longitude')
                .eq('mmsi', vessel.mmsi)
                .maybeSingle();

            if (!aisData) continue;

            // Notify the vessel owner
            await supabase.from('push_notification_queue').insert({
                recipient_user_id: vessel.user_id,
                notification_type: 'geofence_alert',
                title: '🏠 Digital Tripwire Triggered',
                body: `${vessel.vessel_name || 'Your vessel'} has moved ${distanceM.toFixed(0)}m from home base.`,
                data: { mmsi: vessel.mmsi, distance_m: distanceM },
            });

            geofenceAlerted.add(alertKey);
        }
    }

    // Clean up stale alerts
    const activeKeys = new Set(geofenced.map((v) => `${v.mmsi}`));
    for (const key of geofenceAlerted) {
        if (!activeKeys.has(key)) geofenceAlerted.delete(key);
    }
}
