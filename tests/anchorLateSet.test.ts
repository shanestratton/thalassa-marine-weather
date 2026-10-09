/**
 * Late set or drag? The check behind "Move anchor" on the alarm screen
 * (build 125, package 125-03).
 *
 * The watch is armed wherever the GPS is, usually the boat, a rode-length from
 * the hook. A wind shift then swings her round the real anchor, out of a
 * circle centred in the wrong place, and the alarm sounds although nothing has
 * moved. The skipper may move the mark from the alarm, but only when her own
 * swing track backs it up:
 *
 *  (a) a boat fix no more than 30 s old;
 *  (b) the boat inside the circle around the NEW point;
 *  (c) the NEW point within the rode's reach (plus 15 m, or the fix accuracy
 *      if larger) of where the watch was set;
 *  (d) the 10 minutes before the alarm seen without a break, every
 *      half-minute of her track inside the NEW circle (plus its accuracy), and
 *      her distance from the NEW point, half a minute at a time over her WHOLE
 *      track, inside a 15 m band.
 *
 * A swing round the real anchor keeps her distance from it; a drag, with the
 * mark put where the anchor now is, carries her towards that point and past
 * it. The first and last ten minutes alone can sit either side of the point at
 * the same distance (the 125-03 review: drags of 35 to 75 m got through that
 * way), so the band is held over every half-minute.
 *
 * The app cannot always tell; these are the cases it can. Worldwide fixtures:
 * Bequia (west longitudes), Phang Nga Bay, Fiji across 180°, the Saronic Gulf.
 */
import { describe, expect, it } from 'vitest';
import { calculateDistance, destinationPoint } from '../utils/navigationCalculations';
import {
    AFTER_MOVE_DRIFT_M,
    AFTER_MOVE_WATCH_MS,
    LATE_SET_MIN_TRAIL_MS,
    LATE_SET_SETTLE_MS,
    SWING_BUCKET_MS,
    SWING_TRACK_MAX_POINTS,
    SwingTrack,
    judgeLateSet,
    stillMovingAfterMove,
    type LateSetInput,
    type TrailFix,
} from '../services/anchorLateSet';

type LatLon = { latitude: number; longitude: number };

const MIN = 60_000;
const STEP = 4_000;
const toward = (from: LatLon, bearingDeg: number, metres: number): LatLon => {
    const p = destinationPoint(from.latitude, from.longitude, bearingDeg, metres / 1852);
    return { latitude: p.lat, longitude: p.lon };
};
const metres = (a: LatLon, b: LatLon) => calculateDistance(a.latitude, a.longitude, b.latitude, b.longitude) * 1852;

/** Fixes every `step` ms from `startMs` for `durationMs`, at where(fraction of the leg). */
function leg(startMs: number, durationMs: number, where: (f: number) => LatLon, accuracy = 4, step = STEP) {
    const out: TrailFix[] = [];
    for (let t = 0; t <= durationMs; t += step) {
        out.push({ ...where(durationMs ? t / durationMs : 1), accuracy, timestamp: startMs + t });
    }
    return out;
}

/** A chain rode as the watch draws it: she lies 85% of the reach off, the circle a margin beyond. */
function chain(rodeLength: number, waterDepth: number, margin: number) {
    const reach = Math.sqrt(rodeLength ** 2 - waterDepth ** 2);
    const lie = reach * 0.85;
    return { rodeLength, waterDepth, reach, lie, radius: Math.max(lie + margin, 20) };
}

// 40 m of chain in 8 m: a 39.2 m reach; she lies 33.3 m off, in a 43.3 m circle.
const RODE = { rodeLength: 40, waterDepth: 8 };
const L = Math.sqrt(40 ** 2 - 8 ** 2) * 0.85;
const RADIUS = L + 10;

const T0 = Date.parse('2026-10-09T03:00:00Z');

/** When the watch would sound: three fixes after she is first outside the circle round `setAt`. */
function alarmTime(trail: readonly TrailFix[], setAt: LatLon, radius: number): number {
    const out = trail.findIndex((p) => metres(p, setAt) > radius);
    expect(out).toBeGreaterThan(-1);
    return trail[Math.min(out + 2, trail.length - 1)].timestamp;
}

/**
 * A late set: the watch armed at the boat (setAt), the anchor 33 m upwind of
 * her (wind from 060°T), then a wind shift of `shiftDeg` over 16 minutes swings
 * her round that anchor. Returns the trail and where things are.
 */
