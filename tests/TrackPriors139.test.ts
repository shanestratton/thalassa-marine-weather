import { describe, expect, it } from 'vitest';
import type { NavGrid } from '../services/engine/types';
import { applyTrackPriors, trackPriorFactor, type TrackRoutingPrior } from '../services/engine/trackPriors';
import { aStar, cellCostAt, chainCostM } from '../services/engine/aStar';
const grid = (): NavGrid => ({
    width: 15,
    height: 15,
    minLat: -27,
    minLon: 153,
    dLat: 0.0005,
    dLon: 0.0005,
    cells: new Float32Array(225).fill(10),
    preferred: new Uint8Array(225),
    centreFactor: new Float32Array(225).fill(1),
    landBlocked: new Uint8Array(225),
    berthBlocked: new Uint8Array(225),
});
const point = (x: number, y: number) => ({ lat: -27 + (y + 0.5) * 0.0005, lon: 153 + (x + 0.5) * 0.0005 });
const prior = (source: TrackRoutingPrior['source'] = 'own-track'): TrackRoutingPrior => ({
    source,
    approval: 'approved',
    points: [point(1, 7), point(13, 7)],
});
describe('optional track cost priors cannot vouch for water', () => {
    it('own tracks are stronger than approved lanes; neither changes cell, mask or channel evidence', () => {
        const g = grid(),
            before = g.cells.slice(),
            preferred = g.preferred.slice();
        applyTrackPriors(g, [prior('approved-community')], 3);
        expect(trackPriorFactor(g, 7 * 15 + 7)).toBe(0.95);
        applyTrackPriors(g, [prior('approved-community'), prior()], 3);
        expect(trackPriorFactor(g, 7 * 15 + 7)).toBe(0.9);
        expect(g.cells).toEqual(before);
        expect(g.preferred).toEqual(preferred);
        expect(trackPriorFactor(g, 0)).toBe(1);
        applyTrackPriors(g, undefined, 3);
        expect(g.trackPrior).toBeUndefined();
    });
    it('rejects pending/foreign sources, malformed lines and over-budget request geometry', () => {
        for (const p of [
            { ...prior('approved-community'), approval: 'pending' },
            { ...prior(), source: 'chart' },
            { ...prior(), points: [point(1, 7), { lat: NaN, lon: 153 }] },
            null,
        ]) {
            const g = grid();
            applyTrackPriors(g, [p] as TrackRoutingPrior[], 3);
            expect(g.trackPrior).toBeUndefined();
        }
        const g = grid();
        applyTrackPriors(
            g,
            Array.from({ length: 13 }, () => prior()),
            3,
        );
        expect(g.trackPrior).toBeUndefined();
    });
    it('keeps land, obstructions, unknown, sub-margin, caution and channel costs intact even under poisoned hints', () => {
        const g = grid(),
            base = 7 * 15;
        g.cells[base + 2] = NaN;
        g.cells[base + 3] = 0;
        g.cells[base + 4] = 2.9;
        g.cells[base + 5] = -1;
        g.preferred[base + 6] = 1;
        g.landBlocked![base + 8] = 1;
        g.berthBlocked![base + 9] = 1;
        g.cells[base + 10] = Infinity;
        const before = g.cells.slice();
        applyTrackPriors(g, [prior()], 3);
        for (const x of [2, 3, 4, 5, 6, 8, 9, 10]) expect(trackPriorFactor(g, base + x)).toBe(1);
        expect(g.cells).toEqual(before);
        g.trackPrior = new Uint8Array(225).fill(2);
        g.trackPriorRequiredM = 3;
        for (const x of [2, 3, 4, 5, 6, 8, 9, 10]) expect(trackPriorFactor(g, base + x)).toBe(1);
        // The existing scalar helper uses the unknown fallback; A* separately refuses NaN cells.
        expect(cellCostAt(g, 2, 7)).toBe(500);
    });
    it('uses identical A* and refinement prices, while blocked water still refuses', () => {
        const g = grid(),
            start = { x: 1, y: 7 },
            end = { x: 13, y: 7 };
        const ordinary = aStar(g, start, end)!;
        const before = chainCostM(g, ordinary);
        applyTrackPriors(g, [prior()], 3);
        const route = aStar(g, start, end)!;
        expect(chainCostM(g, route)).toBeCloseTo(before * 0.9, 5);
        expect(cellCostAt(g, 7, 7)).toBeCloseTo(3.6, 8);
        for (let y = 0; y < 15; y++) g.cells[y * 15 + 7] = NaN;
        applyTrackPriors(g, [prior()], 3);
        expect(aStar(g, start, end)).toBeNull();
    });
    it('never converts below-margin historical travel into a competing cheap path', () => {
        const g = grid();
        for (let x = 1; x < 14; x++) g.cells[7 * 15 + x] = -1;
        applyTrackPriors(g, [prior()], 3);
        const route = aStar(g, { x: 1, y: 6 }, { x: 13, y: 6 })!;
        expect(route.every((p) => p.y !== 7)).toBe(true);
    });
});
