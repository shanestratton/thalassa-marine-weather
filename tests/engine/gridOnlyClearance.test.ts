/**
 * GRID_ONLY keeps its distance (round-2 review fix-up 2, 2026-10-03).
 *
 * c0309771 stopped drawing red a caution segment whose 50 m cells hold a
 * shallow band the line itself does not enter (CAUTION_WHY GRID_ONLY: Shane's
 * North Molle corner, red while each leg's review said "no issue found"). The
 * review found three ways that let red that should stay red go green and be
 * saved:
 *   1. GRID_ONLY asked only that the line not ENTER the shallow band, and by
 *      construction its line runs 0–35 m from that band: a line 0.5 m off a
 *      steep-to reef that dries 3 m, or along its very edge, was green and
 *      saveable (it had been red);
 *   2. a Notice to Mariners survey's 1.2 m stamp counted as "a shallow band's
 *      cell", while the line reads NtM depths on a 5 m walk — a line clipping
 *      the stamped cell's corner read the chart's 10 m: green;
 *   3. a charted hazard AREA had no keep-out in the hazard mask (a point-in-
 *      area test every 10 m), so a line 1 m beside foul ground, or across a
 *      strip of it under 10 m wide, was "clear of every hazard's buffer".
 * Each now keeps its red, and says why.
 *
 * Measured first on the real cells (tests/repro/whitsundayFieldRouteRealCells
 * .local.test.ts, AU421148 copied read-only to scratch and deleted after): the
 * field route's North Molle corner GRID_ONLY segments pass 12.3–27.3 m from
 * its 2–5 m band, 31.6 m+ from the 0–2 m band and 43 m+ from the reef that
 * dries 3.6 m — clear of 10 m and 30 m, so the corner stays green.
 *
 * Re-pinned 2026-10-03 (the real-chart check): a line too close keeps its red
 * over the STRETCH inside the clearance — a chartedShallowSpan with `near`,
 * on any segment (tests/engine/clearanceStretch.test.ts) — not by turning its
 * whole segment NEAR_SHALLOW: the segment reads GRID_ONLY, the drawn line is
 * red where it is close, Save is refused by the stretch, and a tide that
 * clears the band itself may draw it amber (decision 10). Each line here runs
 * beside its band end to end, so the whole of it is still drawn red.
 *
 * Synthetic water off an invented coast — no chart data.
 */
import { describe, expect, it } from 'vitest';
import type { Feature, FeatureCollection, Polygon } from 'geojson';
import { collectShallowRuns, nearShallowBand, SHALLOW_BAND_CLEARANCE_M } from '../../services/engine/shallowRuns';
import { buildNavGrid } from '../../services/engine/navGrid';
import { forEachCellOnSegment, haversineM, latLonToGrid } from '../../services/engine/geometry';
import { CAUTION } from '../../services/engine/constants';
import { hazardBufferSegments } from '../../services/engine/safetyAudit';
import { chartAreaIndexFor } from '../../services/routing/leadLandClip';
import { CAUTION_WHY, type InshoreLayers, type NavGrid } from '../../services/engine/types';
import {
    dangerWithoutChartedDepth,
    inshoreRoutePieces,
    inshoreSegmentStates,
} from '../../components/map/inshoreRouteState';
import { routeRedStretches } from '../../components/map/routeRedReasons';
import { evaluateAutoroutingProposalSave } from '../../services/autoroutingProposalSave';
import { routeInshore } from '../../services/inshoreRouterEngine';
import type { AutoroutingTrialRoute } from '../../types/autorouting';

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

const W = 170.0;
const SOUTH = -41.006;
const D_LAT = 50 / 111_320;
const M_LAT = 1 / 111_320;
const RANK = 4505;
const DRAFT = 2.4;
const SAFETY = 0.5;
const FLOOR = DRAFT + SAFETY;
const BBOX: [number, number, number, number] = [W - 0.005, SOUTH, W + 0.025, -40.986];
const band = (y0: number, y1: number, d1: number, d2: number): Feature =>
    rect(W, y0, W + 0.02, y1, { acronym: 'DEPARE', DRVAL1: d1, DRVAL2: d2, _scaleRank: RANK });

