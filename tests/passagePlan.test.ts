/**
 * passagePlan — the ghost slows on the nose, and the ETA moves with the wind.
 *
 * Phase 3 of the passage strip (Shane 2026-09-19, "phase 3 - go"). What would
 * mislead a skipper here: a ghost sailing dead upwind at close-hauled boat
 * speed; an unscaled polar quietly replacing the cruising speed she set, moving
 * the ETA by hours; "no forecast" turned into a speed; a plan in which the
 * axis, the ghost and the distance to go each did their own arithmetic.
 */
import { describe, expect, it } from 'vitest';
import {
    MOTOR_BELOW_FRACTION,
    PLAN_STEP_MS,
    passageSpeed,
    pointingDeg,
    planAt,
    planPassage,
    polarReferenceKts,
    polarScale,
    type PassageSpeedModel,
} from '../services/passagePlan';
import { DEFAULT_CRUISING_POLAR } from '../services/defaultPolar';
import { buildRouteIndex } from '../services/routeProgress';
import { parseRouteForecast, type RouteForecast } from '../services/routeForecastSampler';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 8, 19, 0, 0, 0);

const sail = (over: Partial<PassageSpeedModel> = {}): PassageSpeedModel => ({
    mode: 'polar',
    cruiseKts: 6,
    isSail: true,
    polar: DEFAULT_CRUISING_POLAR,
    closeHauledDeg: 45,
    ...over,
});

/** 120 NM due north. */
const NORTH = buildRouteIndex([
    { lat: -28, lon: 153 },
    { lat: -26, lon: 153 },
])!;

/** One wind, everywhere, for `hours`. */
const steady = (speed: number | null, dir: number | null, hours = 60): RouteForecast => {
    const reply = {
        hourly: {
            time: Array.from({ length: hours }, (_, h) => (T0 + h * HOUR) / 1000),
            wind_speed_10m: Array.from({ length: hours }, () => speed),
            wind_direction_10m: Array.from({ length: hours }, () => dir),
        },
    };
    try {
        return parseRouteForecast(
            [
                { alongNm: 0, lat: -28, lon: 153 },
                { alongNm: NORTH.totalNm, lat: -26, lon: 153 },
            ],
            [reply, reply],
            'ecmwf_ifs025',
            NORTH.totalNm,
            T0,
        );
    } catch {
        // parse refuses an all-null model; a forecast with no wind IS no forecast
        return { model: 'ecmwf_ifs025', fetchedAt: T0, totalNm: NORTH.totalNm, stations: [] };
    }
};

describe('the polar gives the SHAPE; her cruising speed gives the size', () => {
    it('a fair reaching breeze is exactly her cruising speed — whatever table is loaded', () => {
        const scale = polarScale(DEFAULT_CRUISING_POLAR, 6)!;
        expect(polarReferenceKts(DEFAULT_CRUISING_POLAR) * scale).toBeCloseTo(6, 6);
        // A table for a much faster boat is scaled DOWN to the speed she set…
        const racer = {
            ...DEFAULT_CRUISING_POLAR,
            matrix: DEFAULT_CRUISING_POLAR.matrix.map((r) => r.map((v) => v * 1.8)),
        };
        const a = passageSpeed(sail({ polar: racer }), 15, 90, 0).kts;
        const b = passageSpeed(sail(), 15, 90, 0).kts;
        expect(a).toBeCloseTo(b, 6);
    });

    it('a table that is plainly about another boat is not used at all: flat cruising speed, and it says CRUISE', () => {
        const dinghy = {
            ...DEFAULT_CRUISING_POLAR,
            matrix: DEFAULT_CRUISING_POLAR.matrix.map((r) => r.map((v) => v * 0.1)),
        };
        expect(polarScale(dinghy, 6)).toBeNull();
        expect(passageSpeed(sail({ polar: dinghy }), 15, 40, 0)).toMatchObject({ kts: 6, how: 'cruise' });
        const empty = { windSpeeds: [], angles: [], matrix: [] };
        expect(passageSpeed(sail({ polar: empty }), 15, 40, 0)).toMatchObject({ kts: 6, how: 'cruise' });
    });

    it('never runs away from the speed she set: capped a little over cruising', () => {
        for (const tws of [8, 12, 15, 20, 25, 30]) {
            for (const twd of [60, 90, 120, 150, 180]) {
                expect(passageSpeed(sail(), tws, twd, 0).kts).toBeLessThanOrEqual(6 * 1.3 + 1e-9);
            }
        }
    });
});

