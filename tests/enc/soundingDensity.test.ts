/**
 * Density ladder — the "depth numbers at every zoom" invariants:
 * shallowest wins the coarse cells (safety), density is constant per
 * screen area, and a stricter SCAMIN gate is never loosened.
 */
import { describe, it, expect } from 'vitest';
import type { Feature, Point } from 'geojson';
import { assignSoundingDensityMinZoom } from '../../services/enc/soundingDensity';

const pt = (lon: number, lat: number, d: number, minZoom?: number): Feature<Point> => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { _d: d, ...(minZoom !== undefined ? { _minZoom: minZoom } : {}) },
});

const mz = (f: Feature<Point>): number => Number((f.properties as Record<string, unknown>)._minZoom);

describe('soundingDensity — the numbers ladder', () => {
    it('the shallowest sounding claims the coarse zooms; a deep neighbour waits', () => {
        const shallow = pt(153.0001, -27.0001, 0.9);
        const deep = pt(153.0002, -27.0002, 18); // ~15 m away — same cell at every ladder zoom
        // Deliberately passed deep-first: input order must not matter.
        assignSoundingDensityMinZoom([deep, shallow]);
        expect(mz(shallow)).toBe(4);
        expect(mz(deep)).toBe(17); // never wins a cell — max-zoom-only
    });

    it('far-apart soundings both appear at the coarsest zoom', () => {
        const a = pt(153.0, -27.0, 12);
        const b = pt(155.0, -25.0, 15); // degrees apart — separate z4 cells
        assignSoundingDensityMinZoom([a, b]);
        expect(mz(a)).toBe(4);
        expect(mz(b)).toBe(4);
    });

    it('density fills in progressively with zoom, not all-at-once', () => {
        // A tight cluster (~500 m apart): one number early, the rest
        // unlocking at deeper zooms as their cells shrink free.
        const cluster = [0, 1, 2, 3].map((i) => pt(153.0 + i * 0.005, -27.0, 5 + i));
        assignSoundingDensityMinZoom(cluster);
        const zs = cluster.map(mz).sort((a, b) => a - b);
        expect(zs[0]).toBe(4); // the shallowest leads
        expect(new Set(zs).size).toBeGreaterThan(1); // staggered, not simultaneous
        expect(zs[3]).toBeLessThanOrEqual(16); // 500 m apart all resolve within the ladder
    });

    it('never loosens a stricter SCAMIN gate', () => {
        const gated = pt(153.0, -27.0, 3.2, 13); // SCAMIN says z13+
        assignSoundingDensityMinZoom([gated]);
        expect(mz(gated)).toBe(13); // density said 4; SCAMIN wins
    });
});