/** As the engine's samplers flag it: a segment is caution where it touches a CAUTION or blocked cell. */
const cautionOf = (grid: NavGrid, line: readonly [number, number][]): boolean[] =>
    line.slice(0, -1).map((a, i) => {
        let red = false;
        forEachCellOnSegment(grid, a, line[i + 1], (idx) => {
            const v = grid.cells[idx];
            if (Number.isNaN(v) || v === CAUTION) red = true;
        });
        return red;
    });

/** An east-going line along `lat`, in two segments. */
const eastAt = (lat: number): [number, number][] => [
    [W + 0.002, lat],
    [W + 0.009, lat],
    [W + 0.016, lat],
];

function read(layers: InshoreLayers, grid: NavGrid, line: [number, number][], hazard?: boolean[]) {
    const caution = cautionOf(grid, line);
    const hazardMask = hazard ?? line.slice(0, -1).map(() => false);
    const out = collectShallowRuns({
        layers,
        grid,
        polyline: line,
        caution,
        draftM: DRAFT,
        safetyM: SAFETY,
        hazardMask,
    });
    const none = caution.map(() => false);
    const masks = {
        polyline: line,
        cautionMask: caution,
        canalMask: none,
        channelMask: none,
        offshoreMask: none,
        chartedShallowMask: out.chartedShallowMask,
        landPaintConflictMask: out.landPaintConflictMask,
        cautionWhy: out.cautionWhy,
        cautionDepthM: out.cautionDepthM,
        cautionNearShallow: out.cautionNearShallow,
    };
    const states = inshoreSegmentStates(masks)!;
    const pieces = inshoreRoutePieces(line, states, [], out.chartedShallowSpans);
    return {
        caution,
        out,
        states,
        /** The drawn colours, in order (adjacent pieces of one colour merged). */
        drawn: pieces.map((p) => p.state),
        unsaveable: dangerWithoutChartedDepth({ ...masks, stateMask: states }),
        save: evaluateAutoroutingProposalSave(
            {
                provider: 'Thalassa',
                coordinates: line,
                engine: { ...masks, stateMask: states, chartedShallowSpans: out.chartedShallowSpans, hardLandAwayM: 0 },
            } as unknown as AutoroutingTrialRoute,
            null,
            DRAFT,
            false,
        ),
        words: routeRedStretches(line, pieces, {
            ...masks,
            chartedShallowSpans: out.chartedShallowSpans,
            tideNeedM: FLOOR,
        }).map((s) => s.why),
    };
}

/** No tide data: the words a liftable stretch ends with (decision 10). */
const NO_TIDE = '; no tide data here shows a tide that clears it';
const NEAR_SAVE = {
    eligible: false,
    reason: 'Part of this route passes too close to water charted shallower than this boat needs. It cannot be saved.',
};