describe('she slows on the nose', () => {
    it('reaching beats close-hauled beats tacking dead upwind', () => {
        const reach = passageSpeed(sail(), 15, 90, 0);
        const close = passageSpeed(sail(), 15, 50, 0);
        const nose = passageSpeed(sail({ cruiseKts: 6 }), 20, 0, 0);
        expect(reach.how).toBe('sail');
        expect(close.how).toBe('sail');
        expect(reach.kts).toBeGreaterThan(close.kts);
        expect(close.kts).toBeGreaterThan(nose.kts);
    });

    it('dead upwind she TACKS: close-hauled speed times cos(45°), not close-hauled speed', () => {
        // 25 kn so the polar gives enough that she does not reach for the engine.
        const close = passageSpeed(sail({ cruiseKts: 5 }), 25, 45, 0);
        const nose = passageSpeed(sail({ cruiseKts: 5 }), 25, 0, 0);
        if (nose.how === 'tack') {
            expect(nose.kts).toBeCloseTo(close.kts * Math.cos(Math.PI / 4), 6);
        } else {
            // …or it was slow enough to motor — either way NOT the held close-hauled speed.
            expect(nose.how).toBe('motor');
        }
        expect(nose.kts).toBeLessThan(close.kts);
    });

    it('TACK is really reached, with the arithmetic it claims: v(40°) × cos 40°, dead upwind', () => {
        const model = sail({ closeHauledDeg: 40, cruiseKts: 4 });
        const closeHauled = passageSpeed(model, 20, 40, 0);
        const nose = passageSpeed(model, 20, 0, 0);
        expect(closeHauled.how).toBe('sail');
        expect(nose.how).toBe('tack');
        expect(nose.kts).toBeCloseTo(closeHauled.kts * Math.cos((40 * Math.PI) / 180), 6);
        // 20° off the wind she makes better way than dead into it, and less than close-hauled
        const between = passageSpeed(model, 20, 20, 0);
        expect(between.how).toBe('tack');
        expect(between.kts).toBeGreaterThan(nose.kts);
        expect(between.kts).toBeLessThan(closeHauled.kts);
    });

    it('works across north and on either tack: the angle off the bow is what matters', () => {
        const a = passageSpeed(sail(), 15, 20, 350); // 30° on the starboard bow
        const b = passageSpeed(sail(), 15, 320, 350); // 30° on the port bow
        expect(a.kts).toBeCloseTo(b.kts, 9);
        expect(a.how).toBe(b.how);
    });

    it('a boat that points higher loses less', () => {
        const high = passageSpeed(sail({ closeHauledDeg: 38, cruiseKts: 4 }), 20, 0, 0);
        const low = passageSpeed(sail({ closeHauledDeg: 52, cruiseKts: 4 }), 20, 0, 0);
        expect(high.kts).toBeGreaterThan(low.kts);
    });
});

