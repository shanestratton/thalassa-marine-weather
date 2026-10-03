/**
 * A charted hazard AREA keeps the router out of its buffer, as a point
 * hazard does (router round 2 part 3, 2026-10-03).
 *
 * navGrid Pass 3 gave a point hazard (OBSTRN / WRECKS / UWTROC) a keep-out:
 * every cell its buffer disc touches is closed. An AREA hazard closed only the
 * cells whose CENTRE lies inside it, and the land skin (Pass 6) is skipped
 * beside deep water, so in open water a chord between two cell centres could
 * clip an area's corner. hazardBufferSegments, which reads the area exactly,
 * then drew it red — but the router had already chosen it. Field evidence
 * (Shane, Coral Sea Marina → Daydream Island, after decision 12): a 5.9 km
 * chord clipped the NE corner of an OBSTRN area (CATOBS 6, WATLEV 4, about
 * 208 × 285 m) on AU421148, red, "within the keep-out of a charted rock,
 * wreck or obstruction". An area now closes every cell within the buffer of
 * its rings, measured exactly, the same rule the final audit reads.
 *
 * Synthetic: deep water everywhere, one foul area whose SE corner pokes 3 m
 * into the straight line between the two pins.
 */
import type { Feature, FeatureCollection } from 'geojson';
import { describe, expect, it } from 'vitest';
import { routeInshore, type RouteRequest, type RouteResult } from '../../services/inshoreRouterEngine';
import { buildNavGrid } from '../../services/engine/navGrid';
import { hazardBufferSegments } from '../../services/engine/safetyAudit';
import { collectShallowRuns } from '../../services/engine/shallowRuns';
import { CAUTION_WHY, type InshoreLayers } from '../../services/engine/types';
import { tracerContextFromLayers, validateTraceLeg } from '../../services/routeTracer';

const fc = (...features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
const LAT = -20.233;
const LON0 = 148.77;
const KY = 110_540;
const KX = 111_320 * Math.cos((LAT * Math.PI) / 180);
/** [lon, lat] of a point `x` m east and `y` m north of (LON0, LAT). */
const at = (x: number, y: number): [number, number] => [LON0 + x / KX, LAT + y / KY];
const rect = (x0: number, y0: number, x1: number, y1: number, props: Record<string, unknown>): Feature => ({
    type: 'Feature',
    properties: props,
    geometry: { type: 'Polygon', coordinates: [[at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)]] },
});
const deep = rect(-6000, -4000, 6000, 4000, { acronym: 'DEPARE', DRVAL1: 10, DRVAL2: 20 });
/** Foul ground, 208 × 285 m, its SE corner at (0, -3): the line y = x / 10
 * crosses its corner from (0, 0) to (-30, -3). */
const foul = (props: Record<string, unknown> = { acronym: 'OBSTRN', CATOBS: 6, WATLEV: 4 }): Feature =>
    rect(-208, -3, 0, 282, props);
const layers = (area: Feature = foul()): InshoreLayers => ({ DEPARE: fc(deep), OBSTRN: fc(area) }) as InshoreLayers;
const [fromLon, fromLat] = at(-3000, -300);
const [toLon, toLat] = at(3000, 300);
const req = (bufferM: number): RouteRequest => ({
    fromLat,
    fromLon,
    toLat,
    toLon,
    draftM: 2.4,
    safetyM: 0.5,
    resolutionM: 50,
    obstructionBufferM: bufferM,
});
const ok = (r: ReturnType<typeof routeInshore>): RouteResult => {
    if ('error' in r) throw new Error(r.error);
    return r;
};

