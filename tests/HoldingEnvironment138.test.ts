import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WindGrid } from '../services/weather/windGridEncoding';
import type { HoldingBounds } from '../services/enc/holdingFootprint';
const m = vi.hoisted(() => ({
    wind: { grid: null as WindGrid | null, field: 'wind', model: 'test' },
    imported: vi.fn(),
    marine: vi.fn(),
}));
vi.mock('../stores/WindStore', () => ({ WindStore: { getState: () => m.wind } }));
vi.mock('../services/weather/localGribImport', () => ({ currentImportedGrib: m.imported }));
vi.mock('../services/weather/api/cmemsGridTrust', () => ({
    readCachedCmemsFrames: m.marine,
    CMEMS_CACHE_TTL_MS: 300000,
}));
import { holdingGridMaximum } from '../services/weather/holdingGridBounds';
import { readHoldingEnvironment } from '../services/weather/readHoldingEnvironment';
const T = Date.parse('2026-10-17T00:00:00Z'),
    box: HoldingBounds = [-0.01, -0.01, 0.01, 0.01];
const grid = (): WindGrid => ({
    width: 3,
    height: 3,
    lats: [-1, 0, 1],
    lons: [-1, 0, 1],
    north: 1,
    south: -1,
    west: -1,
    east: 1,
    totalHours: 3,
    refTime: new Date(T).toISOString(),
    stepHours: [0, 1, 2],
    validUntil: new Date(T + 7200000).toISOString(),
    u: Array.from({ length: 3 }, () => new Float32Array(9).fill(2)),
    v: Array.from({ length: 3 }, () => new Float32Array(9)),
    speed: [],
    gust: Array.from({ length: 3 }, () => new Float32Array(9).fill(3)),
});
const bound = (g: WindGrid) => holdingGridMaximum(g, box, T + 100, T + 3600100, 'vector', () => {});
describe('whole area and time holding forecast bounds', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        m.wind = { grid: null, field: 'wind', model: 'test' };
        m.imported.mockReturnValue(null);
        m.marine.mockReturnValue(null);
    });
    it('includes outer enclosing vertices and every temporal bracket, not merely the holding point or wait ends', () => {
        const g = grid();
        g.u[1][0] = 42;
        expect(bound(g)).toBe(42);
        g.u[1][0] = NaN;
        expect(bound(g)).toBeNull();
    });
    it('supports descending CMEMS rows and refuses missing planes, land mask and coverage gaps', () => {
        const g = grid();
        g.lats.reverse();
        expect(bound(g)).toBe(2);
        g.u[1] = undefined!;
        expect(bound(g)).toBeNull();
        const h = grid();
        h.landMask = new Uint8Array(9);
        h.landMask[0] = 1;
        expect(bound(h)).toBeNull();
        expect(holdingGridMaximum(grid(), [-2, -1, 0, 0], T, T + 100, 'vector', () => {})).toBeNull();
        expect(holdingGridMaximum(grid(), box, T - 1, T + 100, 'vector', () => {})).toBeNull();
        const sparse = grid();
        sparse.stepHours = [0, 6, 12];
        expect(bound(sparse)).toBeNull();
    });
    it('never substitutes sustained wind for a missing actual gust field', () => {
        const g = grid();
        delete g.gust;
        expect(holdingGridMaximum(g, box, T, T + 100, 'gust', () => {})).toBeNull();
        m.wind.grid = g;
        const r = readHoldingEnvironment(box, T, T + 100, T, () => {});
        expect(r.wind.maximum).toBeGreaterThan(3);
        expect(r.gust.maximum).toBeNull();
        expect(r.wind.originalIssueMs).toBeNull(); // refTime alone is not adapter provenance.
    });
    it('reads the owner-selected original GRIB run and still discloses absent waves, gust, currents and exposure', () => {
        const g = grid();
        m.wind.grid = g;
        m.imported.mockReturnValue({ wind: g, refTime: g.refTime, source: { centre: 7, process: 2 } });
        const r = readHoldingEnvironment(box, T, T + 100, T + 1000, () => {});
        expect(r.wind.originalIssueMs).toBe(T);
        expect(r.wind.maximum).toBeCloseTo(3.8877, 3);
        expect(r.includesTidalStreams).toBe(false);
        expect(r.completeLocalExposure).toBe(false);
        expect(r.currents.maximum).toBeNull();
        expect(r.notes.join(' ')).toContain('tidal streams');
        expect(m.marine).toHaveBeenCalledTimes(2);
    });
    it('actually reads retained marine brackets, preserves their clocks and never claims original issue or tidal-stream coverage', () => {
        m.marine.mockImplementation((dataset, now, read) => {
            const g = grid();
            g.sourceGeneration = 'fictional';
            g.landMask = new Uint8Array(9);
            return read(
                {
                    dataset: { id: `fictional-${dataset}` },
                    generation: 'fictional',
                    published_at: new Date(T).toISOString(),
                    data_start: g.refTime,
                    data_end: g.validUntil,
                },
                [0, 1, 2].map((step) => ({ step, grid: g })),
                now - 1000,
            );
        });
        const r = readHoldingEnvironment(box, T, T + 3600100, T + 2000, () => {});
        expect(r.waves).toMatchObject({
            maximum: 2,
            completeAreaAndInterval: true,
            originalIssueMs: null,
            verifiedAtMs: T + 1000,
        });
        expect(r.currents.maximum).toBeCloseTo(3.8877, 3);
        expect(r.includesTidalStreams).toBe(false);
        expect(r.notes.join(' ')).toContain('Neither clock establishes the original model issue');
    });
    it('does not read marine arrays without a complete footprint and propagates retirement', () => {
        const r = readHoldingEnvironment(null, T, T + 100, T, () => {});
        expect(r.wind.maximum).toBeNull();
        expect(m.marine).not.toHaveBeenCalled();
        expect(() =>
            readHoldingEnvironment(box, T, T + 100, T, () => {
                throw new DOMException('retired', 'AbortError');
            }),
        ).toThrow('retired');
    });
});
