/**
 * Polar truth (build 125, package 125-08; gap register #2
 * routing-uses-selected-polar, #12a learned-polars, #44 polar-library-editor).
 *
 * Build 123 (W1-03) gave every ROUTER one resolver (services/routingPolar):
 * learned → the skipper's imported or typed polar → a yacht-database shape
 * scaled to her cruising speed → the generic polar. The Passage HUD and Plan
 * Your Day (build 124) still sailed `settings.polarData ?? DEFAULT_CRUISING_POLAR`
 * with every table scaled to her cruising speed, so an imported polar's own
 * figures and a learned polar never reached them, and the HUD's ETA and the
 * routed ETA for the same boat disagreed.
 *
 * Now the HUD and Plan Your Day build their speed model from the resolved
 * routing polar (routingSpeedModel): her own figures (imported, typed in,
 * learned) are sailed as given, exactly as the routers sail them; a shape (a
 * yacht-database table, the generic polar) is scaled to her cruising speed.
 * A Smart polar still filling says how much it has learned.
 *
 * Fixtures are worldwide and fictional: a due-north passage off Portugal, a
 * beam reach off Cape Cod, a Tasman-side learned boat, and the Caribbean.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../services/nativeStorage', () => ({
    loadLargeData: vi.fn(async () => null),
    saveLargeData: vi.fn(async () => undefined),
}));

import {
    resolveRoutingPolarFrom,
    routingSpeedModel,
    sailsHerOwnFigures,
    toEdgePolar,
    type LearnedPolarSnapshot,
    type ResolvedRoutingPolar,
    type RoutingPolarSettings,
} from '../services/routingPolar';
import {
    MOTOR_UNDER_TWS_KTS,
    passageSpeed,
    planPassage,
    pointingDeg,
    polarReferenceKts,
    type PassageSpeedModel,
} from '../services/passagePlan';
import { createPolarSpeedLookup } from '../services/isochrone/polar';
import { computeIsochrones, _testableInternals } from '../services/IsochroneRouter';
import { buildRouteIndex } from '../services/routeProgress';
import { parseRouteForecast, type RouteForecast } from '../services/routeForecastSampler';
import { POLAR_DATABASE } from '../data/polarDatabase';
import { timesBasis } from '../services/dayPlanner/today';
import { vesselCruisingSpeedKts } from '../services/units';
import { closeHauledDegFor } from '../services/sailing/pointOfSail';
import type { PolarData, VesselProfile } from '../types';

const { haversineNm } = _testableInternals;
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 1, 6, 0, 0);

// ── Fictional boats and polars ───────────────────────────────────

const SLOOP: VesselProfile = {
    name: 'Fair Wind',
    type: 'sail',
    length: 38,
    beam: 12.8,
    draft: 6.2,
    displacement: 15000,
    maxWaveHeight: 10,
    cruisingSpeed: 6.5,
};

/**
 * A 40-footer with no cruising speed set: "auto", sqrt(40) × 1.2 = 7.59 kn —
 * a boat whose cruising speed is NOT the generic polar's ~5.9 kn, so a
 * generic polar sailed two ways shows (review 2026-10-09: 22% apart).
 */
const FORTY: VesselProfile = { ...SLOOP, name: 'Long Reach', length: 40, cruisingSpeed: 0 };

const OCEANIS = POLAR_DATABASE.find((entry) => entry.model === 'Beneteau Oceanis 38.1')!;

/** An Expedition-style export: first row 38°, a 0 kn column the resolver drops. */
const IMPORTED: PolarData = {
    windSpeeds: [0, 6, 8, 10, 12, 16, 20, 25],
    angles: [38, 45, 52, 60, 75, 90, 110, 120, 135, 150, 165, 180],
    matrix: [
        [0, 3.6, 4.4, 5.0, 5.4, 5.8, 6.0, 6.0],
        [0, 4.2, 5.0, 5.6, 6.0, 6.4, 6.6, 6.6],
        [0, 4.6, 5.4, 6.0, 6.4, 6.8, 7.0, 7.0],
        [0, 4.9, 5.8, 6.4, 6.8, 7.2, 7.4, 7.4],
        [0, 5.2, 6.1, 6.8, 7.2, 7.6, 7.9, 8.0],
        [0, 5.3, 6.3, 7.0, 7.4, 7.9, 8.3, 8.5],
        [0, 5.2, 6.3, 7.0, 7.5, 8.0, 8.6, 9.0],
        [0, 5.0, 6.1, 6.9, 7.4, 8.0, 8.7, 9.3],
        [0, 4.5, 5.6, 6.5, 7.1, 7.8, 8.6, 9.4],
        [0, 3.8, 4.9, 5.8, 6.5, 7.3, 8.1, 9.0],
        [0, 3.3, 4.3, 5.2, 5.9, 6.8, 7.6, 8.4],
        [0, 3.0, 4.0, 4.8, 5.5, 6.4, 7.2, 8.0],
    ],
};

