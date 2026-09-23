import { describe, expect, it } from 'vitest';
import { euclideanDistanceTransform, routeMarina, type Cell } from '../services/marinaCenterline';
import { preserveCanalCentreline } from '../services/canalCentreline';
import { visitGridSegment } from '../services/gridSegmentTraversal';

// Synthetic geometry only: this makes no assertion about chart coverage or the
// actual clearance of a real canal. Every orientation shares the same invariant.
const size = 100;
const rotate = ({ x, y }: Cell, turns: number): Cell => {
    for (let i = 0; i < turns; i++) [x, y] = [size - 1 - y, x];
    return { x, y };
};

function bend(turns: number) {
    const water = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            if ((x >= 10 && x <= 80 && y >= 10 && y <= 30) || (x >= 60 && x <= 80 && y >= 10 && y <= 85)) {
                const cell = rotate({ x, y }, turns);
                water[cell.y * size + cell.x] = 1;
            }
        }
    }
    return {
        water,
        depth: Float32Array.from(water, (value) => (value ? 1 : NaN)),
        start: rotate({ x: 30, y: 20 }, turns),
        end: rotate({ x: 70, y: 70 }, turns),
    };
}

function segmentMinimum(path: Cell[], clearance: Float32Array): number {
    let minimum = Infinity;
    for (let i = 1; i < path.length; i++) {
        const a = path[i - 1];
        const b = path[i];
        const samples = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * 20));
        for (let sample = 0; sample <= samples; sample++) {
            const t = sample / samples;
            const x = Math.floor(a.x + 0.5 + (b.x - a.x) * t);
            const y = Math.floor(a.y + 0.5 + (b.y - a.y) * t);
            minimum = Math.min(minimum, clearance[y * size + x]);
        }
    }
    return minimum;
}

describe('generic canal corner clearance survives route simplification', () => {
    it('does not skip a blocked cell crossed between rounded LOS samples', () => {
        const shape = { width: 6, height: 6 };
        const water = new Uint8Array(36).fill(1);
        water[1 * shape.width + 2] = 0;
        const clearance = euclideanDistanceTransform(water, shape);
        const path = [
            { x: 1, y: 1 },
            { x: 1, y: 2 },
            { x: 2, y: 2 },
            { x: 3, y: 2 },
        ];
        const simplified = preserveCanalCentreline(path, water, clearance, shape)!;
        expect(simplified).not.toBeNull();
        for (let i = 1; i < simplified.length; i++) {
            const a = simplified[i - 1];
            const b = simplified[i];
            for (let s = 0; s <= 100; s++) {
                const x = Math.floor(a.x + 0.5 + ((b.x - a.x) * s) / 100);
                const y = Math.floor(a.y + 0.5 + ((b.y - a.y) * s) / 100);
                expect(water[y * shape.width + x], `blocked cell ${x},${y}`).toBe(1);
            }
        }
    });
    it.each([0, 1, 2, 3])('preserves the centreline margin around rotated bend %s', (turns) => {
        const { water, depth, start, end } = bend(turns);
        const shape = { width: size, height: size };
        const clearance = euclideanDistanceTransform(water, shape);
        for (const [from, to] of [
            [start, end],
            [end, start],
        ]) {
            const result = routeMarina(depth, shape, from, to, {
                keelCells: 2,
                depthWeight: 0,
                canalHalfWidthCells: 12,
                bias: 5,
            });
            expect(result).not.toBeNull();
            const rawMinimum = Math.min(...result!.cells.map((c) => clearance[c.y * size + c.x]));
            const passable = Uint8Array.from(clearance, (value) => (value >= 2 ? 1 : 0));
            const waypoints = preserveCanalCentreline(result!.cells, passable, clearance, shape)!;
            expect(waypoints).not.toBeNull();
            const returnedMinimum = segmentMinimum(waypoints, clearance);
            // One raster cell is the allowed de-staircasing tolerance, not a
            // licence to reduce a mid-channel path to the eroded-bank margin.
            expect(returnedMinimum, `raw=${rawMinimum}, returned=${returnedMinimum}`).toBeGreaterThanOrEqual(
                rawMinimum - 1,
            );
            expect(waypoints.length).toBeLessThan(result!.cells.length);
        }
    });
    it('retains a checked winding cell path if simplification exhausts its work budget', () => {
        const width = 400,
            height = 400;
        const passable = new Uint8Array(width * height).fill(1);
        const clearance = new Float32Array(width * height).fill(10);
        const path: Cell[] = [];
        for (let y = 2; y < 202; y++) {
            if (y % 2 === 0) for (let x = 2; x < 398; x++) path.push({ x, y });
            else for (let x = 397; x >= 2; x--) path.push({ x, y });
        }
        const result = preserveCanalCentreline(path, passable, clearance, { width, height });
        expect(result).toEqual(path);
        expect(result).not.toBe(path);
    });
    it('never erases a short reversal or accepts a discontinuous fallback path', () => {
        const shape = { width: 10, height: 10 };
        const passable = new Uint8Array(100).fill(1);
        const clearance = new Float32Array(100).fill(5);
        const path = [
            { x: 2, y: 2 },
            { x: 3, y: 2 },
            { x: 4, y: 2 },
            { x: 3, y: 2 },
            { x: 2, y: 2 },
        ];
        expect(preserveCanalCentreline(path, passable, clearance, shape)).toContainEqual({ x: 4, y: 2 });
        expect(
            preserveCanalCentreline(
                [
                    { x: 2, y: 2 },
                    { x: 5, y: 5 },
                ],
                passable,
                clearance,
                shape,
            ),
        ).toBeNull();
    });
    it('preserves a low-clearance departure approach while retaining the wide-channel corner', () => {
        const { water, depth, end } = bend(0);
        const shape = { width: size, height: size };
        const clearance = euclideanDistanceTransform(water, shape);
        const passable = Uint8Array.from(clearance, (value) => (value >= 2 ? 1 : 0));
        const result = routeMarina(depth, shape, { x: 30, y: 11 }, end, {
            keelCells: 2,
            depthWeight: 0,
            canalHalfWidthCells: 12,
            bias: 5,
        })!;
        const waypoints = preserveCanalCentreline(result.cells, passable, clearance, shape)!;
        expect(waypoints[0]).toEqual(result.cells[0]);
        for (let i = 1; i < waypoints.length; i++) {
            const a = waypoints[i - 1],
                b = waypoints[i];
            expect(
                visitGridSegment(a.x + 0.5, a.y + 0.5, b.x + 0.5, b.y + 0.5, (x, y) => {
                    if (!passable[y * size + x]) return false;
                    return x < 50 || y > 40 || clearance[y * size + x] >= 9;
                }),
            ).toBe(true);
        }
    });
});

