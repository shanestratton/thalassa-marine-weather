/**
 * Routes sail by the boat's own polar, with a real no-go zone (build 123,
 * package W1-03; gap register must-do #2, routing-uses-selected-polar).
 *
 * Before this, every router took `SmartPolarStore.exportToPolarData() ??
 * DEFAULT_CRUISING_POLAR`: the skipper's chosen polar was never read, and
 * the learned grid (zeros in every unsailed cell) reached the router only
 * after the Polars page had been opened. And because the engine's lookup
 * clamps any angle below a table's first row to that row, every route was
 * credited the first row's speed dead into the wind — the generic polar
 * "sailed" at 4.4 kn ten degrees off an 18 kn breeze.
 *
 * services/routingPolar.ts is now the one resolver: learned (blended) →
 * the skipper's imported/typed polar raw → a yacht-database shape scaled to
 * her cruising speed (the Passage HUD's rule) → the generic polar. Every
 * polar it hands a router has a no-go zone; the engine's clamp is untouched.
 *
 * The routing fixtures are worldwide and synthetic (constant wind, no land
 * mask): the Caribbean, the Med, the North Sea, the South Pacific, the US
 * West Coast and one Queensland case. Fictional boats only.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
    loadLargeData: vi.fn(async (): Promise<unknown> => null),
    saveLargeData: vi.fn(async () => undefined),
}));

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../services/nativeStorage', () => ({
    loadLargeData: storage.loadLargeData,
    saveLargeData: storage.saveLargeData,
}));

import {
    LEARNED_MIN_FILLED_CELLS,
    genericPolarFor,
    normaliseRoutingPolar,
    resolveRoutingPolarFrom,
    toEdgePolar,
    type LearnedPolarSnapshot,
    type ResolvedRoutingPolar,
    type RoutingPolarSettings,
} from '../services/routingPolar';
import { DEFAULT_CRUISING_POLAR } from '../services/defaultPolar';
import { POLAR_DATABASE } from '../data/polarDatabase';
import { polarReferenceKts } from '../services/passagePlan';
import { createPolarSpeedLookup } from '../services/isochrone/polar';
import {
    _testableInternals,
    computeIsochrones,
    type IsochroneNode,
    type IsochroneResult,
} from '../services/IsochroneRouter';
import { validateWeatherRouteRequest } from '../supabase/functions/_shared/route-weather-safety';
import { createEmptyPolar } from '../utils/polarParser';
import type { PolarData, VesselProfile } from '../types';

const { haversineNm } = _testableInternals;

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
const LAUNCH: VesselProfile = { ...SLOOP, name: 'Harbour Launch', type: 'power', cruisingSpeed: 9 };

const OCEANIS = POLAR_DATABASE.find((entry) => entry.model === 'Beneteau Oceanis 38.1')!;

/** An Expedition-style export: first row 38°, and a 0 kn column the edge would refuse. */
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

/** A smooth fictional shape: 0.35 at 20°, 1 at 100°, 0.75 at 180°. */
const shapeAt = (twa: number) =>
    twa <= 100 ? Math.min(1, 0.35 + ((twa - 20) / 80) * 0.65) : 1 - ((twa - 100) / 80) * 0.25;
const degreeTable = (from: number, step: number, windSpeeds: number[], tops: number[], below20 = 0.06): PolarData => {
    const angles = Array.from({ length: (180 - from) / step + 1 }, (_, i) => from + i * step);
    return {
        windSpeeds,
        angles,
        matrix: angles.map((a) => tops.map((top) => Math.round(top * (a < 20 ? below20 : shapeAt(a)) * 100) / 100)),
    };
};

/** A qtVlm/VPP-style export: 0–180° in 5° steps (37 rows), 0.3–0.5 kn inside 20°. */
const VPP_37_ROWS = degreeTable(0, 5, [6, 10, 15, 20], [5, 6.5, 7.5, 8]);
/** A 5° table from 40° to 180°: 29 rows, inside the edge's 30-row limit as it stands. */
const FIVE_DEGREE_29_ROWS = degreeTable(40, 5, [6, 10, 15, 20], [5, 6.5, 7.5, 8]);

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

const resolve = (
    patch: RoutingPolarSettings,
    vessel: VesselProfile = SLOOP,
    learned: LearnedPolarSnapshot | null = null,
): ResolvedRoutingPolar => resolveRoutingPolarFrom({ settings: patch, vessel, learned });
const COVERED: LearnedPolarSnapshot = { polar: learnedGrid(TEN_LEARNED_CELLS), filledCells: 10 };
/** "Routing uses: Smart" with the learner switched on (Settings → Preferences). */
const SMART_ON = { polarSource: 'smart', smartPolarsEnabled: true } as const;
/** The generic polar as Fair Wind (6.5 kn cruising) sails it: its shape scaled to her (build 125). */
const GENERIC_FOR_SLOOP = genericPolarFor(SLOOP).polar;

/** First angle of the polar where any speed is priced. */
const firstPricedAngle = (p: PolarData) => p.angles[p.matrix.findIndex((row) => row.some((v) => v > 0))];

/** What the route-weather edge prices for a custom polar: nothing inside 35°, nothing off its axes. */
function edgeSpeed(edge: PolarData, tws: number, twa: number): number {
    if (twa < 35) return 0;
    const off =
        twa < edge.angles[0] ||
        twa > edge.angles[edge.angles.length - 1] ||
        tws < edge.windSpeeds[0] ||
        tws > edge.windSpeeds[edge.windSpeeds.length - 1];
    return off ? 0 : createPolarSpeedLookup(edge, tws)(twa);
}
/** The client's figure where the edge would price it at all (its own 35° no-go on top). */
const clientSpeedPastEdgeNoGo = (polar: PolarData, tws: number, twa: number) =>
    twa < 35 ? 0 : createPolarSpeedLookup(polar, tws)(twa);