describe('neither end of the table is held', () => {
    // The yacht database's tables start at 6 kn of wind and at 45° off it.
    const DATABASE_GRID = {
        windSpeeds: [6, 8, 10, 12, 15, 20, 25],
        angles: [45, 60, 90, 120, 150, 180],
        matrix: [
            [3.0, 3.8, 4.4, 4.8, 5.1, 5.3, 5.2],
            [3.6, 4.5, 5.1, 5.5, 5.8, 6.0, 5.9],
            [4.0, 4.9, 5.5, 5.9, 6.2, 6.4, 6.2],
            [3.8, 4.7, 5.3, 5.7, 6.0, 6.3, 6.1],
            [3.2, 4.1, 4.7, 5.1, 5.5, 5.9, 5.8],
            [2.8, 3.6, 4.2, 4.6, 5.0, 5.4, 5.3],
        ],
    };

    it('BELOW the first column her speed runs down to nothing — not "6 KN SAIL" in a 4-knot drift', () => {
        const model = sail({ polar: DATABASE_GRID });
        const atSix = passageSpeed(model, 6, 90, 0);
        expect(atSix.how).toBe('sail');
        const drift = passageSpeed(model, 4.1, 90, 0);
        expect(drift.how).toBe('motor'); // 4.1/6 of the 6-kn figure is under 60% of cruise
        const nearly = passageSpeed(model, 5.9, 90, 0);
        expect(nearly.how).toBe('sail');
        expect(nearly.kts).toBeCloseTo(atSix.kts * (5.9 / 6), 6);
    });

    it('ABOVE the last column she is never credited more than her cruising speed on a column that does not exist', () => {
        const model = sail({ polar: DATABASE_GRID });
        expect(passageSpeed(model, 25, 90, 0).kts).toBeGreaterThan(6); // inside the table she may exceed it a little
        expect(passageSpeed(model, 45, 90, 0).kts).toBeLessThanOrEqual(6);
    });

    it('she is never priced pointing higher than the table can price', () => {
        expect(pointingDeg({ closeHauledDeg: 40, polar: DATABASE_GRID })).toBe(45);
        expect(pointingDeg({ closeHauledDeg: 52, polar: DATABASE_GRID })).toBe(52);
        expect(pointingDeg({ closeHauledDeg: 38, polar: DEFAULT_CRUISING_POLAR })).toBe(38); // that table starts at 30°
        const at40 = passageSpeed(sail({ polar: DATABASE_GRID, closeHauledDeg: 40, cruiseKts: 4 }), 20, 0, 0);
        const at45 = passageSpeed(sail({ polar: DATABASE_GRID, closeHauledDeg: 45, cruiseKts: 4 }), 20, 0, 0);
        expect(at40.kts).toBeCloseTo(at45.kts, 9);
        // 42° off the wind is inside what she can point on this table: a TACK, continuous with 45°
        expect(passageSpeed(sail({ polar: DATABASE_GRID, closeHauledDeg: 40, cruiseKts: 4 }), 20, 42, 0).how).toBe(
            'tack',
        );
    });
});

describe('through the water is not made good', () => {
    it('tacking she sails FASTER than she gets anywhere: boatKts is her way through the water', () => {
        const model = sail({ closeHauledDeg: 40, cruiseKts: 4 });
        const nose = passageSpeed(model, 20, 0, 0);
        const closeHauled = passageSpeed(model, 20, 40, 0);
        expect(nose.how).toBe('tack');
        expect(nose.boatKts).toBeCloseTo(closeHauled.kts, 6);
        expect(nose.kts).toBeLessThan(nose.boatKts);
        // everywhere else the two are the same number
        expect(closeHauled.boatKts).toBe(closeHauled.kts);
        expect(passageSpeed(model, 3, 90, 0).boatKts).toBe(passageSpeed(model, 3, 90, 0).kts);
    });
});

describe('a cruising boat has an engine', () => {
    it('motors in under four knots of wind — the router’s own rule', () => {
        expect(passageSpeed(sail(), 3, 90, 0)).toMatchObject({ kts: 6, how: 'motor' });
    });

    it('motors when the wind would give her less than 60% of her cruising speed', () => {
        const light = passageSpeed(sail(), 6, 150, 0); // the polar gives ~2.5 kn
        expect(light.how).toBe('motor');
        expect(light.kts).toBe(6);
        expect(MOTOR_BELOW_FRACTION).toBe(0.6);
    });

    it('motoring loses way into a headwind, and never below half', () => {
        const head = passageSpeed(sail({ cruiseKts: 8 }), 30, 0, 0);
        expect(head.how).toBe('motor');
        expect(head.kts).toBeCloseTo(8 * (1 - (30 / 40) * 0.3), 6);
        expect(passageSpeed(sail({ cruiseKts: 8 }), 200, 0, 0).kts).toBeGreaterThanOrEqual(4);
    });

    it('a power vessel does her cruising speed, and says CRUISE — no invented power model', () => {
        expect(passageSpeed(sail({ isSail: false, cruiseKts: 18 }), 25, 0, 0)).toMatchObject({
            kts: 18,
            how: 'cruise',
        });
    });

    it('flat cruising speed is still there, whatever the wind', () => {
        expect(passageSpeed(sail({ mode: 'cruise' }), 35, 0, 0)).toMatchObject({ kts: 6, how: 'cruise' });
    });
});

