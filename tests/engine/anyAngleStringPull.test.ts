/**
 * Any-angle string pulling (field round 2, item a; Shane's second auto route,
 * 2026-10-02, Whitsundays; built 2026-10-03).
 *
 * The field finding: legs 4→5 ran due east ~200 m and 5→6 south-east ~140 m
 * where the straight 4→6 (~317 m) crosses 15–20 m water — a 50 m 8-connected
 * grid artefact. Measured on the Pi's cells (2026-10-03), the shipped route
 * there was the PROMOTED Seaway Graph route, whose connector legs were the A*
 * cell chain itself: 498 points, each 50 m east or 70.7 m south-east, never
 * pulled straight. engine/stringPull replaces a run of segments with its
 * chord when the chord is at least as safe as the run, by the finished
 * route's own exact checks; these pin that rule on synthetic water.
 *
 * Synthetic chart, in grid units from one cell centre (a cell is ~50 m): deep
 * 15–20 m water everywhere; a stair of cell centres east then south-east, as
 * a connector draws it. Everything placed in cell units, so a band never
 * straddles a cell centre by accident.
 */
import type { Feature, FeatureCollection, Point } from 'geojson';
import { describe, expect, it } from 'vitest';
import { buildNavGrid } from '../../services/engine/navGrid';
import { gridToLatLon, haversineM, segmentGeometryDistanceM } from '../../services/engine/geometry';
import {
    chartMarkPoints,
    lateralMarkGates,
    lineExposureReader,
    LINE_STATE,
    pullTaut,
    threadGateCentres,
    type PullOptions,
} from '../../services/engine/stringPull';
import type { InshoreLayers, NavGrid } from '../../services/engine/types';
import { routeInshore, type RouteRequest } from '../../services/inshoreRouterEngine';
import { shadowCompare } from '../../services/seaway/seawayRouter';

const fc = (...features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
const LAT = -21.4;
const LON0 = 151.3;
const KY = 110_540;
const KX = 111_320 * Math.cos((LAT * Math.PI) / 180);
const lonLat = (xM: number, yM: number): [number, number] => [LON0 + xM / KX, LAT + yM / KY];
const polygon = (ring: [number, number][], props: Record<string, unknown>): Feature => ({
    type: 'Feature',
    properties: props,
    geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] },
});
const DEEP = polygon([lonLat(-4000, -4000), lonLat(4000, -4000), lonLat(4000, 4000), lonLat(-4000, 4000)], {
    acronym: 'DEPARE',
    DRVAL1: 15,
    DRVAL2: 20,
});
const BBOX = [...lonLat(-2500, -2500), ...lonLat(2500, 2500)] as [number, number, number, number];
const DRAFT_M = 2.4;
const UKC_M = 0.5;
const CELL_DIAG_M = Math.SQRT2 * 50;

/** The stair's first cell: near the grid's middle, the same for every grid on BBOX. */
const START = (g: NavGrid): { x: number; y: number } => ({
    x: Math.floor(g.width / 2) - 8,
    y: Math.floor(g.height / 2) + 4,
});
/** [lon, lat] of a point (u, v) cells east and north of the stair's first cell centre. */
const cellPt = (g: NavGrid, u: number, v: number): [number, number] => {
    const s = START(g);
    return [g.minLon + (s.x + 0.5 + u) * g.dLon, g.minLat + (s.y + 0.5 + v) * g.dLat];
};
/** A rectangle in cell units from the stair's first cell centre. */
const cellRect = (g: NavGrid, u0: number, v0: number, u1: number, v1: number, props: Record<string, unknown>) =>
    polygon([cellPt(g, u0, v0), cellPt(g, u1, v0), cellPt(g, u1, v1), cellPt(g, u0, v1)], props);
