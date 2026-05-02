/**
 * Voyage integration tools for Calypso.
 *
 * Three tools the skipper invokes by voice while underway:
 *   - log_entry({ notes })             — drop a free-form note in the
 *                                        active ship's log
 *   - save_waypoint({ name, notes? })  — mark current position as a
 *                                        named waypoint in the log
 *   - passage_eta({ dest_lat, dest_lon, dest_name? })
 *                                       — current position to a
 *                                        destination at current speed
 *
 * All three resolve current GPS the same way: NMEA store first
 * (preferred — boat instruments are sailor's truth), phone GPS
 * fallback via BgGeoManager. If neither is alive the tool returns
 * an error and Calypso narrates the gap honestly.
 *
 * log_entry + save_waypoint require an active voyage in ShipLogService
 * — there's no implicit voyage creation here. If tracking isn't on,
 * we tell the skipper "start tracking first" rather than saving an
 * orphan entry that won't be visible in any voyage.
 */

import { ShipLogService } from '../../ShipLogService';
import { NmeaStore } from '../../NmeaStore';
import { BgGeoManager } from '../../BgGeoManager';

interface VesselFix {
    lat: number;
    lon: number;
    sog?: number; // knots
    cog?: number; // degrees
    source: 'nmea' | 'phone';
}

/**
 * Resolve the best-available current fix. NMEA preferred — boat
 * instruments beat the phone's GPS for accuracy underway and don't
 * suffer the dock-side multipath the phone gets in marina cradles.
 */
async function getCurrentFix(): Promise<VesselFix | null> {
    const nm = NmeaStore.getState();
    if (
        nm.latitude.freshness === 'live' &&
        nm.longitude.freshness === 'live' &&
        nm.latitude.value !== null &&
        nm.longitude.value !== null
    ) {
        return {
            lat: nm.latitude.value,
            lon: nm.longitude.value,
            sog: nm.sog.freshness === 'live' ? (nm.sog.value ?? undefined) : undefined,
            cog: nm.cog.freshness === 'live' ? (nm.cog.value ?? undefined) : undefined,
            source: 'nmea',
        };
    }
    // Phone GPS fallback. BgGeoManager caches the last fix in a flat
    // shape (lat/lon/speed/heading at the top level — not nested under
    // `coords` like the Geolocation API).
    try {
        const phone = await BgGeoManager.getLastPosition();
        if (!phone) return null;
        return {
            lat: phone.latitude,
            lon: phone.longitude,
            sog: typeof phone.speed === 'number' && phone.speed >= 0 ? msToKts(phone.speed) : undefined,
            cog:
                typeof phone.heading === 'number' && phone.heading !== null && phone.heading >= 0
                    ? phone.heading
                    : undefined,
            source: 'phone',
        };
    } catch {
        return null;
    }
}

function msToKts(ms: number): number {
    return ms * 1.94384;
}

/** Great-circle distance in nautical miles using the haversine formula. */
function distanceNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 3440.065; // Earth radius in nautical miles
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Initial bearing (forward azimuth) from point 1 to point 2 in
 * compass degrees [0,360). Used for "head one-three-five" style
 * read-backs when Calypso narrates the bearing to a destination.
 */
function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const toRad = (d: number) => (d * Math.PI) / 180;
    const toDeg = (r: number) => (r * 180) / Math.PI;
    const φ1 = toRad(lat1);
    const φ2 = toRad(lat2);
    const λ1 = toRad(lon1);
    const λ2 = toRad(lon2);
    const y = Math.sin(λ2 - λ1) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(λ2 - λ1);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// ── Tool: log_entry ────────────────────────────────────────────────

/**
 * Drop a free-form note into the active voyage's ship's log. GPS +
 * weather snapshot are auto-stamped by ShipLogService. The skipper
 * doesn't have to specify position — that's the whole point of
 * voice-logging while a hand is on the wheel.
 */
export async function logEntry(notes: string): Promise<{ content: string; isError: boolean }> {
    const trimmed = (notes || '').trim();
    if (!trimmed) {
        return { content: 'ERROR: empty log note', isError: true };
    }
    try {
        const entry = await ShipLogService.addManualEntry(trimmed, undefined, 'observation');
        if (!entry) {
            return {
                content: JSON.stringify({
                    status: 'no_active_voyage',
                    note: 'No voyage is currently being tracked. Tell the skipper they need to start tracking from the Ship Log page first.',
                }),
                isError: false,
            };
        }
        return {
            content: JSON.stringify({
                status: 'logged',
                entry_id: entry.id,
                timestamp: entry.timestamp,
                note: 'Confirm to the skipper briefly: "Logged."',
            }),
            isError: false,
        };
    } catch (err) {
        return { content: `ERROR: log entry failed — ${(err as Error).message}`, isError: true };
    }
}