// ── 1. A steep-to reef that dries 3 m, beside 5–10 m water ───────────────
describe('a line beside a steep-to drying reef keeps its red', () => {
    // The reef's edge sits 0.2 of a row above row 12's centre: row 12 is
    // CAUTION (its centre dries), the line runs in row 12 just north of it.
    const EDGE = SOUTH + 12.7 * D_LAT;
    const layers = { DEPARE: fc(band(EDGE, -40.99, 5, 10), band(-41.002, EDGE, -3, 0)) } as InshoreLayers;
    const grid = buildNavGrid(layers, BBOX, 50, DRAFT, SAFETY, 30);

    for (const [name, offM] of [
        ['0.5 m off', 0.5],
        ['0.05 m off', 0.05],
        ['exactly on its edge', 0],
    ] as const)
        it(`${name}: red, "runs on the edge of water charted to dry 3.0 m", and not saveable`, () => {
            const line = eastAt(EDGE + offM * M_LAT);
            const r = read(layers, grid, line);
            expect(r.caution).toEqual([true, true]);
            // c0309771: GRID_ONLY, green and saveable. The line itself reads
            // 5 m+ (on the very edge too: the ray cast puts it in the deep band).
            expect(r.out.chartedShallowMask).toEqual([false, false]);
            // 7f230264: NEAR_SHALLOW, the whole segment red; since the
            // real-chart check (2026-10-03) the segment is the grid's alone and
            // the stretch inside the clearance — here all of it — is drawn red.
            expect(r.out.cautionWhy).toEqual([CAUTION_WHY.GRID_ONLY, CAUTION_WHY.GRID_ONLY]);
            expect(r.out.cautionNearShallow.map((n) => n && [n.depthM, n.requiredM])).toEqual([
                [-3, 30],
                [-3, 30],
            ]);
            for (const n of r.out.cautionNearShallow) expect(n!.clearanceM).toBeCloseTo(offM, 3);
            const near = r.out.chartedShallowSpans.filter((x) => x.near);
            expect(near.map((x) => [x.startSeg, x.startT, x.endSeg, x.endT, x.minDepthM])).toEqual([
                [0, 0, 0, 1, -3],
                [1, 0, 1, 1, -3],
            ]);
            expect(r.states).toEqual(['green', 'green']);
            expect(r.drawn).toEqual(['danger']);
            expect(r.save).toEqual(NEAR_SAVE);
            expect(r.words).toEqual([
                `runs on the edge of water charted to dry 3.0 m — the router keeps 30 m off it${NO_TIDE}`,
            ]);
        });

    it('the depth under the line is not what is short: a tide must clear the reef itself (decision 10)', () => {
        const r = read(layers, grid, eastAt(EDGE + 0.5 * M_LAT));
        expect(r.out.tideDepthM).toEqual([null, null]);
        expect(r.out.cautionDepthM).toEqual([null, null]);
        // The stretch's tide depth is the reef's: −3 m needs +5.9 m.
        expect(r.out.chartedShallowSpans.map((x) => [x.minDepthM, x.tideLiftable])).toEqual([
            [-3, true],
            [-3, true],
        ]);
    });

    it('5 m off says how far', () => {
        const r = read(layers, grid, eastAt(EDGE + 5 * M_LAT));
        expect(r.words).toEqual([
            `passes 5 m from water charted to dry 3.0 m — the router keeps 30 m off it${NO_TIDE}`,
        ]);
    });

    it('Save says what it is: too close to shallow water, not "no charted depth"', () => {
        const r = read(layers, grid, eastAt(EDGE + 0.5 * M_LAT));
        expect(r.unsaveable).toEqual([]);
        expect(r.save).toEqual(NEAR_SAVE);
    });
});

// ── 1c. A contour-continuous band (2–5 m beside 10–15 m) asks for 10 m ──
describe("a 2–5 m band's edge (the 5 m contour) asks for 10 m, not 30 m", () => {
    const EDGE = SOUTH + 12.7 * D_LAT;
    const layers = { DEPARE: fc(band(EDGE, -40.99, 10, 15), band(-41.002, EDGE, 2, 5)) } as InshoreLayers;
    const grid = buildNavGrid(layers, BBOX, 50, DRAFT, SAFETY, 30);

    it(`12 m off (the field route's least was 12.3 m): the grid's alone, not drawn red`, () => {
        const r = read(layers, grid, eastAt(EDGE + 12 * M_LAT));
        expect(r.caution).toEqual([true, true]);
        expect(r.out.cautionWhy).toEqual([CAUTION_WHY.GRID_ONLY, CAUTION_WHY.GRID_ONLY]);
        expect(r.states).toEqual(['green', 'green']);
        expect(r.unsaveable).toEqual([]);
    });

    it("9 m off (c0309771's own synthetic line): red, and says how close", () => {
        const r = read(layers, grid, eastAt(EDGE + 9 * M_LAT));
        // Re-pinned 2026-10-03: the stretch, not the segment (see the header).
        expect(r.out.cautionWhy).toEqual([CAUTION_WHY.GRID_ONLY, CAUTION_WHY.GRID_ONLY]);
        expect(SHALLOW_BAND_CLEARANCE_M).toBe(10);
        expect(r.out.cautionNearShallow.map((n) => n && Math.round(n.clearanceM))).toEqual([9, 9]);
        expect(r.states).toEqual(['green', 'green']);
        expect(r.drawn).toEqual(['danger']);
        expect(r.words).toEqual([`passes 9 m from water charted 2.0 m — the router keeps 10 m off it${NO_TIDE}`]);
    });

    it('a deeper boat makes the same band a cliff: its deep end (5 m) no longer clears the keel', () => {
        const deep = buildNavGrid(layers, BBOX, 50, 5.0, SAFETY, 30);
        const line = eastAt(EDGE + 12 * M_LAT);
        const near = nearShallowBand({
            grid: deep,
            depthBands: chartAreaIndexFor(layers).depth,
            floorM: 5.5,
            cliffClearanceM: 30,
            a: line[0],
            b: line[1],
        });
        expect(near.near?.requiredM).toBe(30);
    });
});

