/**
 * Plan Your Day's leave window (build 128, 127-PYD-11;
 * services/dayPlanner/leaveWindow.ts): on a routed stop, when to leave to
 * carry the tide over the shallow bits of the routed line, there and back.
 *
 * Shane, 2026-10-10: "we work within the rules, but we need to make it bang
 * claude. better than what we were going to do." The router's shallow runs
 * (in memory on the proposal) become the sweep's spots (inshoreTideSpots),
 * grouped by tide place; each hourly departure of her day is swept every
 * 10 minutes (DepartureSweepInshore) at the speed her polar walk gave that
 * leg; a step is clear only when every group is clear both ways. With no
 * tide it says "Tide not known" and never a time; red the tide cannot lift is
 * always said. Computed in memory only: never stored, never logged.
 *
 * Synthetic only: a straight 10 NM line of 500 vertices due north from Horta
 * (Azores, on UTC in October), synthetic runs, semidiurnal sinusoids, and
 * synthetic hourly departures. Nouméa for the place's own clock.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TideCurve } from '../services/TideHeightService';
import type { ThalassaRouteDisclosure } from '../types/autorouting';
import type { ShallowRunInfo } from '../services/engine/types';
import {
    leaveChosen,
    leaveCurves,
    leaveSpots,
    leaveWindow,
    leaveWords,
    type LeaveDeparture,
} from '../services/dayPlanner/leaveWindow';

const H = 3_600_000;
const MIN = 60_000;
const DAY0 = Date.UTC(2026, 9, 8);
const at = (h: number, m = 0) => DAY0 + h * H + m * MIN;
const HORTA = { lat: 38.53, lon: -28.62 };
const VERTS = 500;
const DRAFT = 2.0;
/** Semidiurnal: 12.42 h. */
const P = 12.42 * H;

type LonLat = [number, number];
const line = (o = HORTA, sign = 1): LonLat[] =>
    Array.from({ length: VERTS }, (_, i) => [o.lon, o.lat + (sign * (10 / 60) * i) / (VERTS - 1)] as LonLat);
const LINE = line();
/** A charted shallow run centred `nm` along the line (its shallowest point there). */
function run(nm: number, minDepthM: number | null, extra: Partial<ShallowRunInfo> = {}, coords = LINE): ShallowRunInfo {
    const i = Math.max(0, Math.min(VERTS - 2, Math.round((nm / 10) * (VERTS - 1))));
    const [lon, lat] = coords[i];
    return {
        startSeg: Math.max(0, i - 3),
        endSeg: Math.min(VERTS - 2, i + 3),
        lengthM: 300,
        minDepthM,
        midLat: lat,
        midLon: lon,
        minAtLat: lat,
        minAtLon: lon,
        ...extra,
    };
}
/** Needs 0.9 m of tide at a 2.0 m draft + the 0.5 m margin. */
const NEED_09 = DRAFT + 0.5 - 0.9;
function engine(runs: ShallowRunInfo[], over: Partial<ThalassaRouteDisclosure> = {}): ThalassaRouteDisclosure {
    return {
        stateMask: Array.from({ length: VERTS - 1 }, () => 'green' as const),
        shallowRuns: runs,
        cellsUsed: ['OC-99-SYN001'],
        distanceNM: 10,
        elapsedMs: 1,
        backstop: 'verified',
        ...over,
    };
}
function curve(
    o: {
        hwMs?: number;
        meanM?: number;
        ampM?: number;
        periodMs?: number;
        provenance?: TideCurve['provenance'];
        station?: string;
    } = {},
): TideCurve {
    const hw = o.hwMs ?? at(12);
    const from = DAY0 - 2 * 24 * H;
    const to = DAY0 + 4 * 24 * H;
    const period = o.periodMs ?? P;
    const mean = o.meanM ?? 1.5;
    const amp = o.ampM ?? 1.2;
    return {
        heights: [],
        provenance: o.provenance ?? 'STATION_HEIGHTS',
        heightAt: (t) => (t < from || t > to ? null : mean + amp * Math.cos((2 * Math.PI * (t - hw)) / period)),
        rangeMs: [from, to],
        ...(o.station ? { stationName: o.station } : {}),
    };
}
/** Hourly departures, 2 h each way (5 kn over the 10 NM), a 2 h stay. */
function departures(fromH = 7, toH = 16, legMs = 2 * H, stayMs = 2 * H, day = at): LeaveDeparture[] {
    return Array.from({ length: toH - fromH + 1 }, (_, k) => {
        const departureMs = day(fromH + k);
        return {
            departureMs,
            stayEndMs: departureMs + legMs + stayMs,
            out: { durationMs: legMs },
            home: { durationMs: legMs },
        };
    });
}
const NAMES = { zone: 'Atlantic/Azores', start: 'Horta Marina', stop: 'Fixture Cove', day: 'today' };

