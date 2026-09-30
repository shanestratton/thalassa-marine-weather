/**
 * The depth a tide must lift, per segment (owner decision 10, Shane
 * 2026-09-30: "Amber if a tide clears it").
 *
 * The planner draws a shallow stretch amber when some tide gives draft + UKC
 * over it, red when none does. It can only do that sum for a stretch red for
 * its charted depth ALONE. collectShallowRuns ships RouteResult.tideDepthM:
 * per caution segment, the shallowest charted depth under it — and null
 * wherever something a tide cannot change also makes it red: a charted
 * hazard's buffer, a sample no chart covers, decision-1 water (a finer band
 * under a coarser chart's land paint). Null keeps the red.
 */
import type { Feature, FeatureCollection } from 'geojson';
import { describe, expect, it } from 'vitest';
import { chartStateAlong, collectShallowRuns } from '../../services/engine/shallowRuns';
import { buildNavGrid } from '../../services/engine/navGrid';
import type { InshoreLayers } from '../../services/engine/types';

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

// West 10 m | a 1.5 m bank | a 2 m drying bank | east 10 m — all one rank —
// and a stretch no chart covers at the far east.
const W = 153.7;
const band = (x0: number, x1: number, d: number) =>
    rect(W + x0, -27.01, W + x1, -26.99, { acronym: 'DEPARE', DRVAL1: d, _scaleRank: 5566 });
const layers: InshoreLayers = {
    DEPARE: fc(band(0, 0.01, 10), band(0.01, 0.02, 1.5), band(0.02, 0.03, -2), band(0.03, 0.04, 10)),
} as InshoreLayers;
const at = (x: number): [number, number] => [W + x, -27];
// Segments: 0 deep, 1 inside the 1.5 m bank, 2 inside the drying bank,
// 3 deep, 4 half over water no chart covers.
const polyline: [number, number][] = [at(0.002), at(0.008), at(0.018), at(0.028), at(0.038), at(0.045)];
const grid = buildNavGrid(layers, [W - 0.01, -27.02, W + 0.06, -26.98], 50, 2.4, 0.5, 30);
const caution = [false, true, true, false, true];

describe('RouteResult.tideDepthM — the depth a tide must lift (decision 10)', () => {
    it('each caution segment red for its charted depth alone carries that depth', () => {
        const out = collectShallowRuns({
            layers,
            grid,
            polyline,
            caution,
            draftM: 2.4,
            safetyM: 0.5,
            hazardMask: [false, false, false, false, false],
        });
        expect(out.tideDepthM).toHaveLength(5);
        expect(out.tideDepthM[0]).toBeNull(); // not caution
        expect(out.tideDepthM[1]).toBeCloseTo(1.5, 6);
        expect(out.tideDepthM[2]).toBeCloseTo(-2, 6);
        expect(out.tideDepthM[3]).toBeNull();
        // Half of segment 4 has no chart under it: a tide proves nothing there.
        expect(out.tideDepthM[4]).toBeNull();
    });

    it("a charted hazard's buffer keeps its red: no depth", () => {
        const out = collectShallowRuns({
            layers,
            grid,
            polyline,
            caution,
            draftM: 2.4,
            safetyM: 0.5,
            hazardMask: [false, true, false, false, false],
        });
        expect(out.tideDepthM[1]).toBeNull();
        expect(out.tideDepthM[2]).toBeCloseTo(-2, 6);
    });

    it('without the hazard mask nothing is shipped (fail-safe: red)', () => {
        const out = collectShallowRuns({ layers, grid, polyline, caution, draftM: 2.4, safetyM: 0.5 });
        expect(out.tideDepthM.every((d) => d === null)).toBe(true);
    });
});

