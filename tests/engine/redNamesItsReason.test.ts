/**
 * A red route stretch names its reason; red the chart under the line does
 * not support is not drawn (round 2, Shane's field route, 2026-10-02).
 *
 * The field route's legs 3→4→5→6 cut the south-west corner of North Molle
 * Island and were drawn red with a glow, while each leg's chart check said
 * "no issue found" with 5.0 m least (the boat needs 2.9 m). Measured on the
 * Pi's own cells (a local run, nothing kept): the 50 m grid cells along that
 * corner are CAUTION because the charted 2–5 m band along the shore touches
 * them, while the line itself runs over the 5–10 m and 10–15 m bands. The
 * engine's exact reading of the line (chartSampler) found nothing shallow,
 * uncharted, disputed or near a hazard — the red was the cell's, not the
 * line's, and no words anywhere said why. Worse, red with no charted
 * shallow behind it is read as "no charted depth" (dangerWithoutChartedDepth),
 * which blocks Save with words that are not true.
 *
 * Synthetic water off an invented coast — no chart data.
 */
import { describe, expect, it } from 'vitest';
import type { Feature, FeatureCollection } from 'geojson';
import { collectShallowRuns } from '../../services/engine/shallowRuns';
import { buildNavGrid } from '../../services/engine/navGrid';
import { forEachCellOnSegment, latLonToGrid } from '../../services/engine/geometry';
import { CAUTION } from '../../services/engine/constants';
import { CAUTION_WHY, type InshoreLayers } from '../../services/engine/types';
import {
    dangerWithoutChartedDepth,
    inshoreRoutePieces,
    inshoreSegmentStates,
} from '../../components/map/inshoreRouteState';
import { routeRedStretches } from '../../components/map/routeRedReasons';
import { gridCautionSegMask } from '../../services/seaway/seawayRouter';

const rect = (x0: number, y0: number, x1: number, y1: number, props: Record<string, unknown>): Feature => ({
    type: 'Feature',
    properties: props,
    geometry: {
        type: 'Polygon',
        coordinates: [
            [
                [x0, y0],
                [x1, y0],
                [x1, y1],
                [x0, y1],
                [x0, y0],
            ],
        ],
    },
});
const fc = (...features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });

// One detailed chart: 10 m water to the north, a 2–5 m band along an invented
// shore to the south. The 50 m grid classes a cell by its centre: the row the
// line runs in has its centre 10 m inside the 2 m band, the line itself runs
// east 9 m north of the band's edge — in 10 m water the whole way.
const W = 170.0;
const SOUTH = -41.006;
const D_LAT = 50 / 111_320;
const EDGE = SOUTH + 12.7 * D_LAT;
const RANK = 4505;
const layers: InshoreLayers = {
    DEPARE: fc(
        rect(W, EDGE, W + 0.02, -40.99, { acronym: 'DEPARE', DRVAL1: 10, DRVAL2: 15, _scaleRank: RANK }),
        rect(W, -41.002, W + 0.02, EDGE, { acronym: 'DEPARE', DRVAL1: 2, DRVAL2: 5, _scaleRank: RANK }),
    ),
} as InshoreLayers;
const LAT = SOUTH + 12.88 * D_LAT; // 9 m off the 2 m band, in 10 m water
const polyline: [number, number][] = [
    [W + 0.002, LAT],
    [W + 0.009, LAT],
    [W + 0.016, LAT],
];
const DRAFT = 2.4;
const SAFETY = 0.5;
const grid = buildNavGrid(layers, [W - 0.005, SOUTH, W + 0.025, -40.986], 50, DRAFT, SAFETY, 30);

/** As the engine flags it: a segment is caution where it crosses a CAUTION cell. */
const cellCaution = polyline.slice(0, -1).map(([lonA, latA], i) => {
    const [lonB, latB] = polyline[i + 1];
    for (let k = 0; k <= 40; k++) {
        const t = k / 40;
        const { x, y } = latLonToGrid(grid, latA + (latB - latA) * t, lonA + (lonB - lonA) * t);
        if (grid.cells[y * grid.width + x] === CAUTION) return true;
    }
    return false;
});