/** A connector's cell chain: every cell centre, 'e' = east, 'd' = south-east, 'u' = north-east. */
const chain = (g: NavGrid, moves: string): [number, number][] => {
    const s = START(g);
    let { x, y } = s;
    const out: [number, number][] = [gridToLatLon(g, x, y)];
    for (const m of moves) {
        x += 1;
        if (m === 'd') y -= 1;
        if (m === 'u') y += 1;
        out.push(gridToLatLon(g, x, y));
    }
    return out;
};
/** A point feature's [lon, lat]. */
const pointOf = (f: Feature): [number, number] => (f.geometry as Point).coordinates as [number, number];
const gridOf = (layers: InshoreLayers): NavGrid => buildNavGrid(layers, BBOX, 50, DRAFT_M, UKC_M, 30);
const pullOn = (layers: InshoreLayers, g: NavGrid, line: [number, number][], extra: Partial<PullOptions> = {}) =>
    pullTaut(line, {
        exposureOf: lineExposureReader({
            layers,
            grid: g,
            draftM: DRAFT_M,
            safetyM: UKC_M,
            obstructionBufferM: 30,
            strictUncharted: false,
        }),
        marks: chartMarkPoints(layers),
        corridorM: CELL_DIAG_M,
        ...extra,
    });
const lengthM = (p: readonly [number, number][]): number =>
    p.slice(1).reduce((m, q, i) => m + haversineM(p[i][1], p[i][0], q[1], q[0]), 0);
/** Metres from a point to the segment a→b (local plane). */
const offM = (p: readonly [number, number], a: readonly [number, number], b: readonly [number, number]): number => {
    const kx = 111_320 * Math.cos((a[1] * Math.PI) / 180);
    const dx = (b[0] - a[0]) * kx;
    const dy = (b[1] - a[1]) * KY;
    const qx = (p[0] - a[0]) * kx;
    const qy = (p[1] - a[1]) * KY;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, (qx * dx + qy * dy) / l2)) : 0;
    return Math.hypot(qx - t * dx, qy - t * dy);
};
/** The closest a polyline comes to an area (m). */
const clearanceM = (p: readonly [number, number][], area: Feature): number => {
    const kx = 111_320 * Math.cos((LAT * Math.PI) / 180);
    let best = Infinity;
    for (let i = 0; i + 1 < p.length; i++)
        best = Math.min(
            best,
            segmentGeometryDistanceM(
                p[i],
                p[i + 1],
                area.geometry as Parameters<typeof segmentGeometryDistanceM>[2],
                kx,
                KY,
            ),
        );
    return best;
};

describe('the field stair pulls straight in open water', () => {
    const layers = { DEPARE: fc(DEEP) } as InshoreLayers;
    const g = gridOf(layers);

    it('legs 4→5→6: east 200 m then south-east 141 m become the one 317 m chord', () => {
        const stair = chain(g, 'eeeedd');
        expect(lengthM(stair)).toBeGreaterThan(335);
        const out = pullOn(layers, g, stair);
        expect(out.polyline).toEqual([stair[0], stair[stair.length - 1]]);
        expect(out.pulled).toBe(5);
        expect(lengthM(out.polyline)).toBeCloseTo(haversineM(stair[0][1], stair[0][0], stair[6][1], stair[6][0]), 6);
        expect(lengthM(out.polyline)).toBeLessThan(325);
    });

    it('a long connector stair (the 498-point field leg, in miniature) becomes one line', () => {
        const stair = chain(g, 'eeeeeeeeeeeedeedeedeedeeddddddddd');
        const out = pullOn(layers, g, stair);
        expect(out.polyline).toEqual([stair[0], stair[stair.length - 1]]);
    });

    it('the ends, a pinned vertex and an unpullable segment are kept', () => {
        const stair = chain(g, 'eeeeeeeedddddddd');
        const pinned = stair.map((_, i) => i === 8);
        const a = pullOn(layers, g, stair, { pinned });
        expect(a.polyline).toEqual([stair[0], stair[8], stair[16]]);
        const pullable = stair.slice(1).map((_, i) => i !== 3);
        const b = pullOn(layers, g, stair, { pullable });
        expect(b.polyline.slice(0, 3)).toEqual([stair[0], stair[3], stair[4]]);
        expect(b.polyline[b.polyline.length - 1]).toEqual(stair[16]);
    });
});

