/**
 * AIS proximity tool — top N AIS targets within range, with CPA + TCPA.
 *
 * The skipper asks "anything close?" — Calypso queries this and
 * narrates the closest few traffic vessels with their bearing,
 * range, and (most importantly for collision risk) closest-point-of-
 * approach + time-to-CPA. CPA + TCPA together let her say "Pacific
 * Voyager will pass two cables away in twelve minutes" rather than
 * just "ship four miles north" — the safety-relevant framing.
 *
 * Math:
 *   - Range: great-circle distance from own ship to each target.
 *   - Bearing: compass bearing from own ship to target.
 *   - CPA: minimum distance between own and target trajectories
 *     assuming constant course + speed for both. Geometric solution
 *     using relative-motion vector.
 *   - TCPA: time at which CPA occurs. Negative TCPA means the
 *     vessels are diverging (CPA is in the past) — Calypso skips
 *     reporting on those.
 *
 * Limitations:
 *   - Static-course assumption breaks if either vessel turns. CPA
 *     numbers are point-in-time estimates, not predictions for the
 *     next 20 minutes. Calypso re-queries on follow-up.
 *   - Own-ship SOG/COG comes from NmeaStore (preferred) or phone
 *     GPS. If we have neither, we still report range + bearing for
 *     each target but skip CPA/TCPA — those need own-ship motion.
 */

import { AisStore } from '../../AisStore';
import type { AisTarget } from '../../../types/navigation';
import { getCurrentFix } from './voyage';

interface AisReport {
    mmsi: number;
    name: string;
    range_nm: number;
    bearing_true: number;
    target_sog: number;
    target_cog: number;
    cpa_nm: number | null;
    tcpa_min: number | null;
    age_sec: number;
}

const EARTH_NM = 3440.065;
function toRad(d: number): number {
    return (d * Math.PI) / 180;
}
function toDeg(r: number): number {
    return (r * 180) / Math.PI;
}

function distanceNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_NM * Math.asin(Math.sqrt(a));
}

function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const φ1 = toRad(lat1);
    const φ2 = toRad(lat2);
    const Δλ = toRad(lon2 - lon1);
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Closest Point of Approach calculation in flat-earth approximation
 * (valid out to ~50nm — beyond that the curvature error is bigger
 * than the AIS reporting precision anyway).
 *
 * Convert each vessel's COG/SOG to a velocity vector in nm/hour, take
 * the relative motion of the target vs own ship, and project the
 * relative position onto that. The result is the time at which
 * relative range is minimum (TCPA), and the perpendicular distance
 * is the CPA.
 *
 * Returns null on degenerate cases (zero relative speed → vessels are
 * locked at constant range; no defined CPA).
 */
function computeCpaTcpa(
    ownLat: number,
    ownLon: number,
    ownCog: number,
    ownSog: number,
    target: AisTarget,
): { cpa_nm: number; tcpa_min: number } | null {
    // Convert COG/SOG to north/east velocity components in nm/hour.
    // Sailor's coordinate system: north = +y, east = +x.
    const ownVx = ownSog * Math.sin(toRad(ownCog));
    const ownVy = ownSog * Math.cos(toRad(ownCog));
    const tgtVx = target.sog * Math.sin(toRad(target.cog));
    const tgtVy = target.sog * Math.cos(toRad(target.cog));

    // Relative position from own ship to target, in nm. Quick local
    // flat-earth: 1° lat ≈ 60nm; 1° lon ≈ 60·cos(lat)nm.
    const rx = (target.lon - ownLon) * 60 * Math.cos(toRad(ownLat));
    const ry = (target.lat - ownLat) * 60;

    // Relative velocity (target minus own).
    const vx = tgtVx - ownVx;
    const vy = tgtVy - ownVy;

    const vSquared = vx * vx + vy * vy;
    if (vSquared < 0.0001) return null; // < 0.01 kts relative speed → no defined CPA

    // TCPA = -(r·v) / |v|² (in hours)
    const tcpaHrs = -(rx * vx + ry * vy) / vSquared;
    if (tcpaHrs < 0) {
        // Vessels are diverging — closest approach is in the past.
        // Calypso doesn't report on receding traffic.
        return { cpa_nm: distanceNmFromVec(rx, ry), tcpa_min: tcpaHrs * 60 };
    }
    // Position at CPA = r + v·t
    const cpaX = rx + vx * tcpaHrs;
    const cpaY = ry + vy * tcpaHrs;
    const cpaNm = Math.sqrt(cpaX * cpaX + cpaY * cpaY);
    return { cpa_nm: cpaNm, tcpa_min: tcpaHrs * 60 };
}