function windowFor(o: {
    runs: ShallowRunInfo[];
    curves?: (TideCurve | null)[];
    dayTrip?: boolean;
    deps?: LeaveDeparture[];
    earliestMs?: number | null;
    over?: Partial<ThalassaRouteDisclosure>;
    coords?: LonLat[];
}) {
    const coords = o.coords ?? LINE;
    const spots = leaveSpots(coords, engine(o.runs, o.over), DRAFT)!;
    expect(spots).not.toBeNull();
    const result = leaveWindow({
        spots,
        curves: o.curves ?? spots.groups.map(() => curve()),
        departures: o.deps ?? departures(),
        earliestMs: o.earliestMs === undefined ? at(6, 30) : o.earliestMs,
        dayTrip: o.dayTrip ?? false,
        cruiseKts: 5,
    });
    return { spots, result };
}
const near = (ms: number, expected: number, slackMin = 10) =>
    expect(Math.abs(ms - expected)).toBeLessThanOrEqual(slackMin * MIN);
/** The analytic crossings of 1.5 + 1.2 cos for a 0.9 m need: HW ± P/3. */
const UP = at(12) - P / 3;
const DOWN = at(12) + P / 3;
const PAD = 30 * MIN;
/** At 5 kn: minutes to `nm` along the line. */
const tau = (nm: number) => (nm / 5) * H;

afterEach(() => vi.restoreAllMocks());