// ── 1, through the real engine: a 30 m gap in a reef that dries 3 m ──────
describe('the real engine through a gap in a drying reef', () => {
    // A barrier reef 400 m thick running across a 60° passage 30 m wide, in
    // 5–10 m water (a probe of 140 such routes, 2026-10-03, found this one:
    // its last leg cut the gap's corner 1 m off the reef, GRID_ONLY and green
    // before this fix-up).
    const O = [170.0, -41.0];
    const KX = 111_320 * Math.cos((41 * Math.PI) / 180);
    const th = (60 * Math.PI) / 180;
    const at = (along: number, across: number): [number, number] => [
        O[0] + (Math.cos(th) * along - Math.sin(th) * across) / KX,
        O[1] + (Math.sin(th) * along + Math.cos(th) * across) / 111_320,
    ];
    const ring = (pts: [number, number][]): Polygon => ({ type: 'Polygon', coordinates: [[...pts, pts[0]]] });
    const reefs = [
        ring([at(-200, 15), at(200, 15), at(200, 3000), at(-200, 3000)]),
        ring([at(-200, -15), at(-200, -3000), at(200, -3000), at(200, -15)]),
    ];
    const dries = { acronym: 'DEPARE', DRVAL1: -3, DRVAL2: 0, _scaleRank: RANK };
    const water = rect(169.95, -41.04, 170.05, -40.96, { acronym: 'DEPARE', DRVAL1: 5, DRVAL2: 10, _scaleRank: RANK });
    const layers = {
        DEPARE: fc(water, ...reefs.map((g): Feature => ({ type: 'Feature', properties: dries, geometry: g }))),
    } as InshoreLayers;
    const from = at(-700, 300);
    const to = at(700, -150);
    /** Metres from a→b to the reefs' rings, by sampling every 0.25 m (the
     *  test's own measure, independent of the engine's). */
    const offReefM = (a: [number, number], b: [number, number]): number => {
        const n = Math.max(1, Math.ceil(haversineM(a[1], a[0], b[1], b[0]) / 0.25));
        let best = Infinity;
        for (const g of reefs) {
            const ringPts = g.coordinates[0];
            for (let k = 0; k <= n; k++) {
                const p = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n];
                for (let j = 1; j < ringPts.length; j++) {
                    const [c, d] = [ringPts[j - 1], ringPts[j]];
                    const ex = (d[0] - c[0]) * KX;
                    const ey = (d[1] - c[1]) * 111_320;
                    const px = (p[0] - c[0]) * KX;
                    const py = (p[1] - c[1]) * 111_320;
                    const t = Math.max(0, Math.min(1, (px * ex + py * ey) / (ex * ex + ey * ey)));
                    best = Math.min(best, Math.hypot(px - t * ex, py - t * ey));
                }
            }
        }
        return best;
    };

    it('nothing within 30 m of the reef is drawn green, and the stretch through the gap says why', () => {
        const r = routeInshore(layers, {
            fromLat: from[1],
            fromLon: from[0],
            toLat: to[1],
            toLon: to[0],
            draftM: DRAFT,
            safetyM: SAFETY,
        });
        expect('polyline' in r).toBe(true);
        if (!('polyline' in r)) return;
        const states = inshoreSegmentStates(r)!;
        // Re-pinned 2026-10-03 (the real-chart check): the drawn line, read
        // every metre — the stretch inside the clearance, on any segment.
        const pieces = inshoreRoutePieces(r.polyline, states, r.surveyRuns ?? [], r.chartedShallowSpans ?? []);
        const drawnAt = (u: number) => pieces.find((p) => u >= p.u0 && u <= p.u1)?.state;
        for (let i = 0; i < r.polyline.length - 1; i++) {
            const [a, b] = [r.polyline[i], r.polyline[i + 1]];
            const n = Math.max(1, Math.ceil(haversineM(a[1], a[0], b[1], b[0])));
            for (let k = 1; k < n; k++) {
                const t = k / n;
                const p: [number, number] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
                const offM = offReefM(p, p);
                if (offM < 29.5)
                    expect(drawnAt(i + t), `segment ${i} at ${t.toFixed(3)}, ${offM.toFixed(1)} m off`).toBe('danger');
            }
        }
        // c0309771: the gap's corner was cut 1 m off the reef, GRID_ONLY, green.
        const near = (r.chartedShallowSpans ?? []).filter((x) => x.near);
        expect(near.length).toBeGreaterThan(0);
        for (const x of near) expect(x.near).toMatchObject({ depthM: -3, requiredM: 30 });
        expect(Math.min(...near.map((x) => x.near!.clearanceM))).toBeLessThan(15);
    });
});