describe('red the chart under the line does not support (the North Molle corner)', () => {
    it('the reproduction: the grid flags the line caution though it runs in 10 m water', () => {
        expect(cellCaution).toEqual([true, true]);
    });

    const out = collectShallowRuns({
        layers,
        grid,
        polyline,
        caution: cellCaution,
        draftM: DRAFT,
        safetyM: SAFETY,
        hazardMask: [false, false],
    });
    const masks = {
        polyline,
        cautionMask: cellCaution,
        canalMask: [false, false],
        channelMask: [false, false],
        offshoreMask: [false, false],
        chartedShallowMask: out.chartedShallowMask,
        landPaintConflictMask: out.landPaintConflictMask,
        cautionWhy: out.cautionWhy,
    };

    it('the exact reading says why: the grid cell, not the line', () => {
        expect(out.chartedShallowMask).toEqual([false, false]);
        expect(out.landPaintConflictMask).toEqual([false, false]);
        expect(out.cautionWhy).toEqual([CAUTION_WHY.GRID_ONLY, CAUTION_WHY.GRID_ONLY]);
        // No run, so no chip claims a needs-tide stretch the line is not in.
        expect(out.shallowRuns).toEqual([]);
    });

    it('so it is not drawn red, and Save is not told "no charted depth"', () => {
        const states = inshoreSegmentStates(masks);
        expect(states).toEqual(['green', 'green']);
        expect(dangerWithoutChartedDepth({ ...masks, stateMask: states })).toEqual([]);
        expect(inshoreRoutePieces(polyline, states!, [], out.chartedShallowSpans).map((p) => p.state)).toEqual([
            'green',
        ]);
    });

    it('a line that does enter the 2 m band stays red, and says so', () => {
        const into: [number, number][] = [polyline[0], [W + 0.009, EDGE - 10 / 111_320], polyline[2]];
        const r = collectShallowRuns({
            layers,
            grid,
            polyline: into,
            caution: [true, true],
            draftM: DRAFT,
            safetyM: SAFETY,
            hazardMask: [false, false],
        });
        expect(r.cautionWhy.every((why) => (why & CAUTION_WHY.SHALLOW) !== 0)).toBe(true);
        const states = inshoreSegmentStates({ ...masks, polyline: into, ...r, cautionMask: [true, true] })!;
        expect(states).toEqual(['danger', 'danger']);
        const stretches = routeRedStretches(into, inshoreRoutePieces(into, states, [], r.chartedShallowSpans), {
            ...r,
            cautionMask: [true, true],
            canalMask: [false, false],
            tideNeedM: DRAFT + SAFETY,
        });
        expect(stretches.length).toBeGreaterThan(0);
        expect(stretches.map((s) => s.why)).toEqual([
            'charted 2.0 m — shallower than the 2.9 m this boat needs; no tide data here shows a tide that clears it',
        ]);
        expect(stretches[0].lengthM).toBeGreaterThan(1000);
    });
});