describe('a hazard area closes every cell within its buffer, as a point does', () => {
    const BBOX = [...at(-1000, -1000), ...at(1000, 1000)] as [number, number, number, number];
    /** Every cell within 150 m of the area: whether its centre lies inside the
     * area, and its square's distance from the area (m, local plane). */
    const cellsNear = (g: ReturnType<typeof buildNavGrid>) => {
        const out: { idx: number; inside: boolean; distM: number }[] = [];
        for (let y = 0; y < g.height; y++)
            for (let x = 0; x < g.width; x++) {
                // The cell's square in metres from (LON0, LAT).
                const x0 = (g.minLon + x * g.dLon - LON0) * KX;
                const x1 = x0 + g.dLon * KX;
                const y0 = (g.minLat + y * g.dLat - LAT) * KY;
                const y1 = y0 + g.dLat * KY;
                const dx = Math.max(-208 - x1, 0, x0 - 0);
                const dy = Math.max(-3 - y1, 0, y0 - 282);
                const distM = Math.hypot(dx, dy);
                if (distM > 150) continue;
                const cx = (x0 + x1) / 2;
                const cy = (y0 + y1) / 2;
                out.push({ idx: y * g.width + x, inside: cx > -208 && cx < 0 && cy > -3 && cy < 282, distM });
            }
        return out;
    };
    for (const layer of ['OBSTRN', 'UWTROC', 'WRECKS'] as const) {
        it(`${layer}: closes each cell whose square comes within 30 m of the area, and no other`, () => {
            const g = buildNavGrid(
                { DEPARE: fc(deep), [layer]: fc(foul({ acronym: layer })) } as InshoreLayers,
                BBOX,
                50,
                2.4,
                0.5,
                30,
            );
            const cells = cellsNear(g);
            const ring = cells.filter((c) => !c.inside && c.distM < 28);
            expect(ring.length).toBeGreaterThan(10);
            for (const c of ring) {
                expect(Number.isNaN(g.cells[c.idx]), `cell ${c.idx}, ${c.distM.toFixed(1)} m off`).toBe(true);
                expect(g.obstnBlocked?.[c.idx]).toBe(1);
            }
            for (const c of cells.filter((c) => c.distM > 32))
                expect(Number.isNaN(g.cells[c.idx]), `cell ${c.idx}, ${c.distM.toFixed(1)} m off`).toBe(false);
        });
    }

    it('router furniture with no S-57 identity (an OSM reef) keeps its old footprint: centres inside only', () => {
        const g = buildNavGrid(
            { DEPARE: fc(deep), OBSTRN: fc(foul({ _source: 'osm-reef' })) } as InshoreLayers,
            BBOX,
            50,
            2.4,
            0.5,
            30,
        );
        const cells = cellsNear(g);
        expect(cells.some((c) => c.inside)).toBe(true);
        for (const c of cells) expect(Number.isNaN(g.cells[c.idx]), `cell ${c.idx}`).toBe(c.inside);
    });
});

describe('a route keeps out of a hazard area’s buffer instead of clipping it', () => {
    // The straight line between the pins runs through the top 10 m of a
    // 208 × 295 m foul area: every 50 m cell centre along it lies outside the
    // area, so only the area's own cells closed and the router took the line —
    // through the area, red (measured on the old grid: 0 m from it, HAZARD).
    const strip = rect(-100, -285, 108, 10, { acronym: 'OBSTRN', CATOBS: 6, WATLEV: 4 });
    const stripReq = (bufferM: number): RouteRequest => ({
        ...req(bufferM),
        fromLat: LAT,
        fromLon: at(-3000, 0)[0],
        toLat: LAT,
        toLon: at(3000, 0)[0],
    });
    for (const bufferM of [30, 60]) {
        it(`buffer ${bufferM} m: no segment comes within the buffer, and nothing is drawn red for it`, () => {
            const ls = layers(strip);
            const r = ok(routeInshore(ls, stripReq(bufferM)));
            expect(hazardBufferSegments(r.polyline, ls, bufferM, 2.9)).not.toContain(true);
            expect((r.cautionWhy ?? []).some((w) => (w & CAUTION_WHY.HAZARD) !== 0)).toBe(false);
            expect(r.cautionMask ?? []).not.toContain(true);
            // Round the area, not a detour: within 2% of the straight line.
            expect(r.distanceNM).toBeLessThan((1.02 * 6000) / 1852);
        });
        it(`buffer ${bufferM} m: a line past the area's corner stays outside its buffer too`, () => {
            const r = ok(routeInshore(layers(), req(bufferM)));
            expect(hazardBufferSegments(r.polyline, layers(), bufferM, 2.9)).not.toContain(true);
            expect(r.cautionMask ?? []).not.toContain(true);
        });
    }
});

