/**
 * The clearance ring, priced lazily (G2, 2026-10-04). On the Pi's cells the
 * ring round the shallow bands cost each route 0.08–0.67 s on the main thread,
 * priced for every cell of the cached grid before A* ran; route times had risen
 * 18–37% since 61e36ccb. Attached (the seeds, and the cells a band could be
 * near, marked pending), a cell is priced the first time A*, a connector,
 * cellCostAt or the string pull reads it — the same class and the same factor
 * in centreFactor as pricing all of them up front. (The engine prices its
 * cached grids in full since the G2 review, 2026-10-04: the lazy state stayed
 * with the cached grid, 21–74 MB of it on the goldens, uncounted.)
 *
 * Also the bucket index the ring and the clearance checks ask (geometry
 * bboxBuckets): an overview cell's large bands go in coarse buckets instead of
 * being read for every spot asked (Brisbane's cells hold 910 of them), with the
 * same answer as filtering the whole list.
 *
 * Synthetic water — no chart data.
 */
import { describe, expect, it } from 'vitest';
import type { Feature, FeatureCollection } from 'geojson';
import { buildNavGrid } from '../../services/engine/navGrid';
import { aStar, RING_PENDING, shallowRingClass } from '../../services/engine/aStar';
import { applyShallowClearanceRing, attachShallowClearanceRing } from '../../services/engine/shallowRuns';
import { bboxBuckets } from '../../services/engine/geometry';
import { connectToTargets } from '../../services/seaway/connector';
import type { InshoreLayers, NavGrid } from '../../services/engine/types';