/** SmartPolarStore's export grid with `cells` learned [twsIdx, angleIdx, kts]; zeros elsewhere. */
function learnedGrid(cells: [number, number, number][]): PolarData {
    const windSpeeds = [6, 8, 10, 12, 15, 20, 25];
    const angles = [45, 60, 90, 120, 150, 180];
    const matrix = angles.map(() => windSpeeds.map(() => 0));
    for (const [w, a, kts] of cells) matrix[a][w] = kts;
    return { windSpeeds, angles, matrix };
}
const TEN_LEARNED_CELLS: [number, number, number][] = [
    [1, 1, 4.9],
    [2, 1, 5.6],
    [3, 1, 6.0],
    [1, 2, 5.4],
    [2, 2, 6.1],
    [3, 2, 6.6],
    [4, 2, 7.0],
    [1, 3, 5.2],
    [2, 3, 5.9],
    [3, 3, 6.4],
];
const COVERED: LearnedPolarSnapshot = { polar: learnedGrid(TEN_LEARNED_CELLS), filledCells: 10 };
const SEVEN: LearnedPolarSnapshot = { polar: learnedGrid(TEN_LEARNED_CELLS.slice(0, 7)), filledCells: 7 };
/** Cells learned only running (150° and 180°), nowhere near a beam reach. */
const RUNNING_CELLS: [number, number, number][] = [
    [1, 4, 4.6],
    [2, 4, 5.4],
    [3, 4, 5.9],
    [4, 4, 6.4],
    [1, 5, 4.0],
    [2, 5, 4.8],
    [3, 5, 5.3],
    [4, 5, 5.8],
];
const SEVEN_RUNNING: LearnedPolarSnapshot = { polar: learnedGrid(RUNNING_CELLS.slice(0, 7)), filledCells: 7 };
const EIGHT_RUNNING: LearnedPolarSnapshot = { polar: learnedGrid(RUNNING_CELLS), filledCells: 8 };

const resolve = (
    settings: RoutingPolarSettings,
    vessel: VesselProfile = SLOOP,
    learned: LearnedPolarSnapshot | null = null,
): ResolvedRoutingPolar => resolveRoutingPolarFrom({ settings, vessel, learned });

/** The speed model the HUD and Plan Your Day build for `vessel` on `routing`. */
const hudModel = (routing: ResolvedRoutingPolar, vessel: VesselProfile = SLOOP): PassageSpeedModel =>
    routingSpeedModel(routing, {
        mode: 'polar',
        cruiseKts: vesselCruisingSpeedKts(vessel, 0),
        isSail: vessel.type === 'sail',
        closeHauledDeg: closeHauledDegFor(vessel),
    });

const SMART_ON = { polarSource: 'smart', smartPolarsEnabled: true } as const;

const BOATS: [string, ResolvedRoutingPolar, VesselProfile][] = [
    [
        'factory (a yacht-database shape)',
        resolve({ polarData: OCEANIS.polar, polarBoatModel: OCEANIS.model, polarSource_type: 'database' }),
        SLOOP,
    ],
    [
        'imported',
        resolve({ polarData: IMPORTED, polarBoatModel: 'Fair Wind 2025.pol', polarSource_type: 'file_import' }),
        SLOOP,
    ],
    ['learned', resolve(SMART_ON, SLOOP, COVERED), SLOOP],
    // The commonest setup: no polar chosen, on a boat that is not a 6-knotter.
    ['generic (no polar chosen), a 40-footer on auto cruising speed', resolve({}, FORTY), FORTY],
    // A Smart boat still filling, on the generic polar, and the moment it routes.
    ['learning (7 of 42 cells) on the generic polar, a 40-footer', resolve(SMART_ON, FORTY, SEVEN_RUNNING), FORTY],
    ['learned (8 of 42 cells) on the generic polar, a 40-footer', resolve(SMART_ON, FORTY, EIGHT_RUNNING), FORTY],
];