function lateSet(origin: LatLon, shiftDeg = 120) {
    const setAt = origin;
    const anchor = toward(setAt, 60, L);
    const steady = leg(T0, 14 * MIN, (f) => toward(anchor, 240 + 6 * Math.sin(f * 12), L));
    const swing = leg(T0 + 14 * MIN + STEP, 16 * MIN, (f) => toward(anchor, 240 + shiftDeg * f, L));
    const trail = [...steady, ...swing];
    const boat = trail[trail.length - 1];
    return { setAt, anchor, trail, boat, alarmAt: alarmTime(trail, setAt, RADIUS), now: boat.timestamp + 1_000 };
}

function input(over: Partial<LateSetInput> & Pick<LateSetInput, 'trail' | 'target' | 'setAt'>): LateSetInput {
    const fix = over.trail[over.trail.length - 1] ?? null;
    return {
        now: (fix?.timestamp ?? T0) + 1_000,
        fix,
        watchStartedAt: T0,
        alarmAt: null,
        rodeLength: RODE.rodeLength,
        waterDepth: RODE.waterDepth,
        swingRadiusM: RADIUS,
        ...over,
    };
}

/**
 * A drag the watch was armed for at the boat: she holds for `holdMin`, then
 * the anchor drags `dragM` along 240°T over `dragMin` and bites again; she
 * lies there `afterMin` more. The skipper opens Move anchor and the sheet puts
 * the mark at its prefill, her lie up her heading (060°T): where the anchor
 * now really is.
 */
function dragAndBite(
    origin: LatLon,
    rode: ReturnType<typeof chain>,
    { holdMin = 12, dragM, dragMin, afterMin = 0.5, step = STEP }: Record<string, number>,
) {
    const setAt = origin;
    const hold = leg(T0, holdMin * MIN, () => setAt, 4, step);
    const drag = leg(T0 + holdMin * MIN + step, dragMin * MIN, (f) => toward(setAt, 240, dragM * f), 4, step);
    const end = toward(setAt, 240, dragM);
    const after = leg(T0 + (holdMin + dragMin) * MIN + step, afterMin * MIN, () => end, 4, step);
    const trail = [...hold, ...drag, ...after];
    const boat = trail[trail.length - 1];
    const target = toward(boat, 60, rode.lie);
    return judgeLateSet(
        input({
            trail,
            target,
            setAt,
            alarmAt: alarmTime(trail, setAt, rode.radius),
            swingRadiusM: rode.radius,
            rodeLength: rode.rodeLength,
            waterDepth: rode.waterDepth,
        }),
    );
}

