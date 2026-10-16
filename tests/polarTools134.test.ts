import { describe, expect, it } from 'vitest';
import { polarFile, polarFromTargets, resizePolar, routingPolarScale } from '../services/polarTools';
import { readPolarFile } from '../utils/polarParser';
import { createPolarSpeedLookup } from '../services/isochrone/polar';
import { resolveRoutingPolarFrom, routingSpeedModel, toEdgePolar } from '../services/routingPolar';
import { passageSpeed } from '../services/passagePlan';
import { DEFAULT_VESSEL } from '../utils/defaultVessel';
import type { PolarData } from '../types';

const grid: PolarData = {
    windSpeeds: [6, 12, 20],
    angles: [45, 90, 180],
    matrix: [
        [3.1234, 5, 6],
        [4, 7, 8],
        [2, 4, 5],
    ],
};
describe('134-06 owner polar tools', () => {
    it('resizes by value, preserves exact existing figures, interpolates inside and leaves new extremes empty', () => {
        const next = resizePolar(grid, [6, 9, 12, 20, 25], [30, 45, 60, 90, 180]);
        expect(next.matrix[1][0]).toBe(3.1234);
        expect(next.matrix[3][1]).toBe(5.5);
        expect(next.matrix[0]).toEqual([0, 0, 0, 0, 0]);
        expect(next.matrix.every((row) => row[4] === 0)).toBe(true);
        expect(grid.matrix[0][0]).toBe(3.1234);
        expect(() => resizePolar(grid, [12, 6], [45, 90])).toThrow();
        expect(() => resizePolar(grid, [6], [45, 90])).toThrow();
        expect(() =>
            resizePolar(
                grid,
                Array.from({ length: 31 }, (_, i) => i + 1),
                [45, 90],
            ),
        ).toThrow();
    });
    it('builds one generic starting estimate through the three declared targets, independent of boat or location', () => {
        const p = polarFromTargets({ windKts: 12, beatAngle: 40, beatKts: 5, reachKts: 7, runKts: 4 });
        const at = createPolarSpeedLookup(p, 12);
        expect(at(40)).toBe(5);
        expect(at(90)).toBe(7);
        expect(at(180)).toBe(4);
        expect(p.angles[0]).toBe(40);
        expect(() => polarFromTargets({ windKts: NaN, beatAngle: 40, beatKts: 5, reachKts: 7, runKts: 4 })).toThrow();
    });
    it('round-trips Expedition angle/speed pairs and OpenCPN-style CSV without axis transposition', () => {
        for (const format of ['pol', 'csv'] as const) {
            const p = readPolarFile(polarFile(grid, format)).polar;
            expect(p.windSpeeds).toEqual(grid.windSpeeds);
            expect(p.angles).toEqual(grid.angles);
            expect(p.matrix).toEqual([
                [3.12, 5, 6],
                [4, 7, 8],
                [2, 4, 5],
            ]);
        }
        expect(() => polarFile({ ...grid, matrix: [[NaN]] }, 'csv')).toThrow();
    });
    it('scales every sailing resolver once and the HUD preserves it without scaling engine speed', () => {
        const unscaled = resolveRoutingPolarFrom({ settings: {}, vessel: DEFAULT_VESSEL, learned: null });
        for (const factor of [0.7, 1, 1.3]) {
            const r = resolveRoutingPolarFrom({
                settings: { routingPolarScale: factor },
                vessel: DEFAULT_VESSEL,
                learned: null,
            });
            expect(r.label).toContain(`routing ${Math.round(factor * 100)}%`);
            const value = createPolarSpeedLookup(r.polar, 15)(90);
            expect(value).toBeCloseTo(createPolarSpeedLookup(unscaled.polar, 15)(90) * factor, 8);
            const model = routingSpeedModel(r, { mode: 'polar', cruiseKts: 6, isSail: true, closeHauledDeg: 45 });
            expect(passageSpeed(model, 15, 90, 0).kts).toBeCloseTo(value, 8);
            expect(passageSpeed(model, 0, 90, 0).kts).toBe(6);
            expect(createPolarSpeedLookup(r.polar, 15)(0)).toBe(0);
            if (factor !== 1) expect(r.signature).not.toBe(unscaled.signature);
            if (factor !== 1) expect(toEdgePolar(r)).not.toBeNull();
        }
        expect([
            routingPolarScale(NaN),
            routingPolarScale(null),
            routingPolarScale(0.1),
            routingPolarScale(10),
        ]).toEqual([1, 1, 0.7, 1.3]);
    });
});