/** Best upwind VMG angle at `tws`, 0.5° steps — where a router would point. */
function bestUpwindTwa(p: PolarData, tws: number): number {
    const at = createPolarSpeedLookup(p, tws);
    let best = { twa: 0, vmg: -Infinity };
    for (let twa = 0; twa <= 90; twa += 0.5) {
        const vmg = at(twa) * Math.cos((twa * Math.PI) / 180);
        if (vmg > best.vmg + 1e-9) best = { twa, vmg };
    }
    return best.twa;
}

// ── The resolver ─────────────────────────────────────────────────

describe('resolveRoutingPolarFrom — which polar a route sails by', () => {
    it('no polar chosen: the generic cruising polar, said plainly, scaled to her cruising speed, with a no-go zone', () => {
        const r = resolve({});
        expect(r.source).toBe('default');
        expect(r.label).toBe('Generic cruising polar');
        expect(r.polar.angles).toEqual([0, 25, ...DEFAULT_CRUISING_POLAR.angles]);
        expect(r.polar.matrix[0].every((v) => v === 0)).toBe(true);
        expect(r.polar.matrix[1].every((v) => v === 0)).toBe(true);
        expect(r.polar.matrix.slice(2)).toEqual(GENERIC_FOR_SLOOP.matrix);
        expect(r.polar.windSpeeds).toEqual(DEFAULT_CRUISING_POLAR.windSpeeds);
        expect(r.signature).toMatch(/^[0-9a-f]{8}$/);
        // Build 125 (125-08): the SHAPE, scaled so a fair reaching breeze gives her 6.5 kn —
        // the HUD's rule and the edge's own fallback — not the table's ~5.9 kn raw.
        expect(polarReferenceKts(DEFAULT_CRUISING_POLAR)).toBeCloseTo(5.93, 2);
        expect(polarReferenceKts(r.polar)).toBeCloseTo(6.5, 6);
        expect(r.reason).toMatch(/scaled so a fair reaching breeze gives her 6\.5 kn/);
        expect(toEdgePolar(r)).toBeNull();
    });

    it('the generic polar is raw only when no cruising speed can be matched to it', () => {
        // No cruising speed and no length: nothing to scale to.
        const unknown = { ...SLOOP, cruisingSpeed: 0, length: 0 };
        const r = resolve({}, unknown);
        expect(r.polar.matrix.slice(2)).toEqual(DEFAULT_CRUISING_POLAR.matrix);
        expect(r.reason).toMatch(/unscaled/);
        // A 40-footer on "auto": sqrt(40) × 1.2 = 7.6 kn.
        expect(polarReferenceKts(resolve({}, { ...SLOOP, length: 40, cruisingSpeed: 0 }).polar)).toBeCloseTo(
            Math.sqrt(40) * 1.2,
            6,
        );
    });

    it("an imported polar is the skipper's own numbers: used raw, named after its file", () => {
        const r = resolve({
            polarData: IMPORTED,
            polarBoatModel: 'Fair Wind 2025.pol',
            polarSource_type: 'file_import',
            polarSource: 'factory',
        });
        expect(r.source).toBe('imported');
        expect(r.label).toBe('Fair Wind 2025.pol (imported)');
        // Raw: every priced row and column is the file's own (bar the 0 kn column).
        const firstReal = r.polar.angles.indexOf(38);
        expect(r.polar.angles.slice(firstReal)).toEqual(IMPORTED.angles);
        expect(r.polar.matrix.slice(firstReal)).toEqual(IMPORTED.matrix.map((row) => row.slice(1)));
    });

    it('drops TWS columns under 0.1 kn (the edge contract refuses them; the router motors there anyway)', () => {
        const r = resolve({ polarData: IMPORTED, polarSource_type: 'file_import' });
        expect(r.polar.windSpeeds).toEqual([6, 8, 10, 12, 16, 20, 25]);
        expect(r.polar.matrix.every((row) => row.length === 7)).toBe(true);
    });

    it('typed-in figures are raw too, and an unnamed import still says what it is', () => {
        const manual = resolve({ polarData: IMPORTED, polarSource_type: 'manual', polarBoatModel: 'Fair Wind' });
        expect(manual.source).toBe('manual');
        expect(manual.label).toBe('Fair Wind (your own figures)');
        const unnamed = resolve({ polarData: IMPORTED, polarSource_type: 'file_import' });
        expect(unnamed.label).toBe('Your imported polar');
        // PolarManagerTab treats an untyped polar as manual; so does routing.
        expect(resolve({ polarData: IMPORTED }).source).toBe('manual');
    });

    it("a yacht-database polar supplies the SHAPE, scaled to her cruising speed (the Passage HUD's rule)", () => {
        const r = resolve({
            polarData: OCEANIS.polar,
            polarBoatModel: OCEANIS.model,
            polarSource_type: 'database',
        });
        expect(r.source).toBe('database-scaled');
        expect(r.label).toBe('Beneteau Oceanis 38.1 (shape scaled to 6.5 kn)');
        expect(polarReferenceKts(r.polar)).toBeGreaterThan(6.4);
        expect(polarReferenceKts(r.polar)).toBeLessThan(6.6);
        // Raw, the generated table is ~45% slow: 3.5 kn on a beam reach in 15 kn.
        expect(createPolarSpeedLookup(OCEANIS.polar, 15)(90)).toBeCloseTo(3.5, 1);
        expect(createPolarSpeedLookup(r.polar, 15)(90)).toBeGreaterThan(6);
    });

    it('a database polar her cruising speed cannot match falls back to the generic polar, saying why', () => {
        const r = resolve(
            { polarData: OCEANIS.polar, polarBoatModel: OCEANIS.model, polarSource_type: 'database' },
            { ...SLOOP, cruisingSpeed: 30 },
        );
        expect(r.source).toBe('default');
        // The banner says her choice was refused, not just "generic".
        expect(r.label).toBe('Generic cruising polar (your yacht database polar could not be used)');
        expect(r.reason).toMatch(/cruising speed/i);
    });

    it("cruising speed 0 means 'auto' (VesselTab's Reset to auto): the shape is scaled to the HUD's own figure", () => {
        // VesselTab stores 0 on purpose; the Passage HUD reads it through
        // vesselCruisingSpeedKts (sqrt(LOA) × 1.2 for a sailing boat). The
        // router must scale her chosen shape to the same speed, not drop it.
        const r = resolve(
            { polarData: OCEANIS.polar, polarBoatModel: OCEANIS.model, polarSource_type: 'database' },
            { ...SLOOP, length: 38, cruisingSpeed: 0 },
        );
        expect(r.source).toBe('database-scaled');
        expect(r.label).toBe('Beneteau Oceanis 38.1 (shape scaled to 7.4 kn)');
        expect(polarReferenceKts(r.polar)).toBeCloseTo(Math.sqrt(38) * 1.2, 1);
        expect(toEdgePolar(r)).not.toBeNull();
    });

    it('a learned polar with too few cells is not used; the factory polar routes and the reason says so', () => {
        const r = resolve({ polarData: IMPORTED, polarSource_type: 'file_import', polarSource: 'smart' }, SLOOP, {
            polar: learnedGrid(TEN_LEARNED_CELLS.slice(0, 5)),
            filledCells: 5,
        });
        expect(LEARNED_MIN_FILLED_CELLS).toBe(8);
        expect(r.source).toBe('imported');
        expect(r.reason).toMatch(/too few/i);
    });

    it('a covered learned polar keeps every learned cell and fills ONLY its empty cells from the factory polar', () => {
        const learned = COVERED.polar!;
        const r = resolve(SMART_ON, SLOOP, COVERED);
        expect(r.source).toBe('learned');
        // Build 125 (125-08): it says how much it has learned, and where the rest comes from.
        expect(r.label).toBe('Learned (10 of 42 cells), the rest from Generic cruising polar');
        expect(r.reason).toMatch(/10 of 42/);
        const factory = normaliseRoutingPolar(GENERIC_FOR_SLOOP);
        const firstReal = r.polar.angles.indexOf(45);
        expect(r.polar.angles.slice(firstReal)).toEqual(learned.angles);
        // The learned columns, plus the factory's own light- and heavy-air
        // columns outside the learned 6–25 kn range.
        expect(r.polar.windSpeeds).toEqual([4, ...learned.windSpeeds, 30]);
        learned.angles.forEach((angle, a) => {
            learned.windSpeeds.forEach((tws, w) => {
                const got = r.polar.matrix[firstReal + a][r.polar.windSpeeds.indexOf(tws)];
                if (learned.matrix[a][w] > 0) expect(got).toBe(learned.matrix[a][w]);
                else expect(got).toBeCloseTo(createPolarSpeedLookup(factory, tws)(angle), 2);
                expect(got).toBeGreaterThan(0); // no learned zero survives into routing
            });
        });
    });

    it("outside the learned 6–25 kn range the blend is the factory polar's own figure, not the edge column held flat", () => {
        const r = resolve(SMART_ON, SLOOP, COVERED);
        const factory = normaliseRoutingPolar(GENERIC_FOR_SLOOP);
        for (const tws of [4, 30]) {
            for (const twa of [45, 60, 90, 120, 150, 180]) {
                expect(createPolarSpeedLookup(r.polar, tws)(twa), `${tws} kn / ${twa}°`).toBeCloseTo(
                    createPolarSpeedLookup(factory, tws)(twa),
                    2,
                );
            }
        }
        // The generic polar's 4 kn beam reach (2.2 kn, scaled to her 6.5 kn cruise) — not the 6 kn column's 3.8.
        const scale = 6.5 / polarReferenceKts(DEFAULT_CRUISING_POLAR);
        expect(createPolarSpeedLookup(r.polar, 4)(90)).toBeCloseTo(2.2 * scale, 2);
        expect(createPolarSpeedLookup(r.polar, 4)(90)).toBeLessThan(3.8 * scale);
    });

    it('a learned cell far outside the factory figure is held to 0.5–1.5× it (a surf or a paddlewheel spike)', () => {
        // 11 kn at 150° in 20 kn for a 6.5 kn boat; 0.5 kn at 150° in 6 kn.
        const spiky: LearnedPolarSnapshot = {
            polar: learnedGrid([...TEN_LEARNED_CELLS, [5, 4, 11.0], [0, 4, 0.5]]),
            filledCells: 12,
        };
        const r = resolve(SMART_ON, SLOOP, spiky);
        expect(r.source).toBe('learned');
        const factory = normaliseRoutingPolar(GENERIC_FOR_SLOOP);
        const at = (tws: number, twa: number) =>
            r.polar.matrix[r.polar.angles.indexOf(twa)][r.polar.windSpeeds.indexOf(tws)];
        expect(at(20, 150)).toBeCloseTo(1.5 * createPolarSpeedLookup(factory, 20)(150), 2); // 9.05, not 11
        expect(at(6, 150)).toBeCloseTo(0.5 * createPolarSpeedLookup(factory, 6)(150), 2); // 1.37, not 0.5
        // Cells inside the band are untouched.
        expect(at(15, 90)).toBe(7.0);
    });

    it('malformed polars never reach a router: each one falls back to the generic polar with a reason', () => {
        const bad: [string, PolarData][] = [
            [
                'NaN speed',
                { ...IMPORTED, matrix: IMPORTED.matrix.map((r, i) => (i === 4 ? [0, NaN, ...r.slice(2)] : r)) },
            ],
            ['TWS not increasing', { ...IMPORTED, windSpeeds: [0, 6, 8, 8, 12, 16, 20, 25] }],
            ['angles not increasing', { ...IMPORTED, angles: [38, 45, 52, 60, 75, 90, 90, 120, 135, 150, 165, 180] }],
            ['all zeros (the empty grid)', createEmptyPolar()],
            ['rows ≠ angles', { ...IMPORTED, matrix: IMPORTED.matrix.slice(1) }],
            [
                'speed dead into the wind',
                {
                    windSpeeds: [6, 12],
                    angles: [0, 90, 180],
                    matrix: [
                        [3, 4],
                        [5, 7],
                        [4, 6],
                    ],
                },
            ],
            [
                'too many zeros off the wind',
                { ...IMPORTED, matrix: IMPORTED.matrix.map((r, i) => (i >= 6 ? r.map(() => 0) : r)) },
            ],
            [
                'absurd speed',
                { ...IMPORTED, matrix: IMPORTED.matrix.map((r, i) => (i === 5 ? r.map((v) => v * 10) : r)) },
            ],
        ];
        for (const [name, polarData] of bad) {
            const r = resolve({ polarData, polarSource_type: 'file_import', polarBoatModel: 'broken.pol' });
            expect(r.source, name).toBe('default');
            expect(r.reason, name).toMatch(/not usable/i);
            // The banner says her polar was refused (the reason is only logged).
            expect(r.label, name).toBe('Generic cruising polar (your imported polar could not be used)');
        }
        const manual = resolve({ polarData: createEmptyPolar(), polarSource_type: 'manual' });
        expect(manual.label).toBe('Generic cruising polar (your own polar figures could not be used)');
    });

    it('a VPP-style file pricing a few tenths of a knot inside 20° is used: those rows become the no-go zone', () => {
        const r = resolve({ polarData: VPP_37_ROWS, polarSource_type: 'file_import', polarBoatModel: 'vpp.pol' });
        expect(r.source).toBe('imported');
        expect(r.label).toBe('vpp.pol (imported)');
        expect(firstPricedAngle(r.polar)).toBe(20);
        // Every figure from 20° on is the file's own.
        const from = VPP_37_ROWS.angles.indexOf(20);
        expect(r.polar.angles.slice(r.polar.angles.indexOf(20))).toEqual(VPP_37_ROWS.angles.slice(from));
        expect(r.polar.matrix.slice(r.polar.angles.indexOf(20))).toEqual(VPP_37_ROWS.matrix.slice(from));
        for (const tws of [6, 10, 15]) expect(createPolarSpeedLookup(r.polar, tws)(15)).toBe(0);
    });

    it('blank high-wind columns (OpenCPN-style) are dropped, not counted as zero speed', () => {
        const blankHigh: PolarData = {
            windSpeeds: [...IMPORTED.windSpeeds.slice(1), 35, 40],
            angles: IMPORTED.angles,
            matrix: IMPORTED.matrix.map((row) => [...row.slice(1), 0, 0]),
        };
        const r = resolve({ polarData: blankHigh, polarSource_type: 'file_import', polarBoatModel: 'Fair Wind.csv' });
        expect(r.source).toBe('imported');
        expect(r.polar.windSpeeds).toEqual([6, 8, 10, 12, 16, 20, 25]);
        // Above her last real column the lookup holds it (as for any polar).
        expect(createPolarSpeedLookup(r.polar, 35)(90)).toBeCloseTo(8.5, 5);
    });

    it("a non-sailing vessel keeps today's behaviour exactly", () => {
        const r = resolve(
            { polarData: IMPORTED, polarSource_type: 'file_import', polarSource: 'smart' },
            LAUNCH,
            COVERED,
        );
        expect(r.source).toBe('default');
        expect(r.polar).toEqual(DEFAULT_CRUISING_POLAR); // no no-go rows: motor routing is unchanged
        expect(toEdgePolar(r)).toBeNull();
    });

    it('the signature is stable for one polar and changes with the polar (it keys the precompute cache)', () => {
        const a = resolve({ polarData: IMPORTED, polarSource_type: 'file_import' });
        const again = resolve({ polarData: IMPORTED, polarSource_type: 'file_import' });
        const otherCruise = resolve(
            { polarData: OCEANIS.polar, polarSource_type: 'database' },
            { ...SLOOP, cruisingSpeed: 7 },
        );
        const database = resolve({ polarData: OCEANIS.polar, polarSource_type: 'database' });
        expect(again.signature).toBe(a.signature);
        expect(new Set([a.signature, otherCruise.signature, database.signature, resolve({}).signature]).size).toBe(4);
    });
});

