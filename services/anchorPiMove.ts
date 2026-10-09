/**
 * Moving the mark of a watch the PI keeps (build 126, 126-07a). Pure: no
 * imports but the distance maths.
 *
 * The phone that handed its watch to the boat's Pi sits in Shore Watch, and
 * may move the Pi's anchor mark from there: the Move anchor sheet asks this
 * live, and AnchorPiWatchKeeper.relocate asks it again before anything is
 * sent (the keeper is the authority). ALL must hold:
 *
 *  (a) the Pi's latest fix of the boat is no more than 30 s old;
 *  (b) the Pi reports no alarm: no drag, and no lost GPS;
 *  (c) the boat is inside the swing circle around the NEW point;
 *  (d) the NEW point is within the rode's horizontal reach,
 *      √(rode² − depth²), plus 15 m or the fix accuracy if larger, of where
 *      the Pi's watch was FIRST set. An assignment with no rode or depth (an
 *      older Pi) uses the swing radius instead.
 *
 * (d) stops a mark being walked across the bay behind a slow drag, one move
 * at a time. It is not 125-03's track judgement (anchorLateSet): a phone
 * ashore does not hold her whole track, which is also why a move during the
 * Pi's own alarm stays out.
 *
 * Every comparison is written negated, so a NaN refuses. calculateDistance is
 * a haversine, so a point astride 180° is metres away, not a world.
 */
import { calculateDistance } from '../utils/navigationCalculations';

/** The fix that vouches for a move: no older (or further ahead of this clock) than this. */
export const PI_MOVE_FIX_MAX_AGE_MS = 30_000;
/** The Pi's report shows the point sent when it is within this. */
export const PI_MOVE_MATCH_M = 1;
const SLACK_M = 15;

export interface LatLonPoint {
    latitude: number;
    longitude: number;
}

/** The boat as the Pi last reported her. The Pi sends no accuracy; a phone does. */
export interface PiBoatFix extends LatLonPoint {
    timestamp: number;
    accuracy?: number;
}

/** What Shore Watch hears from the Pi now: the parts of a move only the latest report can vouch for. */
export interface PiMoveLive {
    boatFix: PiBoatFix | null;
    /** The Pi reports a drag alarm (its own flag, or Shore Watch's drag cause). */
    alarm: boolean;
    /** The Pi has lost the boat's GPS. */
    gpsLost: boolean;
}

export interface PiMoveInput extends PiMoveLive {
    now: number;
    /** The new anchor. */
    target: LatLonPoint;
    swingRadiusM: number;
    /** Where the Pi's watch was first set. */
    centreAtSet: LatLonPoint | null;
    rodeLength?: number;
    waterDepth?: number;
}

export type PiMoveRefusal =
    | 'no-fix'
    | 'alarm'
    | 'gps-lost'
    | 'position'
    | 'no-circle'
    | 'outside'
    | 'beyond-rode'
    | 'beyond-circle';

/**
 * A refusal says why in `error`; `lead` is its first sentence, short enough
 * to stay on screen with the keyboard up (the sheet sets the rest aside then).
 */
export type PiMoveVerdict = { ok: true } | { ok: false; refusal: PiMoveRefusal; error: string; lead: string };

const IF_DRAGGING = 'If she is dragging, re-anchor.';
const CHECK_POINT = 'Check where you put the anchor.';
/** Each refusal's first sentence and the rest. */
export const PI_MOVE_REFUSAL_WORDS: Record<PiMoveRefusal, readonly [string, string]> = {
    'no-fix': [
        'The Pi has no recent position for the boat, so the move cannot be checked.',
        'Wait for its next report.',
    ],
    alarm: [
        'The Pi reports a drag alarm, so the anchor cannot be moved from here.',
        `Check her position. ${IF_DRAGGING}`,
    ],
    'gps-lost': ['The Pi has lost the boat’s GPS, so a move cannot be checked.', 'Wait for GPS.'],
    position: ['That is not a real position.', CHECK_POINT],
    'no-circle': ['This watch has no valid swing circle to move.', 'Weigh anchor and set it again.'],
    outside: [
        'The boat would be outside the swing circle around that point.',
        `The alarm would sound at once. ${CHECK_POINT}`,
    ],
    'beyond-rode': ['That point is beyond your rode’s reach from where the watch was set.', IF_DRAGGING],
    'beyond-circle': ['That point is further from where the watch was set than her swing circle reaches.', IF_DRAGGING],
};