describe('judgeLateSet: what a late set looks like', () => {
    // Admiralty Bay, Bequia: west of Greenwich.
    const bequia = { latitude: 13.005, longitude: -61.245 };

    it('accepts a 120° wind shift that swung her round the real anchor and out of a misplaced circle', () => {
        const { setAt, anchor, trail, boat, alarmAt } = lateSet(bequia);
        // She really is outside the circle the watch drew round where it was armed.
        expect(metres(boat, setAt)).toBeGreaterThan(RADIUS);
        const verdict = judgeLateSet(input({ trail, target: anchor, setAt, alarmAt }));
        expect(verdict).toMatchObject({ ok: true });
        if (!verdict.ok) return;
        // She kept her distance from the real anchor all the way round.
        expect(verdict.spreadM).toBeLessThan(1);
        expect(verdict.lateM).toBeCloseTo(L, 0);
    });

    it('measures from the new point, not her centroid, which a swing moves by more than a lying distance', () => {
        // Why (d) is not the literal "centroid moved < 15 m": in this, the case
        // the feature exists for, the centroid of her last ten minutes is over
        // 30 m from that of her first ten. Her distance from the anchor is not.
        const { setAt, anchor, trail, alarmAt } = lateSet(bequia);
        const centroid = (points: TrailFix[]) => ({
            latitude: points.reduce((s, p) => s + p.latitude, 0) / points.length,
            longitude: points.reduce((s, p) => s + p.longitude, 0) / points.length,
        });
        const settled = trail.filter((p) => p.timestamp >= T0 + LATE_SET_SETTLE_MS);
        const first = settled.filter((p) => p.timestamp <= settled[0].timestamp + 10 * MIN);
        const last = settled.filter((p) => p.timestamp >= settled[settled.length - 1].timestamp - 10 * MIN);
        expect(metres(centroid(first), centroid(last))).toBeGreaterThan(30);
        expect(judgeLateSet(input({ trail, target: anchor, setAt, alarmAt })).ok).toBe(true);
    });

    it('allows a mark a few metres off the real anchor (a skipper estimates it)', () => {
        const { setAt, anchor, trail, alarmAt } = lateSet(bequia);
        expect(judgeLateSet(input({ trail, target: toward(anchor, 150, 4), setAt, alarmAt })).ok).toBe(true);
        expect(judgeLateSet(input({ trail, target: toward(anchor, 330, 6), setAt, alarmAt })).ok).toBe(true);
    });

    it('allows a real boat: horsing on her chain and GPS jitter, over an hour and a half', () => {
        // Phone GPS wanders a few metres; she sails up and falls back, her lie
        // 4 m longer and shorter on a two-minute beat. Then the wind backs 120°.
        const setAt = { latitude: 8.276, longitude: 98.5 };
        const anchor = toward(setAt, 60, L);
        const noise = (t: number) =>
            toward({ latitude: 0, longitude: 0 }, (t * 137) % 360, 2.5 * Math.abs(Math.sin(t)));
        const at = (bearing: number, f: number, minutes: number) => {
            const t = f * minutes * 60;
            const p = toward(anchor, bearing + 25 * Math.sin(t / 50), L + 4 * Math.sin((2 * Math.PI * t) / 120));
            const n = noise(t);
            return { latitude: p.latitude + n.latitude, longitude: p.longitude + n.longitude };
        };
        const steady = leg(T0, 80 * MIN, (f) => at(240, f, 80));
        const swing = leg(T0 + 80 * MIN + STEP, 16 * MIN, (f) => at(240 + 120 * f, f, 16));
        const trail = [...steady, ...swing];
        const verdict = judgeLateSet(input({ trail, target: anchor, setAt, alarmAt: alarmTime(trail, setAt, RADIUS) }));
        expect(verdict).toMatchObject({ ok: true });
    });

    it('works across 180°: Taveuni, Fiji, where the antimeridian runs through the anchorage', () => {
        // Armed 21 m west of 180°; the anchor is east of it, at -179.99..°.
        const { setAt, anchor, trail, boat, alarmAt } = lateSet({ latitude: -16.85, longitude: 179.9998 });
        expect(anchor.longitude).toBeLessThan(-179.99);
        expect(trail.some((p) => p.longitude > 0) && trail.some((p) => p.longitude < 0)).toBe(true);
        expect(metres(boat, anchor)).toBeCloseTo(L, 1);
        expect(judgeLateSet(input({ trail, target: anchor, setAt, alarmAt }))).toMatchObject({ ok: true });
    });
});