// ── The no-go zone ───────────────────────────────────────────────

describe('the no-go zone lives in the resolved polar (the engine clamp is unchanged)', () => {
    it('documents the bug: the engine credits a raw polar its first row dead into the wind', () => {
        expect(createPolarSpeedLookup(DEFAULT_CRUISING_POLAR, 12)(0)).toBeCloseTo(3.8, 5);
        expect(bestUpwindTwa(DEFAULT_CRUISING_POLAR, 12)).toBe(0);
    });

    const cases: [string, ResolvedRoutingPolar][] = [
        ['generic', resolve({})],
        ['database (scaled)', resolve({ polarData: OCEANIS.polar, polarSource_type: 'database' })],
        ['imported', resolve({ polarData: IMPORTED, polarSource_type: 'file_import' })],
        ['learned (blended)', resolve({ polarSource: 'smart' }, SLOOP, COVERED)],
    ];
    for (const [name, r] of cases) {
        it(`${name}: no speed dead into the wind, and the best upwind angle is never inside the polar's first row`, () => {
            const first = firstPricedAngle(r.polar);
            for (const tws of [6, 10, 12, 18, 25]) {
                const at = createPolarSpeedLookup(r.polar, tws);
                expect(at(0)).toBe(0);
                expect(at(first - 5)).toBe(0);
                expect(bestUpwindTwa(r.polar, tws)).toBeGreaterThanOrEqual(first);
            }
        });
    }
});