// ── Tool: save_waypoint ────────────────────────────────────────────

/**
 * Save the current position as a named waypoint in the active voyage.
 * "Mark this anchorage as Crocodile Bay" / "save this position as Cape
 * Hawke approach". The waypoint becomes a navigable entry the skipper
 * can scroll back to from the Ship Log.
 */
export async function saveWaypoint(name: string, notes?: string): Promise<{ content: string; isError: boolean }> {
    const trimmedName = (name || '').trim();
    if (!trimmedName) {
        return { content: 'ERROR: waypoint requires a name', isError: true };
    }
    try {
        const entry = await ShipLogService.addManualEntry(notes?.trim() || trimmedName, trimmedName, 'navigation');
        if (!entry) {
            return {
                content: JSON.stringify({
                    status: 'no_active_voyage',
                    note: 'No voyage is being tracked — tell the skipper to start tracking from the Ship Log page so the waypoint has somewhere to live.',
                }),
                isError: false,
            };
        }
        return {
            content: JSON.stringify({
                status: 'saved',
                waypoint_name: trimmedName,
                entry_id: entry.id,
                timestamp: entry.timestamp,
                note: `Confirm to the skipper briefly: "Marked, ${trimmedName}."`,
            }),
            isError: false,
        };
    } catch (err) {
        return { content: `ERROR: waypoint save failed — ${(err as Error).message}`, isError: true };
    }
}

// ── Tool: passage_eta ──────────────────────────────────────────────

/**
 * Compute time + bearing + distance from current position to the
 * given destination at current speed-over-ground. Pure math — no
 * passage routing, no current/wind correction; this is the "as the
 * crow flies" answer the skipper expects when they ask "how long
 * till Bundaberg at this speed?".
 *
 * Returns enough numbers that Calypso can either give a quick
 * answer ("about five hours") or detail ("five hours twelve minutes,
 * forty-three nautical miles, bearing zero-eight-five").
 */
export async function passageEta(
    destLat: number,
    destLon: number,
    destName?: string,
): Promise<{ content: string; isError: boolean }> {
    if (!isFinite(destLat) || !isFinite(destLon)) {
        return { content: 'ERROR: destination requires valid lat + lon', isError: true };
    }
    const fix = await getCurrentFix();
    if (!fix) {
        return {
            content: JSON.stringify({
                status: 'no_position',
                note: 'No live GPS — neither the boat backbone nor the phone has a fix. Tell the skipper plainly.',
            }),
            isError: false,
        };
    }

    const distance_nm = distanceNm(fix.lat, fix.lon, destLat, destLon);
    const bearing_true = bearingDeg(fix.lat, fix.lon, destLat, destLon);
    const sog = fix.sog ?? 0;

    if (sog < 0.2) {
        // Stationary — ETA is undefined. Calypso narrates accordingly.
        return {
            content: JSON.stringify({
                status: 'stationary',
                distance_nm: Number(distance_nm.toFixed(1)),
                bearing_true: Math.round(bearing_true),
                position_source: fix.source,
                destination_name: destName ?? '',
                note: 'Vessel is not moving — ETA is undefined. Quote the distance + bearing, mention "you\'re stationary so an ETA is meaningless until you\'re underway."',
            }),
            isError: false,
        };
    }

    const hours = distance_nm / sog;
    const etaIso = new Date(Date.now() + hours * 3_600_000).toISOString();

    return {
        content: JSON.stringify({
            status: 'eta',
            distance_nm: Number(distance_nm.toFixed(1)),
            bearing_true: Math.round(bearing_true),
            sog_kts: Number(sog.toFixed(1)),
            hours: Number(hours.toFixed(2)),
            hours_label: formatDuration(hours),
            eta_iso: etaIso,
            position_source: fix.source,
            destination_name: destName ?? '',
            note: `Read it naturally: "${formatDuration(hours)} at this speed, ${distance_nm.toFixed(1)} nautical miles bearing ${formatBearing(bearing_true)}." Don't recite all six numbers.`,
        }),
        isError: false,
    };
}

/** "5.2" → "five hours twelve minutes" — Calypso-friendly. */
function formatDuration(hours: number): string {
    if (!isFinite(hours) || hours <= 0) return 'unknown';
    const totalMin = Math.round(hours * 60);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h === 0) return `${m} ${m === 1 ? 'minute' : 'minutes'}`;
    if (m === 0) return `${h} ${h === 1 ? 'hour' : 'hours'}`;
    return `${h} ${h === 1 ? 'hour' : 'hours'} ${m} ${m === 1 ? 'minute' : 'minutes'}`;
}

/** Bearing as a 3-digit compass label (".085" → "zero-eight-five"). */
function formatBearing(deg: number): string {
    const d = Math.round(deg) % 360;
    return d.toString().padStart(3, '0').split('').join('-');
}