describe("only a shallow band's cells are the grid's alone — every other red stays", () => {
    /** The same grid, with the caution cells under the line flagged as `flag`. */
    const flagged = (flag: 'wingCaution' | 'relaxMask' | 'landBlocked' | 'wetConflict' | 'markDiscBlocked') => {
        const marks = new Uint8Array(grid.width * grid.height);
        for (let k = 0; k <= 200; k++) {
            const lon = polyline[0][0] + ((polyline[2][0] - polyline[0][0]) * k) / 200;
            const { x, y } = latLonToGrid(grid, LAT, lon);
            if (grid.cells[y * grid.width + x] === CAUTION) marks[y * grid.width + x] = 1;
        }
        return { ...grid, [flag]: marks };
    };
    const run = (g: typeof grid) =>
        collectShallowRuns({
            layers,
            grid: g,
            polyline,
            caution: cellCaution,
            draftM: DRAFT,
            safetyM: SAFETY,
            hazardMask: [false, false],
        });
    const stateOf = (out: ReturnType<typeof run>) =>
        inshoreSegmentStates({
            polyline,
            cautionMask: cellCaution,
            canalMask: [false, false],
            channelMask: [false, false],
            offshoreMask: [false, false],
            chartedShallowMask: out.chartedShallowMask,
            landPaintConflictMask: out.landPaintConflictMask,
            cautionWhy: out.cautionWhy,
        });

    it("a pair-wing's cell (outside a lateral mark) keeps its red, and says so", () => {
        const out = run(flagged('wingCaution'));
        expect(out.cautionWhy).toEqual([CAUTION_WHY.WING, CAUTION_WHY.WING]);
        const states = stateOf(out)!;
        expect(states).toEqual(['danger', 'danger']);
        expect(
            routeRedStretches(polyline, inshoreRoutePieces(polyline, states), {
                cautionMask: cellCaution,
                cautionWhy: out.cautionWhy,
            }).map((s) => s.why),
        ).toEqual(['passes outside a lateral mark — the wrong side of a channel mark']);
    });

    it('land the router opened (a relax zone, a carve) keeps its red', () => {
        for (const flag of ['relaxMask', 'landBlocked'] as const) {
            const out = run(flagged(flag));
            expect(out.cautionWhy.every((why) => (why & CAUTION_WHY.LAND) !== 0)).toBe(true);
            expect(stateOf(out)).toEqual(['danger', 'danger']);
        }
    });

    it("decision-1 water and a mark's disc are never the grid's alone", () => {
        for (const flag of ['wetConflict', 'markDiscBlocked'] as const) {
            const out = run(flagged(flag));
            expect(out.cautionWhy).not.toContain(CAUTION_WHY.GRID_ONLY);
            expect(stateOf(out)).toEqual(['danger', 'danger']);
        }
    });

    it('without a hazard mask nothing is proved: red, said as the grid', () => {
        const out = collectShallowRuns({
            layers,
            grid,
            polyline,
            caution: cellCaution,
            draftM: DRAFT,
            safetyM: SAFETY,
        });
        expect(out.cautionWhy).toEqual([CAUTION_WHY.UNEXPLAINED, CAUTION_WHY.UNEXPLAINED]);
        expect(stateOf(out)).toEqual(['danger', 'danger']);
    });
});

describe('every red stretch names its reason', () => {
    const line: [number, number][] = [
        [W + 0.002, LAT],
        [W + 0.006, LAT],
        [W + 0.01, LAT],
        [W + 0.014, LAT],
        [W + 0.018, LAT],
    ];
    const base = {
        cautionMask: [true, true, true, true],
        canalMask: [false, false, false, true],
        tideNeedM: 2.9,
    };

    it('in words, per stretch, from what the router knows', () => {
        const masks = {
            ...base,
            cautionWhy: [CAUTION_WHY.HAZARD, CAUTION_WHY.DISAGREE, CAUTION_WHY.UNCHARTED, 0],
            cautionDepthM: [null, null, null, null],
            landPaintConflictMask: [false, true, false, false],
        };
        const states = inshoreSegmentStates({
            polyline: line,
            ...masks,
            channelMask: [false, false, false, false],
            offshoreMask: [false, false, false, false],
            chartedShallowMask: [false, false, false, false],
        })!;
        expect(states).toEqual(['danger', 'danger', 'danger', 'danger']);
        const words = routeRedStretches(line, inshoreRoutePieces(line, states), masks).map((s) => [s.startSeg, s.why]);
        expect(words).toEqual([
            [0, 'within the keep-out of a charted rock, wreck or obstruction'],
            [1, "the charts disagree: a coarser chart paints land over a finer chart's water here"],
            [2, 'no chart gives a depth for part of it (uncharted or unvouched water)'],
            [3, 'canal or marina basin: narrow water — keep to the charted channel'],
        ]);
    });

    it('a route from before the reasons still says it is red, never nothing', () => {
        const states = inshoreSegmentStates({
            polyline: line,
            ...base,
            channelMask: [false, false, false, false],
            offshoreMask: [false, false, false, false],
            chartedShallowMask: [false, false, false, false],
        })!;
        const stretches = routeRedStretches(line, inshoreRoutePieces(line, states), base);
        expect(stretches.map((s) => s.why)).toEqual([
            "the router's chart grid reads shallow, uncharted or disputed water here",
            'canal or marina basin: narrow water — keep to the charted channel',
        ]);
    });
});