// ── A learned polar says how much it has learned (build 125, 125-08) ──

describe('a learned polar says how much it has learned', () => {
    const SEVEN: LearnedPolarSnapshot = { polar: learnedGrid(TEN_LEARNED_CELLS.slice(0, 7)), filledCells: 7 };

    it('at 7 of 42 cells it is learning, and names the polar she sails on meanwhile', () => {
        expect(LEARNED_MIN_FILLED_CELLS).toBe(8);
        const onGeneric = resolve(SMART_ON, SLOOP, SEVEN);
        expect(onGeneric.source).toBe('default');
        expect(onGeneric.label).toBe('Learning (7 of 42 cells), sailing on Generic cruising polar');
        expect(onGeneric.learnedCells).toBe(7);
        const onImported = resolve(
            {
                ...SMART_ON,
                polarData: IMPORTED,
                polarBoatModel: 'Fair Wind 2025.pol',
                polarSource_type: 'file_import',
            },
            SLOOP,
            SEVEN,
        );
        expect(onImported.source).toBe('imported');
        expect(onImported.label).toBe('Learning (7 of 42 cells), sailing on Fair Wind 2025.pol (imported)');
        // The banner prints the label as it stands (components/map/PassageBanner).
    });

    it('with nothing learned yet (or the store not read) it says 0 of 42, never just the factory name', () => {
        expect(resolve(SMART_ON, SLOOP, null).label).toBe(
            'Learning (0 of 42 cells), sailing on Generic cruising polar',
        );
    });

    it('once it routes, it says how many cells are learned and where the rest come from', () => {
        const r = resolve(SMART_ON, SLOOP, COVERED);
        expect(r.label).toBe('Learned (10 of 42 cells), the rest from Generic cruising polar');
        expect(r.learnedCells).toBe(10);
        const full: LearnedPolarSnapshot = {
            polar: {
                windSpeeds: [6, 8, 10, 12, 15, 20, 25],
                angles: [45, 60, 90, 120, 150, 180],
                matrix: [45, 60, 90, 120, 150, 180].map(() => [4, 4.8, 5.4, 5.9, 6.3, 6.6, 6.7]),
            },
            filledCells: 42,
        };
        expect(resolve(SMART_ON, SLOOP, full).label).toBe('Learned (42 of 42 cells)');
        expect(resolve({ ...SMART_ON, smartPolarsEnabled: false }, SLOOP, full).label).toBe(
            'Learned (42 of 42 cells, learning off)',
        );
    });

    it('with the learner switched off (or never on), the label says so instead of "Learning"', () => {
        const off = resolve({ polarSource: 'smart', smartPolarsEnabled: false }, SLOOP, SEVEN);
        expect(off.label).toBe('Smart polar (7 of 42 cells, learning off), sailing on Generic cruising polar');
        expect(off.learning).toBe(false);
        expect(off.reason).toMatch(/learning off/);
        expect(resolve({ polarSource: 'smart' }, SLOOP, SEVEN).label).toBe(off.label);
        expect(resolve({ polarSource: 'smart', smartPolarsEnabled: false }, SLOOP, COVERED).label).toBe(
            'Learned (10 of 42 cells, learning off), the rest from Generic cruising polar',
        );
        // The figures do not change with the switch: only the words.
        expect(resolve({ polarSource: 'smart' }, SLOOP, COVERED).signature).toBe(
            resolve(SMART_ON, SLOOP, COVERED).signature,
        );
    });

    it('a factory choice carries no learning count at all', () => {
        expect(resolve({ polarSource: 'factory' }, SLOOP, COVERED).learnedCells).toBeUndefined();
        expect(resolve({}).learnedCells).toBeUndefined();
    });
});

