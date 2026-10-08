/**
 * Late set or drag? The check behind "Move anchor" on the alarm screen
 * (build 125, package 125-03). Pure: no imports but the distance maths.
 *
 * The watch is armed wherever the GPS is, usually the boat, a rode-length from
 * the hook. A wind shift then swings her round the real anchor and out of a
 * circle centred in the wrong place, and the alarm sounds although nothing
 * has moved. Moving the mark is allowed from the alarm only when ALL hold:
 *
 *  (a) the boat's fix is no more than 30 s old;
 *  (b) the boat is inside the circle around the NEW point;
 *  (c) the NEW point is within the rode's horizontal reach, √(rode² − depth²),
 *      plus 15 m or the fix accuracy if larger, of where the watch was set:
 *      in a late set the real anchor is within reach of the boat as she was;
 *  (d) her track fits a swing round the NEW point:
 *      - this phone saw her without a break for at least the 10 minutes
 *        before the alarm (after a two-minute settle once the watch was set).
 *        A track that starts at an app restart, or breaks for more than two
 *        minutes, does not show how she left the circle, so it cannot back a
 *        move;
 *      - every half-minute of her track lies inside the NEW circle, plus that
 *        half-minute's fix accuracy;
 *      - her distance from the NEW point, taken half a minute at a time over
 *        her WHOLE track, stays inside a 15 m band.
 *
 * Why every half-minute and not her first and last ten minutes. A swing round
 * the real anchor keeps her distance from it; a drag, with the mark put where
 * the anchor now is, carries her towards that point and through or past it,
 * so her distance from it falls and rises again. A window at each end of the
 * track can sit either side of the point at the same distance and miss all of
 * that (the 125-03 review found drags of 35 to 75 m let through that way);
 * the band over every half-minute catches it for any drag that takes half a
 * minute or more to cross. Half-minute means take out a fix's own jitter.
 *
 * Her whole track: SwingTrack keeps one mean fix per half-minute since the
 * watch was set (or since the app last restarted), for up to 24 hours, so a
 * slow creep through a long night stays in view. The 500-point position
 * history behind the trail on screen covers well under an hour.
 *
 * It cannot always tell, and it errs towards refusing. A big change in the
 * wind that shortens or lengthens her lie by more than the band refuses a
 * real late set. A drag across the point in less than half a minute can hide
 * inside one half-minute; the drift watch after the move (stillMovingAfterMove)
 * and the circle itself are what catch her if she keeps going.
 */
import { calculateDistance } from '../utils/navigationCalculations';

/** The fix that vouches for a move: no older than this. */
const FIX_MAX_AGE_MS = 30_000;
/** Right after arming the boat may still be falling back on her rode. */
export const LATE_SET_SETTLE_MS = 120_000;
/** Less unbroken track than this before the alarm is too little to tell. */
export const LATE_SET_MIN_TRAIL_MS = 600_000;
/** A longer break than this in her track and it no longer shows how she moved. */
export const LATE_SET_MAX_GAP_MS = 120_000;
/** Her track is judged in means over this much time. */
export const SWING_BUCKET_MS = 30_000;
/** 24 hours of half-minutes. */
export const SWING_TRACK_MAX_POINTS = 2_880;
const SLACK_M = 15;
/** How far her distance from the new point may wander, half-minute to half-minute. */
export const LATE_SET_BAND_M = 15;
/** After a move: a trailing window, at least a minute of it, and how far her mean may move out. */
const AFTER_MOVE_WINDOW_MS = 300_000;
const AFTER_MOVE_MIN_SPAN_MS = 60_000;
export const AFTER_MOVE_DRIFT_M = 15;
/** The drift watch after a move lasts this long; then the circle alone carries on. */
export const AFTER_MOVE_WATCH_MS = 3_600_000;

/** Why the alarm sounds again after a move: a measurement, not a verdict. */
export const FURTHER_AFTER_MOVE = 'She is further from the anchor than when it was moved.';

export interface LatLonPoint {
    latitude: number;
    longitude: number;
}

export interface TrailFix extends LatLonPoint {
    accuracy: number;
    timestamp: number;
}

export interface LateSetInput {
    now: number;
    /** The boat's latest fix. */
    fix: TrailFix | null;
    /** The new anchor. */
    target: LatLonPoint;
    /** Where the watch was set: its first centre. */
    setAt: LatLonPoint | null;
    watchStartedAt: number | null;
    /** When the alarm went off (now, if unknown). */
    alarmAt: number | null;
    rodeLength: number;
    waterDepth: number;
    swingRadiusM: number;
    /**
     * Her track, oldest first: SwingTrack's half-minute means, or raw fixes
     * (they are put into half-minutes here).
     */
    trail: readonly TrailFix[];
}

