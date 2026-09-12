import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Feature, Position } from 'geojson';

vi.mock('martinez-polygon-clipping', async (importOriginal) => {
    const actual = await importOriginal<typeof import('martinez-polygon-clipping')>();
    return { ...actual, diff: vi.fn(actual.diff) };
});

import { diff } from 'martinez-polygon-clipping';
import {
    clipFeatureOutsideCoverage,
    coverageVertexCount,
    emptyClipStats,
    GLAZE_MARTINEZ_VERTEX_CAP,
    GLAZE_MARTINEZ_WORK_CAP,
    GLAZE_RESULT_VERTEX_CAP,
    martinezAdmissionWork,
    type FineCoverage,
} from '../../services/enc/clipDepareOverlap';

const square = (x0: number, y0: number, x1: number, y1: number): Position[] => [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0],
];
const band = (): Feature => ({
    type: 'Feature',
    properties: { DRVAL1: 5 },
    geometry: { type: 'Polygon', coordinates: [square(0, 0, 10, 10)] },
});
const fine = (): FineCoverage => ({ bbox: [0, 0, 5, 5], coverage: [[square(0, 0, 5, 5)]] });

describe('pre-Martinez work admission', () => {
    beforeEach(() => {
        vi.mocked(diff).mockClear();
    });

    it('never enters Martinez for the real ESM 80-by-80 crossing-strips counterexample', () => {
        // Only800 input vertices, below the old12k cap. Real diff creates
        //32,400 output vertices (~32MB transient) BEFORE a result cap runs.
        const n = 80;
        const subject: Feature = {
            type: 'Feature',
            properties: { DRVAL1: 5 },
            geometry: {
                type: 'MultiPolygon',
                coordinates: Array.from({ length: n }, (_, i) => [square(0, i, n * 2, i + 0.5)]),
            },
        };
        const strips = Array.from({ length: n }, (_, i): [number, number, number, number] => [
            i * 2 + 0.75,
            -1,
            i * 2 + 1.25,
            n + 1,
        ]);
        const coverage: FineCoverage = {
            bbox: [0, -1, n * 2, n + 1],
            coverage: strips.map((rect) => [square(...rect)]),
            stripRects: strips,
        };
        const stats = emptyClipStats();

        const out = clipFeatureOutsideCoverage(subject, [coverage], GLAZE_MARTINEZ_VERTEX_CAP, stats);

        expect(diff).not.toHaveBeenCalled();
        expect(stats.pairsStripped).toBe(1);
        expect(stats.maxPairVertices).toBe(800);
        expect(out).not.toBeNull();
        const geometry = out!.geometry;
        expect(geometry.type).toBe('MultiPolygon');
        if (geometry.type === 'MultiPolygon') expect(coverageVertexCount(geometry.coordinates)).toBeLessThan(24_000);
        expect(subject.geometry.type === 'MultiPolygon' && subject.geometry.coordinates).toHaveLength(80);
    });

    it('counts interactions within a fragmented input, not only subject-times-coverage', () => {
        const subject: Feature = {
            type: 'Feature',
            properties: {},
            geometry: {
                type: 'MultiPolygon',
                coordinates: Array.from({ length: 80 }, (_, i) => [square(0, i / 10, 10, i / 10 + 0.05)]),
            },
        };
        const stats = emptyClipStats();
        clipFeatureOutsideCoverage(subject, [fine()], undefined, stats);
        expect(diff).not.toHaveBeenCalled();
        expect(stats.pairsStripped).toBe(1);
    });

    it('preserves clip-nothing semantics when a work-capped fine has empty strips', () => {
        const subject = band();
        const coverage: FineCoverage = {
            ...fine(),
            coverage: Array.from({ length: 80 }, (_, i) => [square(0, i / 10, 5, i / 10 + 0.05)]),
            stripRects: [],
        };
        expect(clipFeatureOutsideCoverage(subject, [coverage])).toBe(subject);
        expect(diff).not.toHaveBeenCalled();
    });

    it('rejects a pair that does not fit the remaining job budget before allocating', () => {
        const budget = { remaining: 1 };
        const stats = emptyClipStats();
        clipFeatureOutsideCoverage(band(), [fine()], undefined, stats, budget);
        expect(diff).not.toHaveBeenCalled();
        expect(budget.remaining).toBe(1);
        expect(stats.pairsStripped).toBe(1);
    });

    it('precharges failed attempts instead of letting repeated throws consume no budget', () => {
        vi.mocked(diff).mockImplementationOnce(() => {
            throw new Error('degenerate clip');
        });
        const budget = { remaining: 1_000 };
        const stats = emptyClipStats();
        clipFeatureOutsideCoverage(band(), [fine()], undefined, stats, budget);
        expect(diff).toHaveBeenCalledOnce();
        expect(budget.remaining).toBeLessThan(1_000);
        expect(budget.remaining).toBeGreaterThanOrEqual(0);
        expect(stats.pairsRectFallback).toBe(1);
    });

    it('keeps empty strips as clip-nothing even when an admitted exact operation throws', () => {
        vi.mocked(diff).mockImplementationOnce(() => {
            throw new Error('degenerate clip');
        });
        const subject = band();
        const budget = { remaining: 1_000 };
        expect(clipFeatureOutsideCoverage(subject, [{ ...fine(), stripRects: [] }], undefined, undefined, budget)).toBe(
            subject,
        );
        expect(diff).toHaveBeenCalledOnce();
        expect(budget.remaining).toBe(1_000 - martinezAdmissionWork(10));
    });

    it('still uses the extent fallback on a throw when strips are absent', () => {
        vi.mocked(diff).mockImplementationOnce(() => {
            throw new Error('degenerate clip');
        });
        const all: FineCoverage = { bbox: [-1, -1, 11, 11], coverage: [[square(-1, -1, 11, 11)]] };
        expect(clipFeatureOutsideCoverage(band(), [all])).toBeNull();
        expect(diff).toHaveBeenCalledOnce();
    });

    it('fits a complete attempt exactly, then refuses the next without budget overshoot', () => {
        const work = martinezAdmissionWork(10); // two closed squares
        const budget = { remaining: work };
        clipFeatureOutsideCoverage(band(), [fine()], undefined, undefined, budget);
        expect(diff).toHaveBeenCalledOnce();
        expect(budget.remaining).toBe(0);
        clipFeatureOutsideCoverage(band(), [fine()], undefined, undefined, budget);
        expect(diff).toHaveBeenCalledOnce();
        expect(budget.remaining).toBe(0);
    });

    it('charges an admitted attempt even when its returned result is discarded', () => {
        vi.mocked(diff).mockReturnValueOnce([[new Array<[number, number]>(3_000).fill([0, 0])]]);
        const work = martinezAdmissionWork(10);
        const budget = { remaining: work };
        const stats = emptyClipStats();
        clipFeatureOutsideCoverage(band(), [fine()], undefined, stats, budget);
        expect(diff).toHaveBeenCalledOnce();
        expect(budget.remaining).toBe(0);
        expect(stats.pairsResultCapped).toBe(1);
    });

    it('derives its conservative admission from the existing result bound', () => {
        expect(GLAZE_MARTINEZ_WORK_CAP).toBe(GLAZE_RESULT_VERTEX_CAP);
        expect(martinezAdmissionWork(10)).toBe(10 + 4 * ((10 * 9) / 2));
        expect(martinezAdmissionWork(800)).toBeGreaterThan(GLAZE_MARTINEZ_WORK_CAP);
        expect(martinezAdmissionWork(NaN)).toBe(Infinity);
    });
});
