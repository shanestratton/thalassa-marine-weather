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
        // The deep one waits for boat-length zooms — the exact rung moves
        // with the density curve, the ORDER is the invariant.
        expect(mz(deep)).toBeGreaterThanOrEqual(14);
        expect(mz(deep)).toBeGreaterThan(mz(shallow));
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

    it('REPLACES the SCAMIN pre-bake — wide-zoom numbers actually appear', () => {
        // SCAMIN pinned nearly every AU sounding to z11+, silencing the
        // ladder's wide rungs (Shane 2026-07-11: "depths from zoom 7??").
        // The ladder is the stricter safety-biased declutter — it owns
        // the gate outright now.
        const gated = pt(153.0, -27.0, 3.2, 13); // extractor SCAMIN said z13+
        assignSoundingDensityMinZoom([gated]);
        expect(mz(gated)).toBe(4); // ladder wins: the shallowest sounding leads from z4
    });
});