// ── The edge payload ─────────────────────────────────────────────

describe('toEdgePolar — what the route-weather edge function is sent', () => {
    const DEPART = '2026-11-01T06:00:00Z';
    const request = (polar: PolarData | null) => ({
        centerline: [
            { lat: 43.3, lon: 5.37, name: 'Marseille' },
            { lat: 41.39, lon: 9.16, name: 'Bonifacio' },
        ],
        departure_time: DEPART,
        vessel: {
            type: 'sail',
            cruising_speed_kts: 6.5,
            max_wind_kts: 35,
            max_wave_m: 3,
            draft_m: 1.9,
            polar_data: polar,
        },
    });

    it('the generic polar is sent as null, so the edge keeps its own cruise-scaled fallback', () => {
        expect(toEdgePolar(resolve({}))).toBeNull();
    });

    for (const [name, r] of [
        ['imported', resolve({ polarData: IMPORTED, polarSource_type: 'file_import' })],
        ['database (scaled)', resolve({ polarData: OCEANIS.polar, polarSource_type: 'database' })],
        ['learned (blended)', resolve({ polarSource: 'smart' }, SLOOP, COVERED)],
    ] as [string, ResolvedRoutingPolar][]) {
        it(`${name}: passes the shared validateWeatherRouteRequest contract`, () => {
            const edge = toEdgePolar(r)!;
            expect(edge).not.toBeNull();
            const validated = validateWeatherRouteRequest(request(edge), Date.parse(DEPART));
            expect(validated.vessel.polar_data).toEqual(edge);
        });

        it(`${name}: matches the client everywhere the edge looks (it zeroes anything off a custom polar's axes)`, () => {
            const edge = toEdgePolar(r)!;
            // The edge's interpolatePolar returns 0 outside a custom polar's
            // axes: light air under the first column would be IMPASSABLE.
            for (const tws of [0.5, 3, 5, 26, 40, 60]) {
                expect(tws).toBeGreaterThanOrEqual(edge.windSpeeds[0]);
                expect(tws).toBeLessThanOrEqual(edge.windSpeeds[edge.windSpeeds.length - 1]);
                for (const twa of [0, 30, 35, 37, 42, 50, 90, 135, 179, 180]) {
                    expect(edgeSpeed(edge, tws, twa), `${tws} kn / ${twa}°`).toBeCloseTo(
                        clientSpeedPastEdgeNoGo(r.polar, tws, twa),
                        6,
                    );
                }
            }
        });
    }

    it('leaves out the 0° row (the edge zeroes everything inside 35° itself), so a 29-row 5° table still fits its 30 rows', () => {
        const r = resolve({ polarData: FIVE_DEGREE_29_ROWS, polarSource_type: 'file_import' });
        expect(r.source).toBe('imported');
        expect(r.polar.angles.length).toBe(31); // 0°, the 35° ramp and her 29 rows
        const edge = toEdgePolar(r)!;
        expect(edge.angles.length).toBeLessThanOrEqual(30);
        expect(edge.angles[0]).toBe(35); // the ramp stays: it shapes 35–40°, which the edge prices
        expect(validateWeatherRouteRequest(request(edge), Date.parse(DEPART)).vessel.polar_data).toEqual(edge);
        for (const tws of [3, 6, 12, 20, 30]) {
            for (const twa of [0, 30, 35, 37, 40, 42, 50, 90, 135, 180]) {
                expect(edgeSpeed(edge, tws, twa), `${tws} kn / ${twa}°`).toBeCloseTo(
                    clientSpeedPastEdgeNoGo(r.polar, tws, twa),
                    6,
                );
            }
        }
    });

    it('thins a table too big for the edge contract (37 rows past 35°, 31 columns) instead of sending nothing', () => {
        const fine = resolve({
            polarData: degreeTable(36, 4, [6, 10, 15, 20], [5, 6.5, 7.5, 8]),
            polarSource_type: 'file_import',
        });
        const wide = resolve({
            polarData: degreeTable(
                40,
                5,
                Array.from({ length: 31 }, (_, i) => i + 1),
                Array.from({ length: 31 }, (_, i) => Math.min(9, 1 + i * 0.4)),
            ),
            polarSource_type: 'file_import',
        });
        const vpp = resolve({ polarData: VPP_37_ROWS, polarSource_type: 'file_import' });
        for (const [name, r] of [
            ['4° steps', fine],
            ['31 TWS columns', wide],
            ['VPP 0–180°', vpp],
        ] as const) {
            const edge = toEdgePolar(r)!;
            expect(edge, name).not.toBeNull();
            expect(edge.angles.length, name).toBeLessThanOrEqual(30);
            expect(edge.windSpeeds.length, name).toBeLessThanOrEqual(30);
            expect(validateWeatherRouteRequest(request(edge), Date.parse(DEPART)).vessel.polar_data).toEqual(edge);
            expect(edge.angles[edge.angles.length - 1]).toBe(180);
            for (const tws of [6, 10, 15, 20]) {
                for (const twa of [35, 40, 52, 67, 90, 111, 150, 180]) {
                    const gap = Math.abs(edgeSpeed(edge, tws, twa) - clientSpeedPastEdgeNoGo(r.polar, tws, twa));
                    expect(gap, `${name}: ${tws} kn / ${twa}°`).toBeLessThan(0.3);
                }
            }
        }
        // The VPP table needs no thinning: only its rows inside 35° are left out.
        expect(toEdgePolar(vpp)!.angles).toEqual(VPP_37_ROWS.angles.filter((a) => a >= 35));
    });
});