describe('judgeLateSet: drags it refuses, with the mark put where the anchor now is', () => {
    // Phang Nga Bay, Thailand.
    const phangNga = { latitude: 8.276, longitude: 98.5 };

    it('a slow drag smaller than the rode reach', () => {
        // 50 m of chain in 10 m, a 5 m margin: a 49 m reach, 41.6 m lie, 46.6 m
        // circle. Armed at the boat; then the anchor drags downwind at 3 m/min.
        // The alarm sounds at 46.6 m of drag, less than the rode's reach, so
        // the new point is still within reach of where the watch was set and
        // guard (c) alone would pass it.
        const rode = chain(50, 10, 5);
        const setAt = phangNga;
        const steady = leg(T0, 12 * MIN, (f) => toward(setAt, 240, 1.5 * Math.sin(f * 9)));
        const dragMin = rode.radius / 3;
        const drag = leg(T0 + 12 * MIN + STEP, dragMin * MIN, (f) => toward(setAt, 240, 3 * dragMin * f));
        const trail = [...steady, ...drag];
        const boat = trail[trail.length - 1];
        expect(metres(boat, setAt)).toBeGreaterThan(rode.radius - 0.5);
        expect(metres(boat, setAt)).toBeLessThan(rode.reach);
        const judge = (target: LatLon) =>
            judgeLateSet(
                input({
                    trail,
                    target,
                    setAt,
                    alarmAt: boat.timestamp,
                    swingRadiusM: rode.radius,
                    rodeLength: rode.rodeLength,
                    waterDepth: rode.waterDepth,
                }),
            );
        // Where the sheet would put it: the lie, up the boat's heading.
        const target = toward(boat, 60, rode.lie);
        expect(metres(target, setAt)).toBeLessThan(rode.reach + 15);
        const verdict = judge(target);
        expect(verdict).toMatchObject({ ok: false, refusal: 'moving' });
        expect(!verdict.ok && verdict.error).toMatch(/drag/i);
        // Nor anywhere the skipper might type instead, short of her lie: the
        // ends of her track sit either side of those points at much the same
        // distance, which is how they got through when only the ends counted.
        for (let typed = 20; typed <= 38; typed += 3) {
            expect(judge(toward(boat, 60, typed))).toMatchObject({ ok: false });
        }
    });

    it.each([
        ['the app’s default rode: 30 m of chain in 5 m, a 10 m margin', chain(30, 5, 10), 3],
        ['35 m of chain in 6 m', chain(35, 6, 10), 3],
        ['25 m of chain in 4 m, at 3 m/min', chain(25, 4, 10), 3],
        ['25 m of chain in 4 m, at 1 m/min', chain(25, 4, 10), 1],
        ['40 m of chain in 8 m, a 10 m margin', chain(40, 8, 10), 3],
    ])('a steady drag out of the circle on %s', (_name, rode, perMin) => {
        // Armed at the boat; she holds 12 minutes, then drags at `perMin` until
        // she is one circle radius from where it was set (the alarm).
        const dragM = rode.radius + 1;
        const verdict = dragAndBite(phangNga, rode, { dragM, dragMin: dragM / perMin, afterMin: 0 });
        expect(verdict).toMatchObject({ ok: false, refusal: 'moving' });
    });

    it.each([55, 66, 75])(
        'a squall drags her %i m in one to five minutes off Fiji and the anchor bites again',
        (dragM) => {
            // 40 m of chain in 8 m: a 33.3 m lie, a 43.3 m circle. 66 m is twice
            // her lie: the mark is where the drag's start and end are the SAME
            // distance from it, so only the half-minutes in between give it away.
            const fiji = { latitude: -17.6, longitude: 177.4 };
            const rode = chain(40, 8, 10);
            for (const dragMin of [1, 2, 5]) {
                for (const afterMin of [0.5, 2, 8]) {
                    const verdict = dragAndBite(fiji, rode, { holdMin: 14, dragM, dragMin, afterMin });
                    expect({ dragMin, afterMin, verdict }).toMatchObject({
                        dragMin,
                        afterMin,
                        verdict: { ok: false, refusal: 'moving' },
                    });
                }
            }
        },
    );

    it('a slow creep through a long night, too slow for the start and end of the last hour to show it', () => {
        // 50 m of chain in 10 m, a 5 m margin. She lies settled for 90 minutes,
        // then creeps at 0.5 m/min, fixes each second, until she leaves the
        // circle. Her last hour alone moved her less than the band; her whole
        // track since the watch was set does not fit.
        const rode = chain(50, 10, 5);
        const dragM = rode.radius + 1;
        const verdict = dragAndBite(phangNga, rode, {
            holdMin: 90,
            dragM,
            dragMin: dragM / 0.5,
            afterMin: 0,
            step: 1_000,
        });
        expect(verdict).toMatchObject({ ok: false, refusal: 'moving' });
    });

    it('the mark moved onto the boat after a drag', () => {
        const setAt = phangNga;
        const rode = chain(50, 10, 5);
        const steady = leg(T0, 12 * MIN, () => setAt);
        const drag = leg(T0 + 12 * MIN + STEP, 15 * MIN, (f) => toward(setAt, 240, 45 * f));
        const trail = [...steady, ...drag];
        const boat = trail[trail.length - 1];
        const verdict = judgeLateSet(
            input({ trail, target: boat, setAt, swingRadiusM: rode.radius, rodeLength: 50, waterDepth: 10 }),
        );
        expect(verdict).toMatchObject({ ok: false, refusal: 'moving' });
    });

    it('a real drag: the new point is further from where the watch was set than the rode can reach', () => {
        const setAt = phangNga;
        const steady = leg(T0, 12 * MIN, () => setAt);
        const drag = leg(T0 + 12 * MIN + STEP, 10 * MIN, (f) => toward(setAt, 240, 150 * f));
        const trail = [...steady, ...drag];
        const boat = trail[trail.length - 1];
        for (const target of [toward(boat, 60, L), boat]) {
            const verdict = judgeLateSet(input({ trail, target, setAt }));
            expect(verdict).toMatchObject({ ok: false, refusal: 'beyond-rode' });
            expect(!verdict.ok && verdict.error).toMatch(/re-anchor/i);
        }
    });
});