describe('no wind forecast is not a speed', () => {
    it('is ASSUMED at cruising speed — never a polar lookup of nothing', () => {
        expect(passageSpeed(sail(), null, 90, 0)).toMatchObject({ kts: 6, how: 'assumed' });
        expect(passageSpeed(sail(), 15, null, 0)).toMatchObject({ kts: 6, how: 'assumed' });
    });

    it('the plan records from WHEN it is assuming', () => {
        const plan = planPassage({
            index: NORTH,
            startAlongNm: 0,
            backNm: 0,
            startMs: T0,
            forecast: steady(15, 90, 6), // six hours of forecast, then nothing
            model: sail(),
            maxMs: 168 * HOUR,
        });
        expect(plan.assumedFromMs).not.toBeNull();
        expect(plan.assumedFromMs!).toBeGreaterThan(5 * HOUR);
        expect(plan.assumedFromMs!).toBeLessThanOrEqual(6 * HOUR);
        expect(planAt(plan, 3 * HOUR)!.assumed).toBe(false);
        expect(planAt(plan, 12 * HOUR)!.assumed).toBe(true);
    });

    it('with no forecast at all the whole plan is assumed, from now — and still arrives', () => {
        const plan = planPassage({
            index: NORTH,
            startAlongNm: 0,
            backNm: 0,
            startMs: T0,
            forecast: null,
            model: sail(),
            maxMs: 168 * HOUR,
        });
        expect(plan.assumedFromMs).toBe(0);
        expect(plan.arrivalMs!).toBeCloseTo((NORTH.totalNm / 6) * HOUR, -3);
    });
});