// ── A due-north passage off Portugal: a constant course, so a constant wind angle ──

const FROM = { lat: 38.7, lon: -9.6 };
const TO = { lat: 40.7, lon: -9.6 };
const NORTH = buildRouteIndex([FROM, TO])!;

/** One wind everywhere along NORTH for `hours` (knots, FROM `dir`). */
function steady(speed: number, dir: number, hours = 72): RouteForecast {
    const reply = {
        hourly: {
            time: Array.from({ length: hours }, (_, h) => (T0 + h * HOUR) / 1000),
            wind_speed_10m: Array.from({ length: hours }, () => speed),
            wind_direction_10m: Array.from({ length: hours }, () => dir),
        },
    };
    return parseRouteForecast(
        [
            { alongNm: 0, ...FROM },
            { alongNm: NORTH.totalNm, ...TO },
        ],
        [reply, reply],
        'ecmwf_ifs025',
        NORTH.totalNm,
        T0,
    );
}

describe('resolver parity: the HUD and Plan Your Day sail the polar the routers sail', () => {
    for (const [name, routing, vessel] of BOATS) {
        it(`${name}: at every in-range wind and angle she sails off the wind, the HUD's speed IS the router's`, () => {
            const model = hudModel(routing, vessel);
            // The routers look the speed up on routing.polar with no scaling.
            for (const tws of [10, 12, 15]) {
                const router = createPolarSpeedLookup(routing.polar, tws);
                for (const twa of [60, 90, 120]) {
                    // Wind from the beam of a northbound course: course 0°, wind FROM `twa`.
                    const leg = passageSpeed(model, tws, twa, 0);
                    expect(leg.how, `${tws} kn / ${twa}°`).toBe('sail');
                    expect(leg.kts, `${tws} kn / ${twa}°`).toBeCloseTo(router(twa), 9);
                }
            }
        });

        it(`${name}: the HUD's ETA on a beam reach is the routed ETA (distance ÷ the router's beam speed)`, () => {
            const plan = planPassage({
                index: NORTH,
                startAlongNm: 0,
                backNm: 0,
                startMs: T0,
                forecast: steady(12, 270),
                model: hudModel(routing, vessel),
                maxMs: 72 * HOUR,
            });
            const routerKts = createPolarSpeedLookup(routing.polar, 12)(90);
            expect(plan.arrivalMs).not.toBeNull();
            expect(plan.arrivalMs! / HOUR).toBeCloseTo(NORTH.totalNm / routerKts, 6);
        });

        it(`${name}: and the isochrone router itself, on the same polar and wind, lands within one of its steps`, async () => {
            const routed = await computeIsochrones(
                FROM,
                TO,
                new Date(T0).toISOString(),
                routing.polar,
                {
                    getWind: () => ({ speed: 12, direction: 270 }),
                },
                { timeStepHours: 1, maxHours: 72, useDepthPenalty: false },
            );
            expect(routed).not.toBeNull();
            const plan = planPassage({
                index: NORTH,
                startAlongNm: 0,
                backNm: 0,
                startMs: T0,
                forecast: steady(12, 270),
                model: hudModel(routing, vessel),
                maxMs: 72 * HOUR,
            });
            expect(Math.abs(routed!.totalDurationHours - plan.arrivalMs! / HOUR)).toBeLessThanOrEqual(1.5);
        });
    }

    it("an imported polar's own figures are sailed as given, not squeezed to her cruising speed (the bug)", () => {
        const imported = BOATS[1][1];
        expect(sailsHerOwnFigures(imported.source)).toBe(true);
        // 12 kn on the beam: the file says 7.4 kn. Scaled to 6.5 kn cruising it was 6.4.
        const leg = passageSpeed(hudModel(imported), 12, 90, 0);
        expect(leg.kts).toBeCloseTo(7.4, 6);
        expect(hudModel(imported).polarKind).toBe('figures');
    });

    it('a learned cell reaches the HUD: 6.1 kn learned at 10 kn on the beam, not the factory figure', () => {
        const learned = BOATS[2][1];
        expect(learned.source).toBe('learned');
        expect(passageSpeed(hudModel(learned), 10, 90, 0).kts).toBeCloseTo(6.1, 6);
    });

    it('the generic polar is ONE figure set: the resolver scales it to her cruising speed, for the routers and the HUD alike', () => {
        // Before: the routers sailed the generic table raw (~5.9 kn on a fair
        // reach) while the HUD scaled it to her cruising speed — a 22% split.
        const generic = resolve({}, FORTY);
        expect(generic.source).toBe('default');
        expect(generic.label).toBe('Generic cruising polar');
        expect(polarReferenceKts(generic.polar)).toBeCloseTo(vesselCruisingSpeedKts(FORTY, 0), 6);
        // Still 'default': the route-weather edge keeps its own cruise-scaled fallback.
        expect(toEdgePolar(generic)).toBeNull();
        // A fast boat: her 8 kn, not the table's 5.9, in the routers' own figures.
        const fast = { ...SLOOP, cruisingSpeed: 8 };
        const quick = resolve({}, fast);
        expect(createPolarSpeedLookup(quick.polar, 15)(90)).toBeGreaterThan(7.5);
        expect(passageSpeed(hudModel(quick, fast), 15, 90, 0).kts).toBeCloseTo(
            createPolarSpeedLookup(quick.polar, 15)(90),
            9,
        );
        // A database shape is scaled by the resolver too, so the HUD's own shape scaling is identity.
        expect(sailsHerOwnFigures(BOATS[0][1].source)).toBe(false);
        expect(hudModel(BOATS[0][1]).polarKind).toBe('shape');
        expect(hudModel(generic, FORTY).polarKind).toBe('shape');
    });

    it('a Smart boat crossing from 7 to 8 learned cells: her ETA does not jump when nothing near her course was learned', () => {
        // Cells learned only running; she is on a beam reach (wind from 270°, course 000°).
        const eta = (learned: LearnedPolarSnapshot) => {
            const routing = resolve(SMART_ON, FORTY, learned);
            const plan = planPassage({
                index: NORTH,
                startAlongNm: 0,
                backNm: 0,
                startMs: T0,
                forecast: steady(14, 270),
                model: hudModel(routing, FORTY),
                maxMs: 72 * HOUR,
            });
            return { routing, hours: plan.arrivalMs! / HOUR };
        };
        const seven = eta(SEVEN_RUNNING);
        const eight = eta(EIGHT_RUNNING);
        expect(seven.routing.source).toBe('default');
        expect(seven.routing.label).toBe('Learning (7 of 42 cells), sailing on Generic cruising polar');
        expect(eight.routing.source).toBe('learned');
        expect(eight.routing.label).toBe('Learned (8 of 42 cells), the rest from Generic cruising polar');
        // The same, bar the learned blend's 0.01-kn rounding of factory cells (was +29% on the raw generic).
        expect(Math.abs(eight.hours - seven.hours) / seven.hours).toBeLessThan(0.002);
        // …and both are the routers' figure on her beam.
        const routerKts = createPolarSpeedLookup(eight.routing.polar, 14)(90);
        expect(eight.hours).toBeCloseTo(NORTH.totalNm / routerKts, 6);
    });

    it('her own figures are never capped at 1.3× cruising: the cap is for shapes about another boat', () => {
        // Her file says 9.4 kn at 135° in 25 kn; she cruises at 6 (a 1.3× cap would say 7.8).
        const quick = { ...SLOOP, cruisingSpeed: 6 };
        const imported = resolve({ polarData: IMPORTED, polarSource_type: 'file_import' }, quick);
        expect(passageSpeed(hudModel(imported, quick), 25, 135, 0).kts).toBeCloseTo(9.4, 6);
        // Past her last column (25 kn) she holds it, as every router does: 9.4 kn, not her cruising 6.
        expect(passageSpeed(hudModel(imported, quick), 30, 135, 0).kts).toBeCloseTo(9.4, 6);
    });

    /** An ORC-style certificate export: its columns stop at 20 kn (fictional figures). */
    const TO_20 = resolve(
        {
            polarData: {
                windSpeeds: IMPORTED.windSpeeds.slice(0, -1),
                angles: IMPORTED.angles,
                matrix: IMPORTED.matrix.map((row) => row.slice(0, -1)),
            },
            polarBoatModel: 'Fair Wind ORC-style.csv',
            polarSource_type: 'file_import',
        },
        SLOOP,
    );

    it("her own figures past her table's last column: she holds it, as the routers do (a trade-wind leg)", () => {
        const model = hudModel(TO_20);
        expect(model.polarKind).toBe('figures');
        expect(TO_20.polar.windSpeeds[TO_20.polar.windSpeeds.length - 1]).toBe(20);
        for (const tws of [20, 20.5, 22, 25]) {
            const router = createPolarSpeedLookup(TO_20.polar, tws)(90);
            expect(router, `${tws} kn`).toBeCloseTo(8.3, 6);
            const leg = passageSpeed(model, tws, 90, 0);
            expect(leg.how, `${tws} kn`).toBe('sail');
            expect(leg.kts, `${tws} kn`).toBeCloseTo(router, 9);
        }
        // 22 kn on the beam the whole way: the HUD's ETA is the routed one, not ~28% later.
        const plan = planPassage({
            index: NORTH,
            startAlongNm: 0,
            backNm: 0,
            startMs: T0,
            forecast: steady(22, 270),
            model,
            maxMs: 72 * HOUR,
        });
        expect(plan.arrivalMs! / HOUR).toBeCloseTo(NORTH.totalNm / 8.3, 6);
    });

    it("her own figures under her table's first column: she holds it down to the 4 kn engine rule, as the routers do", () => {
        const model = hudModel(TO_20);
        expect(TO_20.polar.windSpeeds[0]).toBe(6);
        for (const tws of [MOTOR_UNDER_TWS_KTS, 5, 5.9]) {
            const router = createPolarSpeedLookup(TO_20.polar, tws)(90);
            expect(router, `${tws} kn`).toBeCloseTo(5.3, 6);
            const leg = passageSpeed(model, tws, 90, 0);
            expect(leg.how, `${tws} kn`).toBe('sail');
            expect(leg.kts, `${tws} kn`).toBeCloseTo(router, 9);
        }
        // Under 4 kn of wind she motors, in the HUD as in the isochrone router.
        expect(passageSpeed(model, 3.5, 90, 0).how).toBe('motor');
    });

    it("a shape keeps its own guards: under a database table's first column the HUD still runs her speed down", () => {
        // The yacht database tables start at 6 kn; held, they credited 6-kn speed in a drift (2026-09-19).
        const database = BOATS[0][1];
        const first = database.polar.windSpeeds[0];
        expect(first).toBeGreaterThan(MOTOR_UNDER_TWS_KTS);
        const at6 = passageSpeed(hudModel(database), first, 90, 0).kts;
        const lower = passageSpeed(hudModel(database), (first + MOTOR_UNDER_TWS_KTS) / 2, 90, 0);
        expect(lower.how === 'motor' || lower.kts < at6).toBe(true);
    });

    it('she points where the routing polar first prices a speed, not at its 0° no-go row', () => {
        // Every routing polar now starts with zero rows at 0° and 5° inside its first priced angle.
        const imported = BOATS[1][1];
        expect(imported.polar.angles[0]).toBe(0);
        expect(pointingDeg({ closeHauledDeg: 30, polar: imported.polar })).toBe(38);
        const generic = resolve({});
        expect(pointingDeg({ closeHauledDeg: 25, polar: generic.polar })).toBe(30);
        // Dead upwind in the Caribbean trade she TACKS on her close-hauled figure; she does not motor.
        const nose = passageSpeed(hudModel(imported), 18, 0, 0);
        expect(nose.how).toBe('tack');
        expect(nose.kts).toBeGreaterThan(0);
    });
});

