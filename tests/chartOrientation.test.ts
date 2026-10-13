/**
 * Chart orientation, part 2: the modes (127-11b). The controller is the one
 * owner of the chart's bearing: North up, Course up, Track up and Heading up.
 *
 * Shane 2026-10-09: "charts may need to have course-up, north-up and heading
 * up and track up. what do you think?" and 2026-10-10: "oh, um add in the
 * course up and north up etc. that is cool to see as well". The gesture locks
 * from 2026-05-18 ("prevent the earth from rotating on the chart page") all
 * stay: modes turn the chart, fingers never do.
 *
 * Her motion arrives as the own-ship marker publishes it (ownshipMotion), by
 * the lane it came down. Every place here is fictional: a made-up approach
 * like Nouméa's, a fjord like Tromsø's, a bay like the Chesapeake, and a reef
 * on the antimeridian like Taveuni's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type mapboxgl from 'mapbox-gl';
import { FakeMapboxMap } from './helpers/fakeMapboxGl';
import { publishOwnshipMotion, type OwnshipMotion } from '../components/map/ownshipMotion';
import { claimObsCamera } from '../components/map/obsCameraClaims';
import {
    arc,
    chartFitBearing,
    chartOrientationView,
    chartTurning,
    emaStep,
    holdChartFrame,
    keepHerOnScreen,
    orientChart,
    orientationKey,
    pickChartMode,
    plannerLegBearing,
    savedChartMode,
    type ChartMode,
} from '../components/map/chartOrientation';

const T0 = Date.UTC(2026, 9, 13, 2, 0, 0);
const KN = 1.9438444924;
/** A made-up approach like Nouméa's. */
const APPROACH = { lat: -22.3, lon: 166.42 };
/** A made-up bay like the Chesapeake's. */
const BAY = { lat: 38.6, lon: -76.4 };

type Where = { lat: number; lon: number };
const metric = (value: number, at: number) => ({ value, lastUpdated: at, freshness: 'live' });

/** The phone is all she has: its fix, its GPS course (geolocation heading) and speed. */
function phone(cog: number | null, kn: number, where: Where = APPROACH, at = Date.now()): OwnshipMotion {
    return {
        lane: 'phone',
        lat: where.lat,
        lon: where.lon,
        at,
        heading: cog,
        speed: kn / KN,
        instruments: {},
        maxAgeMs: 30_000,
    };
}

/** Her bus (the gateway): her instruments as NmeaStore holds them. */
function bus(
    {
        heading,
        cog = null,
        sog = 0,
        legacy,
        at = Date.now(),
        headingAt = at,
    }: {
        heading?: number | null;
        cog?: number | null;
        sog?: number | null;
        legacy?: number;
        at?: number;
        headingAt?: number;
    },
    where: Where = BAY,
): OwnshipMotion {
    return {
        lane: 'bus',
        lat: where.lat,
        lon: where.lon,
        at,
        heading: null,
        speed: null,
        instruments: {
            ...(heading != null && { headingTrue: metric(heading, headingAt) }),
            ...(cog != null && { cog: metric(cog, at) }),
            ...(sog != null && { sog: metric(sog, at) }),
            // NmeaStore's legacy `heading` (magnetic or unknown): never Heading up's.
            ...(legacy !== undefined && { heading: metric(legacy, at) }),
        } as OwnshipMotion['instruments'],
        maxAgeMs: 13_000,
    };
}

function chart(w = 390, h = 844) {
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: w });
    Object.defineProperty(container, 'clientHeight', { value: h });
    document.body.appendChild(container);
    const map = new FakeMapboxMap({ container });
    // She is in the middle of the screen unless a test moves her.
    map.projectTo = () => ({ x: w / 2, y: h / 2 });
    return map;
}
const asMap = (map: FakeMapboxMap) => map as unknown as mapboxgl.Map;

/** Bearings the controller eased the chart to, in order. */
const turns = (map: FakeMapboxMap) =>
    map.easeTo.mock.calls.filter(([options]) => options.bearing !== undefined).map(([options]) => options.bearing!);
const norm = (b: number) => ((b % 360) + 360) % 360;
const near = (a: number, b: number, tol = 1) => Math.abs(arc(a, b)) <= tol;