describe('judgeLateSet: what else it refuses', () => {
    const phangNga = { latitude: 8.276, longitude: 98.5 };

    it('measures the rode reach with 15 m of slack, or the fix accuracy where that is larger', () => {
        const setAt = phangNga;
        const reach = Math.sqrt(40 ** 2 - 8 ** 2);
        // A boat holding still with an anchor-sized circle round her: only (c) is in question.
        const near = (accuracy: number, target: LatLon) =>
            judgeLateSet(
                input({
                    trail: leg(T0, 20 * MIN, () => toward(target, 0, 30), accuracy),
                    target,
                    setAt,
                }),
            );
        expect(near(4, toward(setAt, 90, reach + 14)).ok).toBe(true);
        expect(near(4, toward(setAt, 90, reach + 16))).toMatchObject({ ok: false, refusal: 'beyond-rode' });
        expect(near(25, toward(setAt, 90, reach + 24)).ok).toBe(true);
    });

    it('under 10 minutes of the watch before the alarm: too early to tell a late set from a drag', () => {
        const setAt = phangNga;
        const anchor = toward(setAt, 60, L);
        // A fast swing 9 minutes after arming. The first two minutes are the settle.
        const trail = leg(T0, 9 * MIN, (f) => toward(anchor, 240 + 130 * f, L));
        expect(9 * MIN - LATE_SET_SETTLE_MS).toBeLessThan(LATE_SET_MIN_TRAIL_MS);
        const verdict = judgeLateSet(input({ trail, target: anchor, setAt, alarmAt: T0 + 9 * MIN }));
        expect(verdict).toMatchObject({ ok: false, refusal: 'too-early' });
        expect(!verdict.ok && verdict.error).toMatch(/too early to tell a late set from a drag/i);
        expect(!verdict.ok && verdict.error).toMatch(/before the alarm/i);
        // Twelve and a half minutes is enough.
        const longer = leg(T0, 12.5 * MIN, (f) => toward(anchor, 240 + 130 * f, L));
        expect(judgeLateSet(input({ trail: longer, target: anchor, setAt, alarmAt: T0 + 12.5 * MIN })).ok).toBe(true);
        // But not when the alarm itself came early: what she did after it is not how she left.
        expect(judgeLateSet(input({ trail: longer, target: anchor, setAt, alarmAt: T0 + 9 * MIN }))).toMatchObject({
            ok: false,
            refusal: 'too-early',
        });
    });

    it('a track that starts at an app restart: it did not see how she left the circle', () => {
        // Set at dusk; the app restarted at 02:55 (the track starts again), and
        // the alarm sounded at 02:56. Twelve minutes of steady track since then
        // say nothing about how she got there.
        const { setAt, anchor } = lateSet(phangNga);
        const restartAt = T0 + 8 * 60 * MIN;
        const trail = leg(restartAt, 13 * MIN, () => toward(anchor, 0, L));
        const verdict = judgeLateSet(input({ trail, target: anchor, setAt, alarmAt: restartAt + MIN }));
        expect(verdict).toMatchObject({ ok: false, refusal: 'unseen' });
        expect(!verdict.ok && verdict.error).toMatch(/only 1 min of her track before the alarm/i);
        expect(!verdict.ok && verdict.error).toMatch(/the app restarted/i);
        expect(!verdict.ok && verdict.error).toMatch(/re-anchor/i);
        // An alarm that went off before the restart: none of it.
        const before = judgeLateSet(input({ trail, target: anchor, setAt, alarmAt: restartAt - 30 * MIN }));
        expect(before).toMatchObject({ ok: false, refusal: 'unseen' });
        expect(!before.ok && before.error).toMatch(/only 0 min/i);
        // Once the phone has seen ten minutes before the alarm, it can judge.
        expect(judgeLateSet(input({ trail, target: anchor, setAt, alarmAt: restartAt + 11 * MIN })).ok).toBe(true);
    });

    it('a track with a break: the app asleep two hours, then 20 s of fixes well away', () => {
        // The app's default rode (30 m of chain in 5 m, a 10 m margin). Half an
        // hour seen, two hours of nothing, then she is 50 m from where it was set.
        const rode = chain(30, 5, 10);
        const setAt = phangNga;
        const seen = leg(T0, 30 * MIN, () => setAt);
        const wake = T0 + 150 * MIN;
        const away = toward(setAt, 240, 50);
        const trail = [...seen, ...leg(wake, 20_000, () => away)];
        const target = toward(away, 60, rode.lie);
        const verdict = judgeLateSet(
            input({
                trail,
                target,
                setAt,
                alarmAt: wake + 8_000,
                swingRadiusM: rode.radius,
                rodeLength: rode.rodeLength,
                waterDepth: rode.waterDepth,
            }),
        );
        expect(verdict).toMatchObject({ ok: false, refusal: 'unseen' });
        expect(!verdict.ok && verdict.error).toMatch(/fixes stopped/i);
    });

    it('a stale fix, or none at all, cannot vouch for the move', () => {
        const { setAt, anchor, trail, boat, alarmAt } = lateSet(phangNga);
        expect(judgeLateSet(input({ trail, target: anchor, setAt, alarmAt, fix: null }))).toMatchObject({
            ok: false,
            refusal: 'no-fix',
        });
        expect(
            judgeLateSet(input({ trail, target: anchor, setAt, alarmAt, now: boat.timestamp + 30_001 })),
        ).toMatchObject({
            ok: false,
            refusal: 'no-fix',
        });
        expect(judgeLateSet(input({ trail, target: anchor, setAt, alarmAt, now: boat.timestamp + 30_000 })).ok).toBe(
            true,
        );
    });

    it('a point that leaves the boat outside its circle', () => {
        const { setAt, trail, boat, alarmAt } = lateSet(phangNga);
        const verdict = judgeLateSet(input({ trail, target: toward(boat, 60, RADIUS + 1), setAt, alarmAt }));
        // In words for any way the point was given: no bearing field on the Position tab.
        expect(verdict).toMatchObject({
            ok: false,
            refusal: 'outside',
            error: expect.stringMatching(/Check where you put the anchor\.$/),
        });
    });

    it('a track that leaves the new circle, allowing each half-minute its own accuracy', () => {
        const { setAt, anchor, trail, alarmAt } = lateSet(phangNga);
        // Two minutes 10 m outside the new circle, reported at ±4 m: off the track.
        const from = trail[200].timestamp;
        const strayed = (accuracy: number, start = from) =>
            trail.map((p) =>
                p.timestamp >= start && p.timestamp < start + 2 * MIN
                    ? { ...toward(anchor, 200, RADIUS + 10), accuracy, timestamp: p.timestamp }
                    : p,
            );
        const verdict = judgeLateSet(input({ trail: strayed(4), target: anchor, setAt, alarmAt }));
        expect(verdict).toMatchObject({ ok: false, refusal: 'off-trail' });
        expect(!verdict.ok && verdict.error).toMatch(/her track does not fit a swing round that point/i);
        // One stray fix is GPS jitter, and the half-minute's mean absorbs it.
        const once = [...trail.slice(0, 200), { ...toward(anchor, 200, RADIUS + 10), accuracy: 4, timestamp: from }];
        expect(judgeLateSet(input({ trail: [...once, ...trail.slice(201)], target: anchor, setAt, alarmAt })).ok).toBe(
            true,
        );
        // Strays inside the settle are not held against her.
        expect(judgeLateSet(input({ trail: strayed(4, T0), target: anchor, setAt, alarmAt })).ok).toBe(true);
    });
});