// Round-4 review (2026-09-30): on a caution segment the tide depth came from
// point samples every 25 m, not the band pieces the backstop reads — so a
// strip narrower than 25 m fell between two samples. MEASURED: a 15 m ridge
// drying 2 m across a 1.5 m bank drew the segment amber, its window worked
// from the bank ("clears 10:55–15:30 ≈"), and 24 m of the Brisbane River
// mouth with no band at all read as charted 0 m, "a tide clears it". The
// caution segment is now read exactly: cut at the bands' own edges.
describe('a caution segment is read exactly, never between samples (round-4 review)', () => {
    // A 1.5 m bank W+0.010..W+0.030, with a 15 m ridge drying 2 m at
    // W+0.02005..W+0.0202 — between the old 25 m samples of a segment
    // W+0.012 → W+0.028 (W+0.02000 and W+0.02025). All one rank.
    const bank = (x0: number, x1: number) =>
        rect(W + x0, -27.01, W + x1, -26.99, { acronym: 'DEPARE', DRVAL1: 1.5, _scaleRank: 5566 });
    const deep = (x0: number, x1: number) =>
        rect(W + x0, -27.01, W + x1, -26.99, { acronym: 'DEPARE', DRVAL1: 10, _scaleRank: 5566 });
    const ridge = rect(W + 0.02005, -27.01, W + 0.0202, -26.99, { acronym: 'DEPARE', DRVAL1: -2, _scaleRank: 5566 });
    const line: [number, number][] = [at(0.002), at(0.012), at(0.028), at(0.038)];
    const bbox: [number, number, number, number] = [W - 0.01, -27.02, W + 0.05, -26.98];

    it('a 15 m drying ridge across the bank sets the depth: -2 m, not the bank’s 1.5 m', () => {
        const ridged = { DEPARE: fc(deep(0, 0.01), bank(0.01, 0.03), ridge, deep(0.03, 0.04)) } as InshoreLayers;
        const out = collectShallowRuns({
            layers: ridged,
            grid: buildNavGrid(ridged, bbox, 50, 2.4, 0.5, 30),
            polyline: line,
            caution: [false, true, false],
            draftM: 2.4,
            safetyM: 0.5,
            hazardMask: [false, false, false],
        });
        expect(out.tideDepthM[1]).toBeCloseTo(-2, 6);
        expect(out.shallowRuns).toHaveLength(1);
        expect(out.shallowRuns[0].minDepthM).toBeCloseTo(-2, 6);
        // The shallowest spot is on the ridge.
        expect(out.shallowRuns[0].minAtLon).toBeGreaterThan(W + 0.02005);
        expect(out.shallowRuns[0].minAtLon).toBeLessThan(W + 0.0202);
    });

    it('a 15 m strip no band covers makes the segment uncharted: no tide depth', () => {
        const gapped = {
            DEPARE: fc(deep(0, 0.01), bank(0.01, 0.02005), bank(0.0202, 0.03), deep(0.03, 0.04)),
        } as InshoreLayers;
        const out = collectShallowRuns({
            layers: gapped,
            grid: buildNavGrid(gapped, bbox, 50, 2.4, 0.5, 30),
            polyline: line,
            caution: [false, true, false],
            draftM: 2.4,
            safetyM: 0.5,
            hazardMask: [false, false, false],
        });
        expect(out.tideDepthM[1]).toBeNull();
        expect(out.shallowRuns[0].partUncharted).toBe(true);
    });

    it('the scaffold collapse reads the same exact facts (chartStateAlong)', () => {
        const ridged = { DEPARE: fc(deep(0, 0.01), bank(0.01, 0.03), ridge, deep(0.03, 0.04)) } as InshoreLayers;
        const key = chartStateAlong({
            layers: ridged,
            grid: buildNavGrid(ridged, bbox, 50, 2.4, 0.5, 30),
            draftM: 2.4,
            safetyM: 0.5,
        });
        expect(key(line[1], line[2])).toBe('-2.00||');
    });

    it('a run through a charted hazard’s buffer says so (its chip names why it is red)', () => {
        const out = collectShallowRuns({
            layers,
            grid,
            polyline,
            caution,
            draftM: 2.4,
            safetyM: 0.5,
            hazardMask: [false, true, false, false, false],
        });
        expect(out.shallowRuns[0].nearHazard).toBe(true);
        expect(out.shallowRuns[0].startSeg).toBe(1);
    });
});