const W = 170.0;
const S = -41.006;
const M_LAT = 1 / 111_320;
const KX = 111_320 * Math.cos((41 * Math.PI) / 180);
const BBOX: [number, number, number, number] = [W, S, W + 0.03, S + 0.012];
const box = (x0: number, y0: number, x1: number, y1: number): number[][] => [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0],
];
const band = (x0: number, y0: number, x1: number, y1: number, d1: number, d2: number, rank = 4505): Feature => ({
    type: 'Feature',
    properties: { acronym: 'DEPARE', DRVAL1: d1, DRVAL2: d2, _scaleRank: rank },
    geometry: { type: 'Polygon', coordinates: [box(x0, y0, x1, y1)] },
});
const fc = (...features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
const mx = (m: number) => m / KX;
const my = (m: number) => m * M_LAT;

/** 10–15 m water with a reef drying 2 m, a 34 m patch drying 1 m between
 *  cell centres, a 0–2 m strip, a 2–5 m band, and a coarse chart's 0–2 m band
 *  a finer survey charts 10 m over half of it. */
const layers: InshoreLayers = {
    DEPARE: fc(
        band(W, S, W + 0.03, S + 0.012, 10, 15),
        band(W + 0.004, S + my(300), W + 0.007, S + my(420), -2, 0),
        band(W + 0.012, S + my(610), W + 0.012 + mx(34), S + my(644), -1, 0),
        band(W + 0.016, S + my(200), W + 0.024, S + my(230), 0, 2),
        band(W + 0.004, S + my(900), W + 0.012, S + my(960), 2, 5),
        band(W + 0.018, S + my(700), W + 0.026, S + my(800), 0, 2, 3000),
        band(W + 0.022, S + my(650), W + 0.028, S + my(850), 10, 15, 6000),
    ),
} as InshoreLayers;
const FLOOR = 2.9;
const fresh = (): NavGrid => buildNavGrid(layers, BBOX, 50, 2.4, 0.5, 30);

describe('the clearance ring, priced lazily', () => {
    it('attaching prices nothing: the cells a band could be near are pending, centreFactor untouched', () => {
        const grid = fresh();
        const before = Float32Array.from(grid.centreFactor!);
        attachShallowClearanceRing(grid, layers, FLOOR);
        const ring = grid.shallowRing!;
        expect(ring.length).toBe(grid.width * grid.height);
        expect(ring.some((v) => (v & RING_PENDING) !== 0)).toBe(true);
        expect(Float32Array.from(grid.centreFactor!)).toEqual(before);
        expect(typeof grid.shallowRingResolve).toBe('function');
    });

    it('every cell read reads the class pricing the whole grid gives, with the same factor', () => {
        const eager = fresh();
        const ringed = applyShallowClearanceRing(eager, layers, FLOOR);
        expect(ringed).toBeGreaterThan(0);
        const lazy = fresh();
        attachShallowClearanceRing(lazy, layers, FLOOR);
        // Read in a scattered order: a cell's class never depends on which was read first.
        const n = lazy.width * lazy.height;
        for (let k = 0; k < n; k++) {
            const idx = (k * 7919) % n;
            expect(shallowRingClass(lazy, idx)).toBe(eager.shallowRing![idx]);
        }
        expect(Float32Array.from(lazy.centreFactor!)).toEqual(Float32Array.from(eager.centreFactor!));
        // Read twice, the factor is folded in once.
        for (let idx = 0; idx < n; idx++) shallowRingClass(lazy, idx);
        expect(Float32Array.from(lazy.centreFactor!)).toEqual(Float32Array.from(eager.centreFactor!));
    });

    it('A* and the connectors find the same way on either grid, and A* leaves cells it never reached unpriced', () => {
        const eager = fresh();
        applyShallowClearanceRing(eager, layers, FLOOR);
        const lazy = fresh();
        attachShallowClearanceRing(lazy, layers, FLOOR);
        const start = { x: 2, y: 6 };
        const end = { x: 20, y: 6 };
        expect(aStar(lazy, start, end)).toEqual(aStar(eager, start, end));
        expect(lazy.shallowRing!.some((v) => (v & RING_PENDING) !== 0)).toBe(true);
        const cell = (g: NavGrid, x: number, y: number) => ({
            lat: g.minLat + (y + 0.5) * g.dLat,
            lon: g.minLon + (x + 0.5) * g.dLon,
        });
        const viaLazy = connectToTargets(lazy, cell(lazy, 2, 20), [{ id: 't', kind: 'portal', ...cell(lazy, 36, 14) }]);
        const viaEager = connectToTargets(eager, cell(eager, 2, 20), [
            { id: 't', kind: 'portal', ...cell(eager, 36, 14) },
        ]);
        expect(viaLazy.results).toEqual(viaEager.results);
    });

    it('priced in full, the ring is plain classes and a second call is a no-op', () => {
        const grid = fresh();
        attachShallowClearanceRing(grid, layers, FLOOR);
        expect(applyShallowClearanceRing(grid, layers, FLOOR)).toBeGreaterThan(0);
        expect(grid.shallowRing!.every((v) => v <= 2)).toBe(true);
        expect(grid.shallowRingResolve).toBeUndefined();
        expect(applyShallowClearanceRing(grid, layers, FLOOR)).toBe(0);
    });
});

describe('bboxBuckets: the same answer as filtering the list, with large boxes in coarse buckets', () => {
    // A small deterministic PRNG (no Math.random in a pinned test).
    let seed = 20261004;
    const rnd = (): number => {
        seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
        return seed / 2_147_483_648;
    };
    const items: number[][] = [];
    for (let i = 0; i < 400; i++) {
        const size = i % 10 === 0 ? 3 + rnd() * 3 : i % 3 === 0 ? 0.2 + rnd() * 0.5 : rnd() * 0.05; // huge / coarse / fine (°)
        const x = 152 + rnd() * 3;
        const y = -28 + rnd() * 3;
        items.push([x, y, x + size * rnd(), y + size * rnd()]);
    }
    const meets = (b: number[], q: number[]) => !(b[2] < q[0] || b[0] > q[2] || b[3] < q[1] || b[1] > q[3]);
    const query = bboxBuckets(items, (b) => b);

    it('points, small boxes and wide boxes, in the items’ order', () => {
        for (let k = 0; k < 600; k++) {
            const x = 151.8 + rnd() * 3.4;
            const y = -28.2 + rnd() * 3.4;
            const span = k % 3 === 0 ? 0 : k % 3 === 1 ? rnd() * 0.05 : rnd() * 0.8;
            const q = [x, y, x + span, y + span];
            expect(query(q)).toEqual(items.filter((b) => meets(b, q)));
        }
    });
});
