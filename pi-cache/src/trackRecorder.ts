/**
 * TrackRecorder — the Pi keeps the boat's track, always.
 *
 * Shane 2026-08-30: "why dont we have the pi, ALWAYS (assuming we ask it to)
 * track our course. at all times. so even if the punter forgets to start a
 * track or it crashes or their phone goes flat or over the side whatever."
 *
 * WHY THIS IS MORE THAN A CONVENIENCE
 * ───────────────────────────────────
 * The Pi is bolted to the boat, so its track IS the vessel's track by
 * construction. That is not a side benefit — it dissolves a problem the app
 * has been fighting. On 2026-08-30 a voyage track followed Shane's CAR home,
 * because the phone was the only receiver still reporting once he drove away
 * from the yard. Every rule the app applies to guess whether the phone is
 * still aboard is a rule this recorder does not need: a Pi cannot drive home.
 *
 * WHAT IT RECORDS, AND WHEN
 * ─────────────────────────
 * Not a fixed interval. Fixed rates are the wrong axis: 5 minutes smooths a
 * beat up a channel into a straight line the boat never sailed, while 30
 * seconds at anchor writes a thousand identical rows a night. This logs on
 * CHANGE — far enough, turned enough, or the heartbeat has elapsed — which is
 * how chartplotters have always done it and needs no inshore/offshore mode
 * that someone has to remember to set.
 *
 * Stationary is handled by keeping the FIRST and LAST fix of a stop rather
 * than none of them. Dropping every identical fix loses the one fact worth
 * remembering about an anchorage: that you sat in it for fourteen hours.
 *
 * SPACE IS NOT THE CONSTRAINT
 * ───────────────────────────
 * Measured on Calypso 2026-08-30: 875 GB free of 917 GB, 1% used. At the ~60
 * bytes a row costs here, a point a minute is about 31 MB a year — call it
 * twenty-seven thousand years of disk. So nothing is aged out, nothing is
 * compressed and nothing is dropped to save room. Optimise for being able to
 * ASK the log questions later, not for bytes.
 *
 * THE CLOCK IS THE REAL RISK
 * ──────────────────────────
 * A Pi has no RTC battery. One that boots without network time starts in 1970
 * or at its last-known time, and a track stamped from that clock is worse than
 * no track — it is silently misfiled for ever. The bus carries the truth
 * ($YDZDA and $YDRMC both do), so every row is stamped with GPS time and a fix
 * whose GPS time is missing is NOT recorded. Better a gap than a lie about
 * when the boat was somewhere.
 */

import { distanceMetres } from './anchorBroadcaster.js';

/** A candidate point, as read off the bus. */
export interface TrackFix {
    lat: number;
    lon: number;
    /** Epoch ms, FROM GPS — never the system clock. Null when the bus has not
     *  given us a time yet, in which case the fix is not recordable. */
    gpsTimeMs: number | null;
    /** Knots. Null when the bus is not reporting it. */
    sogKts: number | null;
    /** Degrees true. Null when not reporting, or when stopped (a stationary
     *  boat's COG is noise, not a heading). */
    cogDeg: number | null;
    /** Metres below the transducer, when the sounder is reporting. */
    depthM: number | null;

    /* ── Everything below is optional colour on the track, and every one of
       them is nullable because no two boats report the same set. A column
       nobody fills costs nothing; a value we failed to capture is gone for
       good, and on 875 GB of free disk there is no argument for thrift here.

       Shane 2026-08-30 asked for wind and depth. These are the rest, and the
       reason is the PAIRS: SOG against STW, and COG against HDG. The
       difference between each pair IS the current the boat actually sat in —
       set and drift, recorded automatically, everywhere she has ever sailed.
       Almost nobody records that, and in a tidal place like Moreton Bay it is
       worth more than the breadcrumb trail it rides on. ── */

    /** True wind speed, knots. */
    twsKts: number | null;
    /** True wind DIRECTION, degrees true — a compass bearing, not an angle off
     *  the bow, so it stays comparable across tacks and boats. */
    twdDeg: number | null;
    /** Speed through the water, knots. SOG minus this is the current. */
    stwKts: number | null;
    /** Heading, degrees. COG minus this is the leeway and set. */
    hdgDeg: number | null;
    /** Sea temperature, °C — cheap, and it finds the eddies. */
    waterTempC: number | null;
    /** Barometric pressure, hPa. Serene Summer's MDA carries empty pressure
     *  fields, so this is null on her bus; other boats report it. */
    pressureHpa: number | null;
    /** Heel, degrees, signed to port. */
    heelDeg: number | null;
}

export interface TrackPoint extends TrackFix {
    gpsTimeMs: number;
    reason: TrackReason;
}

export type TrackReason = 'first' | 'distance' | 'course' | 'heartbeat' | 'stop-end';

export interface TrackRules {
    /** Log once the boat has moved this far from the last logged point. */
    minDistanceM: number;
    /** Log once the course has swung this far from the last logged point. */
    courseChangeDeg: number;
    /** Log at least this often while under way, so a long straight leg still
     *  carries timestamps you can navigate the log by. */
    heartbeatMs: number;
    /** At or below this speed the boat is treated as stopped. */
    stationarySpeedKts: number;
    /** ...and within this distance of where the stop began. Speed alone is not
     *  enough: a boat drifting at 0.2 kt for six hours has gone a mile. */
    stationaryRadiusM: number;
}