// ── 1b. A drying band in the NEXT row, beside a 2–5 m cell the line touches ─
describe('a drying band within reach counts though the line touches only a 2–5 m cell', () => {
    // South to north: dries (to row 12.8), a 27.5 m strip of 10–15 m with the
    // line in it at row 13.1, then 2–5 m from row 13.35. The line touches row
    // 13 only (CAUTION: its centre, 13.5, is 2–5 m), 12.5 m from the 2–5 m
    // band — clear of its 10 m — and 15 m from the reef in row 12.
    const DRY = SOUTH + 12.8 * D_LAT;
    const SHOAL = SOUTH + 13.35 * D_LAT;
    const layers = {
        DEPARE: fc(band(-41.002, DRY, -3, 0), band(DRY, SHOAL, 10, 15), band(SHOAL, -40.99, 2, 5)),
    } as InshoreLayers;
    const grid = buildNavGrid(layers, BBOX, 50, DRAFT, SAFETY, 30);
    const line = eastAt(SOUTH + 13.1 * D_LAT);

    it('the precondition: every cell the line touches is in row 13', () => {
        const rows = new Set<number>();
        forEachCellOnSegment(grid, line[0], line[2], (idx) => rows.add(Math.floor(idx / grid.width)));
        expect([...rows]).toEqual([latLonToGrid(grid, line[0][1], line[0][0]).y]);
        expect(latLonToGrid(grid, line[0][1], line[0][0]).y).toBe(13);
    });

    it('red: 15 m from water charted to dry, which asks for 30 m', () => {
        const r = read(layers, grid, line);
        expect(r.caution).toEqual([true, true]);
        // Re-pinned 2026-10-03: the stretch, not the segment (see the header).
        expect(r.out.cautionWhy).toEqual([CAUTION_WHY.GRID_ONLY, CAUTION_WHY.GRID_ONLY]);
        expect(r.words).toEqual([
            `passes 15 m from water charted to dry 3.0 m — the router keeps 30 m off it${NO_TIDE}`,
        ]);
        expect(r.states).toEqual(['green', 'green']);
        expect(r.drawn).toEqual(['danger']);
    });
});

// ── 2. A Notice to Mariners survey's sub-floor stamp is not a shallow band ─
describe("a line clipping an NtM survey cell's corner keeps its red", () => {
    // 10–15 m over the whole grid.
    const layers = {
        DEPARE: fc(rect(...BBOX, { acronym: 'DEPARE', DRVAL1: 10, DRVAL2: 15, _scaleRank: RANK })),
    } as InshoreLayers;
    const plain = buildNavGrid(layers, BBOX, 50, DRAFT, SAFETY, 30);
    // One cell, (20, 30): a fresh survey charts 1.2 m there.
    const cx = plain.minLon + 20.5 * plain.dLon;
    const cy = plain.minLat + 30.5 * plain.dLat;
    const half = 0.2;
    const NTMZONE = fc(
        rect(cx - half * plain.dLon, cy - half * plain.dLat, cx + half * plain.dLon, cy + half * plain.dLat, {
            _class: 'ntm-survey',
            depthM: 1.2,
            _noticeKey: 'T1',
        }),
    );
    const withNtm = { ...layers, NTMZONE } as InshoreLayers;
    const grid = buildNavGrid(withNtm, BBOX, 50, DRAFT, SAFETY, 30);
    const idx = 30 * grid.width + 20;
    // A diagonal (x + y = 51.96 in cells) across the cell's north-east corner
    // (21, 31): inside it for 0.04 √2 of a cell, ~2.8 m.
    const at = (fx: number, fy: number): [number, number] => [
        grid.minLon + fx * grid.dLon,
        grid.minLat + fy * grid.dLat,
    ];
    const line: [number, number][] = [at(16.96, 35.0), at(25.0, 26.96)];

    it('the precondition: the survey stamped one sub-floor cell, and the line clips its corner', () => {
        expect(grid.cells[idx]).toBe(CAUTION);
        expect(grid.ntmRiseM?.[idx]).toBeCloseTo(FLOOR - 1.2, 5);
        const cells: number[] = [];
        forEachCellOnSegment(grid, line[0], line[1], (i) => cells.push(i));
        expect(cells).toContain(idx);
        const [p, q] = [at(20.96, 31), at(21, 30.96)];
        const inM = haversineM(p[1], p[0], q[1], q[0]);
        expect(inM).toBeGreaterThan(2);
        expect(inM).toBeLessThan(5);
    });

    it("not the grid's alone: red, and not saveable", () => {
        const r = read(withNtm, grid, line);
        expect(r.caution).toEqual([true]);
        // c0309771: GRID_ONLY, green — the line's 5 m walk read the chart's
        // 10 m past the survey's 1.2 m corner.
        expect(r.out.cautionWhy).toEqual([CAUTION_WHY.UNEXPLAINED]);
        expect(r.states).toEqual(['danger']);
        expect(r.unsaveable).toEqual([0]);
    });
});