// Fix-up review (2026-10-03): the ring agrees with the audit, and grows with
// the cell only where the grid is fine.
describe('the keep-out ring agrees with the final audit', () => {
    const BBOX = [...at(-1000, -1000), ...at(1000, 1000)] as [number, number, number, number];
    /** The foul area's distance (m) from a point (x, y) in the local frame. */
    const offFoul = (x: number, y: number): number =>
        Math.hypot(Math.max(-208 - x, 0, x), Math.max(-3 - y, 0, y - 282));
    const cellCentre = (g: ReturnType<typeof buildNavGrid>, idx: number): [number, number] => {
        const x = idx % g.width;
        const y = Math.floor(idx / g.width);
        return [(g.minLon + (x + 0.5) * g.dLon - LON0) * KX, (g.minLat + (y + 0.5) * g.dLat - LAT) * KY];
    };

    // Foul ground the chart sounds at 5.4 m (CATOBS 7) in a dredged fairway:
    // the audit exempts it for a 2.9 m need, and its ring closed fairway cells
    // round it, so a leg 40 m off read "crosses a charted hazard" (the
    // Brisbane River, newport-rivergate fixture).
    const sounded = (valsou: number) => foul({ acronym: 'OBSTRN', CATOBS: 7, WATLEV: 3, VALSOU: valsou });

    it('an area charted deep enough for the keel (VALSOU ≥ draft + UKC) closes its own cells, no ring', () => {
        const g = buildNavGrid(layers(sounded(5.4)), BBOX, 50, 2.4, 0.5, 60);
        for (let idx = 0; idx < g.width * g.height; idx++) {
            const [x, y] = cellCentre(g, idx);
            const inside = x > -208 && x < 0 && y > -3 && y < 282;
            expect(Number.isNaN(g.cells[idx]), `cell ${idx} at (${x.toFixed(0)}, ${y.toFixed(0)})`).toBe(inside);
        }
    });

    it('…and one charted shallower than the keel needs keeps its ring', () => {
        const g = buildNavGrid(layers(sounded(1.0)), BBOX, 50, 2.4, 0.5, 60);
        const ringClosed = [...Array(g.width * g.height).keys()].filter((idx) => {
            const [x, y] = cellCentre(g, idx);
            return Number.isNaN(g.cells[idx]) && offFoul(x, y) > 0 && offFoul(x, y) < 55;
        });
        expect(ringClosed.length).toBeGreaterThan(10);
    });

    it('the leg review agrees: a leg 40 m off the sounded area is clear; off the shallow one it is a hazard', () => {
        const bbox = [...at(-800, -800), ...at(800, 1100)] as [number, number, number, number];
        const pt = (x: number, y: number) => ({ lon: at(x, y)[0], lat: at(x, y)[1] });
        for (const [valsou, crosses] of [
            [5.4, false],
            [1.0, true],
        ] as const) {
            const ls = layers(sounded(valsou));
            const ctx = tracerContextFromLayers(ls, [], bbox, 2.4);
            const v = validateTraceLeg(pt(40, -500), pt(40, 700), ctx);
            const audit = hazardBufferSegments([at(40, -500), at(40, 700)], ls, 60, 2.9)[0];
            expect(audit, `VALSOU ${valsou}: the audit`).toBe(crosses);
            expect(
                v.issues.some((i) => i.message === 'crosses a charted hazard'),
                `VALSOU ${valsou}: ${v.issues.map((i) => i.message).join(' / ')}`,
            ).toBe(crosses);
        }
    });

    // The Coral Sea Marina → Shute Harbour chord on the Pi's cells: a 981 m
    // smoothing chord clipped the far corner of one ring cell, 113.7 m from
    // the nearest charted hazard, in 15 m water — drawn red "a charted
    // hazard", and Auto refused to save it while the audit and the leg review
    // found none.
    const chordBeside = (ls: InshoreLayers, insideColumn: (x: number, y: number) => boolean) => {
        const g = buildNavGrid(ls, BBOX, 50, 2.4, 0.5, 60);
        // The easternmost closed column level with the area; the chord runs
        // north–south 3 m inside its east edge.
        let col = -1;
        for (let idx = 0; idx < g.width * g.height; idx++) {
            const [x, y] = cellCentre(g, idx);
            if (Number.isNaN(g.cells[idx]) && insideColumn(x, y)) col = Math.max(col, idx % g.width);
        }
        const lon = g.minLon + (col + 1) * g.dLon - 3 / KX;
        const polyline: [number, number][] = [
            [lon, at(0, -150)[1]],
            [lon, at(0, 430)[1]],
        ];
        const hazardMask = hazardBufferSegments(polyline, ls, 60, 2.9);
        const out = collectShallowRuns({
            layers: ls,
            grid: g,
            polyline,
            caution: [true],
            draftM: 2.4,
            safetyM: 0.5,
            hazardMask,
        });
        return { offM: (lon - LON0) * KX, hazardMask, why: out.cautionWhy[0] };
    };

    it('a line that keeps every charted hazard’s buffer but clips a keep-out cell is the grid’s alone (GRID_ONLY)', () => {
        const c = chordBeside(layers(), (x, y) => y > 0 && y < 280 && x > 0);
        expect(c.offM).toBeGreaterThan(60);
        expect(c.hazardMask).toEqual([false]);
        expect(c.why).toBe(CAUTION_WHY.GRID_ONLY);
    });

    it('…but router furniture the audit never reads (an OSM reef) stays a hazard', () => {
        const c = chordBeside(layers(foul({ _source: 'osm-reef' })), (x, y) => y > 0 && y < 280 && x > -208);
        expect(c.hazardMask).toEqual([false]);
        expect((c.why & CAUTION_WHY.HAZARD) !== 0).toBe(true);
    });
});