// ── Loading the learned grid ─────────────────────────────────────

describe('the learned grid is read with ensureLoaded, never re-initialised over live samples', () => {
    beforeEach(() => {
        vi.resetModules();
        storage.loadLargeData.mockReset();
        storage.loadLargeData.mockResolvedValue(null);
        storage.saveLargeData.mockReset();
    });

    /** `n` clean samples per bucket: 3 is the store's display floor, 10 the routing floor. */
    function teach(
        store: { recordSample(tws: number, twa: number, stw: number): void },
        pairs: [number, number][],
        n = 3,
    ) {
        for (const [tws, twa] of pairs) for (let i = 0; i < n; i++) store.recordSample(tws, twa, 5 + tws / 10);
    }
    const NINE_BUCKETS: [number, number][] = [
        [8, 60],
        [10, 60],
        [12, 60],
        [8, 90],
        [10, 90],
        [12, 90],
        [8, 120],
        [10, 120],
        [12, 120],
    ];

    it('ensureLoaded reads the disk once, even when asked twice at once, and keeps a live grid', async () => {
        const { SmartPolarStore } = await import('../services/SmartPolarStore');
        await Promise.all([SmartPolarStore.ensureLoaded(), SmartPolarStore.ensureLoaded()]);
        expect(storage.loadLargeData).toHaveBeenCalledTimes(1);
        teach(SmartPolarStore, [[10, 90]]);
        await SmartPolarStore.ensureLoaded();
        expect(storage.loadLargeData).toHaveBeenCalledTimes(1);
        expect(SmartPolarStore.getStats().totalSamples).toBe(3);
        const exported = SmartPolarStore.exportToPolarData()!;
        expect(SmartPolarStore.filledCellCount()).toBe(exported.matrix.flat().filter((v) => v > 0).length);
        expect(SmartPolarStore.filledCellCount()).toBeGreaterThan(0);
    });

    it('resolveRoutingPolar blends a covered learned grid and never calls initialize()', async () => {
        const { SmartPolarStore } = await import('../services/SmartPolarStore');
        const { resolveRoutingPolar } = await import('../services/routingPolar');
        await SmartPolarStore.ensureLoaded();
        teach(SmartPolarStore, NINE_BUCKETS, 10);
        const initialize = vi.spyOn(SmartPolarStore, 'initialize');
        const r = await resolveRoutingPolar({ settings: { polarSource: 'smart' }, vessel: SLOOP });
        expect(r.source).toBe('learned');
        expect(initialize).not.toHaveBeenCalled();
        expect(SmartPolarStore.getStats().totalSamples).toBe(90); // nothing reloaded over the samples
    });

    it('routing counts a cell as learned only from buckets of 10+ samples (outlier rejection on), not ~15 s of sailing', async () => {
        const { SmartPolarStore } = await import('../services/SmartPolarStore');
        const { resolveRoutingPolar } = await import('../services/routingPolar');
        await SmartPolarStore.ensureLoaded();
        // Three samples a bucket: enough for the Polars page chart, not for routing.
        teach(SmartPolarStore, NINE_BUCKETS, 3);
        expect(SmartPolarStore.filledCellCount()).toBeGreaterThanOrEqual(LEARNED_MIN_FILLED_CELLS);
        const thin = await resolveRoutingPolar({ settings: { polarSource: 'smart' }, vessel: SLOOP });
        expect(thin.source).toBe('default');
        expect(thin.reason).toMatch(/too few/i);
        // Seven more each (10 a bucket): now routing uses them.
        teach(SmartPolarStore, NINE_BUCKETS, 7);
        const covered = await resolveRoutingPolar({ settings: { polarSource: 'smart' }, vessel: SLOOP });
        expect(covered.source).toBe('learned');
    });

    it('does not touch the learned store when routing is set to the factory polar', async () => {
        const { SmartPolarStore } = await import('../services/SmartPolarStore');
        const { resolveRoutingPolar } = await import('../services/routingPolar');
        const ensureLoaded = vi.spyOn(SmartPolarStore, 'ensureLoaded');
        const r = await resolveRoutingPolar({ settings: { polarSource: 'factory' }, vessel: SLOOP });
        expect(r.source).toBe('default');
        expect(ensureLoaded).not.toHaveBeenCalled();
        expect(storage.loadLargeData).not.toHaveBeenCalled();
    });

    it('with no vessel profile it routes as the default boat (a sailing sloop, 6 kn), like the voyage form', async () => {
        const { resolveRoutingPolar } = await import('../services/routingPolar');
        const r = await resolveRoutingPolar({
            settings: { polarData: OCEANIS.polar, polarBoatModel: OCEANIS.model, polarSource_type: 'database' },
            vessel: null,
        });
        expect(r.source).toBe('database-scaled');
        expect(r.label).toBe('Beneteau Oceanis 38.1 (shape scaled to 6 kn)');
    });
});