function distanceNmFromVec(dx: number, dy: number): number {
    return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Top N AIS targets within `max_range_nm` of the own ship, with
 * CPA/TCPA on each (when own-ship motion is known). Sorted by range
 * ascending — closest first.
 */
export async function aisProximity(
    maxRangeNm: number,
    maxCount: number,
): Promise<{ content: string; isError: boolean }> {
    const fix = await getCurrentFix();
    if (!fix) {
        return {
            content: JSON.stringify({
                status: 'no_position',
                note: 'No live GPS to anchor proximity from. Tell the skipper plainly.',
            }),
            isError: false,
        };
    }

    const targets = AisStore.getTargets();
    if (!targets || targets.size === 0) {
        return {
            content: JSON.stringify({
                status: 'no_targets',
                position_source: fix.source,
                note: 'No AIS targets in receiver range right now. Could be open ocean, AIS antenna issue, or nothing nearby — say so plainly.',
            }),
            isError: false,
        };
    }

    const range = Math.max(0.5, Math.min(50, maxRangeNm || 10));
    const count = Math.max(1, Math.min(10, maxCount || 3));
    const ownCog = fix.cog;
    const ownSog = fix.sog;

    const reports: AisReport[] = [];
    const now = Date.now();
    for (const target of targets.values()) {
        const r = distanceNm(fix.lat, fix.lon, target.lat, target.lon);
        if (r > range) continue;
        const b = bearingDeg(fix.lat, fix.lon, target.lat, target.lon);
        let cpaNm: number | null = null;
        let tcpaMin: number | null = null;
        if (typeof ownCog === 'number' && typeof ownSog === 'number' && ownSog > 0.2) {
            const cpa = computeCpaTcpa(fix.lat, fix.lon, ownCog, ownSog, target);
            if (cpa) {
                cpaNm = Number(cpa.cpa_nm.toFixed(2));
                tcpaMin = Number(cpa.tcpa_min.toFixed(1));
            }
        }
        reports.push({
            mmsi: target.mmsi,
            name: target.name || `MMSI ${target.mmsi}`,
            range_nm: Number(r.toFixed(2)),
            bearing_true: Math.round(b),
            target_sog: Number(target.sog.toFixed(1)),
            target_cog: Math.round(target.cog),
            cpa_nm: cpaNm,
            tcpa_min: tcpaMin,
            age_sec: Math.round((now - target.lastUpdated) / 1000),
        });
    }

    reports.sort((a, b) => a.range_nm - b.range_nm);

    const top = reports.slice(0, count);
    return {
        content: JSON.stringify({
            status: 'targets',
            own_position_source: fix.source,
            own_cog: ownCog ?? null,
            own_sog: ownSog ?? null,
            range_searched_nm: range,
            total_in_range: reports.length,
            targets: top,
            note:
                top.length === 0
                    ? `Nothing within ${range} nautical miles. Say so plainly.`
                    : "Narrate naturally — vessel name, range, bearing, then CPA/TCPA only when CPA < 1nm OR TCPA < 30 min (those are the alarming ones). Quiet ones get one line each. Skip targets with negative TCPA — they're receding.",
        }),
        isError: false,
    };
}