// ── 3. A charted hazard AREA gets the keep-out a point gets ──────────────
describe("a hazard area's keep-out is measured exactly", () => {
    const EDGE = SOUTH + 12.7 * D_LAT;
    const LAT = EDGE + 12 * M_LAT; // GRID_ONLY's own line, clear of its 2–5 m band
    const kx = 111_320 * Math.cos((LAT * Math.PI) / 180);
    const foul = (x0: number, y0: number, x1: number, y1: number): Feature =>
        rect(x0, y0, x1, y1, { acronym: 'OBSTRN', CATOBS: 6, WATLEV: 4 });

    it('foul ground 1 m beside the line: inside its buffer, so a hazard, never green', () => {
        // 70 × 76 m, 1 m north of the line, over the first segment.
        const area = foul(W + 0.004, LAT + 1 * M_LAT, W + 0.004 + 70 / kx, LAT + 77 * M_LAT);
        const layers = {
            DEPARE: fc(band(EDGE, -40.99, 10, 15), band(-41.002, EDGE, 2, 5)),
            OBSTRN: fc(area),
        } as InshoreLayers;
        const line = eastAt(LAT);
        const hz = hazardBufferSegments(line, layers, 30, FLOOR);
        expect(hz).toEqual([true, false]);
        const grid = buildNavGrid(layers, BBOX, 50, DRAFT, SAFETY, 30);
        const r = read(layers, grid, line, hz);
        expect(r.out.cautionWhy[0] & CAUTION_WHY.HAZARD).toBe(CAUTION_WHY.HAZARD);
        expect(r.states[0]).toBe('danger');
        expect(r.words[0]).toBe('within the keep-out of a charted rock, wreck or obstruction');
        // 31 m off it is clear, as a point 31 m off is.
        const far = foul(W + 0.004, LAT + 31 * M_LAT, W + 0.004 + 70 / kx, LAT + 107 * M_LAT);
        expect(hazardBufferSegments(line, { ...layers, OBSTRN: fc(far) }, 30, FLOOR)).toEqual([false, false]);
    });

    it('a strip of foul ground 4 m wide crossed between two 10 m samples is a hazard', () => {
        const line = eastAt(LAT);
        const [a, b] = [line[0], line[1]];
        const segM = haversineM(a[1], a[0], b[1], b[0]);
        const steps = Math.ceil(segM / 10);
        const stepLon = (b[0] - a[0]) / steps;
        // Between samples 50 and 51, clear of both by ≥ 2.5 m.
        const x0 = a[0] + 50 * stepLon + 2.5 / kx;
        const strip = foul(x0, LAT - 100 * M_LAT, x0 + 4 / kx, LAT + 100 * M_LAT);
        expect(x0 + 4 / kx).toBeLessThan(a[0] + 51 * stepLon);
        const layers = {
            DEPARE: fc(band(EDGE, -40.99, 10, 15), band(-41.002, EDGE, 2, 5)),
            OBSTRN: fc(strip),
        } as InshoreLayers;
        expect(hazardBufferSegments(line, layers, 30, FLOOR)).toEqual([true, false]);
        // Charted deep enough over it (VALSOU ≥ need): not read, as before.
        const deep = { ...strip, properties: { acronym: 'OBSTRN', CATOBS: 6, VALSOU: 12 } };
        expect(hazardBufferSegments(line, { ...layers, OBSTRN: fc(deep) }, 30, FLOOR)).toEqual([false, false]);
    });
});