describe('SwingTrack: her track in half-minutes', () => {
    it('keeps one mean fix per half-minute, the one still filling included', () => {
        const track = new SwingTrack();
        const at = { latitude: 37.9, longitude: 23.0 };
        const start = Math.ceil(T0 / SWING_BUCKET_MS) * SWING_BUCKET_MS;
        for (const p of leg(start, 75_000, (f) => toward(at, 90, 30 * f), 6, 3_000)) track.add(p);
        const points = track.points();
        expect(points.map((p) => p.timestamp)).toEqual([start, start + 30_000, start + 60_000]);
        expect(metres(points[0], at)).toBeCloseTo(5.4, 0);
        expect(points[0].accuracy).toBe(6);
        // A fix replayed from a half-minute already closed adds nothing.
        track.add({ ...at, accuracy: 6, timestamp: start + 1_000 });
        expect(track.points()).toEqual(points);
        track.clear();
        expect(track.points()).toEqual([]);
    });

    it('averages a boat astride 180° where she is, not at 0°', () => {
        const track = new SwingTrack();
        const taveuni = { latitude: -16.85, longitude: 179.99999 };
        for (const p of leg(T0, 20_000, (f) => toward(taveuni, (f * 720) % 360, 6), 4, 1_000)) track.add(p);
        for (const p of track.points()) {
            expect(Math.abs(p.longitude)).toBeGreaterThan(179.99);
            expect(metres(p, taveuni)).toBeLessThan(6);
        }
    });

    it('holds 24 hours of it', () => {
        const track = new SwingTrack();
        const at = { latitude: 13.005, longitude: -61.245 };
        for (let i = 0; i < SWING_TRACK_MAX_POINTS + 10; i += 1) {
            track.add({ ...at, accuracy: 4, timestamp: T0 + i * SWING_BUCKET_MS });
        }
        expect(track.points()).toHaveLength(SWING_TRACK_MAX_POINTS + 1);
        expect(SWING_TRACK_MAX_POINTS * SWING_BUCKET_MS).toBe(24 * 60 * MIN);
    });
});

