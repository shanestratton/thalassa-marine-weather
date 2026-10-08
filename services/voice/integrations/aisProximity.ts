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
 *
 * Build 125 (125-01): the CPA maths, the risk grade and the alarm flag are
 * the collision rule's (utils/collisionRule.ts), the same one the chart's
 * CPA chip and the collision alarm use. This file used to carry its own copy,
 * with its own idea of 'alarming', so Calypso could call quiet a ship the
 * chip called DANGER. A speed or course that is 'not available' (102.3 / 360)
 * is reported as unknown and never feeds a CPA. Its inputs — our position,
 * our course and speed, the pair in use, the skipper's thresholds and our
 * own MMSIs — are the alarm's own (AisGuardWatch.readCollisionInputs), so
 * with any saved thresholds Calypso's `alarm` is exactly the alarm's.
 */

import { AisStore } from '../../AisStore';
import { readCollisionInputs } from '../../AisGuardWatch';
import { aisCogDeg, aisSogKn, assessCollision, type CollisionRisk } from '../../../utils/collisionRule';

interface AisReport {
    mmsi: number;
    name: string;
    range_nm: number;
    bearing_true: number;
    target_sog: number | null;
    target_cog: number | null;
    cpa_nm: number | null;
    tcpa_min: number | null;
    risk: CollisionRisk | null;
    alarm: boolean;
    age_sec: number;
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
    const now = Date.now();
    const { own: fix, motion, prefs, ownMmsis } = readCollisionInputs(now);
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
                position_source: fix.source === 'gps' ? 'phone' : 'nmea',
                note: 'No AIS targets in receiver range right now. Could be open ocean, AIS antenna issue, or nothing nearby — say so plainly.',
            }),
            isError: false,
        };
    }

    const range = Math.max(0.5, Math.min(50, maxRangeNm || 10));
    const count = Math.max(1, Math.min(10, maxCount || 3));
    const ownCog = motion.cogDeg;
    const ownSog = motion.sogKn;

    const reports: AisReport[] = [];
    for (const target of targets.values()) {
        // Our own transponder is not traffic.
        if (ownMmsis.has(target.mmsi)) continue;
        const ageSec = Math.round((now - target.lastUpdated) / 1000);
        const a = assessCollision(
            { lat: fix.lat, lon: fix.lon, sogKn: ownSog, cogDeg: ownCog, pair: motion.pair },
            {
                lat: target.lat,
                lon: target.lon,
                sogKn: target.sog,
                cogDeg: target.cog,
                navStatus: target.navStatus,
                reportAgeSec: ageSec,
                // Everything in AisStore came off the boat's own receiver.
                source: 'local',
            },
            prefs,
        );
        if (!a || a.rangeNm > range) continue;
        const sog = aisSogKn(target.sog);
        const cog = aisCogDeg(target.cog);
        reports.push({
            mmsi: target.mmsi,
            name: target.name || `MMSI ${target.mmsi}`,
            range_nm: Number(a.rangeNm.toFixed(2)),
            bearing_true: Math.round(a.bearingDeg),
            target_sog: sog === null ? null : Number(sog.toFixed(1)),
            target_cog: cog === null ? null : Math.round(cog),
            cpa_nm: a.cpaNm === null ? null : Number(a.cpaNm.toFixed(2)),
            tcpa_min: a.tcpaMin === null ? null : Number(a.tcpaMin.toFixed(1)),
            risk: a.rangeOnly ? null : a.risk,
            alarm: a.alarm,
            age_sec: ageSec,
        });
    }

    reports.sort((a, b) => a.range_nm - b.range_nm);

    const top = reports.slice(0, count);
    return {
        content: JSON.stringify({
            status: 'targets',
            own_position_source: fix.source === 'gps' ? 'phone' : 'nmea',
            own_cog: ownCog ?? null,
            own_sog: ownSog ?? null,
            range_searched_nm: range,
            total_in_range: reports.length,
            targets: top,
            note:
                top.length === 0
                    ? `Nothing within ${range} nautical miles. Say so plainly.`
                    : "Narrate naturally — vessel name, range, bearing. Give CPA/TCPA first for any target with alarm true (the collision alarm's own rule) or risk CAUTION; quiet ones get one line each. Skip targets with negative TCPA — they're receding. A null CPA means her course or speed is unknown: say range and bearing only, never guess.",
        }),
        isError: false,
    };
}
