/**
 * WindField Service — Unit tests
 *
 * Tests the wind texture encoder (pure function) and
 * exported constants. Fetch-dependent functions are tested
 * with mocked responses.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../services/weather/keys', () => ({
    getOpenMeteoKey: vi.fn().mockReturnValue('test-key'),
}));

import { encodeWindTexture, MAX_SPEED, WIND_FIELD_HOURS, GLOBAL_GRID_HOURS } from '../services/weather/windField';
import type { WindGrid } from '../services/weather/windField';

// ── Helper: build a minimal WindGrid ────────────────────────────

function makeGrid(overrides: Partial<WindGrid> = {}): WindGrid {
    const width = overrides.width ?? 2;
    const height = overrides.height ?? 2;
    const size = width * height;

    return {
        u: [new Float32Array(size)],
        v: [new Float32Array(size)],
        speed: [new Float32Array(size)],
        width,
        height,
        lats: Array.from({ length: height }, (_, i) => -10 + i),
        lons: Array.from({ length: width }, (_, i) => 150 + i),
        north: -10 + height - 1,
        south: -10,
        west: 150,
        east: 150 + width - 1,
        totalHours: 1,
        ...overrides,
    };
}

// ── Constants ───────────────────────────────────────────────────

describe('WindField constants', () => {
    it('MAX_SPEED is 60 m/s', () => {
        expect(MAX_SPEED).toBe(60.0);
    });

    it('WIND_FIELD_HOURS is 48', () => {
        expect(WIND_FIELD_HOURS).toBe(48);
    });

    it('GLOBAL_GRID_HOURS is 24', () => {
        expect(GLOBAL_GRID_HOURS).toBe(24);
    });
});

// ── encodeWindTexture ───────────────────────────────────────────

describe('encodeWindTexture', () => {
    it('returns RGBA Uint8Array of correct size', () => {
        const grid = makeGrid({ width: 3, height: 3 });
        const rgba = encodeWindTexture(grid, 0);

        expect(rgba).toBeInstanceOf(Uint8Array);
        expect(rgba.length).toBe(3 * 3 * 4); // width × height × 4 channels
    });

    it('alpha channel is always 255', () => {
        const grid = makeGrid({ width: 2, height: 2 });
        const rgba = encodeWindTexture(grid, 0);

        for (let i = 0; i < 4; i++) {
            expect(rgba[i * 4 + 3]).toBe(255);
        }
    });

    it('zero wind encodes to midpoint R/G and zero B', () => {
        const grid = makeGrid();
        // All u/v/speed are 0
        const rgba = encodeWindTexture(grid, 0);

        // R = (0 + 60) / 120 * 255 = 127.5 → 128
        expect(rgba[0]).toBe(128); // R (U midpoint)
        expect(rgba[1]).toBe(128); // G (V midpoint)
        expect(rgba[2]).toBe(0); // B (speed = 0)
    });

    it('max positive wind encodes to ~255 R/G', () => {
        const grid = makeGrid();
        grid.u[0][0] = MAX_SPEED;
        grid.v[0][0] = MAX_SPEED;
        grid.speed[0][0] = MAX_SPEED;

        const rgba = encodeWindTexture(grid, 0);

        expect(rgba[0]).toBe(255); // R (U = MAX_SPEED → 1.0 → 255)
        expect(rgba[1]).toBe(255); // G (V = MAX_SPEED → 1.0 → 255)
        expect(rgba[2]).toBe(255); // B (speed = MAX_SPEED → 1.0 → 255)
    });

    it('max negative wind encodes to ~0 R/G', () => {
        const grid = makeGrid();
        grid.u[0][0] = -MAX_SPEED;
        grid.v[0][0] = -MAX_SPEED;
        grid.speed[0][0] = 0;

        const rgba = encodeWindTexture(grid, 0);

        expect(rgba[0]).toBe(0); // R (U = -MAX → 0)
        expect(rgba[1]).toBe(0); // G (V = -MAX → 0)
    });

    it('clamps hour to totalHours - 1', () => {
        const grid = makeGrid();
        // Request hour 100 when only 1 exists — should not throw
        const rgba = encodeWindTexture(grid, 100);
        expect(rgba.length).toBe(2 * 2 * 4);
    });

    it('encoding is reversible (round-trip within 1 unit)', () => {
        const grid = makeGrid();
        const testU = 15.0;
        const testV = -8.0;
        const testSpeed = Math.sqrt(testU * testU + testV * testV);

        grid.u[0][0] = testU;
        grid.v[0][0] = testV;
        grid.speed[0][0] = testSpeed;

        const rgba = encodeWindTexture(grid, 0);

        // Decode (same as shader)
        const decodedU = (rgba[0] / 255) * 2 * MAX_SPEED - MAX_SPEED;
        const decodedV = (rgba[1] / 255) * 2 * MAX_SPEED - MAX_SPEED;
        const decodedSpeed = (rgba[2] / 255) * MAX_SPEED;

        // 8-bit quantization: ~0.47 m/s precision for ±60 range
        expect(decodedU).toBeCloseTo(testU, 0);
        expect(decodedV).toBeCloseTo(testV, 0);
        expect(decodedSpeed).toBeCloseTo(testSpeed, 0);
    });
});

// ── fetchWindGrid ───────────────────────────────────────────────

describe('fetchWindGrid', () => {
    beforeEach(() => {
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
            return new Response(
                JSON.stringify([
                    { hourly: { wind_speed_10m: [10], wind_direction_10m: [180] } },
                    { hourly: { wind_speed_10m: [15], wind_direction_10m: [270] } },
                    { hourly: { wind_speed_10m: [20], wind_direction_10m: [90] } },
                    { hourly: { wind_speed_10m: [12], wind_direction_10m: [0] } },
                    { hourly: { wind_speed_10m: [8], wind_direction_10m: [45] } },
                    { hourly: { wind_speed_10m: [18], wind_direction_10m: [135] } },
                    { hourly: { wind_speed_10m: [14], wind_direction_10m: [225] } },
                    { hourly: { wind_speed_10m: [16], wind_direction_10m: [315] } },
                    { hourly: { wind_speed_10m: [11], wind_direction_10m: [160] } },
                ]),
                { status: 200 },
            );
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns null when grid is too small (< 3 lats/lons)', async () => {
        const { fetchWindGrid } = await import('../services/weather/windField');
        // Tiny bounds that would produce < 3 grid points
        const result = await fetchWindGrid(0, 0, 0, 0, 5);
        expect(result).toBeNull();
    });
});
