/**
 * At anchor, for the collision rule (build 125, package 125-01b).
 *
 * utils/collisionRule.ts takes `atAnchor` as an explicit input on our own
 * ship: stopped with an anchor watch on, close quarters still sounds for a
 * vessel under way; stopped at a berth (no anchor watch), nothing does. This
 * is where that input comes from, for the alarm, the chart's CPA chip and
 * Calypso alike (AisGuardWatch.readCollisionInputs). It reads the one
 * anchor-watch truth, presentAnchorWatchRow (the row the System status box,
 * the Vessel tile and the chart's badge read), never a nav status:
 *
 *  - A watch kept on THIS PHONE (holding, setting, paused or alarming): at
 *    anchor. The phone's own watch runs aboard; carried ashore it would
 *    drag-alarm.
 *  - The watch this phone handed to ITS PI: at anchor while the position the
 *    rule grades is the boat's own (her GPS, by any lane). Graded from this
 *    phone's own GPS (the boat's feed lapsed), only while that is within
 *    100 m of where the Pi last reported her, fresh: aboard. Handed over, this
 *    phone may be ashore on Shore Watch, and graded from there a ferry
 *    passing the waterfront would sound close quarters.
 *  - A session joined from ANOTHER DEVICE: at anchor only while the position
 *    we grade is within 100 m of where that device last reported its boat,
 *    fresh (this phone is aboard her, or alongside). Otherwise it says
 *    nothing about where this phone is, or even which boat it is.
 *
 * An anchor watch that is on but does not put us at anchor is 'elsewhere',
 * so the strip says so instead of 'no anchor watch' (125-01b review).
 * Unreadable is no anchor watch: the rule then behaves exactly as 125-01
 * shipped, and a read failure can never take the collision watch down.
 */
import { AnchorWatchService, type AnchorWatchSnapshot } from './AnchorWatchService';
import { ShoreWatchAlarmService, type ShoreAlarmSnapshot } from './ShoreWatchAlarmService';
import { AnchorPiWatchKeeper } from './anchorPiWatchKeeper';
import {
    presentAnchorWatchRow,
    type AnchorWatchRowPresentation,
} from '../components/anchor-watch/anchorWatchStatusRow';
import { rangeBearing } from '../utils/collisionRule';

/** Where the position the rule grades came from: 'nmea' is the boat's own GPS (any lane), 'gps' this phone. */
export type CollisionPositionSource = 'nmea' | 'gps' | null;

/**
 * 'at-anchor': the rule's `atAnchor`. 'elsewhere': an anchor watch is on, but
 * not for the position we grade. 'none': no anchor watch (a berth).
 */
export type CollisionAnchorWatch = 'at-anchor' | 'elsewhere' | 'none';

/** Within this of where the watch's keeper last reported her, the position we grade is aboard (or alongside). */
export const COLLISION_ABOARD_WITHIN_M = 100;

const METRES_PER_NM = 1852;

/**
 * What the anchor watch the row describes means for the position we grade.
 * `keptAt` is where the watch's keeper (the Pi or another device) last
 * reported the boat, null unless that report is fresh.
 */
export function collisionAnchorWatch(
    row: Pick<AnchorWatchRowPresentation, 'active' | 'keeper'>,
    own: { lat: number; lon: number; source: CollisionPositionSource } | null,
    keptAt: { lat: number; lon: number } | null,
): CollisionAnchorWatch {
    if (!row.active) return 'none';
    if (row.keeper === 'phone') return 'at-anchor';
    if (row.keeper === 'pi' && own?.source === 'nmea') return 'at-anchor';
    if (
        own &&
        keptAt &&
        rangeBearing(own.lat, own.lon, keptAt.lat, keptAt.lon).rangeNm * METRES_PER_NM <= COLLISION_ABOARD_WITHIN_M
    ) {
        return 'at-anchor';
    }
    return 'elsewhere';
}

type LocalWatch = Pick<
    AnchorWatchSnapshot,
    'state' | 'distanceFromAnchor' | 'swingRadius' | 'alarmTriggeredAt' | 'alarmCause'
>;

/**
 * This phone's own watch, as its last snapshot said. Kept from a subscription
 * because the guard reads it on every AIS report, and a snapshot copies the
 * watch's whole position history.
 */
let localWatch: LocalWatch | null = null;
let listening = false;

function pick(s: LocalWatch): LocalWatch {
    return {
        state: s.state,
        distanceFromAnchor: s.distanceFromAnchor,
        swingRadius: s.swingRadius,
        alarmTriggeredAt: s.alarmTriggeredAt,
        alarmCause: s.alarmCause,
    };
}

function readLocalWatch(): LocalWatch | null {
    if (!listening) {
        try {
            AnchorWatchService.subscribe((snapshot) => {
                localWatch = pick(snapshot);
            });
            listening = true;
        } catch {
            try {
                return pick(AnchorWatchService.getSnapshot());
            } catch {
                return null;
            }
        }
    }
    return localWatch;
}

/** Where a fresh report from the watch's keeper puts the boat, else null. */
function keptPosition(shore: Pick<ShoreAlarmSnapshot, 'position' | 'stale'>): { lat: number; lon: number } | null {
    const vessel = shore.stale ? null : shore.position?.vessel;
    if (!vessel) return null;
    const lat = Number(vessel.latitude);
    const lon = Number(vessel.longitude);
    return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
        ? { lat, lon }
        : null;
}

/**
 * The anchor watch for the collision rule, for the position we grade (null
 * without a fix). Never throws: unreadable is 'none', as before 125-01b.
 */
export function readCollisionAnchorWatch(
    own: { lat: number; lon: number; source: CollisionPositionSource } | null,
): CollisionAnchorWatch {
    try {
        const shore = ShoreWatchAlarmService.getSnapshot();
        const row = presentAnchorWatchRow(readLocalWatch(), shore, AnchorPiWatchKeeper.keepingSessionCode());
        return collisionAnchorWatch(row, own, keptPosition(shore));
    } catch {
        return 'none';
    }
}

/** Test seam. */
export function __resetCollisionAnchorWatchForTests(): void {
    localWatch = null;
    listening = false;
}