describe('Plan Your Day says which polar its times came from', () => {
    const speed = (routing: ResolvedRoutingPolar): PassageSpeedModel => hudModel(routing);
    it('her own figures, learned, a database shape and the generic shape each say so plainly', () => {
        const [database, imported, learned] = BOATS.map(([, r]) => r);
        expect(timesBasis(speed(imported), imported)).toBe("Times from your polar's own figures");
        expect(timesBasis(speed(learned), learned)).toBe('Times from your learned polar (10 of 42 cells)');
        expect(timesBasis(speed(database), database)).toBe('Times from your polar at 6.5 kn');
        const generic = resolve({});
        expect(timesBasis(speed(generic), generic)).toBe('Times from a typical cruising polar at 6.5 kn');
    });

    it('a Smart polar still filling says so after the times', () => {
        const learning = resolve(SMART_ON, SLOOP, SEVEN);
        expect(timesBasis(speed(learning), learning)).toBe(
            'Times from a typical cruising polar at 6.5 kn (Smart Polars still learning: 7 of 42 cells)',
        );
    });

    it('with the learner switched off in Preferences, nothing claims to be learning', () => {
        // "Routing uses: Smart" (Polars page) and the learner (Settings → Preferences) are separate switches.
        const off = { polarSource: 'smart', smartPolarsEnabled: false } as const;
        const filling = resolve(off, SLOOP, SEVEN);
        expect(filling.label).toBe('Smart polar (7 of 42 cells, learning off), sailing on Generic cruising polar');
        expect(filling.learning).toBe(false);
        expect(timesBasis(speed(filling), filling)).toBe(
            'Times from a typical cruising polar at 6.5 kn (Smart polar: 7 of 42 cells learned, learning off)',
        );
        const learned = resolve(off, SLOOP, COVERED);
        expect(learned.source).toBe('learned');
        expect(learned.label).toBe('Learned (10 of 42 cells, learning off), the rest from Generic cruising polar');
        expect(timesBasis(speed(learned), learned)).toBe(
            'Times from your learned polar (10 of 42 cells, learning off)',
        );
        // Never switched on at all reads the same as switched off.
        expect(resolve({ polarSource: 'smart' }, SLOOP, SEVEN).label).toBe(filling.label);
        // Switched on, it is learning.
        expect(resolve(SMART_ON, SLOOP, SEVEN).label).toBe(
            'Learning (7 of 42 cells), sailing on Generic cruising polar',
        );
        expect(resolve(SMART_ON, SLOOP, SEVEN).learning).toBe(true);
    });

    it('flat cruising speed is flat cruising speed, whatever the polar', () => {
        const imported = BOATS[1][1];
        expect(timesBasis({ ...speed(imported), mode: 'cruise' }, imported)).toBe('Times at 6.5 kn cruising speed');
    });

    it('Cape Cod to Nantucket on a beam reach: the planner walks her imported figures, not cruise-scaled ones', () => {
        // A due-south-east leg would vary the angle; this one is checked on the
        // same constant-course walk the HUD uses, at a US East Coast latitude.
        const imported = BOATS[1][1];
        const index = buildRouteIndex([
            { lat: 41.55, lon: -70.0 },
            { lat: 41.3, lon: -70.0 },
        ])!;
        const reply = {
            hourly: {
                time: Array.from({ length: 24 }, (_, h) => (T0 + h * HOUR) / 1000),
                wind_speed_10m: Array.from({ length: 24 }, () => 12),
                wind_direction_10m: Array.from({ length: 24 }, () => 90),
            },
        };
        const forecast = parseRouteForecast(
            [
                { alongNm: 0, lat: 41.55, lon: -70.0 },
                { alongNm: index.totalNm, lat: 41.3, lon: -70.0 },
            ],
            [reply, reply],
            'gfs_seamless',
            index.totalNm,
            T0,
        );
        const plan = planPassage({
            index,
            startAlongNm: 0,
            backNm: 0,
            startMs: T0,
            forecast,
            model: speed(imported),
            maxMs: 24 * HOUR,
        });
        expect(index.totalNm).toBeCloseTo(haversineNm(41.55, -70, 41.3, -70), 1);
        expect(plan.arrivalMs! / HOUR).toBeCloseTo(index.totalNm / 7.4, 6);
    });
});
