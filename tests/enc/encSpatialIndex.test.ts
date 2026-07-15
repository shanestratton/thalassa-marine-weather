/**
 * EncSpatialIndex.queryPoint — the per-cell "is this water safe" decision
 * the router trusts to avoid grounding. Flagged by the mission audit as
 * ZERO-tested despite being the safety-critical query. These lock in the
 * fail-safe rules: unknown depth is a hazard, deep water is clear, the
 * worst hazard at a point wins, and points outside the cell aren't
 * answered. The last test composes two cells the way queryHazards does.
 */
import { describe, it, expect } from 'vitest';
import type { Geometry } from 'geojson';

import { EncSpatialIndex } from '../../services/enc/EncSpatialIndex';
import { mergeHazardResults } from '../../services/enc/hazardSeverity';
import type { EncHazard, EncLayer } from '../../services/enc/types';

/** Closed square polygon centred on (cx,cy), half-width r. Coords are
 *  [lon,lat] — plain planar values are fine for point-in-polygon. */
const square = (cx: number, cy: number, r: number): Geometry => ({
    type: 'Polygon',
    coordinates: [
        [
            [cx - r, cy - r],
            [cx + r, cy - r],
            [cx + r, cy + r],
            [cx - r, cy + r],
            [cx - r, cy - r],
        ],
    ],
});
/** Right triangle with legs on the axes from the origin — its bbox is
 *  [0,0,size,size] but it only fills the lower-left half (x+y < size). */
const triangle = (size: number): Geometry => ({
    type: 'Polygon',
    coordinates: [
        [
            [0, 0],
            [size, 0],
            [0, size],
            [0, 0],
        ],
    ],
});
const hz = (layer: EncLayer, geometry: Geometry, minDepthM: number | null = null): EncHazard => ({
    layer,
    geometry,
    minDepthM,
});
const idx = (cellId: string, hazards: EncHazard[]) => new EncSpatialIndex(cellId, hazards);

describe('EncSpatialIndex.queryPoint', () => {
    it('a point outside the cell bbox is NOT answered (covered:false)', () => {
        const i = idx('A', [hz('DEPARE', square(0, 0, 1), 2)]);
        expect(i.queryPoint(50, 50).covered).toBe(false);
    });

    it('a shallow DEPARE (< 15 m) is a shallow hazard', () => {
        const i = idx('A', [hz('DEPARE', square(0, 0, 1), 2)]);
        const r = i.queryPoint(0, 0);
        expect(r).toMatchObject({ covered: true, hazard: true, hazardType: 'shallow', minDepthM: 2 });
    });

    it('a DEEP DEPARE (≥ 15 m) is clear water, not a hazard', () => {
        const i = idx('A', [hz('DEPARE', square(0, 0, 1), 20)]);
        expect(i.queryPoint(0, 0)).toMatchObject({ covered: true, hazard: false });
    });

    it('UNKNOWN DEPARE depth (null) is a hazard — never reads as safe', () => {
        const i = idx('A', [hz('DEPARE', square(0, 0, 1), null)]);
        expect(i.queryPoint(0, 0)).toMatchObject({ hazard: true, hazardType: 'shallow' });
    });

    it('land (LNDARE) is a land hazard', () => {
        const i = idx('A', [hz('LNDARE', square(0, 0, 1))]);
        expect(i.queryPoint(0, 0).hazardType).toBe('land');
    });

    it('a point-geometry rock (UWTROC) is a rock hazard', () => {
        const i = idx('A', [hz('UWTROC', { type: 'Point', coordinates: [1, 1] })]);
        expect(i.queryPoint(1, 1).hazardType).toBe('rock');
    });

    it('within a cell, the WORST overlapping hazard wins (land over shallow)', () => {
        const i = idx('A', [hz('DEPARE', square(0, 0, 2), 1), hz('LNDARE', square(0, 0, 2))]);
        expect(i.queryPoint(0, 0).hazardType).toBe('land'); // 5 > 1
    });

    it('FAIL-DANGEROUS FIX: a point in the bbox but OUTSIDE all charted polygons is NOT covered (gap → GEBCO)', () => {
        const i = idx('A', [hz('DEPARE', triangle(4), 2)]);
        // (3.5,3.5): inside the cell bbox [0,0,4,4] but OUTSIDE the DEPARE
        // triangle — a data gap / unsurveyed area. It must NOT read as
        // ENC-validated clear water (which would suppress the GEBCO fallback).
        expect(i.queryPoint(3.5, 3.5)).toMatchObject({ covered: false, hazard: false });
        // (0.5,0.5): inside the DEPARE triangle → covered + the shallow hazard.
        expect(i.queryPoint(0.5, 0.5)).toMatchObject({ covered: true, hazard: true });
    });

    it('charted DEEP water is covered + clear (inside a deep DEPARE → skips GEBCO)', () => {
        const i = idx('A', [hz('DEPARE', square(0, 0, 1), 20)]);
        expect(i.queryPoint(0, 0)).toMatchObject({ covered: true, hazard: false });
        expect(i.queryPoint(50, 50).covered).toBe(false); // outside the cell entirely
    });

    it('a shallow DREDGED area (DRGARE) is a hazard — no longer dropped from the model', () => {
        const i = idx('A', [hz('DRGARE', square(0, 0, 1), 2)]);
        expect(i.queryPoint(0, 0)).toMatchObject({ covered: true, hazard: true, hazardType: 'shallow' });
    });

    it('a deep DRGARE gives coverage without being a hazard', () => {
        const i = idx('A', [hz('DRGARE', square(0, 0, 1), 20)]);
        expect(i.queryPoint(0, 0)).toMatchObject({ covered: true, hazard: false });
    });

    it('among SAME-type overlapping hazards the SHALLOWER wins (within-cell depth tiebreak)', () => {
        const i = idx('A', [hz('DEPARE', square(0, 0, 2), 5), hz('DEPARE', square(0, 0, 2), 1)]);
        expect(i.queryPoint(0, 0)).toMatchObject({ hazardType: 'shallow', minDepthM: 1 });
    });

    it('an unknown-depth (null) shallow beats a known shallow within a cell', () => {
        const i = idx('A', [hz('DEPARE', square(0, 0, 2), 2), hz('DEPARE', square(0, 0, 2), null)]);
        expect(i.queryPoint(0, 0).minDepthM).toBeNull();
    });

    it('COMPOSES across cells like queryHazards — worst hazard wins, order-independent', () => {
        // Overlapping coarse (shallow) + fine (rock) cells over one point.
        const coarse = idx('coarse', [hz('DEPARE', square(0, 0, 2), 3)]);
        const fine = idx('fine', [hz('UWTROC', { type: 'Point', coordinates: [0, 0] })]);
        const fold = (order: EncSpatialIndex[]) =>
            order
                .map((c) => c.queryPoint(0, 0))
                .reduce(mergeHazardResults, {
                    covered: false,
                    hazard: false,
                    minDepthM: null,
                });
        expect(fold([coarse, fine]).hazardType).toBe('rock');
        expect(fold([fine, coarse]).hazardType).toBe('rock'); // same regardless of resolution order
    });
});