describe('a chord is never less safe than the run it replaces', () => {
    // The stair east 8 cells then south-east 8: its chord runs from (0, 0) to
    // (16, -8) in cell units — the line u + 2v = 0, up to 3.6 cells (179 m)
    // inside the corner at (8, 0).
    const base = { DEPARE: fc(DEEP) } as InshoreLayers;
    const g0 = gridOf(base);
    const stairOn = (g: NavGrid): [number, number][] => chain(g, 'eeeeeeeedddddddd');

    it('control: the same stair in open deep water is one chord', () => {
        expect(pullOn(base, g0, stairOn(g0)).polyline).toHaveLength(2);
    });

    it('keeps 30 m off a drying reef the stair kept clear, even where the chord touches none of its cells', () => {
        // 60 × 60 m, drying 1 m: its nearest corner (5.2, -2.3) is 0.6/√5
        // cells — 13 m — from the chord, 2.1 cells from the stair; only the
        // cell centre (6, -2) lies in it, and the chord never enters that cell.
        const reef = cellRect(g0, 5.2, -2.3, 6.4, -1.1, { acronym: 'DEPARE', DRVAL1: -1, DRVAL2: 0 });
        const layers = { DEPARE: fc(DEEP, reef) } as InshoreLayers;
        const g = gridOf(layers);
        const stair = stairOn(g);
        expect(clearanceM([stair[0], stair[16]], reef)).toBeLessThan(20);
        expect(clearanceM(stair, reef)).toBeGreaterThan(50);
        const out = pullOn(layers, g, stair);
        expect(out.polyline.length).toBeGreaterThan(2);
        expect(clearanceM(out.polyline, reef)).toBeGreaterThanOrEqual(30);
        expect(out.pulled).toBeGreaterThan(0);
    });

    it('keeps a charted rock out of its 30 m buffer', () => {
        const rock: Feature = {
            type: 'Feature',
            properties: { acronym: 'UWTROC', WATLEV: 3 },
            geometry: { type: 'Point', coordinates: cellPt(g0, 5.2, -2.3) },
        };
        const layers = { DEPARE: fc(DEEP), UWTROC: fc(rock) } as InshoreLayers;
        const g = gridOf(layers);
        const stair = stairOn(g);
        const out = pullOn(layers, g, stair);
        const rockAt = pointOf(rock);
        const least = Math.min(...out.polyline.slice(1).map((q, i) => offM(rockAt, out.polyline[i], q)));
        expect(least).toBeGreaterThanOrEqual(30);
        expect(out.polyline.length).toBeGreaterThan(2);
    });

    it('weighs each shallow band on its own: a flat the stair hugs does not license a chord onto a drying reef', () => {
        // Stage-B review, 2026-10-03. The stair east 2 cells then south-east 2
        // runs 3 m off a 2–5 m flat on its north-east side the whole way (the
        // flat asks 10 m: a 7 m shortfall on every segment), and 51 m clear of
        // a reef drying 1 m on the far side of its chord. The chord shares the
        // stair's first vertex, so it is 3 m off the flat too — and 25.7 m off
        // the reef, which asks 30 m. Read as ONE number (the worst shortfall,
        // 7 m both ways) it passed; band by band it must keep the reef's 30 m,
        // since the stair did.
        const off = 0.06; // cells: 3 m
        const sk = 2 + off * Math.SQRT2; // the flat's south-west edge, u + v = sk
        const flat = polygon(
            [
                cellPt(g0, -1, off),
                cellPt(g0, sk - off, off),
                cellPt(g0, 5.5, sk - 5.5),
                cellPt(g0, 6, sk - 5.5),
                cellPt(g0, 6, 3),
                cellPt(g0, -1, 3),
            ],
            { acronym: 'DEPARE', DRVAL1: 2, DRVAL2: 5 },
        );
        // Only the centre of cell (2, -2) lies in it; the chord never enters that cell.
        const reef = cellRect(g0, 1.6, -2.4, 2.25, -1.7, { acronym: 'DEPARE', DRVAL1: -1, DRVAL2: 0 });
        const layers = { DEPARE: fc(DEEP, flat, reef) } as InshoreLayers;
        const g = gridOf(layers);
        const stair = chain(g, 'eedd');
        const read = lineExposureReader({
            layers,
            grid: g,
            draftM: DRAFT_M,
            safetyM: UKC_M,
            obstructionBufferM: 30,
            strictUncharted: false,
        });
        const chord = [stair[0], stair[4]];
        // The setup the review measured: every stair segment and the chord are
        // too near a shallow band, the chord touches no caution cell, and only
        // the chord comes within the reef's clearance.
        for (let i = 0; i + 1 < stair.length; i++)
            expect(read(stair[i], stair[i + 1]).state & LINE_STATE.NEAR_SHALLOW).toBeTruthy();
        expect(read(chord[0], chord[1]).state).toBe(LINE_STATE.NEAR_SHALLOW);
        expect(clearanceM(stair, flat)).toBeLessThan(4);
        expect(clearanceM(stair, reef)).toBeGreaterThan(45);
        expect(clearanceM(chord, reef)).toBeGreaterThan(23);
        expect(clearanceM(chord, reef)).toBeLessThan(30);
        const out = pullOn(layers, g, stair);
        expect(clearanceM(out.polyline, reef)).toBeGreaterThanOrEqual(30);
        // The flat is kept no closer than the stair kept it, and the pull still
        // takes what it safely can.
        expect(clearanceM(out.polyline, flat)).toBeGreaterThanOrEqual(clearanceM(stair, flat) - 0.01);
        expect(out.pulled).toBeGreaterThan(0);
    });

    it('passes a lateral mark on the side the stair does: no mark between the run and its chord', () => {
        // A starboard beacon 70–100 m from both the stair and its chord.
        const mark: Feature = {
            type: 'Feature',
            properties: { acronym: 'BCNLAT', CATLAM: 2 },
            geometry: { type: 'Point', coordinates: cellPt(g0, 8, -2) },
        };
        const layers = { DEPARE: fc(DEEP), BCNLAT: fc(mark) } as InshoreLayers;
        const g = gridOf(layers);
        const stair = stairOn(g);
        const out = pullOn(layers, g, stair);
        expect(out.polyline.length).toBeGreaterThan(2);
        // The mark stays south of the line wherever the line passes it.
        const [mLon, mLat] = pointOf(mark);
        for (let i = 0; i + 1 < out.polyline.length; i++) {
            const [a, b] = [out.polyline[i], out.polyline[i + 1]];
            if ((a[0] - mLon) * (b[0] - mLon) > 0) continue;
            const latThere = a[1] + ((b[1] - a[1]) * (mLon - a[0])) / (b[0] - a[0]);
            expect(latThere).toBeGreaterThan(mLat);
        }
    });

    it('never reads shallower water than the stair, even water deep enough for the keel', () => {
        // A 6–10 m band across the chord's middle that the stair never enters.
        const band = cellRect(g0, 6, -4.5, 10, -2.5, { acronym: 'DEPARE', DRVAL1: 6, DRVAL2: 10 });
        const layers = { DEPARE: fc(DEEP, band) } as InshoreLayers;
        const g = gridOf(layers);
        const read = lineExposureReader({
            layers,
            grid: g,
            draftM: DRAFT_M,
            safetyM: UKC_M,
            obstructionBufferM: 30,
            strictUncharted: false,
        });
        const stair = stairOn(g);
        for (let i = 0; i + 1 < stair.length; i++) expect(read(stair[i], stair[i + 1]).leastM).toBe(15);
        const out = pullOn(layers, g, stair);
        expect(out.polyline.length).toBeGreaterThan(2);
        for (let i = 0; i + 1 < out.polyline.length; i++)
            expect(read(out.polyline[i], out.polyline[i + 1]).leastM).toBe(15);
    });

    it('where nothing proves the water, a chord stays within a cell diagonal of the cells it replaces', () => {
        // Charted 1–2 m everywhere: every segment is red, needs tide.
        const flat = polygon([lonLat(-4000, -4000), lonLat(4000, -4000), lonLat(4000, 4000), lonLat(-4000, 4000)], {
            acronym: 'DEPARE',
            DRVAL1: 1,
            DRVAL2: 2,
        });
        const layers = { DEPARE: fc(flat) } as InshoreLayers;
        const g = gridOf(layers);
        const stair = stairOn(g);
        const read = lineExposureReader({
            layers,
            grid: g,
            draftM: DRAFT_M,
            safetyM: UKC_M,
            obstructionBufferM: 30,
            strictUncharted: false,
        });
        expect(read(stair[0], stair[1]).state & LINE_STATE.CHART_SHALLOW).toBeTruthy();
        const out = pullOn(layers, g, stair);
        expect(out.polyline.length).toBeGreaterThan(2);
        expect(out.polyline.length).toBeLessThan(stair.length);
        for (let k = 0; k + 1 < out.kept.length; k++)
            for (let v = out.kept[k] + 1; v < out.kept[k + 1]; v++)
                expect(offM(stair[v], out.polyline[k], out.polyline[k + 1])).toBeLessThanOrEqual(CELL_DIAG_M + 1e-6);
    });

    it('equal or better is enough: a chord clear of a shallow cell the stair dipped into replaces it', () => {
        // A 1–2 m patch over the one cell the stair dips into, 32 m clear of the
        // straight line along the stair's row (its clearance asks 30 m).
        const patch = cellRect(g0, 4.6, -1.45, 5.4, -0.65, { acronym: 'DEPARE', DRVAL1: 1, DRVAL2: 2 });
        const layers = { DEPARE: fc(DEEP, patch) } as InshoreLayers;
        const g = gridOf(layers);
        const dip = chain(g, 'eeeeduee');
        const read = lineExposureReader({
            layers,
            grid: g,
            draftM: DRAFT_M,
            safetyM: UKC_M,
            obstructionBufferM: 30,
            strictUncharted: false,
        });
        expect(read(dip[4], dip[5]).state & LINE_STATE.GRID_CAUTION).toBeTruthy();
        const out = pullOn(layers, g, dip);
        expect(out.polyline).toEqual([dip[0], dip[dip.length - 1]]);
        expect(read(dip[0], dip[dip.length - 1]).state).toBe(0);
    });
});

