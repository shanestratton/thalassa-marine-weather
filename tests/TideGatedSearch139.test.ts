import { describe, expect, it } from 'vitest';
import { searchTideGatedCandidate, type TideGatedCandidateRequest } from '../services/engine/tideGatedSearch';
import type { NavGrid } from '../services/engine/types';
const T = Date.parse('2026-10-17T00:00:23.456Z');
const fixture = (scale = 2) => {
    const grid: NavGrid & { exclusionBlocked?: Uint8Array } = {
        width: 9,
        height: 5,
        minLon: 0,
        minLat: 0,
        dLon: 0.0001 * scale,
        dLat: 0.0001 * scale,
        cells: new Float32Array(45).fill(5),
        preferred: new Uint8Array(45),
        chartedShallow: new Uint8Array(45),
        shallowDepthM: new Float32Array(45).fill(NaN),
    };
    for (let y = 1; y < 4; y++) {
        const i = y * 9 + 4;
        grid.cells[i] = -1;
        grid.shallowDepthM![i] = 1;
        grid.chartedShallow![i] = 1;
    }
    const request: TideGatedCandidateRequest = {
        enabled: true,
        from: { lat: 0.00025 * scale, lon: 0.00015 * scale },
        to: { lat: 0.00025 * scale, lon: 0.00075 * scale },
        departureMs: T,
        speedKts: 6,
        requiredM: 3,
        expiresAtMs: T + 3600000,
        uncertaintyMs: 60000,
        maxJourneyMs: 900000,
        areas: [
            {
                id: 'fictional-grid-only-window',
                chartedDepthM: 1,
                coverage: [-0.01, -0.01, 0.01, 0.01],
                station: { lat: 0, lon: 0 },
                maxDistanceKm: 10,
                geometry: {
                    type: 'Polygon',
                    coordinates: [
                        [
                            [-0.01, -0.01],
                            [0.01, -0.01],
                            [0.01, 0.01],
                            [-0.01, 0.01],
                            [-0.01, -0.01],
                        ],
                    ],
                },
                windows: [{ fromMs: T - 3600000, untilMs: T + 3600000, minLowM: 2 }],
            },
        ],
    };
    return { grid, request };
};
const options = { check: () => {}, now: () => T + 1000 };
describe('139 opt-in worker candidate search, never navigation authority', () => {
    it('leaves the default path untouched without even reading grid data', () => {
        expect(searchTideGatedCandidate(null!, { enabled: false } as TideGatedCandidateRequest)).toEqual({
            kind: 'off',
        });
    });
    it('measures strict first and selects a shorter fully windowed bank crossing as a candidate only', () => {
        const { grid, request } = fixture(),
            before = grid.cells.slice();
        const r = searchTideGatedCandidate(grid, request, options);
        expect(r.kind).toBe('candidate');
        if (r.kind !== 'candidate') return;
        expect(r.strict).not.toBeNull();
        expect(r.path.distanceM).toBeLessThan(r.strict!.distanceM - 20);
        expect(r.path.tideCells).toContain(22);
        expect(new Set(r.path.indices).size).toBe(r.path.indices.length);
        expect(r.path.points[0]).toEqual([request.from.lon, request.from.lat]);
        expect(r.path.points.at(-1)).toEqual([request.to.lon, request.to.lat]);
        expect(r.path.timesMs[0]).toBe(T);
        expect(r.path.timesMs.at(-1)! - T).toBeCloseTo((r.path.distanceM / ((6 * 1852) / 3600)) * 1000, 1);
        expect(grid.cells).toEqual(before);
    });
    it('honours original lane flow in the time-labelled neighbor expansion without changing depth', () => {
        const { grid, request } = fixture(),
            before = grid.cells.slice();
        grid.tssLane = new Uint8Array(45).fill(1);
        grid.tssDirection = new Float32Array(45).fill(90);
        expect(searchTideGatedCandidate(grid, request, options).kind).toBe('candidate');
        grid.tssDirection.fill(270);
        const against = searchTideGatedCandidate(grid, request, options);
        expect(against.kind).toBe('held');
        if (against.kind === 'held') expect(against.strict).toBeNull();
        expect(grid.cells).toEqual(before);
    });
    it.each(['none', 'insufficient', 'late', 'early-close', 'point-coverage', 'far-station'] as const)(
        'withholds %s windows and keeps the strict route',
        (kind) => {
            const { grid, request } = fixture();
            if (kind === 'none') request.areas = [];
            if (kind === 'insufficient') request.areas[0].windows[0].minLowM = 1.9;
            if (kind === 'late') request.areas[0].windows[0].fromMs = T + 600000;
            if (kind === 'early-close') request.areas[0].windows[0].untilMs = T + 300000;
            if (kind === 'point-coverage') request.areas[0].coverage = [0.00044, 0.00024, 0.00046, 0.00026];
            if (kind === 'far-station') request.areas[0].station = { lat: 1, lon: 1 };
            const r = searchTideGatedCandidate(grid, request, options);
            expect(r.kind).toBe('held');
            if (r.kind === 'held') expect(r.strict).not.toBeNull();
        },
    );
    it.each([
        'landBlocked',
        'berthBlocked',
        'obstnBlocked',
        'clearanceBarred',
        'unvouched',
        'wetConflict',
        'relaxMask',
        'noTideClears',
        'wingCaution',
        'exclusionBlocked',
    ] as const)('never reopens %s despite a complete numeric candidate window', (mask) => {
        const { grid, request } = fixture();
        grid[mask] = new Uint8Array(45);
        for (let y = 1; y < 4; y++) grid[mask]![y * 9 + 4] = 1;
        const r = searchTideGatedCandidate(grid, request, options);
        expect(r.kind).toBe('held');
    });
    it('never reopens NaN/drying/unknown cells or borrows extra depth from a window area', () => {
        for (const mode of ['NaN', 'dry', 'unknown', 'optimistic-band']) {
            const { grid, request } = fixture();
            for (let y = 1; y < 4; y++) {
                const i = y * 9 + 4;
                if (mode === 'NaN') grid.cells[i] = NaN;
                if (mode === 'dry') grid.shallowDepthM![i] = -0.1;
                if (mode === 'unknown') grid.chartedShallow![i] = 0;
                if (mode === 'optimistic-band') {
                    grid.shallowDepthM![i] = 0.5;
                    request.areas[0].chartedDepthM = 10;
                }
            }
            expect(searchTideGatedCandidate(grid, request, options).kind).toBe('held');
        }
    });
    it('requires whole original polygon coverage, including tiny holes', () => {
        const { grid, request } = fixture();
        request.areas[0].geometry = {
            type: 'Polygon',
            coordinates: [
                [
                    [-0.01, -0.01],
                    [0.01, -0.01],
                    [0.01, 0.01],
                    [-0.01, 0.01],
                    [-0.01, -0.01],
                ],
                [
                    [0.00082, 0.0002],
                    [0.00098, 0.0002],
                    [0.00098, 0.0008],
                    [0.00082, 0.0008],
                    [0.00082, 0.0002],
                ],
            ],
        };
        expect(searchTideGatedCandidate(grid, request, options).kind).toBe('held');
    });
    it('never corner-cuts a blocked flank or manufactures a holding wait by sailing loops', () => {
        const { grid, request } = fixture();
        request.areas[0].windows[0].fromMs = T + 600000;
        const r = searchTideGatedCandidate(grid, request, options);
        expect(r.kind).toBe('held');
        // A diagonal through two blocked flank cells is unavailable even if its destination is deep.
        const g = {
            ...grid,
            width: 2,
            height: 2,
            dLon: 0.0001,
            dLat: 0.0001,
            cells: new Float32Array([5, NaN, NaN, 5]),
            preferred: new Uint8Array(4),
            shallowDepthM: new Float32Array(4).fill(NaN),
            chartedShallow: new Uint8Array(4),
        };
        const q = { ...request, from: { lat: 0.00005, lon: 0.00005 }, to: { lat: 0.00015, lon: 0.00015 } };
        const held = searchTideGatedCandidate(g, q, options);
        expect(held.kind).toBe('held');
        if (held.kind === 'held') expect(held.strict).toBeNull();
    });
    it('propagates request retirement and source expiry instead of returning a candidate', () => {
        const { grid, request } = fixture();
        expect(() =>
            searchTideGatedCandidate(grid, request, {
                ...options,
                check: () => {
                    throw new DOMException('retired', 'AbortError');
                },
            }),
        ).toThrow('retired');
        request.expiresAtMs = T;
        expect(() => searchTideGatedCandidate(grid, request, options)).toThrow('expired');
    });
});