// ── Worldwide routes (synthetic constant wind, no land mask) ─────

describe('worldwide routes: upwind now tacks; off the wind nothing changes', () => {
    const DEPART = '2026-11-01T06:00:00Z';
    const ENGINE = { timeStepHours: 1, maxHours: 96, useDepthPenalty: false } as const;
    type Wind = { speed: number; direction: number };
    const sail = (polar: PolarData, from: Pt, to: Pt, wind: Wind) =>
        computeIsochrones(from, to, DEPART, polar, { getWind: () => wind }, ENGINE);
    type Pt = { lat: number; lon: number };

    /** The legs actually sailed (the drawn line is DP-smoothed; the wavefront chain is not). */
    function sailedLegs(r: IsochroneResult): IsochroneNode[] {
        const fronts = r.isochrones;
        let node = fronts[fronts.length - 1].nodes[0];
        const path = [node];
        for (let i = fronts.length - 1; i > 0 && node.parentIndex !== null; i--) {
            node = fronts[i - 1].nodes[node.parentIndex];
            path.unshift(node);
        }
        return path.slice(1);
    }
    const offTheWind = (heading: number, windFrom: number) => ((heading - windFrom + 540) % 360) - 180;
    const tacks = (legs: IsochroneNode[], windFrom: number) => {
        const sides = new Set(legs.filter((n) => n.twa < 90).map((n) => Math.sign(offTheWind(n.bearing, windFrom))));
        return sides.has(1) && sides.has(-1);
    };

    const ST_MARTIN = { lat: 18.02, lon: -63.05 };
    const ANTIGUA = { lat: 17.07, lon: -61.89 };
    const AIRLIE = { lat: -20.27, lon: 148.72 };
    const MACKAY = { lat: -21.1, lon: 149.23 };

    it('Caribbean, St Martin → Antigua in an 18 kn ESE trade (rhumb line 18° off the wind): she tacks', async () => {
        const wind = { speed: 18, direction: 112.5 };
        const generic = resolve({});
        // Before: the same (scaled) generic figures with no no-go zone.
        const before = (await sail(GENERIC_FOR_SLOOP, ST_MARTIN, ANTIGUA, wind))!;
        const after = (await sail(generic.polar, ST_MARTIN, ANTIGUA, wind))!;
        expect(before).not.toBeNull();
        expect(after).not.toBeNull();
        // Before: the raw polar sailed ten degrees off the breeze.
        expect(Math.min(...sailedLegs(before).map((n) => n.twa))).toBeLessThan(25);
        // After: never inside the no-go zone, on both tacks, and it takes longer.
        const legs = sailedLegs(after);
        expect(Math.min(...legs.map((n) => n.twa))).toBeGreaterThanOrEqual(25);
        expect(tacks(legs, wind.direction)).toBe(true);
        expect(after.totalDurationHours).toBeGreaterThan(before.totalDurationHours);

        const oceanis = resolve({ polarData: OCEANIS.polar, polarSource_type: 'database' });
        const db = (await sail(oceanis.polar, ST_MARTIN, ANTIGUA, wind))!;
        expect(Math.min(...sailedLegs(db).map((n) => n.twa))).toBeGreaterThanOrEqual(40);
        expect(tacks(sailedLegs(db), wind.direction)).toBe(true);
    });

    it('Queensland, Airlie Beach → Mackay into a 15 kn SE trade, on a scaled database polar: she tacks', async () => {
        const wind = { speed: 15, direction: 135 };
        const oceanis = resolve({ polarData: OCEANIS.polar, polarSource_type: 'database' });
        const r = (await sail(oceanis.polar, AIRLIE, MACKAY, wind))!;
        expect(r).not.toBeNull();
        const legs = sailedLegs(r);
        expect(Math.min(...legs.map((n) => n.twa))).toBeGreaterThanOrEqual(40);
        expect(tacks(legs, wind.direction)).toBe(true);
        // Beating costs time: slower than her cruising speed down the rhumb line.
        const straightNm = haversineNm(AIRLIE.lat, AIRLIE.lon, MACKAY.lat, MACKAY.lon);
        expect(r.totalDurationHours).toBeGreaterThan(straightNm / SLOOP.cruisingSpeed);
    });

    const offWind: [string, Pt, Pt, Wind][] = [
        [
            'the Med, Marseille → Bonifacio running before a 25 kn mistral',
            { lat: 43.3, lon: 5.37 },
            { lat: 41.39, lon: 9.16 },
            { speed: 25, direction: 315 },
        ],
        [
            'the North Sea, IJmuiden → Harwich on a beam reach in 15 kn NNW',
            { lat: 52.46, lon: 4.55 },
            { lat: 51.95, lon: 1.29 },
            { speed: 15, direction: 345 },
        ],
        [
            'the South Pacific, Papeete → Huahine broad reaching in a 15 kn trade',
            { lat: -17.53, lon: -149.57 },
            { lat: -16.71, lon: -151.04 },
            { speed: 15, direction: 90 },
        ],
        [
            'the US West Coast, Marina del Rey → Avalon reaching in 12 kn W',
            { lat: 33.97, lon: -118.46 },
            { lat: 33.34, lon: -118.33 },
            { speed: 12, direction: 270 },
        ],
        [
            'the Caribbean, St Martin → Antigua close reaching in an 18 kn ENE trade',
            ST_MARTIN,
            ANTIGUA,
            { speed: 18, direction: 67.5 },
        ],
    ];
    for (const [name, from, to, wind] of offWind) {
        it(`${name}: the same route and ETA as before (the no-go zone only touches upwind)`, async () => {
            const before = (await sail(GENERIC_FOR_SLOOP, from, to, wind))!;
            const after = (await sail(resolve({}).polar, from, to, wind))!;
            expect(after).not.toBeNull();
            expect(after.totalDurationHours).toBe(before.totalDurationHours);
            expect(after.totalDistanceNM).toBe(before.totalDistanceNM);
            expect(after.routeCoordinates).toEqual(before.routeCoordinates);
        });
    }

    it("the North Sea beam reach sails at the polar's beam speed, scaled to her: ETA ≈ distance ÷ 7.1 kn", async () => {
        const from = { lat: 52.46, lon: 4.55 };
        const to = { lat: 51.95, lon: 1.29 };
        const generic = resolve({});
        const r = (await sail(generic.polar, from, to, { speed: 15, direction: 345 }))!;
        // The generic table's 6.5 kn beam reach in 15 kn, × 6.5 / 5.93 for a 6.5-kn cruiser.
        const beamKts = createPolarSpeedLookup(generic.polar, 15)(90);
        expect(beamKts).toBeCloseTo((6.5 * 6.5) / polarReferenceKts(DEFAULT_CRUISING_POLAR), 6);
        const expected = haversineNm(from.lat, from.lon, to.lat, to.lon) / beamKts;
        expect(Math.abs(r.totalDurationHours - expected)).toBeLessThanOrEqual(1.5);
    });
});