export type LateSetRefusal = 'no-fix' | 'outside' | 'beyond-rode' | 'too-early' | 'unseen' | 'off-trail' | 'moving';

/**
 * A refusal says why in `error`; `lead` is its first sentence, short enough
 * to stay on screen with the keyboard up (the Move anchor sheet sets the rest
 * aside then).
 */
export type LateSetVerdict =
    | { ok: true; spreadM: number; lateM: number }
    | { ok: false; refusal: LateSetRefusal; error: string; lead: string };

const IF_DRAGGING = 'If she is dragging, re-anchor.';
const WORDS: Record<Exclude<LateSetRefusal, 'unseen'>, [string, string]> = {
    'no-fix': ['The boat has no recent position fix, so the move cannot be checked.', 'Wait for GPS.'],
    outside: [
        'The boat would be outside the swing circle around that point.',
        'The alarm would go on sounding. Check the distance and bearing.',
    ],
    'beyond-rode': ['That point is beyond your rode’s reach from where the watch was set.', IF_DRAGGING],
    'too-early': [
        'Too early to tell a late set from a drag.',
        `The watch needs 10 minutes of her swing before the alarm. ${IF_DRAGGING}`,
    ],
    'off-trail': ['Her track does not fit a swing round that point.', IF_DRAGGING],
    moving: ['Her distance from that point has been changing, the way a drag does.', IF_DRAGGING],
};

/** What is missing when the phone did not see her for long enough before the alarm. */
const unseenWords = (seenMs: number): [string, string] => [
    `This phone has only ${Math.floor(Math.max(0, seenMs) / 60_000)} min of her track before the alarm.`,
    `It needs 10 to tell a late set from a drag (the app restarted, or fixes stopped). ${IF_DRAGGING}`,
];

const refusal = (refusal: LateSetRefusal, [lead, more]: [string, string]): LateSetVerdict => ({
    ok: false,
    refusal,
    error: `${lead} ${more}`,
    lead,
});

const metres = (a: LatLonPoint, b: LatLonPoint) =>
    calculateDistance(a.latitude, a.longitude, b.latitude, b.longitude) * 1852;

const usable = (p: TrailFix) =>
    Number.isFinite(p.latitude) && Number.isFinite(p.longitude) && Number.isFinite(p.timestamp);

/** A longitude (or a difference of two) taken the short way round, in [-180, 180). */
const shortLon = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

interface OpenBucket {
    index: number;
    n: number;
    lat: number;
    /** Longitudes as offsets from the first, the short way round (a boat astride 180°). */
    dLon: number;
    refLon: number;
    accuracy: number;
}

/**
 * Her track for judging a move: one mean fix per SWING_BUCKET_MS of clock
 * time, oldest first, the last 24 hours of it. The watch adds every fix it
 * uses and clears it only with the watch (a move keeps it: it is her track,
 * not the mark's).
 */
export class SwingTrack {
    private closed: TrailFix[] = [];
    private open: OpenBucket | null = null;

    add(fix: TrailFix): void {
        if (!usable(fix)) return;
        const index = Math.floor(fix.timestamp / SWING_BUCKET_MS);
        // A fix replayed from a half-minute already closed adds nothing.
        if (this.open && index < this.open.index) return;
        if (this.open && index !== this.open.index) this.close();
        const bucket = (this.open ??= { index, n: 0, lat: 0, dLon: 0, refLon: fix.longitude, accuracy: 0 });
        bucket.n += 1;
        bucket.lat += fix.latitude;
        bucket.dLon += shortLon(fix.longitude - bucket.refLon);
        bucket.accuracy += Number.isFinite(fix.accuracy) ? Math.max(0, fix.accuracy) : 0;
    }

    /** The half-minute means so far, the one still filling included. */
    points(): TrailFix[] {
        return this.open ? [...this.closed, mean(this.open)] : [...this.closed];
    }

    clear(): void {
        this.closed = [];
        this.open = null;
    }

    private close(): void {
        if (!this.open) return;
        this.closed.push(mean(this.open));
        if (this.closed.length > SWING_TRACK_MAX_POINTS) {
            this.closed.splice(0, this.closed.length - SWING_TRACK_MAX_POINTS);
        }
        this.open = null;
    }
}