describe('stillMovingAfterMove: the drift watch after an accepted move', () => {
    const anchor = { latitude: 37.9, longitude: 23.0 }; // Saronic Gulf
    const movedAt = T0 + 30 * MIN;

    it('a boat still swinging round the new anchor is not moving', () => {
        const trail = leg(movedAt, 6 * MIN, (f) => toward(anchor, 240 + 90 * f, 30));
        expect(stillMovingAfterMove(trail, anchor, movedAt, 30, movedAt + 6 * MIN)).toBe(false);
    });

    it('a boat whose distance from the new anchor keeps growing is', () => {
        const trail = leg(movedAt, 10 * MIN, (f) => toward(anchor, 240, 30 + 40 * f));
        expect(stillMovingAfterMove(trail, anchor, movedAt, 30, movedAt + 10 * MIN)).toBe(true);
        // Not on less than the threshold.
        const slight = leg(movedAt, 10 * MIN, (f) => toward(anchor, 240, 30 + (AFTER_MOVE_DRIFT_M - 2) * f));
        expect(stillMovingAfterMove(slight, anchor, movedAt, 30, movedAt + 10 * MIN)).toBe(false);
    });

    it('waits for a minute of fixes after the move, and ignores the trail before it', () => {
        const before = leg(movedAt - 10 * MIN, 10 * MIN - STEP, () => toward(anchor, 240, 80));
        const after = leg(movedAt, 50_000, () => toward(anchor, 240, 30));
        expect(stillMovingAfterMove([...before, ...after], anchor, movedAt, 30, movedAt + 50_000)).toBe(false);
        const far = leg(movedAt, 50_000, () => toward(anchor, 240, 70));
        expect(stillMovingAfterMove([...before, ...far], anchor, movedAt, 30, movedAt + 50_000)).toBe(false);
        const farLonger = leg(movedAt, 70_000, () => toward(anchor, 240, 70));
        expect(stillMovingAfterMove(farLonger, anchor, movedAt, 30, movedAt + 70_000)).toBe(true);
    });

    it('ends after an hour: by then a longer lie in a stronger wind is not a drag', () => {
        // 50 m of rope in 10 m: moved at 01:00 in light air with her 28 m off;
        // a front at 05:00 lies her out to 49 m, inside the circle.
        const later = movedAt + 4 * 60 * MIN;
        const front = leg(later - 6 * MIN, 6 * MIN, () => toward(anchor, 240, 49));
        expect(stillMovingAfterMove(front, anchor, movedAt, 28, later)).toBe(false);
        // The same lengthening inside the hour still speaks.
        const soon = movedAt + AFTER_MOVE_WATCH_MS - MIN;
        const early = leg(soon - 6 * MIN, 6 * MIN, () => toward(anchor, 240, 49));
        expect(stillMovingAfterMove(early, anchor, movedAt, 28, soon)).toBe(true);
    });
});