describe('one shallow bit needing 0.9 m', () => {
    it('the window is the analytic crossings pulled in 30 min, less the run to the spot, to 10 min', () => {
        const { result } = windowFor({ runs: [run(4.2, NEED_09)] });
        expect(result.kind).toBe('window');
        expect(result.windows).toHaveLength(1);
        near(result.windows[0].fromMs, UP + PAD - tau(4.2));
        near(result.windows[0].toMs, DOWN - PAD - tau(4.2));
    });

    it('her leave inside it works; before it is too early; after it too late; the words say so', () => {
        const { result } = windowFor({ runs: [run(4.2, NEED_09)] });
        expect(leaveChosen(result.windows, at(9))).toBe('works');
        expect(leaveChosen(result.windows, at(7))).toBe('too-early');
        expect(leaveChosen(result.windows, at(15))).toBe('too-late');
        const [w] = result.windows;
        const t = (ms: number) => new Date(ms).toISOString().slice(11, 16);
        expect(leaveWords(result, at(9), NAMES).text).toBe(
            `Leave ${t(w.fromMs)}–${t(w.toMs)} to carry the tide over the shallow bit 4.2 NM out; your 09:00 works. Home tomorrow: check its tide in the morning.`,
        );
        expect(leaveWords(result, at(7), NAMES).text).toContain('; your 07:00 is too early for it.');
        expect(leaveWords(result, at(15), NAMES).text).toContain('; your 15:00 is too late for it.');
        // No leave chosen (no forecast): the window without the last clause.
        expect(leaveWords(result, null, NAMES).text).toMatch(/4\.2 NM out\. Home tomorrow/);
    });

    it('a day trip: the way home narrows the window to the intersection, and says "there and back"', () => {
        const { result } = windowFor({ runs: [run(4.2, NEED_09)], dayTrip: true });
        expect(result.kind).toBe('window');
        // Out: as above. Home: 4 h later on the reversed line, 5.8 NM to the spot.
        near(result.windows[0].fromMs, UP + PAD - tau(4.2));
        near(result.windows[0].toMs, DOWN - PAD - 4 * H - tau(5.8));
        expect(result.windows[0].toMs).toBeLessThan(DOWN - PAD - tau(4.2) - H);
        const words = leaveWords(result, at(11), NAMES).text;
        expect(words).toMatch(/over the shallow bit 4\.2 NM out, there and back; your 11:00 is too late for it\.$/);
        expect(words).not.toContain('Home tomorrow');
    });

    it('overnight ignores the way home and adds the morning sentence', () => {
        const overnight = windowFor({ runs: [run(4.2, NEED_09)], dayTrip: false }).result;
        const trip = windowFor({ runs: [run(4.2, NEED_09)], dayTrip: true }).result;
        expect(overnight.windows[0].toMs).toBeGreaterThan(trip.windows[0].toMs);
        expect(leaveWords(overnight, at(9), NAMES).text).toMatch(/ Home tomorrow: check its tide in the morning\.$/);
        expect(leaveWords(overnight, at(9), NAMES).text).not.toContain('there and back');
    });

    // Review 2026-10-13: the sweep searched each step's tide from its own start, so a crossing a few minutes
    // before a 10 min step butted the search and was never padded: the bar out of her marina said 08:00, 18 min
    // inside the pad. Each bit's time there is now judged on the tide around it.
    it('a bar 0.3 NM out of her marina keeps the 30 min pad on the rising tide', () => {
        const { result } = windowFor({ runs: [run(0.3, NEED_09)] });
        near(result.windows[0].fromMs, UP + PAD - tau(0.3));
        expect(leaveWords(result, at(8), NAMES).text).toContain(
            'leaving Horta Marina; your 08:00 is too early for it.',
        );
    });

    it('a bar 0.3 NM short of the stop keeps the pad on the way home of a day trip', () => {
        // Needs 0.4 m (2.1 m charted): below it only 1 h 37 a tide, so her way home after a 3 h stay meets the
        // flood just after it turns. Out at 9.7 NM (1 h 56), home 5 h after she leaves plus 0.3 NM.
        const half = (Math.acos((0.4 - 1.5) / 1.2) / (2 * Math.PI)) * P;
        const flood = at(12) + P - half;
        const { result } = windowFor({
            runs: [run(9.7, DRAFT + 0.5 - 0.4)],
            dayTrip: true,
            deps: departures(5, 16, 2 * H, 3 * H),
            earliestMs: at(4, 30),
        });
        expect(result.windows).toHaveLength(2);
        near(result.windows[1].fromMs, flood + PAD - 5 * H - tau(0.3));
        near(result.windows[1].toMs, at(12) + half - PAD - tau(9.7));
    });
});