function mean(bucket: OpenBucket): TrailFix {
    return {
        latitude: bucket.lat / bucket.n,
        longitude: shortLon(bucket.refLon + bucket.dLon / bucket.n),
        accuracy: bucket.accuracy / bucket.n,
        timestamp: bucket.index * SWING_BUCKET_MS,
    };
}

/** Whether her track backs moving the mark to `target` from the alarm. */
export function judgeLateSet(input: LateSetInput): LateSetVerdict {
    const refuse = (why: Exclude<LateSetRefusal, 'unseen'>) => refusal(why, WORDS[why]);
    const { fix, target, swingRadiusM, now } = input;

    // (a) Written as negated comparisons so a NaN refuses too.
    if (!fix || !(now - fix.timestamp <= FIX_MAX_AGE_MS)) return refuse('no-fix');
    // (b)
    if (!(metres(fix, target) <= swingRadiusM)) return refuse('outside');
    // (c)
    const reach = Math.sqrt(Math.max(0, input.rodeLength ** 2 - input.waterDepth ** 2));
    const slack = Math.max(SLACK_M, Number.isFinite(fix.accuracy) ? fix.accuracy : 0);
    if (!input.setAt || !(metres(input.setAt, target) <= reach + slack)) return refuse('beyond-rode');

    // (d) Her track in half-minutes, after the settle.
    const track = new SwingTrack();
    for (const p of input.trail) track.add(p);
    const settleEnd = (input.watchStartedAt ?? 0) + LATE_SET_SETTLE_MS;
    const settled = track.points().filter((p) => p.timestamp >= settleEnd);
    const alarmAt = Number.isFinite(input.alarmAt) ? (input.alarmAt as number) : now;
    if (!(alarmAt - settleEnd >= LATE_SET_MIN_TRAIL_MS)) return refuse('too-early');

    // Unbroken back from now, and reaching at least 10 minutes before the alarm.
    let start = settled.length - 1;
    const last = settled[start];
    if (!last || !(now - (last.timestamp + SWING_BUCKET_MS) <= LATE_SET_MAX_GAP_MS)) {
        return refusal('unseen', unseenWords(0));
    }
    while (start > 0 && settled[start].timestamp - settled[start - 1].timestamp <= LATE_SET_MAX_GAP_MS) start -= 1;
    const seenMs = alarmAt - settled[start].timestamp;
    if (!(seenMs >= LATE_SET_MIN_TRAIL_MS)) return refusal('unseen', unseenWords(seenMs));

    let nearM = Infinity;
    let farM = -Infinity;
    let lateSum = 0;
    let lateCount = 0;
    for (const p of settled) {
        const d = metres(p, target);
        if (!(d <= swingRadiusM + p.accuracy)) return refuse('off-trail');
        nearM = Math.min(nearM, d);
        farM = Math.max(farM, d);
        if (p.timestamp >= last.timestamp - AFTER_MOVE_WINDOW_MS) {
            lateSum += d;
            lateCount += 1;
        }
    }
    const spreadM = farM - nearM;
    if (!(spreadM <= LATE_SET_BAND_M)) return refuse('moving');
    return { ok: true, spreadM, lateM: lateSum / lateCount };
}

/**
 * After an accepted move: is she further from the new mark than she was? Her
 * mean distance from it over the last five minutes (fixes since the move only,
 * and at least a minute of them) against `baselineM`, her mean distance from
 * it just before the move. A swing round the mark keeps that distance; a drag
 * that carries on grows it, and this speaks before the circle does wherever
 * the circle is wider than her lie. It watches for AFTER_MOVE_WATCH_MS only:
 * hours later a stronger wind lengthening her lie is not a drag.
 */
export function stillMovingAfterMove(
    trail: readonly TrailFix[],
    anchor: LatLonPoint,
    movedAt: number,
    baselineM: number,
    now: number,
): boolean {
    if (!(now - movedAt <= AFTER_MOVE_WATCH_MS)) return false;
    const from = Math.max(movedAt, now - AFTER_MOVE_WINDOW_MS);
    const recent = trail.filter((p) => usable(p) && p.timestamp >= from);
    if (recent.length < 5 || recent[recent.length - 1].timestamp - recent[0].timestamp < AFTER_MOVE_MIN_SPAN_MS) {
        return false;
    }
    const meanM = recent.reduce((sum, p) => sum + metres(p, anchor), 0) / recent.length;
    return meanM - baselineM > AFTER_MOVE_DRIFT_M;
}
