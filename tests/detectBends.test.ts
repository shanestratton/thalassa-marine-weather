/**
 * Tests for the route-bend detector. Synthetic GeoJSON LineStrings
 * exercise the threshold + spacing + epsilon knobs.
 *
 * Sanity: coordinates are GeoJSON `[lon, lat]` order. If a test name
 * mentions "north" or "east" — north = +lat, east = +lon. Mixing those
 * up was the most fragile part of the implementation; tests are
 * intentionally redundant on that axis.
 */
import { describe, expect, it } from 'vitest';
import { detectBends } from '../services/passage/detectBends';

describe('detectBends — empty / trivial inputs', () => {
    it('returns [] for fewer than 3 points', () => {
        expect(detectBends([])).toEqual([]);
        expect(detectBends([[0, 0]])).toEqual([]);
        expect(
            detectBends([
                [0, 0],
                [1, 1],
            ]),
        ).toEqual([]);
    });

    it('returns [] for a straight line (no direction change)', () => {
        // 5 points marching east at the equator.
        const coords: Array<[number, number]> = [
            [0, 0],
            [1, 0],
            [2, 0],
            [3, 0],
            [4, 0],
        ];
        expect(detectBends(coords)).toEqual([]);
    });
});

describe('detectBends — basic L-shape (90° turn)', () => {
    it('detects the corner of an east → north L', () => {
        // East along equator from 0 to 100km, then north 100km.
        // Each "1 unit" ≈ 111km at the equator.
        const coords: Array<[number, number]> = [
            [0, 0],
            [0.5, 0],
            [1, 0], // ← bend point
            [1, 0.5],
            [1, 1],
        ];
        const bends = detectBends(coords);
        expect(bends).toHaveLength(1);
        expect(bends[0].coordinates.lat).toBeCloseTo(0, 5);
        expect(bends[0].coordinates.lon).toBeCloseTo(1, 5);
        expect(bends[0].bendDeg).toBeGreaterThanOrEqual(85); // ~90°, allow for great-circle slop
    });
});

describe('detectBends — gentle curve below threshold', () => {
    it('returns [] when each segment turns less than 22.5°', () => {
        // A slow curve: 5° heading change per leg, 4 legs total.
        // Total turn 20°, but no single segment crosses the threshold.
        const coords: Array<[number, number]> = [];
        let lon = 0;
        let lat = 0;
        let heading = 0; // east
        for (let i = 0; i <= 6; i++) {
            coords.push([lon, lat]);
            heading += 5; // 5° turn per leg
            const stepDeg = 0.5;
            lon += stepDeg * Math.cos((heading * Math.PI) / 180);
            lat += stepDeg * Math.sin((heading * Math.PI) / 180);
        }
        const bends = detectBends(coords);
        expect(bends).toHaveLength(0);
    });
});

describe('detectBends — multi-bend zigzag', () => {
    it('detects two distinct corners of an N-shape', () => {
        // east → north → east — two 90° corners, well-separated.
        const coords: Array<[number, number]> = [
            [0, 0],
            [1, 0],
            [2, 0], // bend 1
            [2, 1],
            [2, 2], // bend 2
            [3, 2],
            [4, 2],
        ];
        const bends = detectBends(coords);
        expect(bends).toHaveLength(2);
        // Bend 1 at (lon=2, lat=0)
        expect(bends[0].coordinates.lon).toBeCloseTo(2, 5);
        expect(bends[0].coordinates.lat).toBeCloseTo(0, 5);
        // Bend 2 at (lon=2, lat=2)
        expect(bends[1].coordinates.lon).toBeCloseTo(2, 5);
        expect(bends[1].coordinates.lat).toBeCloseTo(2, 5);
    });
});

describe('detectBends — minSpacingNm dedup', () => {
    it('drops a bend that lands within 1 NM of an existing waypoint', () => {
        // L-shape with the corner exactly co-located with a named WP.
        const coords: Array<[number, number]> = [
            [0, 0],
            [0.5, 0],
            [1, 0], // candidate bend
            [1, 0.5],
            [1, 1],
        ];
        const bends = detectBends(coords, {
            existingWaypoints: [{ lat: 0, lon: 1 }],
            minSpacingNm: 5,
        });
        expect(bends).toHaveLength(0);
    });

    it('keeps a bend > minSpacingNm away from existing waypoints', () => {
        const coords: Array<[number, number]> = [
            [0, 0],
            [0.5, 0],
            [1, 0],
            [1, 0.5],
            [1, 1],
        ];
        const bends = detectBends(coords, {
            existingWaypoints: [{ lat: 50, lon: 50 }], // far away
            minSpacingNm: 1,
        });
        expect(bends).toHaveLength(1);
    });
});

describe('detectBends — RDP epsilon filters noise', () => {
    it('does not flag tiny zigzag noise as a bend at the default epsilon', () => {
        // Straight east route with sub-meter noise on lat (way under 200m epsilon).
        const coords: Array<[number, number]> = [
            [0, 0],
            [0.5, 0.0000001],
            [1, 0],
            [1.5, -0.0000001],
            [2, 0],
            [2.5, 0.0000001],
            [3, 0],
        ];
        const bends = detectBends(coords);
        expect(bends).toHaveLength(0);
    });
});

describe('detectBends — bendDeg accuracy', () => {
    it('reports an obtuse turn (> 90°) for a near-reversal', () => {
        // ~150° turn (near U-turn). Should report bendDeg > 90.
        const coords: Array<[number, number]> = [
            [0, 0],
            [1, 0],
            [2, 0], // turn point
            [2.5, 1.5], // back-and-up — sharp angle
        ];
        const bends = detectBends(coords);
        expect(bends).toHaveLength(1);
        expect(bends[0].bendDeg).toBeGreaterThan(45);
    });
});