// Fix-up review (2026-10-03): navGrid writes a lateral mark's disc, a berth or
// pontoon, a bridge too low for the boat, a hazard's buffer and land as
// BLOCKED (NaN) — never CAUTION. A promoted Seaway route's red comes from
// gridCautionSegMask, which flags a segment for ANY blocked cell it samples.
// The reason reader skipped every NaN cell, so such a segment over charted
// 10–15 m water read "the grid's alone" (GRID_ONLY), was drawn green and
// could be saved. And a caution segment on which no shallow band's cell was
// found at all was GRID_ONLY by vacuous truth.
describe('a blocked cell on the line is never the grid alone (production encoding)', () => {
    /** A point at fractional grid coordinates (x along lon, y along lat). */
    const at = (fx: number, fy: number): [number, number] => [
        grid.minLon + fx * grid.dLon,
        grid.minLat + fy * grid.dLat,
    ];
    // Row 20 is well inside the 10 m band: every cell on it reads 10 m.
    const DEEP: [number, number][] = [at(12.5, 20.5), at(24.5, 20.5), at(36.5, 20.5)];
    const asSeaway = (line: readonly [number, number][]) => line.map(([lon, lat]) => ({ lat, lon }));
    type Flag = 'landBlocked' | 'obstnBlocked' | 'markDiscBlocked' | 'berthBlocked' | 'clearanceBarred' | 'wingCaution';
    /** The grid with cell (x, y) set to `value` and `flags` raised there. */
    const withCell = (
        base: typeof grid,
        x: number,
        y: number,
        value: number,
        flags: readonly Flag[],
        shallowM?: number,
    ): typeof grid => {
        const idx = y * base.width + x;
        const cells = new Float32Array(base.cells);
        cells[idx] = value;
        const g: typeof grid = { ...base, cells };
        if (shallowM !== undefined) {
            const sd = new Float32Array(base.shallowDepthM ?? new Float32Array(base.width * base.height).fill(NaN));
            sd[idx] = shallowM;
            g.shallowDepthM = sd;
        }
        for (const flag of flags) {
            const mask = new Uint8Array(base[flag] ?? new Uint8Array(base.width * base.height));
            mask[idx] = 1;
            g[flag] = mask;
        }
        return g;
    };
    const masksFor = (
        line: readonly [number, number][],
        caution: boolean[],
        out: ReturnType<typeof collectShallowRuns>,
    ) => {
        const none = caution.map(() => false);
        return {
            polyline: line,
            cautionMask: caution,
            canalMask: none,
            channelMask: none,
            offshoreMask: none,
            chartedShallowMask: out.chartedShallowMask,
            landPaintConflictMask: out.landPaintConflictMask,
            cautionWhy: out.cautionWhy,
            cautionDepthM: out.cautionDepthM,
        };
    };
    const BLOCKED_WORDS =
        "touches a cell the router's chart grid keeps closed (land, the shore's keep-out or water no tide clears) — check it on the chart";
    const cases: { name: string; flags: Flag[]; bit: number; words: string }[] = [
        {
            name: "a lateral mark's disc",
            flags: ['obstnBlocked', 'markDiscBlocked'],
            bit: CAUTION_WHY.MARK,
            words: 'touches the keep-out the router keeps round a navigation mark — check which side to pass it on the chart',
        },
        {
            name: 'a berth or pontoon',
            flags: ['landBlocked', 'berthBlocked'],
            bit: CAUTION_WHY.STRUCTURE,
            words: 'touches a berth, pontoon or bridge the router keeps closed — check it on the chart',
        },
        {
            name: 'a bridge too low for this boat',
            flags: ['obstnBlocked', 'clearanceBarred'],
            bit: CAUTION_WHY.STRUCTURE,
            words: 'touches a berth, pontoon or bridge the router keeps closed — check it on the chart',
        },
        {
            name: "a hazard's buffer",
            flags: ['obstnBlocked'],
            bit: CAUTION_WHY.HAZARD,
            words: 'within the keep-out of a charted rock, wreck or obstruction',
        },
        {
            name: "land or the shore's buffer",
            flags: ['landBlocked'],
            bit: CAUTION_WHY.BLOCKED,
            words: BLOCKED_WORDS,
        },
        {
            name: 'a cell blocked for no flagged reason (water no tide clears)',
            flags: [],
            bit: CAUTION_WHY.BLOCKED,
            words: BLOCKED_WORDS,
        },
    ];

    for (const c of cases)
        it(`${c.name} over charted 10 m water stays red, blocks Save and says why`, () => {
            const g = withCell(grid, 18, 20, Number.NaN, c.flags);
            const caution = gridCautionSegMask(g, asSeaway(DEEP));
            expect(caution).toEqual([true, false]);
            const out = collectShallowRuns({
                layers,
                grid: g,
                polyline: DEEP,
                caution,
                draftM: DRAFT,
                safetyM: SAFETY,
                hazardMask: [false, false],
            });
            expect(out.cautionWhy[0]).not.toBe(CAUTION_WHY.GRID_ONLY);
            expect(out.cautionWhy[0] & c.bit).toBe(c.bit);
            expect(out.cautionWhy[1]).toBe(0);
            const masks = masksFor(DEEP, caution, out);
            const states = inshoreSegmentStates(masks)!;
            expect(states).toEqual(['danger', 'green']);
            expect(dangerWithoutChartedDepth({ ...masks, stateMask: states })).toEqual([0]);
            expect(routeRedStretches(DEEP, inshoreRoutePieces(DEEP, states), masks).map((s) => s.why)).toEqual([
                c.words,
            ]);
        });

    it('a caution segment with no shallow band cell under it is never the grid alone', () => {
        const caution = [true, true];
        const out = collectShallowRuns({
            layers,
            grid,
            polyline: DEEP,
            caution,
            draftM: DRAFT,
            safetyM: SAFETY,
            hazardMask: [false, false],
        });
        expect(out.cautionWhy).toEqual([CAUTION_WHY.UNEXPLAINED, CAUTION_WHY.UNEXPLAINED]);
        expect(inshoreSegmentStates(masksFor(DEEP, caution, out))).toEqual(['danger', 'danger']);
    });

    // Every cell the line touches is read, not samples along it: a line that
    // clips a cell's corner for a metre or two is in that cell, and the
    // producer's sampler (25 m, from either end, on another grid offset) may
    // be the one that found it.
    describe('every cell the line touches, corners included', () => {
        // Row 20 for 9.77 cells, then over the corner of cell (21, 21) for
        // 0.03 of a cell (~1.5 m), then on along row 21. All 10 m water by the
        // chart; cells (14, 20) and (15, 20) hold a shore band's 2 m.
        const CLIP: [number, number][] = [at(12.2, 20.5), at(23.5, 20.5 + (11.3 * 0.5) / 9.77)];
        let g = withCell(grid, 14, 20, CAUTION, [], 2);
        g = withCell(g, 15, 20, CAUTION, [], 2);
        const clipIdx = 21 * grid.width + 21;
        const run = (gg: typeof grid) =>
            collectShallowRuns({
                layers,
                grid: gg,
                polyline: CLIP,
                caution: [true],
                draftM: DRAFT,
                safetyM: SAFETY,
                hazardMask: [false],
            });

        it('the precondition: a 25 m sampler steps over the clipped corner', () => {
            const [[lonA, latA], [lonB, latB]] = CLIP;
            const segM = Math.hypot((lonB - lonA) / grid.dLon, (latB - latA) / grid.dLat) * 50;
            const steps = Math.ceil(segM / 25);
            const hit = Array.from({ length: steps + 1 }, (_, s) => {
                const { x, y } = latLonToGrid(
                    grid,
                    latA + ((latB - latA) * s) / steps,
                    lonA + ((lonB - lonA) * s) / steps,
                );
                return y * grid.width + x;
            });
            expect(hit).not.toContain(clipIdx);
            const { x, y } = latLonToGrid(grid, CLIP[1][1], CLIP[1][0]);
            expect(y).toBe(21);
            expect(x).toBe(23);
        });

        it("a shore band's cells alone: the grid's, not drawn red", () => {
            expect(run(g).cautionWhy).toEqual([CAUTION_WHY.GRID_ONLY]);
        });

        it("a wing cell clipped at its corner keeps the segment's red", () => {
            expect(run(withCell(g, 21, 21, CAUTION, ['wingCaution'], 2)).cautionWhy).toEqual([CAUTION_WHY.WING]);
        });

        it('a mark disc clipped at its corner keeps the red', () => {
            const out = run(withCell(g, 21, 21, Number.NaN, ['obstnBlocked', 'markDiscBlocked']));
            expect(out.cautionWhy[0] & CAUTION_WHY.MARK).toBe(CAUTION_WHY.MARK);
            expect(out.cautionWhy[0]).not.toBe(CAUTION_WHY.GRID_ONLY);
        });
    });
});