// ── Guard ────────────────────────────────────────────────────────

describe('guard: every router reads the resolver', () => {
    function sources(dir: string): string[] {
        const out: string[] = [];
        for (const name of readdirSync(dir)) {
            const path = join(dir, name);
            if (statSync(path).isDirectory()) out.push(...sources(path));
            else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
        }
        return out;
    }

    it('no caller keeps the old `exportToPolarData() ?? DEFAULT_CRUISING_POLAR` fallback', () => {
        const offenders = ['components', 'hooks', 'services']
            .flatMap(sources)
            .filter((file) => /exportToPolarData\(\)\s*\?\?\s*DEFAULT_CRUISING_POLAR/.test(readFileSync(file, 'utf8')));
        expect(offenders).toEqual([]);
    });

    it('the four isochrone callers and the edge payload all go through resolveRoutingPolar', () => {
        for (const file of [
            'components/map/usePassagePlanner.ts',
            'hooks/useVoyageForm.ts',
            'services/isochroneEnhancer.ts',
            'services/IsochronePrecomputeCache.ts',
            'services/weatherRouter.ts',
        ]) {
            expect(readFileSync(file, 'utf8'), file).toContain('resolveRoutingPolar');
        }
    });

    it('weatherRouter no longer reads the legacy vessel_polars table (nothing writes it)', () => {
        expect(readFileSync('services/weatherRouter.ts', 'utf8')).not.toContain('vessel_polars');
    });
});