describe('exact bounded grid segment traversal', () => {
    it('covers an independent closed-rectangle intersection oracle in all directions', () => {
        let seed = 93481;
        const random = () => {
            seed = (seed * 1664525 + 1013904223) >>> 0;
            return seed / 2 ** 32;
        };
        const intersects = (a: number[], b: number[], x: number, y: number) => {
            let lower = 0,
                upper = 1;
            for (const [origin, delta, min, max] of [
                [a[0], b[0] - a[0], x, x + 1],
                [a[1], b[1] - a[1], y, y + 1],
            ]) {
                if (delta === 0) {
                    if (origin < min || origin > max) return false;
                } else {
                    const first = (min - origin) / delta,
                        last = (max - origin) / delta;
                    lower = Math.max(lower, Math.min(first, last));
                    upper = Math.min(upper, Math.max(first, last));
                    if (lower > upper + 1e-13) return false;
                }
            }
            return lower <= upper + 1e-13;
        };
        for (let run = 0; run < 300; run++) {
            const a = [random() * 14 - 7, random() * 14 - 7];
            const b = [random() * 14 - 7, random() * 14 - 7];
            if (run % 3 === 0) a[0] = Math.round(a[0]);
            if (run % 5 === 0) b[1] = Math.round(b[1]);
            if (run % 7 === 0) b[0] = a[0];
            if (run % 11 === 0) b[1] = a[1];
            const seen = new Set<string>();
            expect(
                visitGridSegment(a[0], a[1], b[0], b[1], (x, y) => {
                    seen.add(`${x},${y}`);
                    return true;
                }),
            ).toBe(true);
            for (let y = -8; y < 8; y++)
                for (let x = -8; x < 8; x++) {
                    if (intersects(a, b, x, y))
                        expect(
                            seen.has(`${x},${y}`),
                            `${JSON.stringify(a)} -> ${JSON.stringify(b)} misses ${x},${y}`,
                        ).toBe(true);
                }
        }
    });
    it.each([false, true])('catches a tiny blocked-corner crossing, reverse=%s', (reverse) => {
        const a = reverse ? [4.5, 4.49] : [0.5, 0.5];
        const b = reverse ? [0.5, 0.5] : [4.5, 4.49];
        expect(visitGridSegment(a[0], a[1], b[0], b[1], (x, y) => x !== 2 || y !== 1)).toBe(false);
    });
    it('checks all four cells at exact corners and both sides of an edge', () => {
        for (const blocked of [
            [1, 0],
            [0, 1],
        ])
            expect(visitGridSegment(0.5, 0.5, 2.5, 2.5, (x, y) => x !== blocked[0] || y !== blocked[1])).toBe(false);
        expect(visitGridSegment(2, 0.5, 2, 4.5, (x, y) => x !== 1 || y !== 2)).toBe(false);
        expect(visitGridSegment(0.5, 2, 4.5, 2, (x, y) => x !== 2 || y !== 1)).toBe(false);
    });
    it('visits ordinary clear segments, refuses invalid input, and stops at its work budget', () => {
        expect(visitGridSegment(2.5, 2.5, 4.5, 4.5, () => true)).toBe(true);
        expect(visitGridSegment(2.5, 2.5, 2.5, 2.5, () => true)).toBe(true);
        expect(visitGridSegment(NaN, 2.5, 4.5, 4.5, () => true)).toBe(false);
        let count = 0;
        expect(
            visitGridSegment(
                0.5,
                0.5,
                100_000.5,
                0.5,
                () => {
                    count++;
                    return true;
                },
                12,
            ),
        ).toBe(false);
        expect(count).toBe(12);
    });
});