describe('forEachCellOnSegment: every cell a line touches', () => {
    const g = { minLon: 0, minLat: 0, dLon: 1, dLat: 1, width: 10, height: 10 } as unknown as typeof grid;
    const cellsOf = (a: [number, number], b: [number, number]) => {
        const out: string[] = [];
        forEachCellOnSegment(g, a, b, (idx) => out.push(`${idx % 10},${Math.floor(idx / 10)}`));
        return out;
    };

    it('a diagonal through cell corners touches both neighbours at each corner', () => {
        expect(cellsOf([0.5, 0.5], [2.5, 2.5])).toEqual(['0,0', '1,0', '0,1', '1,1', '2,1', '1,2', '2,2']);
    });

    it('is the same set walked either way', () => {
        const fwd = cellsOf([0.2, 3.7], [7.9, 1.1]);
        const back = cellsOf([7.9, 1.1], [0.2, 3.7]);
        expect(new Set(back)).toEqual(new Set(fwd));
        expect(fwd[0]).toBe('0,3');
        expect(fwd.at(-1)).toBe('7,1');
    });

    it('a corner clipped for a sliver is touched; cells off the grid are skipped', () => {
        // Enters row 1 at x = 2.97, crosses into column 3 at y ≈ 1.0015.
        const line: [[number, number], [number, number]] = [
            [0.2, 0.5],
            [4.5, 0.5 + (4.3 * 0.5) / 2.77],
        ];
        expect(cellsOf(...line)).toContain('2,1');
        expect(cellsOf([-3.5, 0.5], [1.5, 0.5])).toEqual(['0,0', '1,0']);
        expect(cellsOf([4.5, 4.5], [4.5, 4.5])).toEqual(['4,4']);
    });
});
