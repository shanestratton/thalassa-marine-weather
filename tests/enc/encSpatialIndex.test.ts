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

    it('GUARD RADIUS: a point rock is detected NEAR its coord (~111 m), not just exactly on it', () => {
        // UWTROC at [lon,lat]=[0,0]. A route sample 0.001° (~111 m) away must
        // still flag it — the router never lands exactly on a rock's coordinate.
        const i = idx('A', [hz('UWTROC', { type: 'Point', coordinates: [0, 0] })]);
        expect(i.queryPoint(0.001, 0)).toMatchObject({ covered: true, hazard: true, hazardType: 'rock' });
    });

    it('GUARD RADIUS: beyond ~150 m the point rock is NOT selected (no false lock-on)', () => {
        // 0.003° (~333 m) away → outside the padded bbox entirely → no candidate.
        const i = idx('A', [hz('UWTROC', { type: 'Point', coordinates: [0, 0] })]);
        expect(i.queryPoint(0.003, 0).covered).toBe(false);
    });

    it('GUARD RADIUS: a rock inside DEEP DEPARE is caught by a nearby sample (deep water no longer hides it)', () => {
        // The exact grounding-fly-over case: an isolated danger sitting in
        // otherwise-clear deep water. A sample near (not on) the rock must
        // report the rock, not "deep + clear".
        const i = idx('A', [
            hz('DEPARE', square(0, 0, 1), 25), // deep, clear water all around
            hz('UWTROC', { type: 'Point', coordinates: [0, 0] }),
        ]);
        expect(i.queryPoint(0, 0)).toMatchObject({ hazard: true, hazardType: 'rock' }); // on it
        expect(i.queryPoint(0.001, 0)).toMatchObject({ hazard: true, hazardType: 'rock' }); // ~111 m away
    });

    it('a LONE shoal SOUNDG (no area coverage) flags as hazard but is marked soundingOnly', () => {
        // A sounding in a coverage gap: hazard EVIDENCE, not area coverage.
        // The flag lets the caller fall to GEBCO if the draft re-eval clears
        // it — one 12 m spot depth must not certify the water around it.
        const i = idx('A', [hz('SOUNDG', { type: 'Point', coordinates: [0, 0] }, 12)]);
        expect(i.queryPoint(0.001, 0)).toMatchObject({
            covered: true,
            hazard: true,
            hazardType: 'shallow',
            soundingOnly: true,
        });
        // With REAL area coverage under the point, the flag must NOT be set.
        const j = idx('B', [
            hz('DEPARE', square(0, 0, 1), 25),
            hz('SOUNDG', { type: 'Point', coordinates: [0, 0] }, 12),
        ]);
        expect(j.queryPoint(0, 0).soundingOnly).toBeUndefined();
    });

    it('a shoal SOUNDG spot sounding is a shallow hazard (defense-in-depth in "deep" water)', () => {
        // A 1.2 m sounding sitting inside otherwise-deep DEPARE — the exact
        // case the DEPARE DRVAL1 floor can miss.
        const i = idx('A', [
            hz('DEPARE', square(0, 0, 1), 25), // deep, clear
            hz('SOUNDG', { type: 'Point', coordinates: [0, 0] }, 1.2),
        ]);
        expect(i.queryPoint(0, 0)).toMatchObject({ hazard: true, hazardType: 'shallow', minDepthM: 1.2 });
        expect(i.queryPoint(0.001, 0)).toMatchObject({ hazard: true, hazardType: 'shallow' }); // ~111 m away
    });

    it('a LINE OBSTRN is detected within the guard radius (was invisible to routing)', () => {
        // Vertical line at lon 0 from lat 0 → 0.01. A sample ~111 m east must
        // flag it; ~333 m east must not.
        const line: Geometry = {
            type: 'LineString',
            coordinates: [
                [0, 0],
                [0, 0.01],
            ],
        };
        const i = idx('A', [hz('OBSTRN', line)]);
        expect(i.queryPoint(0.005, 0.001)).toMatchObject({ hazard: true, hazardType: 'obstruction' });
        expect(i.queryPoint(0.005, 0.003).covered).toBe(false);
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

    it('SEGMENT crossing: a shallow DEPARE thinner than the sample spacing is caught even with BOTH endpoints outside', () => {
        // The exact between-samples gap: a shoal patch the discrete point
        // sampler steps over. Segment runs W→E through a shallow square whose
        // extent (±0.5°) both endpoints (lon ±1) sit outside.
        const i = idx('A', [hz('DEPARE', square(0, 0, 0.5), 2)]);
        expect(i.segmentHazard(0, -1, 0, 1)).toMatchObject({ covered: true, hazard: true, hazardType: 'shallow' });
    });

    it('SEGMENT crossing: land is caught; a clear miss returns covered:false', () => {
        const i = idx('A', [hz('LNDARE', square(0, 0, 0.5))]);
        expect(i.segmentHazard(0, -1, 0, 1).hazardType).toBe('land');
        expect(i.segmentHazard(5, -1, 5, 1).covered).toBe(false); // far north — no crossing
    });

    it('SEGMENT crossing: an endpoint INSIDE a shallow area counts as a crossing', () => {
        const i = idx('A', [hz('DEPARE', square(0, 0, 0.5), 2)]);
        expect(i.segmentHazard(0, 0, 0, 5)).toMatchObject({ covered: true, hazard: true }); // starts inside
    });

    it('SEGMENT crossing: passing through DEEP water only is covered but NOT a hazard', () => {
        const i = idx('A', [hz('DEPARE', square(0, 0, 0.5), 25)]);
        expect(i.segmentHazard(0, -1, 0, 1)).toMatchObject({ covered: true, hazard: false });
    });

    it('SEGMENT crossing: a point rock within the guard corridor IS flagged (short terminal-leg blind-zone fix)', () => {
        // The sub-231m terminal-leg case: sampleSegment yields no samples, so
        // the point query can't see a charted rock — but the segment can.
        const i = idx('A', [hz('UWTROC', { type: 'Point', coordinates: [0, 0] })]);
        expect(i.segmentHazard(0, -1, 0, 1)).toMatchObject({ covered: true, hazard: true, hazardType: 'rock' });
        expect(i.segmentHazard(5, -1, 5, 1).covered).toBe(false); // rock far from the corridor
    });

    it('SEGMENT crossing: a berth-exempt TERMINAL does not flag the leg for sitting in its own shoal', () => {
        const i = idx('A', [hz('DEPARE', square(0, 0, 0.5), 2)]); // shoal berth at origin
        // Leg starts INSIDE the berth and exits north.
        expect(i.segmentHazard(0, 0, 5, 0).hazard).toBe(true); // no exemption → flagged
        expect(i.segmentHazard(0, 0, 5, 0, true, false).covered).toBe(false); // exemptStart → skipped
    });

    it('SEGMENT crossing: berth exemption STILL flags a separate islet the leg crosses', () => {
        const i = idx('A', [
            hz('DEPARE', square(0, 0, 0.3), 2), // berth shoal (contains origin [0,0])
            hz('LNDARE', square(0, 3, 0.3)), // islet at lat 3 — contains neither endpoint
        ]);
        // Origin (in the berth) → far north; berth is exempt but the islet is not.
        expect(i.segmentHazard(0, 0, 6, 0, true, false)).toMatchObject({ hazard: true, hazardType: 'land' });
    });

    it('SEGMENT CAUTION: flags a restricted/cable area the segment crosses (advisory, not a hazard)', () => {
        const i = new EncSpatialIndex('A', [], [], [], [{ geometry: square(0, 0, 0.5), cls: 'RESARE', restrn: '7' }]);
        const crossed = i.segmentCautions(0, -1, 0, 1); // W→E through the area
        expect(crossed).toHaveLength(1);
        expect(crossed[0]).toMatchObject({ cls: 'RESARE', restrn: '7' });
        expect(i.segmentCautions(5, -1, 5, 1)).toHaveLength(0); // misses → none
        // Caution areas are NOT grounding hazards — queryPoint ignores them.
        expect(i.queryPoint(0, 0).covered).toBe(false);
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