describe('the walk', () => {
    const plan = (over: Partial<Parameters<typeof planPassage>[0]> = {}) =>
        planPassage({
            index: NORTH,
            startAlongNm: 30,
            backNm: 0,
            startMs: T0,
            forecast: steady(15, 90),
            model: sail(),
            maxMs: 168 * HOUR,
            ...over,
        });

    it('starts from where she IS, at NOW', () => {
        const p = plan();
        expect(p.offsetsMs[0]).toBe(0);
        expect(planAt(p, 0)!.alongNm).toBe(30);
        expect(planAt(p, 0)!.toGoNm).toBeCloseTo(NORTH.totalNm - 30, 9);
    });

    it('in flat-cruise mode it is EXACTLY phase 2: distance = speed × time, arrival = distance / speed', () => {
        const p = plan({ model: sail({ mode: 'cruise' }) });
        expect(p.arrivalMs!).toBeCloseTo(((NORTH.totalNm - 30) / 6) * HOUR, 3);
        for (const h of [0.4, 1, 3.3, 7]) expect(planAt(p, h * HOUR)!.alongNm).toBeCloseTo(30 + 6 * h, 6);
    });

    it('a beat takes longer than a reach over the same water — the ETA moves with the wind', () => {
        const reach = plan({ forecast: steady(18, 90) });
        const beat = plan({ forecast: steady(18, 0) }); // dead on the nose, northbound
        expect(beat.arrivalMs!).toBeGreaterThan(reach.arrivalMs! * 1.2);
    });

    it('never goes backwards, never passes the end, and lands its last row exactly on arrival', () => {
        const p = plan({ forecast: steady(22, 10) });
        for (let i = 1; i < p.alongNm.length; i++) {
            expect(p.alongNm[i]).toBeGreaterThanOrEqual(p.alongNm[i - 1]);
            expect(p.offsetsMs[i]).toBeGreaterThan(p.offsetsMs[i - 1]);
        }
        expect(p.alongNm[p.alongNm.length - 1]).toBeCloseTo(NORTH.totalNm, 9);
        expect(p.toGoNm[p.toGoNm.length - 1]).toBeCloseTo(0, 9);
        expect(p.endMs).toBe(p.arrivalMs);
        expect(planAt(p, p.arrivalMs!)!.arrived).toBe(true);
        expect(planAt(p, p.arrivalMs! - 60_000)!.arrived).toBe(false);
        // asked past the end, it holds at the end — it does not extrapolate
        expect(planAt(p, p.arrivalMs! + 50 * HOUR)!.alongNm).toBeCloseTo(NORTH.totalNm, 9);
    });

    it('at the END she is ARRIVED at the speed she arrived at — not "0.0 KN SAIL"', () => {
        const p = plan({ forecast: steady(18, 90) });
        const end = planAt(p, p.arrivalMs!)!;
        expect(end.arrived).toBe(true);
        expect(end.kts).toBeGreaterThan(1);
        expect(end.boatKts).toBeGreaterThan(1);
    });

    it('a passage longer than seven days stops at seven days, and does not claim to arrive', () => {
        const p = plan({ startAlongNm: 0, model: sail({ mode: 'cruise', cruiseKts: 0.5 }) });
        expect(p.arrivalMs).toBeNull();
        expect(p.endMs).toBe(168 * HOUR);
        expect(p.offsetsMs.length).toBeLessThanOrEqual(168 * 4 + 2);
        expect(planAt(p, 168 * HOUR)!.alongNm).toBeCloseTo(84, 6);
    });

    it('off her line she sails BACK to it first: the ghost waits abeam, and the miles to go count down throughout', () => {
        const p = plan({ backNm: 9, model: sail({ mode: 'cruise' }) });
        expect(planAt(p, 0)!.toGoNm).toBeCloseTo(NORTH.totalNm - 30 + 9, 9);
        expect(planAt(p, 1 * HOUR)!.alongNm).toBe(30); // 6 of the 9 NM back: still abeam
        expect(planAt(p, 1 * HOUR)!.toGoNm).toBeCloseTo(NORTH.totalNm - 30 + 3, 6);
        expect(planAt(p, 2 * HOUR)!.alongNm).toBeCloseTo(33, 6); // 9 back, then 3 along
        expect(p.arrivalMs!).toBeCloseTo(((NORTH.totalNm - 30 + 9) / 6) * HOUR, 3);
    });

    it('the wind it sails in is the wind AT THAT HOUR — a shift half way changes the second half only', () => {
        const shifting = steady(18, 90);
        for (const s of shifting.stations) {
            for (let h = 6; h < s.dirDeg.length; h++) s.dirDeg[h] = 0; // goes onto the nose at +6 h
        }
        const steadyReach = plan();
        const p = plan({ forecast: shifting });
        expect(planAt(p, 5 * HOUR)!.alongNm).toBeCloseTo(
            planAt(plan({ forecast: steady(18, 90) }), 5 * HOUR)!.alongNm,
            6,
        );
        expect(p.arrivalMs!).toBeGreaterThan(steadyReach.arrivalMs!);
        expect(['tack', 'motor']).toContain(planAt(p, 8 * HOUR)!.how);
    });

    it('a boat with no speed has a dead plan, not an infinite loop', () => {
        const p = plan({ model: sail({ cruiseKts: 0 }) });
        expect(p.offsetsMs).toEqual([0]);
        expect(p.arrivalMs).toBeNull();
    });

    it('steps a quarter of an hour at a time', () => {
        expect(PLAN_STEP_MS).toBe(15 * 60_000);
        expect(plan().offsetsMs[1]).toBe(PLAN_STEP_MS);
    });
});
