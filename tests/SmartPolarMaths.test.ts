/**
 * The learned polar's maths (build 132, package 132-B22): SmartPolarStore's
 * buckets, its outlier test, and the 42-cell table it exports for the chart
 * and for routing. Nothing here was pinned before: tests elsewhere fed it
 * samples and looked only at what routing made of them.
 *
 *  - A sample lands in a 2 kn × 5° bucket (floored), and only inside 0–30 kn
 *    and 40–180°.
 *  - From 10 samples a bucket refuses one more than 3σ off its mean — with a
 *    floor on σ of 0.1 kn, a log's resolution: ten identical readings made σ
 *    0, and the bucket then refused every reading a tenth off, for good (the
 *    one fix here).
 *  - A cell is the sample-weighted mean of its own bucket and the eight
 *    around it, nearer ones heavier (weight = count / (distance in buckets +
 *    0.1)), to 0.1 kn; a bucket counts from 3 samples for the chart and from
 *    10 for routing.
 *
 * Fictional figures; storage is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/nativeStorage', () => ({
    loadLargeData: vi.fn(async () => null),
    saveLargeData: vi.fn(async () => undefined),
}));

import { ROUTING_MIN_BUCKET_SAMPLES, SmartPolarStore } from '../services/SmartPolarStore';
import { LEARNED_CELLS } from '../services/routingPolar';

const ANGLES = [45, 60, 90, 120, 150, 180];
const WINDS = [6, 8, 10, 12, 15, 20, 25];

/** One exported cell (the 42-cell table: 7 wind speeds × 6 angles). */
function cellAt(twa: number, tws: number, minSamples?: number): number {
    const p = SmartPolarStore.exportToPolarData(minSamples);
    if (!p) return 0;
    return p.matrix[p.angles.indexOf(twa)][p.windSpeeds.indexOf(tws)];
}

const record = (tws: number, twa: number, ...speeds: number[]) => {
    for (const stw of speeds) SmartPolarStore.recordSample(tws, twa, stw);
};
const times = (n: number, stw: number) => Array.from({ length: n }, () => stw);
const bucket = (tws: number, twa: number) => SmartPolarStore.getGrid()!.buckets[`tws_${tws}_twa_${twa}`];

beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T00:00:00Z'));
    await SmartPolarStore.ensureLoaded();
    await SmartPolarStore.reset();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('a sample lands in its 2 kn × 5° bucket', () => {
    it('floored: 11.9 kn at 94.9° is the 10 kn, 90° bucket', () => {
        record(11.9, 94.9, 6.4);
        expect(Object.keys(SmartPolarStore.getGrid()!.buckets)).toEqual(['tws_10_twa_90']);
        expect(bucket(10, 90)).toMatchObject({ count: 1, sumSTW: 6.4, minSTW: 6.4, maxSTW: 6.4 });
        expect(bucket(10, 90).sumSTW2).toBeCloseTo(6.4 * 6.4, 10);
    });

    it('only inside 0–30 kn of wind and 40–180° of angle', () => {
        record(30, 90, 7); // 30 kn is past the last bucket
        record(10, 39.9, 5); // inside 40°
        record(10, 180.1, 5);
        record(-1, 90, 5);
        expect(SmartPolarStore.getStats().totalSamples).toBe(0);
        record(29.9, 40, 7);
        record(0, 180, 1.2);
        expect(Object.keys(SmartPolarStore.getGrid()!.buckets).sort()).toEqual(['tws_0_twa_180', 'tws_28_twa_40']);
    });

    it('counts samples, buckets and their spread of time in its stats', () => {
        record(10, 90, 6.0, 6.2);
        vi.setSystemTime(new Date('2026-10-15T01:00:00Z'));
        record(12, 120, 6.8);
        const stats = SmartPolarStore.getStats();
        expect(stats.totalSamples).toBe(3);
        expect(stats.filledBuckets).toBe(2);
        // 15 wind buckets (0–30 kn) × 28 angle buckets (40–180°).
        expect(stats.totalBuckets).toBe(15 * 28);
        expect(stats.oldestSample).toBe(Date.parse('2026-10-15T00:00:00Z'));
        expect(stats.newestSample).toBe(Date.parse('2026-10-15T01:00:00Z'));
    });
});

describe('the outlier test, from 10 samples a bucket', () => {
    it('takes every sample before the tenth, however wild', () => {
        record(10, 90, ...times(9, 6.1), 12);
        expect(bucket(10, 90).count).toBe(10);
        expect(bucket(10, 90).maxSTW).toBe(12);
    });

    it('then refuses one more than 3σ off the mean, and takes one within it', () => {
        // Ten samples, 6.0 and 6.2 alternately: mean 6.1, σ 0.1.
        record(10, 90, ...Array.from({ length: 10 }, (_, i) => (i % 2 ? 6.2 : 6.0)));
        record(10, 90, 9.5); // a surf, or a paddlewheel spike
        expect(bucket(10, 90).count).toBe(10);
        expect(SmartPolarStore.getStats().totalSamples).toBe(10);
        record(10, 90, 6.35); // 2.5σ
        expect(bucket(10, 90).count).toBe(11);
        expect(bucket(10, 90).maxSTW).toBe(6.35);
    });

    it('never treats a spread of 0 as the spread: ten identical readings do not freeze the bucket', () => {
        record(10, 90, ...times(10, 6.0));
        record(10, 90, 6.1, 6.2, 6.3); // a tenth, two and three off: within 3 × 0.1 kn
        expect(bucket(10, 90).count).toBe(13);
        record(10, 90, 7.5); // still refused: 1.45 kn off, far past 3 × 0.1 kn
        expect(bucket(10, 90).count).toBe(13);
    });
});