describe('a gate crossed close by one of its marks is threaded through its centre', () => {
    // A port mark 7.5 m north of the route's row at u = 10, its starboard
    // partner 52.5 m south: a 60 m gate the straight route crosses 7.5 m off
    // the port mark — as Newport's tier-2 search crossed the 5/6 gate 12 m off
    // mark 5.
    const g0 = gridOf({ DEPARE: fc(DEEP) } as InshoreLayers);
    const mark = (u: number, v: number, catlam: number): Feature => ({
        type: 'Feature',
        properties: { acronym: 'BOYLAT', CATLAM: catlam },
        geometry: { type: 'Point', coordinates: cellPt(g0, u, v) },
    });
    const marks = [mark(10, 0.15, 1), mark(10, -1.05, 2)];
    const threadOn = (layers: InshoreLayers) => {
        const g = gridOf(layers);
        const line = [cellPt(g, 0, 0), cellPt(g, 10, 0), cellPt(g, 20, 0)];
        const gates = lateralMarkGates(layers);
        return {
            line,
            gates,
            out: threadGateCentres(line, {
                gates,
                marks: chartMarkPoints(layers),
                corridorM: CELL_DIAG_M,
                exposureOf: lineExposureReader({
                    layers,
                    grid: g,
                    draftM: DRAFT_M,
                    safetyM: UKC_M,
                    obstructionBufferM: 30,
                    strictUncharted: false,
                }),
            }),
        };
    };

    it('the vertex on the gate line moves onto the centre, 30 m from each mark', () => {
        const { line, gates, out } = threadOn({ DEPARE: fc(DEEP), BOYLAT: fc(...marks) } as InshoreLayers);
        expect(gates).toHaveLength(1);
        expect(gates[0].widthM).toBeCloseTo(60, 0);
        expect(out.threaded).toBe(1);
        expect(out.polyline).toEqual([line[0], gates[0].centre, line[2]]);
        expect(out.onCentre).toEqual([false, true, false]);
        const port = pointOf(marks[0]);
        expect(offM(port, out.polyline[0], out.polyline[1])).toBeGreaterThan(25);
    });

    it('not where the centre is less safe: a drying patch on it keeps the line where it was', () => {
        const patch = cellRect(g0, 9.6, -0.8, 10.4, -0.1, { acronym: 'DEPARE', DRVAL1: -0.5, DRVAL2: 0 });
        const { line, out } = threadOn({ DEPARE: fc(DEEP, patch), BOYLAT: fc(...marks) } as InshoreLayers);
        expect(out.threaded).toBe(0);
        expect(out.polyline).toEqual(line);
    });
});