/** Seconds pass, one published sample per `every` s (the sample made fresh each time). */
function run(seconds: number, sample: (t: number) => OwnshipMotion | null, every = 1) {
    for (let t = 0; t < seconds; t += every) {
        vi.advanceTimersByTime(every * 1000);
        publishOwnshipMotion(sample(t));
    }
}

let stop: (() => void) | null = null;
function start(map: FakeMapboxMap, mode: ChartMode, inputs: Parameters<typeof orientChart>[2] = () => ({})) {
    localStorage.setItem(orientationKey('obs'), mode);
    const ctl = orientChart(asMap(map), 'obs', inputs);
    stop = ctl.stop;
    return ctl;
}

beforeEach(() => {
    vi.useFakeTimers({ now: T0 });
    localStorage.clear();
    publishOwnshipMotion(null);
});
afterEach(() => {
    stop?.();
    stop = null;
    publishOwnshipMotion(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
});

describe('angles go the short way round', () => {
    it('the EMA of 350° and 10° is 0°, never 180°', () => {
        // Half weight to the new value: dt = τ·ln 2.
        expect(emaStep(350, 10, 3000 * Math.LN2, 3000)).toBeCloseTo(0, 6);
        expect(emaStep(10, 350, 3000 * Math.LN2, 3000)).toBeCloseTo(0, 6);
        expect(arc(350, 10)).toBe(20);
        expect(arc(10, 350)).toBe(-20);
    });

    it('easeTo turns the short way: 350° to 10° is a 20° turn', () => {
        const map = chart();
        map.bearing = -10; // Mapbox keeps 350° as -10°.
        publishOwnshipMotion(bus({ heading: 10 }));
        start(map, 'heading');
        const [options, data] = map.easeTo.mock.calls[0];
        expect(options.bearing).toBeCloseTo(10, 6);
        expect((options as { duration: number }).duration).toBe(300);
        expect(data).toEqual({ thalassaOrientation: true });
    });
});

describe('Track up: her course over the ground', () => {
    it('1.4 kn holds North up and says why; 1.6 kn for 5 s turns', () => {
        const map = chart();
        start(map, 'track');
        run(30, () => phone(47, 1.4));
        expect(chartOrientationView()).toMatchObject({ mode: 'track', target: null, reason: 'slow' });
        expect(turns(map)).toEqual([]);
        run(4, () => phone(47, 1.6));
        expect(chartOrientationView().target).toBeNull();
        run(2, () => phone(47, 1.6));
        expect(chartOrientationView().target).toBeCloseTo(47, 3);
        expect(near(turns(map).at(-1)!, 47)).toBe(true);
    });

    it('leaves only after 20 s under 1.0 kn', () => {
        const map = chart();
        start(map, 'track');
        run(10, () => phone(47, 4));
        expect(chartOrientationView().target).toBeCloseTo(47, 3);
        run(19, () => phone(47, 0.4));
        expect(chartOrientationView().target).toBeCloseTo(47, 3);
        run(2, () => phone(47, 0.4));
        expect(chartOrientationView()).toMatchObject({ target: null, reason: 'slow' });
        expect(norm(map.bearing)).toBe(0);
    });

    it('the phone’s own GPS course when the phone is all she has (most punters worldwide)', () => {
        const map = chart();
        start(map, 'track');
        run(8, () => phone(212, 5.5));
        expect(chartOrientationView().target).toBeCloseTo(212, 3);
    });

    it('her bus’s COG and SOG, by the bus’s own gate', () => {
        const map = chart();
        start(map, 'track');
        run(8, () => bus({ cog: 300, sog: 6 }));
        expect(chartOrientationView().target).toBeCloseTo(300, 3);
    });

    it('her held fix (history) holds North up', () => {
        const map = chart();
        start(map, 'track');
        run(10, () => ({ ...phone(47, 6), lane: 'held', maxAgeMs: -1 }));
        expect(chartOrientationView()).toMatchObject({ target: null, reason: 'slow' });
        expect(turns(map)).toEqual([]);
    });
});

describe('Heading up: her true heading from her compass, nothing else', () => {
    it('her bus’s true heading turns the chart', () => {
        const map = chart();
        start(map, 'heading');
        run(5, () => bus({ heading: 52 }), 5);
        expect(chartOrientationView().target).toBeCloseTo(52, 3);
    });

    it('a legacy heading alone, or the phone’s, holds North up: "Needs a true heading"', () => {
        const map = chart();
        start(map, 'heading');
        run(10, () => bus({ legacy: 52, sog: 0 }));
        expect(chartOrientationView()).toMatchObject({ target: null, reason: 'noheading' });
        run(10, () => phone(52, 6));
        expect(chartOrientationView()).toMatchObject({ target: null, reason: 'noheading' });
        expect(turns(map)).toEqual([]);
    });

    it('a stale heading holds North up', () => {
        const map = chart();
        start(map, 'heading');
        run(5, () => bus({ heading: 52, headingAt: Date.now() - 20_000 }), 5);
        expect(chartOrientationView()).toMatchObject({ target: null, reason: 'noheading' });
    });

    it('the two-compass guard: 15.5° and 41° in turn at rest is two sources, not a boat', () => {
        const map = chart();
        start(map, 'heading');
        run(60, (t) => bus({ heading: (t / 10) % 2 < 1 ? 15.5 : 41, sog: 0.1, cog: 200 }), 10);
        expect(chartOrientationView()).toMatchObject({ target: null, reason: 'twocompass' });
        expect(norm(map.bearing)).toBe(0);
        // At most one swing of the chart before the guard held it.
        expect(turns(map).length).toBeLessThanOrEqual(3);
        // It clears after 60 s steady.
        run(55, () => bus({ heading: 41, sog: 0.1, cog: 200 }), 5);
        expect(chartOrientationView().reason).toBe('twocompass');
        run(10, () => bus({ heading: 41, sog: 0.1, cog: 200 }), 5);
        expect(chartOrientationView().reason).toBeNull();
        expect(near(chartOrientationView().target!, 41, 4)).toBe(true);
    });

    /**
     * The war at the cadences she really has: each source holds for several
     * samples. The gateway's 5 s aggregate with a 10 s swap (A A B B), and
     * her Pi's 2 s poll with 4 s and 6 s swaps (A A B B, A A A B B B).
     */
    for (const { lane, every, swap } of [
        { lane: 'bus', every: 5, swap: 10 },
        { lane: 'pi', every: 2, swap: 4 },
        { lane: 'pi', every: 2, swap: 6 },
    ] as const) {
        it(`the two-compass guard on her ${lane} at ${every} s, the sources swapping every ${swap} s`, () => {
            const map = chart();
            start(map, 'heading');
            run(
                120,
                (t) => ({
                    ...bus({ heading: Math.floor(t / swap) % 2 ? 41 : 15.5, sog: 0.1, cog: 200 }),
                    lane,
                }),
                every,
            );
            expect(chartOrientationView()).toMatchObject({ target: null, reason: 'twocompass' });
            expect(norm(map.bearing)).toBe(0);
            // It never swung to the other compass: one turn to the first, then North up.
            expect(turns(map).filter((b) => near(norm(b), 41, 12))).toEqual([]);
            expect(turns(map).length).toBeLessThanOrEqual(2);
        });
    }

    it('a jump while she is stopped holds the chart where it is; one jump alone is let go after 60 s', () => {
        const map = chart();
        start(map, 'heading');
        run(20, () => bus({ heading: 15.5, sog: 0.1 }), 2);
        expect(near(chartOrientationView().target!, 15.5, 1)).toBe(true);
        run(50, () => bus({ heading: 41, sog: 0.1 }), 2);
        expect(near(chartOrientationView().target!, 15.5, 1)).toBe(true);
        run(14, () => bus({ heading: 41, sog: 0.1 }), 2);
        expect(chartOrientationView().reason).toBeNull();
        expect(near(chartOrientationView().target!, 41, 4)).toBe(true);
    });

    it('a steady 41 ± 2° turns, and never trips the guard', () => {
        const map = chart();
        start(map, 'heading');
        run(120, (t) => bus({ heading: 41 + 2 * Math.sin(t / 7), sog: 0.1 }), 5);
        expect(chartOrientationView().reason).toBeNull();
        expect(near(chartOrientationView().target!, 41, 4)).toBe(true);
    });

    it('a tack moves her COG with her heading: the guard never trips', () => {
        const map = chart();
        start(map, 'heading');
        run(
            120,
            (t) => {
                const port = (t / 10) % 2 < 1;
                return bus({ heading: port ? 45 : 315, cog: port ? 50 : 310, sog: 5.5 });
            },
            10,
        );
        expect(chartOrientationView().reason).toBeNull();
    });
});

describe('damping: the chart ignores her wander and follows a turn in a few eases', () => {
    it('10 minutes of ±3° heading wander: no turn after the first', () => {
        const map = chart();
        start(map, 'heading');
        run(600, (t) => bus({ heading: 41 + 3 * Math.sin(t / 23) * Math.cos(t / 11), sog: 4, cog: 43 }), 5);
        expect(turns(map)).toHaveLength(1);
    });

    it('three 90° turns: at most 3 eases each', () => {
        const map = chart();
        start(map, 'heading');
        const leg = (t: number) => (t < 60 ? 0 : t < 120 ? 90 : t < 180 ? 180 : 270);
        run(240, (t) => bus({ heading: leg(t), sog: 6, cog: leg(t) }), 5);
        expect(turns(map).length).toBeLessThanOrEqual(1 + 3 * 3);
        expect(near(norm(map.bearing), 270, 4)).toBe(true);
    });

    it('Track up: a minute of ±4° COG noise at 1 Hz moves nothing; a 90° turn takes at most 3 eases', () => {
        const map = chart();
        start(map, 'track');
        run(60, (t) => phone(100 + 4 * Math.sin(t * 1.7), 6));
        expect(turns(map)).toHaveLength(1);
        run(60, () => phone(190, 6));
        expect(turns(map).length).toBeLessThanOrEqual(1 + 3);
        expect(near(norm(map.bearing), 190, 6)).toBe(true);
    });
});

/** A fictional L: 2 NM north from the approach, then 2 NM east. */
const NM_LAT = 1 / 60;
const nmLon = (lat: number) => 1 / (60 * Math.cos((lat * Math.PI) / 180));
const L_ROUTE = [
    APPROACH,
    { lat: APPROACH.lat + 2 * NM_LAT, lon: APPROACH.lon },
    { lat: APPROACH.lat + 2 * NM_LAT, lon: APPROACH.lon + 2 * nmLon(APPROACH.lat) },
];

describe('Course up on Obs: the route ahead, held steady', () => {
    it('an L route: 0° up the first leg, 90° after the corner', () => {
        const map = chart();
        start(map, 'course', () => ({ route: L_ROUTE }));
        run(10, () => phone(0, 6, { lat: APPROACH.lat + 1 * NM_LAT, lon: APPROACH.lon }));
        expect(near(chartOrientationView().target!, 0, 0.5)).toBe(true);
        run(4, () => phone(90, 6, { lat: L_ROUTE[1].lat, lon: APPROACH.lon + 0.6 * nmLon(APPROACH.lat) }));
        // Held: a new value replaces it only after ≥ 10° for 5 s.
        expect(near(chartOrientationView().target!, 0, 0.5)).toBe(true);
        run(3, () => phone(90, 6, { lat: L_ROUTE[1].lat, lon: APPROACH.lon + 0.6 * nmLon(APPROACH.lat) }));
        expect(near(chartOrientationView().target!, 90, 0.5)).toBe(true);
    });

    it('a new route on the chart starts its own hold: no 5 s wait on the old one', () => {
        const map = chart();
        const east = [
            { lat: APPROACH.lat + 1 * NM_LAT, lon: APPROACH.lon - 1 * nmLon(APPROACH.lat) },
            { lat: APPROACH.lat + 1 * NM_LAT, lon: APPROACH.lon + 2 * nmLon(APPROACH.lat) },
        ];
        let route: Where[] = L_ROUTE;
        const ctl = start(map, 'course', () => ({ route }));
        const here = { lat: APPROACH.lat + 1 * NM_LAT, lon: APPROACH.lon };
        run(3, () => phone(0, 6, here));
        expect(near(chartOrientationView().target!, 0, 0.5)).toBe(true);
        route = east;
        ctl.refresh();
        expect(near(chartOrientationView().target!, 90, 0.5)).toBe(true);
    });

    it('a dense autorouted line wiggling ±8°: no turn', () => {
        const map = chart();
        // 0.05 NM steps, each leg 8° either side of north.
        const route: Where[] = [BAY];
        for (let i = 1; i <= 120; i++) {
            const prev = route[i - 1];
            const b = ((i % 2 ? 8 : -8) * Math.PI) / 180;
            route.push({
                lat: prev.lat + 0.05 * NM_LAT * Math.cos(b),
                lon: prev.lon + 0.05 * nmLon(prev.lat) * Math.sin(b),
            });
        }
        start(map, 'course', () => ({ route }));
        // She sails up it at 6 kn for 3 minutes, on the line.
        run(180, (t) => {
            const at = route[Math.min(route.length - 1, Math.floor((t * 6) / 3600 / 0.05) + 1)];
            return phone(0, 6, at);
        });
        // On the line, 0.3 NM ahead spans the wiggles: at most the first alignment.
        expect(turns(map).length).toBeLessThanOrEqual(1);
        expect(near(chartOrientationView().target!, 0, 3)).toBe(true);
    });

    it('no position, or no route: North up and why', () => {
        const map = chart();
        start(map, 'course', () => ({ route: L_ROUTE }));
        run(5, () => null);
        expect(chartOrientationView()).toMatchObject({ target: null, reason: 'noroute' });
        stop?.();
        start(map, 'course', () => ({ route: null }));
        run(5, () => phone(0, 6));
        expect(chartOrientationView()).toMatchObject({ target: null, reason: 'noroute' });
    });

    it('past the end: the last leg', () => {
        const map = chart();
        start(map, 'course', () => ({ route: L_ROUTE }));
        run(5, () => phone(90, 6, { lat: L_ROUTE[2].lat, lon: L_ROUTE[2].lon + 1 * nmLon(APPROACH.lat) }));
        expect(near(chartOrientationView().target!, 90, 0.5)).toBe(true);
    });

    it('a route across the antimeridian (a reef like Taveuni’s): east is 90°, never 270°', () => {
        const map = chart();
        const route = [
            { lat: -16.8, lon: 179.9 },
            { lat: -16.8, lon: -179.9 },
        ];
        start(map, 'course', () => ({ route }));
        run(5, () => phone(90, 6, { lat: -16.8, lon: 179.95 }));
        expect(near(chartOrientationView().target!, 90, 0.5)).toBe(true);
    });

    it('a high-latitude route (a fjord like Tromsø’s): the leg’s own bearing', () => {
        const map = chart();
        const route = [
            { lat: 69.65, lon: 18.9 },
            { lat: 69.7, lon: 19.1 },
        ];
        start(map, 'course', () => ({ route }));
        run(5, () => phone(0, 6, { lat: 69.66, lon: 18.94 }));
        const t = chartOrientationView().target!;
        expect(t).toBeGreaterThan(50);
        expect(t).toBeLessThan(65);
    });
});

describe('Course up on the planner: the selected pin’s leg', () => {
    const pins = [
        { lat: 50.75, lon: -1.3 },
        { lat: 50.78, lon: -1.3 },
        { lat: 50.78, lon: -1.25 },
    ];
    it('the selected pin’s leg; none selected, the first; the last pin, the leg into it; one pin, none', () => {
        expect(plannerLegBearing(pins, 1)).toBeCloseTo(90, 0);
        expect(plannerLegBearing(pins, null)).toBeCloseTo(0, 0);
        expect(plannerLegBearing(pins, 2)).toBeCloseTo(90, 0);
        expect(plannerLegBearing(pins.slice(0, 1), 0)).toBeNull();
    });

    it('turns to the leg about its own pin, and holds North up with fewer than two pins', () => {
        const map = chart();
        localStorage.setItem(orientationKey('plan'), 'course');
        let leg: number | null = 90;
        const ctl = orientChart(asMap(map), 'plan', () => ({ leg, pivot: pins[1] }));
        stop = ctl.stop;
        expect(chartOrientationView()).toMatchObject({ surface: 'plan', mode: 'course', target: 90 });
        expect(near(turns(map)[0], 90)).toBe(true);
        // About the selected pin, so the leg stays on screen while the chart turns.
        expect((map.easeTo.mock.calls[0][0] as { around?: unknown }).around).toEqual([pins[1].lon, pins[1].lat]);
        leg = null;
        ctl.refresh();
        expect(chartOrientationView()).toMatchObject({ target: null, reason: 'nolegs' });
        expect(norm(map.bearing)).toBe(0);
    });

    it('Track and Heading up are not offered while planning: a stored one opens North up', () => {
        localStorage.setItem(orientationKey('plan'), 'heading');
        expect(savedChartMode('plan')).toBe('north');
    });
});

describe('the turn itself: never under a finger, never mid-flight', () => {
    it('never while the camera is moving: applied once at its moveend', () => {
        const map = chart();
        map.moving = true;
        start(map, 'heading');
        run(5, () => bus({ heading: 52 }), 5);
        expect(turns(map)).toEqual([]);
        map.moving = false;
        map.fire('moveend', {});
        // Off the event, never inside it (Mapbox fires an interrupted ease's moveend from stop()).
        expect(turns(map)).toEqual([]);
        vi.advanceTimersByTime(0);
        expect(turns(map)).toHaveLength(1);
        map.fire('moveend', {});
        vi.advanceTimersByTime(0);
        expect(turns(map)).toHaveLength(1);
    });

    it('never while a finger is on the chart, nor 300 ms after it lifts', () => {
        const map = chart();
        start(map, 'heading');
        map.fire('touchstart', {});
        run(5, () => bus({ heading: 52 }), 5);
        expect(turns(map)).toEqual([]);
        map.fire('touchend', {});
        vi.advanceTimersByTime(250);
        expect(turns(map)).toEqual([]);
        vi.advanceTimersByTime(100);
        expect(turns(map)).toHaveLength(1);
    });

    it('reduced motion: duration 0', () => {
        vi.spyOn(window, 'matchMedia').mockImplementation(
            (query: string) => ({ matches: query.includes('reduce'), media: query }) as MediaQueryList,
        );
        const map = chart();
        start(map, 'heading');
        run(5, () => bus({ heading: 90 }), 5);
        expect((map.easeTo.mock.calls[0][0] as { duration: number }).duration).toBe(0);
    });

    it('about her when she is on screen, about the centre when she is not; the mark rides every turn', () => {
        const map = chart();
        start(map, 'heading');
        // Under way: she turns from 090° to 180°, her course with her.
        run(5, () => bus({ heading: 90, sog: 6, cog: 90 }), 5);
        const [onScreen, data] = map.easeTo.mock.calls.at(-1)!;
        expect((onScreen as { around?: unknown }).around).toEqual([BAY.lon, BAY.lat]);
        expect(data).toEqual({ thalassaOrientation: true });
        map.projectTo = () => ({ x: -40, y: 300 });
        run(10, () => bus({ heading: 180, sog: 6, cog: 180 }), 5);
        const [offScreen] = map.easeTo.mock.calls.filter(([o]) => o.bearing !== undefined).at(-1)!;
        expect((offScreen as { around?: unknown }).around).toBeUndefined();
    });

    it('the late start: nothing turns before the chart’s first settle (A13)', () => {
        const map = chart();
        map.settled = false;
        start(map, 'heading');
        run(5, () => bus({ heading: 90 }), 5);
        expect(turns(map)).toEqual([]);
        map.settled = true;
        map.fire('idle', {});
        expect(turns(map)).toHaveLength(1);
    });

    it('a fit and the mode agree: chartFitBearing is the mode’s target, North up 0', () => {
        const map = chart();
        start(map, 'heading');
        run(5, () => bus({ heading: 47 }), 5);
        expect(chartTurning()).toBe(true);
        expect(chartFitBearing(asMap(map))).toBeCloseTo(47, 3);
        pickChartMode('north');
        expect(chartTurning()).toBe(false);
        expect(chartFitBearing(asMap(map))).toBe(0);
        expect(norm(map.bearing)).toBe(0);
    });

    it('a stray north snap (a fit that forgot the helper) heals at its moveend', () => {
        const map = chart();
        start(map, 'heading');
        run(5, () => bus({ heading: 47 }), 5);
        map.bearing = 0;
        map.fire('moveend', {});
        vi.advanceTimersByTime(0);
        expect(near(norm(map.bearing), 47)).toBe(true);
    });

    /**
     * Mapbox's own order of things: an ease runs over frames, each putting
     * the camera from where the ease began; a jumpTo or a fit first stops it,
     * and stop() fires the stopped ease's moveend before the jump lands. A
     * duration-0 fit (fitBounds goes through flyTo to a zero-length ease)
     * leaves another ease's frames running.
     */
    class EasingMap extends FakeMapboxMap {
        center: [number, number] = [-4.6, 48.3];
        pending: {
            from: [number, number];
            to: { center?: [number, number]; bearing?: number };
            data: Record<string, unknown>;
        } | null = null;
        constructor(container: HTMLElement) {
            super({ container });
            this.easeTo = vi.fn(
                (to: { center?: [number, number]; bearing?: number }, data: Record<string, unknown> = {}) => {
                    this.stop();
                    this.pending = { from: this.center, to, data };
                    this.moving = true;
                    this.fire('movestart', data);
                    return this;
                },
            ) as never;
            const land = (to: { center?: [number, number]; bearing?: number }) => {
                this.stop();
                if (to.center) this.center = to.center;
                if (to.bearing !== undefined) this.bearing = to.bearing;
                this.fire('movestart');
                this.fire('moveend');
                return this;
            };
            this.jumpTo = vi.fn(land) as never;
            this.fitBounds = vi.fn((_bounds: unknown, options: { center: [number, number]; bearing?: number }) =>
                land(options),
            );
        }
        stop() {
            const p = this.pending;
            if (!p) return;
            this.pending = null;
            this.moving = false;
            this.fire('moveend', p.data);
        }
        /** The frames that follow: the ease ends where it was going, from where it began. */
        frames() {
            const p = this.pending;
            if (!p) return;
            this.pending = null;
            this.center = p.to.center ?? p.from;
            if (p.to.bearing !== undefined) this.bearing = p.to.bearing;
            this.moving = false;
            this.fire('moveend', p.data);
        }
    }
    function easingChart() {
        const container = document.createElement('div');
        Object.defineProperty(container, 'clientWidth', { value: 390 });
        Object.defineProperty(container, 'clientHeight', { value: 844 });
        document.body.appendChild(container);
        const map = new EasingMap(container);
        map.projectTo = () => ({ x: 300, y: 650 });
        return map;
    }
    /** Her first fix at a made-up Brittany-like headland, where the startup camera jumps. */
    const HEADLAND = { lat: 48.38, lon: -4.77 };

    it('a jump while a turn is in flight keeps the jump: the turn goes on from where it put the chart', () => {
        const map = easingChart();
        start(map, 'heading');
        publishOwnshipMotion(bus({ heading: 120 }, HEADLAND));
        expect(map.isMoving()).toBe(true);
        // The Obs startup camera centres on her, 200 ms into the turn.
        vi.advanceTimersByTime(200);
        map.jumpTo({ center: [HEADLAND.lon, HEADLAND.lat], zoom: 14 } as never);
        vi.advanceTimersByTime(0);
        map.frames();
        vi.advanceTimersByTime(0);
        map.frames();
        expect(map.center).toEqual([HEADLAND.lon, HEADLAND.lat]);
        expect(near(norm(map.bearing), 120)).toBe(true);
    });

    it('a duration-0 whole-route fit while a turn is in flight keeps the fit (a fjord like Tromsø’s)', () => {
        const map = easingChart();
        const fjord = { lat: 69.8, lon: 19.4 };
        start(map, 'heading');
        publishOwnshipMotion(bus({ heading: 120 }, fjord));
        expect(map.isMoving()).toBe(true);
        vi.advanceTimersByTime(200);
        map.fitBounds([], { center: [18.95, 69.65], duration: 0, bearing: chartFitBearing(asMap(map)) } as never);
        vi.advanceTimersByTime(0);
        map.frames();
        expect(map.center).toEqual([18.95, 69.65]);
        expect(near(norm(map.bearing), 120)).toBe(true);
    });
});

describe('keep her on screen in the turning modes (Shane’s question 1: our recommendation, on)', () => {
    const making = () => bus({ heading: 47, sog: 6, cog: 47 });
    const recentres = (map: FakeMapboxMap) => map.easeTo.mock.calls.filter(([o]) => o.center !== undefined);

    it('she leaves the middle 60%: one move puts her in the lower third, at most every 20 s', () => {
        const map = chart(390, 844);
        start(map, 'heading');
        run(5, making, 5);
        map.projectTo = () => ({ x: 360, y: 422 });
        run(5, making, 5);
        expect(recentres(map)).toHaveLength(1);
        const [options, data] = recentres(map)[0];
        expect(options).toMatchObject({ center: [BAY.lon, BAY.lat], offset: [0, 844 / 6] });
        expect(data).toEqual({ thalassaOrientation: true });
        run(10, making, 5);
        expect(recentres(map)).toHaveLength(1);
        run(15, making, 5);
        expect(recentres(map)).toHaveLength(2);
    });

    it('never in North up, never off screen, never when she is stopped', () => {
        const map = chart(390, 844);
        start(map, 'north');
        map.projectTo = () => ({ x: 360, y: 422 });
        run(30, making, 5);
        expect(recentres(map)).toHaveLength(0);
        stop?.();
        map.projectTo = () => ({ x: 195, y: 422 });
        start(map, 'heading');
        map.projectTo = () => ({ x: 360, y: 422 });
        run(30, () => bus({ heading: 47, sog: 0.2 }), 5);
        map.projectTo = () => ({ x: 500, y: 422 });
        run(30, making, 5);
        expect(recentres(map)).toHaveLength(0);
    });

    it('a pan stands it down until Locate; so does a camera claim (Show on map)', () => {
        const map = chart(390, 844);
        start(map, 'heading');
        run(5, making, 5);
        map.fire('dragstart', { originalEvent: new Event('pointermove') });
        map.projectTo = () => ({ x: 360, y: 422 });
        run(30, making, 5);
        expect(recentres(map)).toHaveLength(0);
        keepHerOnScreen(asMap(map));
        run(5, making, 5);
        expect(recentres(map)).toHaveLength(1);
        claimObsCamera(asMap(map));
        run(30, making, 5);
        expect(recentres(map)).toHaveLength(1);
    });

    it('stands down while the passage overview holds the camera, and comes back when it lets go', () => {
        const map = chart(390, 844);
        start(map, 'heading');
        run(5, making, 5);
        const release = holdChartFrame();
        map.projectTo = () => ({ x: 195, y: 760 });
        run(60, making, 5);
        expect(recentres(map)).toHaveLength(0);
        release();
        run(5, making, 5);
        expect(recentres(map)).toHaveLength(1);
    });

    it('the zoom buttons (a click) do not stand it down; a pinch does', () => {
        const map = chart(390, 844);
        start(map, 'heading');
        run(5, making, 5);
        map.fire('zoomstart', { originalEvent: new MouseEvent('click') });
        map.projectTo = () => ({ x: 360, y: 422 });
        run(5, making, 5);
        expect(recentres(map)).toHaveLength(1);
        map.fire('zoomstart', { originalEvent: new Event('touchmove') });
        run(30, making, 5);
        expect(recentres(map)).toHaveLength(1);
    });
});

describe('remembered on this device, per surface', () => {
    it('one key per surface, written only on a pick', () => {
        const writes = vi.spyOn(Storage.prototype, 'setItem');
        const map = chart();
        const ctl = orientChart(asMap(map), 'obs', () => ({}));
        stop = ctl.stop;
        expect(writes.mock.calls.filter(([key]) => key.startsWith('thalassa_chart_orientation'))).toEqual([]);
        pickChartMode('track');
        expect(localStorage.getItem(orientationKey('obs'))).toBe('track');
        expect(localStorage.getItem(orientationKey('plan'))).toBeNull();
        expect(orientationKey('obs')).not.toBe(orientationKey('plan'));
        expect(savedChartMode('obs')).toBe('track');
    });

    it('a throwing localStorage opens North up, and a pick still works for the session', () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('denied');
        });
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('denied');
        });
        expect(savedChartMode('obs')).toBe('north');
        const map = chart();
        const ctl = orientChart(asMap(map), 'obs', () => ({}));
        stop = ctl.stop;
        expect(chartOrientationView().mode).toBe('north');
        expect(() => pickChartMode('heading')).not.toThrow();
        expect(chartOrientationView().mode).toBe('heading');
    });

    it('an unknown stored value opens North up', () => {
        localStorage.setItem(orientationKey('obs'), 'sideways');
        expect(savedChartMode('obs')).toBe('north');
    });
});

describe('Obs hidden: nothing left running', () => {
    it('stopping leaves no listener, no timer, and the chart North up', () => {
        const map = chart();
        const before = [...map.handlers.values()].reduce((n, list) => n + list.length, 0);
        const ctl = start(map, 'heading');
        run(5, () => bus({ heading: 52 }), 5);
        map.fire('mousedown', {});
        map.fire('mouseup', {});
        ctl.stop();
        stop = null;
        expect([...map.handlers.values()].reduce((n, list) => n + list.length, 0)).toBe(before);
        expect(vi.getTimerCount()).toBe(0);
        expect(chartTurning()).toBe(false);
        expect(chartOrientationView().surface).toBeNull();
        expect(norm(map.bearing)).toBe(0);
        const eases = map.easeTo.mock.calls.length;
        run(10, () => bus({ heading: 120 }), 5);
        expect(map.easeTo.mock.calls.length).toBe(eases);
    });
});