export const DEFAULT_TRACK_RULES: TrackRules = {
    minDistanceM: 30,
    courseChangeDeg: 20,
    heartbeatMs: 60_000,
    stationarySpeedKts: 0.3,
    stationaryRadiusM: 25,
};

/**
 * Smallest angle between two courses, in degrees.
 *
 * Across north the naive difference lies: 359° to 001° is a two-degree nudge,
 * not a 358° turn. Getting this wrong would log a point on every wave while
 * the boat steers north, and none at all as it swings through south.
 *
 * The first version of this was inverted — it returned 180 for two IDENTICAL
 * courses and 0 for opposite ones. A boat holding a dead straight course would
 * have logged a turn on every single fix, which is the runaway the store's
 * size cap exists to bound. Caught by the test below, which is why that test
 * asserts the boring case (90 against 90) as well as the interesting one.
 */
export function courseDeltaDeg(a: number, b: number): number {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
}

/** Is this fix worth keeping, given the last one we kept? */
export function logReason(
    last: TrackPoint | null,
    fix: TrackFix,
    rules: TrackRules = DEFAULT_TRACK_RULES,
): TrackReason | null {
    if (fix.gpsTimeMs === null) return null;
    if (!last) return 'first';

    if (distanceMetres(last.lat, last.lon, fix.lat, fix.lon) >= rules.minDistanceM) return 'distance';

    if (
        last.cogDeg !== null &&
        fix.cogDeg !== null &&
        courseDeltaDeg(last.cogDeg, fix.cogDeg) >= rules.courseChangeDeg
    ) {
        return 'course';
    }

    if (fix.gpsTimeMs - last.gpsTimeMs >= rules.heartbeatMs) return 'heartbeat';
    return null;
}

/** Is the boat stopped, relative to where this stop began? */
export function isStationary(
    stopAnchor: { lat: number; lon: number } | null,
    fix: TrackFix,
    rules: TrackRules = DEFAULT_TRACK_RULES,
): boolean {
    if (fix.sogKts === null || fix.sogKts > rules.stationarySpeedKts) return false;
    if (!stopAnchor) return true;
    return distanceMetres(stopAnchor.lat, stopAnchor.lon, fix.lat, fix.lon) <= rules.stationaryRadiusM;
}

/**
 * The recorder's decision, kept pure so the whole policy can be tested without
 * a database, a socket or a clock.
 *
 * Returns the points to append (0, 1 or 2) and the next state. Two happen when
 * a stop ends: the last fix OF the stop is flushed first so the log says how
 * long the boat sat there, then the fix that broke it.
 */
export interface RecorderState {
    last: TrackPoint | null;
    /** Where the current stop began, and the most recent fix within it. */
    stopAnchor: { lat: number; lon: number } | null;
    stopLatest: TrackFix | null;
}

export const EMPTY_STATE: RecorderState = { last: null, stopAnchor: null, stopLatest: null };

export function considerFix(
    state: RecorderState,
    fix: TrackFix,
    rules: TrackRules = DEFAULT_TRACK_RULES,
): { append: TrackPoint[]; state: RecorderState } {
    if (fix.gpsTimeMs === null) return { append: [], state };

    /* The very first fix is ALWAYS recorded, even if she is already stopped.
       Without this, switching the recorder on while the boat sits at anchor
       writes nothing at all until she next moves — and a skipper checking
       whether it works sees "0 points", which is indistinguishable from
       broken. It also loses the one fact a long stop has: when it began.
       Found on the boat 2026-08-30, on the hard with SOG reading 0.0. */
    if (!state.last) {
        const opening: TrackPoint = { ...fix, gpsTimeMs: fix.gpsTimeMs, reason: 'first' };
        return { append: [opening], state: { last: opening, stopAnchor: null, stopLatest: null } };
    }

    const stationary = isStationary(state.stopAnchor, fix, rules);

    if (stationary) {
        // Remember it, write nothing. The first fix of a stop was already
        // written by whatever rule was in force when the boat arrived.
        const anchor = state.stopAnchor ?? { lat: fix.lat, lon: fix.lon };
        return { append: [], state: { ...state, stopAnchor: anchor, stopLatest: fix } };
    }

    const append: TrackPoint[] = [];
    let last = state.last;

    // The boat has started moving again. Close the stop with its last fix, so
    // the gap in the track carries a duration rather than being a mystery.
    if (state.stopLatest && state.stopAnchor) {
        const closing = state.stopLatest;
        if (closing.gpsTimeMs !== null && (!last || closing.gpsTimeMs > last.gpsTimeMs)) {
            const point: TrackPoint = { ...closing, gpsTimeMs: closing.gpsTimeMs, reason: 'stop-end' };
            append.push(point);
            last = point;
        }
    }

    const reason = logReason(last, fix, rules);
    if (reason) {
        const point: TrackPoint = { ...fix, gpsTimeMs: fix.gpsTimeMs, reason };
        append.push(point);
        last = point;
    }

    return { append, state: { last, stopAnchor: null, stopLatest: null } };
}