describe('more than one tide place', () => {
    // 2 NM out is in the 38.5° tide bucket, 8 NM out in the 38.75° one.
    const A = run(2, NEED_09);
    const B = run(8, NEED_09);
    const curveA = curve({ hwMs: at(12), station: 'Fixture Gauge A' });
    const curveB = curve({ hwMs: at(13), station: 'Fixture Gauge B' });

    it('two groups with phase-shifted curves: the window is the intersection of each', () => {
        const both = windowFor({ runs: [A, B], curves: [curveA, curveB] });
        expect(both.spots.groups).toHaveLength(2);
        const a = windowFor({ runs: [A], curves: [curveA] }).result.windows[0];
        const b = windowFor({ runs: [B], curves: [curveB] }).result.windows[0];
        expect(both.result.windows).toEqual([{ fromMs: Math.max(a.fromMs, b.fromMs), toMs: Math.min(a.toMs, b.toMs) }]);
        expect(both.result.stations).toEqual(['Fixture Gauge A', 'Fixture Gauge B']);
        const said = leaveWords(both.result, at(10), NAMES);
        expect(said.text).toContain('the shallow bits 2.0 and 8.0 NM out');
        expect(said.footnote).toBe(
            'Tide from WorldTides (Fixture Gauge A, Fixture Gauge B); check the official tide table.',
        );
    });

    it('a group with no curve: "Tide not known" with what it needs, never a time', () => {
        const { result } = windowFor({ runs: [A, B], curves: [curveA, null] });
        expect(result.kind).toBe('unknown');
        const said = leaveWords(result, at(9), NAMES);
        expect(said.text).toBe(
            'Tide not known for the shallow bit 8.0 NM out (it needs 0.9 m of tide): check the tide table before you go. Home tomorrow: check its tide in the morning.',
        );
        expect(said.text).not.toMatch(/\d\d:\d\d/);
        // No curve at all: every bit named, still no time.
        const none = windowFor({ runs: [A, B], curves: [null, null] }).result;
        expect(leaveWords(none, at(9), { ...NAMES }).text).toMatch(
            /^Tide not known for the shallow bits 2\.0 and 8\.0 NM out \(up to 0\.9 m of tide needed\)/,
        );
        expect(leaveWords(none, at(9), NAMES).footnote).toBeNull();
    });

    it('fetches one curve per tide place, at most four, and a fifth is not known', async () => {
        // Five tide places: each run's shallowest point a quarter degree further east (its own bucket).
        const runs = [1, 3, 5, 7, 9].map((nm, k) => {
            const r = run(nm, NEED_09);
            return { ...r, minAtLon: HORTA.lon + 0.25 * k, midLon: HORTA.lon + 0.25 * k };
        });
        const spots = leaveSpots(LINE, engine(runs), DRAFT)!;
        expect(new Set(spots.groups.map((g) => g.bucket)).size).toBe(spots.groups.length);
        expect(spots.groups.length).toBe(5);
        const load = vi.fn(async () => curve());
        const curves = await leaveCurves(spots, load, at(6), at(20));
        expect(load).toHaveBeenCalledTimes(4);
        expect(curves.filter(Boolean)).toHaveLength(4);
        expect(curves[4]).toBeNull();
        // A failed load is a group not known, never a throw.
        const failing = await leaveCurves(spots, async () => Promise.reject(new Error('offline')), at(6), at(20));
        expect(failing.every((c) => c === null)).toBe(true);
    });
});

describe('what it says when nothing gates or nothing clears', () => {
    it('nothing clears: "No leave time today…", there and back for a day trip', () => {
        // Needs 3.0 m; the tide tops out at 2.7.
        const { result } = windowFor({ runs: [run(4.2, DRAFT + 0.5 - 3.0)], dayTrip: true });
        expect(result.kind).toBe('none');
        expect(leaveWords(result, at(9), NAMES).text).toBe(
            'No leave time today carries the tide over the shallow bit 4.2 NM out, there and back: see it on the chart, or try another day.',
        );
        expect(leaveWords(result, at(9), { ...NAMES, day: 'on Friday' }).text).toMatch(/^No leave time on Friday /);
    });

    it('no runs: the tide does not limit when she leaves', () => {
        const { result } = windowFor({ runs: [] });
        expect(result.kind).toBe('not-gated');
        expect(leaveWords(result, at(9), NAMES)).toEqual({
            text: "No charted shallow water on the way: the tide doesn't limit when you leave.",
            more: null,
            footnote: null,
        });
    });

    it('no departures to judge (no forecast along the way): what the tide must give, never a time', () => {
        const { result } = windowFor({ runs: [run(4.2, NEED_09)], deps: [], dayTrip: true });
        expect(result.kind).toBe('no-times');
        const said = leaveWords(result, null, NAMES);
        expect(said).toEqual({
            text: 'No leave time without a forecast for the shallow bit 4.2 NM out (it needs 0.9 m of tide): check the tide table before you go.',
            more: null,
            footnote: null,
        });
        // Nothing to gate says so with or without a forecast.
        expect(windowFor({ runs: [], deps: [] }).result.kind).toBe('not-gated');
    });

    it('a run the keel already clears gates nothing', () => {
        const { result } = windowFor({ runs: [run(4.2, DRAFT + 0.6)] });
        expect(result.kind).toBe('not-gated');
        expect(leaveWords(result, at(9), NAMES).text).toBe(
            "Nothing on the way waits for the tide: the tide doesn't limit when you leave.",
        );
    });
});