describe('a promoted Seaway connector is pulled taut (the field route, lon 151.60)', () => {
    // A numbered four-gate channel south-east of the origin: the connector to
    // it is an 8-connected A* chain (east and south-east), and before the pull
    // it shipped as that chain, a cell centre every 50–71 m.
    const LON = 151.6;
    const mPerLon = 111_320 * Math.cos((LAT * Math.PI) / 180);
    const pt = (xM: number, yM: number): [number, number] => [LON + xM / mPerLon, LAT + yM / KY];
    const deep = polygon([pt(-3000, -3000), pt(5000, -3000), pt(5000, 3000), pt(-3000, 3000)], {
        acronym: 'DEPARE',
        DRVAL1: 15,
        DRVAL2: 20,
    });
    const gate = (xM: number, k: number): Feature[] => [
        {
            type: 'Feature',
            properties: { acronym: 'BOYLAT', CATLAM: 1, OBJNAM: `G${2 * k + 2}` },
            geometry: { type: 'Point', coordinates: pt(xM, -900 + 90) },
        },
        {
            type: 'Feature',
            properties: { acronym: 'BOYLAT', CATLAM: 2, OBJNAM: `G${2 * k + 1}` },
            geometry: { type: 'Point', coordinates: pt(xM, -900 - 90) },
        },
    ];
    const layers = {
        DEPARE: fc(deep),
        BOYLAT: fc(...[1800, 2300, 2800, 3300].flatMap((x, k) => gate(x, k))),
    } as InshoreLayers;
    const [fromLon, fromLat] = pt(0, 0);
    const [toLon, toLat] = pt(4200, -1500);
    const req: RouteRequest = { fromLat, fromLon, toLat, toLon, draftM: DRAFT_M, safetyM: UKC_M, resolutionM: 50 };

    it('the leg from the origin to the channel is a straight line, not a cell chain', () => {
        const direct = routeInshore(layers, req);
        if (!('polyline' in direct)) throw new Error(direct.error);
        const report = shadowCompare(layers, req, direct);
        const graph = report?.graph;
        expect(graph, report?.reason).toBeTruthy();
        if (!graph) return;
        // The first channel edge starts at the entry gate; before it, the
        // connector from the origin to the channel's seaward portal, then the
        // portal's hop to that gate.
        const entry = graph.channelSegMask.indexOf(true);
        expect(entry).toBeGreaterThan(1);
        const connector = graph.polyline.slice(0, entry);
        // Measured on ea300aa8 (before the pull): 27 points — 8 cells east,
        // then 18 south-east — its corner 226 m off the connector's chord.
        expect(connector).toHaveLength(2);
        expect(lengthM(connector)).toBeGreaterThan(1500);
        expect(graph.pulledVertices).toBeGreaterThanOrEqual(25);
        expect(graph.maxLegDetour).toBeLessThan(1.01);
    });
});