describe('the 42-cell table it exports', () => {
    it('is nothing until a bucket has 3 samples; then the chart shows it, and routing not until 10', () => {
        record(10, 90, 6.0, 6.2);
        expect(SmartPolarStore.exportToPolarData()).toBeNull();
        expect(SmartPolarStore.filledCellCount()).toBe(0);
        record(10, 90, 6.1);
        expect(cellAt(90, 10)).toBe(6.1);
        expect(SmartPolarStore.exportToPolarData(ROUTING_MIN_BUCKET_SAMPLES)).toBeNull();
        record(10, 90, ...times(7, 6.1));
        expect(cellAt(90, 10, ROUTING_MIN_BUCKET_SAMPLES)).toBe(6.1);
    });

    it('has the factory polar’s rows and columns: 7 wind speeds × 6 angles', () => {
        record(10, 90, ...times(3, 6.1));
        const p = SmartPolarStore.exportToPolarData()!;
        expect(p.windSpeeds).toEqual(WINDS);
        expect(p.angles).toEqual(ANGLES);
        expect(p.matrix.flat()).toHaveLength(LEARNED_CELLS);
    });

    it('fills each cell from its own bucket and the eight around it, so one bucket fills its neighbours', () => {
        // The 10 kn, 90° bucket is the 8, 10 and 12 kn cells' neighbour at 90°.
        record(10, 90, ...times(3, 6.1));
        expect(cellAt(90, 8)).toBe(6.1);
        expect(cellAt(90, 10)).toBe(6.1);
        expect(cellAt(90, 12)).toBe(6.1);
        expect(cellAt(90, 15)).toBe(0); // 14–16 kn buckets: not a neighbour
        expect(cellAt(60, 10)).toBe(0);
        expect(SmartPolarStore.filledCellCount()).toBe(3);
    });

    it('weights the neighbours by samples over distance: count / (buckets away + 0.1)', () => {
        // Own bucket: 3 samples at 6.0 (weight 3 / 0.1 = 30). One angle
        // bucket off: 4 at 7.0 (weight 4 / 1.1). One off in both: 5 at 8.0
        // (weight 5 / (√2 + 0.1)).
        record(10, 90, ...times(3, 6.0));
        record(10, 95, ...times(4, 7.0));
        record(12, 95, ...times(5, 8.0));
        const w = [3 / 0.1, 4 / 1.1, 5 / (Math.SQRT2 + 0.1)];
        const mean = (6.0 * w[0] + 7.0 * w[1] + 8.0 * w[2]) / (w[0] + w[1] + w[2]);
        expect(cellAt(90, 10)).toBe(Math.round(mean * 10) / 10);
        expect(cellAt(90, 10)).toBe(6.3);
    });

    it('a cell takes the bucket mean, not the last sample: four samples 5.8–6.4 give 6.1', () => {
        record(10, 90, 5.8, 6.0, 6.2, 6.4);
        expect(cellAt(90, 10)).toBe(6.1);
    });

    it('the 180° row reads the 180° bucket; the 25 kn column the 22–26 kn buckets', () => {
        record(0, 180, ...times(3, 1.4)); // 0–2 kn: no exported column reaches it
        expect(SmartPolarStore.exportToPolarData()).toBeNull();
        record(24, 180, ...times(3, 7.2));
        expect(cellAt(180, 25)).toBe(7.2);
        expect(cellAt(180, 20)).toBe(0); // the 20 kn cell reads the 18–22 kn buckets
        record(28, 180, ...times(3, 9.9)); // 28 kn: past the 25 kn cell's neighbours
        expect(cellAt(180, 25)).toBe(7.2);
    });

    it('reset empties it', async () => {
        record(10, 90, ...times(3, 6.1));
        await SmartPolarStore.reset();
        expect(SmartPolarStore.exportToPolarData()).toBeNull();
        expect(SmartPolarStore.getStats().totalSamples).toBe(0);
    });

    it('fills Pi history gaps from phone learning without counting the same sailing twice', () => {
        record(10, 90, ...times(10, 6));
        const local = SmartPolarStore.exportToRoutingPolar()!;
        const pi = { ...local, matrix: local.matrix.map((row) => row.map(() => 0)) };
        pi.matrix[0][0] = 5;
        expect(SmartPolarStore.exportToRoutingPolar(pi)!.matrix[2][2]).toBe(6);
        expect(SmartPolarStore.exportToRoutingPolar(pi)!.matrix[0][0]).toBe(5);
        pi.matrix[2][2] = 5.5;
        expect(SmartPolarStore.exportToRoutingPolar(pi)!.matrix[2][2]).toBe(5.5);
        expect(SmartPolarStore.getStats().totalSamples).toBe(10);
        expect(SmartPolarStore.exportToRoutingPolar(null)).toEqual(local);
    });
});