describe('red the tide cannot clear', () => {
    const RED = 'Red on the route that no tide clears: see it on the chart.';
    const gated = run(4.2, NEED_09);
    const cases: [string, ShallowRunInfo[], Partial<ThalassaRouteDisclosure>][] = [
        ['a pin that dries', [gated, run(9.95, -1, { dryTail: true, endpointTail: 'destination' })], {}],
        ['a stretch with no charted depth', [gated, run(7, null)], {}],
        ['part uncharted', [{ ...gated, partUncharted: true }], {}],
        ['near a hazard', [{ ...gated, nearHazard: true }], {}],
        ['charts disagree', [{ ...gated, chartsDisagree: true }], {}],
        [
            'red with no charted depth behind it',
            [gated],
            {
                stateMask: Array.from({ length: VERTS - 1 }, (_, i) =>
                    i === 400 ? ('danger' as const) : ('green' as const),
                ),
            },
        ],
    ];
    for (const [name, runs, over] of cases)
        it(`${name}: the red sentence, and "works" never alone`, () => {
            const { result } = windowFor({ runs, over });
            expect(result.red).toBe(true);
            expect(result.kind).toBe('window');
            const text = leaveWords(result, at(9), NAMES).text;
            expect(text).toContain(`; your 09:00 works. ${RED}`);
        });

    it('red with nothing to gate is said too', () => {
        const { result } = windowFor({ runs: [run(9.95, -1, { dryTail: true, endpointTail: 'destination' })] });
        expect(result.kind).toBe('not-gated');
        expect(leaveWords(result, at(9), NAMES).text).toBe(
            `Nothing on the way waits for the tide: the tide doesn't limit when you leave. ${RED}`,
        );
    });

    it('clean water never says it', () => {
        const { result } = windowFor({ runs: [run(4.2, NEED_09)] });
        expect(result.red).toBe(false);
        expect(leaveWords(result, at(9), NAMES).text).not.toContain('Red on the route');
    });
});