describe('the ring by grid size: whole squares on a fine grid, centres on a coarse one, none on the pre-check', () => {
    const BIG = [...at(-8000, -8000), ...at(8000, 8000)] as [number, number, number, number];
    const nanMask = (g: ReturnType<typeof buildNavGrid>) => Array.from(g.cells, (v) => Number.isNaN(v));

    it('the 400 m strict pre-check grid closes the area’s own cells only, as before', () => {
        const ring = buildNavGrid(layers(), BIG, 400, 2.4, 0.5, 60);
        const footprint = buildNavGrid(layers(foul({ _source: 'osm-reef' })), BIG, 400, 2.4, 0.5, 60);
        expect(nanMask(ring)).toEqual(nanMask(footprint));
    });

    it('a 150 m grid at a 60 m keep-out closes a cell when its centre is within the buffer', () => {
        const g = buildNavGrid(layers(), BIG, 150, 2.4, 0.5, 60);
        let checked = 0;
        for (let idx = 0; idx < g.width * g.height; idx++) {
            const x = (g.minLon + ((idx % g.width) + 0.5) * g.dLon - LON0) * KX;
            const y = (g.minLat + (Math.floor(idx / g.width) + 0.5) * g.dLat - LAT) * KY;
            const off = Math.hypot(Math.max(-208 - x, 0, x), Math.max(-3 - y, 0, y - 282));
            if (off > 61) expect(Number.isNaN(g.cells[idx]), `cell ${idx}, ${off.toFixed(0)} m off`).toBe(false);
            else if (off > 0 && off < 59) {
                expect(Number.isNaN(g.cells[idx]), `cell ${idx}, ${off.toFixed(0)} m off`).toBe(true);
                checked++;
            }
        }
        expect(checked).toBeGreaterThan(0);
    });

    it('a strict route through a 500 m gap between two foul areas is not refused as uncharted', () => {
        // Charted water only ±700 m round the line: the way round the walls is
        // uncharted. The 400 m pre-check closed the gap and refused at once.
        const wall = { acronym: 'OBSTRN', CATOBS: 6, WATLEV: 4 };
        const ls = {
            DEPARE: fc(rect(-3000, -700, 3000, 700, { acronym: 'DEPARE', DRVAL1: 10, DRVAL2: 20 })),
            OBSTRN: fc(rect(-100, 250, 100, 3000, wall), rect(-100, -3000, 100, -250, wall)),
        } as InshoreLayers;
        const [fLon, fLat] = at(-2500, 0);
        const [tLon, tLat] = at(2500, 0);
        const r = ok(
            routeInshore(ls, {
                fromLat: fLat,
                fromLon: fLon,
                toLat: tLat,
                toLon: tLon,
                draftM: 2.4,
                safetyM: 0.5,
                obstructionBufferM: 60,
                unchartedPolicy: 'strict',
            }),
        );
        expect(r.distanceNM).toBeLessThan((1.02 * 5000) / 1852);
        expect(hazardBufferSegments(r.polyline, ls, 60, 2.9)).not.toContain(true);
    });
});