const refuse = (refusal: PiMoveRefusal): PiMoveVerdict => {
    const [lead, more] = PI_MOVE_REFUSAL_WORDS[refusal];
    return { ok: false, refusal, error: `${lead} ${more}`, lead };
};

const metres = (a: LatLonPoint, b: LatLonPoint) =>
    calculateDistance(a.latitude, a.longitude, b.latitude, b.longitude) * 1852;

/** Whether a point is on the globe, written so a NaN is not. */
const onGlobe = (p: LatLonPoint | null | undefined): p is LatLonPoint =>
    !!p && p.latitude >= -90 && p.latitude <= 90 && p.longitude >= -180 && p.longitude <= 180;

/**
 * Guard (a) on its own: the Pi's fix of the boat is on the globe and no more
 * than 30 s old (or ahead of this clock). Shore Watch offers Move only while
 * it holds, so the chip and the check go by the same fix.
 */
export function piFixIsFresh(fix: PiBoatFix | null | undefined, now: number): fix is PiBoatFix {
    const age = fix ? now - fix.timestamp : Number.NaN;
    return !!fix && age <= PI_MOVE_FIX_MAX_AGE_MS && age >= -PI_MOVE_FIX_MAX_AGE_MS && onGlobe(fix);
}

/** Whether moving the Pi's mark to `target` is safe to allow. */
export function judgePiMove(input: PiMoveInput): PiMoveVerdict {
    const { now, boatFix: fix, target, swingRadiusM } = input;
    // (a)
    if (!piFixIsFresh(fix, now)) return refuse('no-fix');
    // (b)
    if (input.gpsLost) return refuse('gps-lost');
    if (input.alarm) return refuse('alarm');
    if (!onGlobe(target)) return refuse('position');
    if (!(swingRadiusM > 0)) return refuse('no-circle');
    // (c)
    if (!(metres(fix, target) <= swingRadiusM)) return refuse('outside');
    // (d) From the FIRST centre. With no rode and depth, the circle stands in.
    const { rodeLength, waterDepth } = input;
    const hasRode = rodeLength !== undefined && waterDepth !== undefined;
    const reach = hasRode ? Math.sqrt(Math.max(0, rodeLength ** 2 - waterDepth ** 2)) : swingRadiusM;
    const accuracy = fix.accuracy;
    const slack = Math.max(SLACK_M, typeof accuracy === 'number' && Number.isFinite(accuracy) ? accuracy : 0);
    const fromSet = onGlobe(input.centreAtSet) ? metres(input.centreAtSet, target) : Number.NaN;
    if (!(fromSet <= reach + slack)) return refuse(hasRode ? 'beyond-rode' : 'beyond-circle');
    return { ok: true };
}

/** The Pi's report of its anchor shows `target` (within 1 m). Across 180° too. */
export function piAnchorMatches(anchor: LatLonPoint | null | undefined, target: LatLonPoint): boolean {
    return onGlobe(anchor) && onGlobe(target) && metres(anchor, target) <= PI_MOVE_MATCH_M;
}

/**
 * How a move sent to the Pi went. `invalid`: refused here, nothing sent.
 * `refused`: the Pi answered no, nothing changed. `unknown`: no answer at any
 * address, so the Pi may or may not have taken it.
 */
export type PiMoveResult =
    | { ok: true; ashore: boolean }
    | { ok: false; outcome: 'invalid' | 'refused' | 'unknown'; error: string };

/** The sheet's lines for each outcome, first sentence and the rest. */
export const PI_MOVE_LINES = {
    sent: ['Sent to the Pi…', 'Waiting for its report to show the new point.'],
    moved: ['Moved. The Pi is watching the new point.', ''],
    late: ['The Pi said yes, but hasn’t shown the new point yet.', 'Shore Watch will show which point it is watching.'],
    refused: ['The Pi is still watching the old point.', 'Nothing was moved.'],
    unknown: [
        'The Pi didn’t answer.',
        'It is watching either the old or the new point; Shore Watch will show which within a minute.',
    ],
} as const satisfies Record<string, readonly [string, string]>;

/** The whole of an outcome's line, as the keeper reports it. */
export const piMoveWords = (outcome: 'refused' | 'unknown') => PI_MOVE_LINES[outcome].join(' ');