describe('the curve and the windows', () => {
    it('an interpolated curve says "(tide approx)" after the times', () => {
        const { result } = windowFor({ runs: [run(4.2, NEED_09)], curves: [curve({ provenance: 'EXTREMES_INTERP' })] });
        expect(result.approx).toBe(true);
        expect(leaveWords(result, at(9), NAMES).text).toMatch(
            /^Leave \d\d:\d\d–\d\d:\d\d \(tide approx\) to carry the tide over/,
        );
        expect(leaveWords(result, at(9), NAMES).footnote).toBe('Tide from WorldTides; check the official tide table.');
    });

    it('two openings in her day are said; a third never', () => {
        // Needs 2.2 m: about 1 h 50 either side of each high water (08:00 and 20:25).
        const two = windowFor({
            runs: [run(4.2, DRAFT + 0.5 - 2.2)],
            curves: [curve({ hwMs: at(8) })],
            deps: departures(6, 19),
            earliestMs: at(5, 30),
        }).result;
        expect(two.windows).toHaveLength(2);
        expect(leaveWords(two, at(7), NAMES).text).toMatch(
            /^Leave \d\d:\d\d–\d\d:\d\d or \d\d:\d\d–\d\d:\d\d to carry the tide over the shallow bit 4\.2 NM out; your 07:00 works\./,
        );
        // A 5-hour tide opens three times in her day (the third shows when she can only leave late): two are said.
        const fiveHour = (deps: LeaveDeparture[]) =>
            windowFor({
                runs: [run(4.2, DRAFT + 0.5 - 2.2)],
                curves: [curve({ periodMs: 5 * H })],
                deps,
                earliestMs: at(5, 30),
            }).result;
        const many = fiveHour(departures(6, 19));
        const late = fiveHour(departures(15, 19));
        expect(many.windows.length).toBeGreaterThanOrEqual(3);
        expect(late.windows[0]).toEqual(many.windows.find((w) => w.fromMs >= late.windows[0].fromMs));
        expect(leaveWords(many, at(7), NAMES).text.match(/\d\d:\d\d(–\d\d:\d\d)?(?= or | \(| to )/g)).toHaveLength(2);
    });

    // Review 2026-10-13: only two stretches were kept, so a leave in a third was "too late" though it clears.
    it('her leave in a third clear stretch works, and the two said are hers and the nearest', () => {
        // A day trip, 1 h ashore, over a bit 4.2 NM out needing 0.4 m, high water 06:00: the way out misses the
        // low before noon and the way home the one after, which cuts her day into three.
        const { result } = windowFor({
            runs: [run(4.2, DRAFT + 0.5 - 0.4)],
            curves: [curve({ hwMs: at(6) })],
            dayTrip: true,
            deps: departures(6, 19, 2 * H, 1 * H),
            earliestMs: at(5, 30),
        });
        expect(result.windows).toHaveLength(3);
        const [, second, third] = result.windows;
        expect(third.fromMs).toBeLessThanOrEqual(at(13));
        expect(third.toMs).toBeGreaterThan(at(13));
        expect(leaveChosen(result.windows, at(13))).toBe('works');
        const t = (ms: number) => new Date(ms).toISOString().slice(11, 16);
        expect(leaveWords(result, at(13), NAMES).text).toBe(
            `Leave ${t(second.fromMs)}–${t(second.toMs)} or ${t(third.fromMs)}–${t(third.toMs)} to carry the tide over the shallow bit 4.2 NM out, there and back; your 13:00 works.`,
        );
        // No leave chosen: the first two of her day.
        expect(leaveWords(result, null, NAMES).text).toMatch(
            new RegExp(`^Leave ${t(result.windows[0].fromMs)}–\\d\\d:\\d\\d or ${t(second.fromMs)}–`),
        );
    });

    it('between two windows her leave is too late for the first or too early for the next, whichever is nearer', () => {
        const windows = [
            { fromMs: at(6), toMs: at(8) },
            { fromMs: at(18), toMs: at(20) },
        ];
        expect(leaveChosen(windows, at(10))).toBe('too-late');
        expect(leaveChosen(windows, at(16))).toBe('too-early');
        expect(leaveChosen([], at(10))).toBeNull();
    });
});

describe('the route and the words', () => {
    it('an unverified route (no masks) gets no leave row at all', () => {
        expect(leaveSpots(LINE, engine([run(4.2, NEED_09)], { stateMask: null }), DRAFT)).toBeNull();
        expect(leaveSpots(LINE, undefined, DRAFT)).toBeNull();
    });

    it('where: near the start "leaving", near the stop "at", else NM out', () => {
        const say = (runs: ShallowRunInfo[]) => leaveWords(windowFor({ runs }).result, at(9), NAMES).text;
        expect(say([run(0.3, NEED_09)])).toContain('over the shallow bit leaving Horta Marina;');
        expect(say([run(9.7, NEED_09)])).toContain('over the shallow bit at Fixture Cove;');
        expect(say([run(4.2, NEED_09)])).toContain('over the shallow bit 4.2 NM out;');
        // A needs-tide pin tail is gated, and named by its end.
        expect(say([run(5, NEED_09, { endpointTail: 'origin' })])).toContain('the shallow bit leaving Horta Marina');
        expect(say([run(0.3, NEED_09), run(4.2, NEED_09)])).toContain(
            'the shallow bits leaving Horta Marina and 4.2 NM out',
        );
        expect(say([run(1.1, NEED_09), run(4.2, NEED_09), run(6.6, NEED_09)])).toContain('over 3 shallow bits;');
    });

    it('a routed line of long legs is timed where the shallow bit is, not at the end of its leg', () => {
        // The same 10 NM, as three points: the shallow bit 4.2 NM out, mid-way along a 6 NM leg.
        const coarse: LonLat[] = [LINE[0], LINE[150], LINE[VERTS - 1]];
        const fine = windowFor({ runs: [run(4.2, NEED_09)], dayTrip: true }).result;
        const { spots, result } = windowFor({ runs: [run(4.2, NEED_09)], dayTrip: true, coords: coarse });
        expect(spots.line.length).toBeGreaterThan(90);
        near(result.windows[0].fromMs, fine.windows[0].fromMs);
        near(result.windows[0].toMs, fine.windows[0].toMs);
        // Said to the 0.1 NM leg its shallowest point falls on.
        expect(leaveWords(result, at(9), NAMES).text).toMatch(/the shallow bit 4\.[23] NM out/);
    });

    it('Fiji, across the antimeridian: the line is filled in the short way, never round the world', () => {
        const coords: LonLat[] = [
            [179.95, -16.8],
            [-179.95, -16.85],
        ];
        const spots = leaveSpots(coords, engine([]), DRAFT)!;
        expect(spots.line.length).toBeGreaterThan(40);
        expect(spots.line.every(([lon]) => Math.abs(lon) > 179.9)).toBe(true);
    });

    it("Nouméa: the times are on the place's clock, not the phone's", () => {
        const NOUMEA = { lat: -22.2758, lon: 166.4406 };
        const coords = line(NOUMEA, -1);
        // 07:00 at Nouméa (UTC+11) is 20:00 UTC the evening before.
        const local = (h: number, m = 0) => Date.UTC(2026, 9, 7, h - 11, m);
        const r = run(4.2, NEED_09, {}, coords);
        const { result } = windowFor({
            runs: [r],
            coords,
            curves: [curve({ hwMs: local(12) })],
            deps: departures(7, 16, 2 * H, 2 * H, local),
            earliestMs: local(6, 30),
        });
        const fmt = (zone: string) =>
            new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
        const there = fmt('Pacific/Noumea').format(result.windows[0].fromMs);
        const utc = fmt('UTC').format(result.windows[0].fromMs);
        const text = leaveWords(result, local(9), { ...NAMES, zone: 'Pacific/Noumea' }).text;
        expect(text.startsWith(`Leave ${there}–`)).toBe(true);
        expect(text).not.toContain(`Leave ${utc}`);
        expect(text).toContain('your 09:00 works');
    });
});

describe('memory only, and cheap', () => {
    it('stores nothing and logs nothing', async () => {
        const writes = vi.spyOn(Storage.prototype, 'setItem');
        const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) => vi.spyOn(console, k));
        const spots = leaveSpots(LINE, engine([run(2, NEED_09), run(8, NEED_09)]), DRAFT)!;
        const curves = await leaveCurves(spots, async () => curve(), at(6), at(20));
        const result = leaveWindow({
            spots,
            curves,
            departures: departures(),
            earliestMs: at(6, 30),
            dayTrip: true,
            cruiseKts: 5,
        });
        leaveWords(result, at(9), NAMES);
        expect(writes).not.toHaveBeenCalled();
        for (const log of logs) expect(log).not.toHaveBeenCalled();
    });

    it('is deterministic: the same inputs give the same answer', () => {
        const a = windowFor({ runs: [run(2, NEED_09), run(8, NEED_09)], dayTrip: true });
        const b = windowFor({ runs: [run(2, NEED_09), run(8, NEED_09)], dayTrip: true });
        expect(a.result).toEqual(b.result);
        expect(leaveWords(a.result, at(9), NAMES)).toEqual(leaveWords(b.result, at(9), NAMES));
    });

    it('14 departures x 6 steps x 2 ways x 2 tide places on 500 vertices: well under 300 ms', () => {
        const spots = leaveSpots(LINE, engine([run(2, NEED_09), run(8, NEED_09)]), DRAFT)!;
        const curves = [curve(), curve({ hwMs: at(13) })];
        const deps = departures(6, 19);
        expect(deps).toHaveLength(14);
        const times: number[] = [];
        for (let i = 0; i < 7; i++) {
            const t0 = performance.now();
            leaveWindow({
                spots,
                curves,
                departures: deps,
                earliestMs: at(5, 30),
                dayTrip: true,
                cruiseKts: 5,
            });
            times.push(performance.now() - t0);
        }
        const median = [...times].sort((x, y) => x - y)[3];
        process.stdout.write(`[leave window] median ${median.toFixed(1)} ms over 7 runs\n`);
        expect(median).toBeLessThan(300);
    });
});
