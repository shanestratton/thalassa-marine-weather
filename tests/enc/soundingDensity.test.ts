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

    it('grid is screen-square at high latitude — no column-y Mercator bias', () => {
        // At 60°S a degree of latitude spans 2× the pixels of a degree of
        // longitude. cellDeg[4] ≈ 48px worth of lon-degrees at z4; two
        // points 0.6 lon-cells apart HORIZONTALLY share a cell (one
        // waits), so the same 0.6·cellDeg separation VERTICALLY — which
        // is 1.2 screen cells at cos(60°)=0.5 — must NOT share one
        // (2026-07-12 audit: one shared degree-size made Tasmania's
        // sounding field ~40% sparser down than across).
        const cellDeg4 = (48 * 78271.484) / 2 ** 4 / 111_320;
        const a = pt(150.0, -60.0, 5);
        const vert = pt(150.0, -60.0 + cellDeg4 * 0.6, 9); // 1.2 screen cells away
        const horiz = pt(150.0 + cellDeg4 * 0.6, -60.0, 9); // 0.6 screen cells away
        assignSoundingDensityMinZoom([a, vert]);
        expect(mz(a)).toBe(4);
        expect(mz(vert)).toBe(4); // its own screen cell — shows immediately
        const a2 = pt(150.0, -60.0, 5);
        assignSoundingDensityMinZoom([a2, horiz]);
        expect(mz(a2)).toBe(4);
        expect(mz(horiz)).toBeGreaterThan(4); // same screen cell — waits
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
