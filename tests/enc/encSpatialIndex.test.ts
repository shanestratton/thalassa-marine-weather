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

import { EncSpatialIndex, type EncCoastline } from '../../services/enc/EncSpatialIndex';
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
        // PER-LOCALITY semantics (closing audit): the berth shoal is small —
        // the leg exits its boundary within ~330 m of the exempt terminal,
        // squarely inside BERTH_EXEMPT_RADIUS_M. (The OLD pinning used a
        // 0.5-degree shoal whose exit lay 55 km out and still waived it —
        // exactly the feature-wide skip the audit called fail-dangerous.)
        const i = idx('A', [hz('DEPARE', square(0, 0, 0.003), 2)]); // shoal berth at origin
        // Leg starts INSIDE the berth and exits north.
        expect(i.segmentHazard(0, 0, 5, 0).hazard).toBe(true); // no exemption → flagged
        expect(i.segmentHazard(0, 0, 5, 0, true, false).covered).toBe(false); // exemptStart → local exit skipped
    });

    it('SEGMENT crossing: berth exemption is PER-LOCALITY — a distant arm of the SAME feature still flags (closing audit)', () => {
        // One MultiPolygon "terminal" feature: the berth basin at the origin
        // PLUS a distant arm ~22 km north. The old feature-wide waiver
        // cleared the whole thing because the exempt terminal sat inside it.
        const i = idx('A', [
            hz(
                'DEPARE',
                {
                    type: 'MultiPolygon',
                    coordinates: [
                        (square(0, 0, 0.02) as GeoJSON.Polygon).coordinates,
                        (square(0, 0.2, 0.02) as GeoJSON.Polygon).coordinates,
                    ],
                },
                2,
            ),
        ]);
        // Leg from the berth (inside piece 1) north across the distant arm.
        const r = i.segmentHazard(0, 0, 0.4, 0, true, false);
        expect(r.hazard).toBe(true); // the distant arm is NOT the berth's water
        // Control: a short hop that stays within the berth's own locality
        // keeps the exemption (crossing its boundary within ~500 m).
        expect(i.segmentHazard(0, 0, 0.004, 0, true, false).covered).toBe(false);
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

describe('EncSpatialIndex.segmentAreaGraze (ZOC lateral clearance, burn-down 2026-07-18 #1)', () => {
    // All geometry sits at lat≈0 so 1° ≈ 111 320 m in BOTH axes — a lon offset
    // of `m/111320` degrees is `m` metres of clearance. A vertical segment at
    // lon=x whose lat span lies WITHIN the square's ±hw runs parallel to the
    // square's nearest N-S edge, so the near-miss distance IS that lon gap.
    const M = 111_320; // metres per degree at the equator
    const deg = (m: number) => m / M;
    /** A vertical (N-S) segment at longitude `lon`, from lat -span to +span. */
    const vseg = (lon: number, span = 0.0005): [number, number, number, number] => [-span, lon, span, lon];
    /** A cell whose whole area carries one CATZOC (M_QUAL) value. */
    const zocIdx = (hazards: EncHazard[], catzoc: 1 | 2 | 3 | 4 | 5 | 6) =>
        new EncSpatialIndex('A', hazards, [{ geometry: square(0, 0, 1), catzoc }]);

    it('flags a shallow DEPARE the leg passes ~30 m outside (no M_QUAL → ZOC-B ±50 m margin)', () => {
        // Shoal square centred so its WEST edge sits ~30 m east of the segment
        // at lon 0 (centre = 30 m clearance + 500 m half-width, east).
        const i = idx('A', [hz('DEPARE', square(deg(30) + deg(500), 0, deg(500)), 2)]);
        const g = i.segmentAreaGraze(...vseg(0));
        expect(g).not.toBeNull();
        expect(g!.type).toBe('shallow');
        expect(g!.marginM).toBe(50); // null CATZOC → treated as ZOC-B
        expect(Math.abs(g!.clearanceM - 30)).toBeLessThan(6);
    });

    it('does NOT flag when the clearance exceeds the ZOC margin', () => {
        // Same shoal but the segment sits 80 m outside — beyond the ±50 m ZOC-B margin.
        const i = idx('A', [hz('DEPARE', square(deg(80) + deg(500), 0, deg(500)), 2)]);
        expect(i.segmentAreaGraze(...vseg(0))).toBeNull();
    });

    it('margin SCALES with survey confidence — a 30 m near-miss flags in ZOC-B but not ZOC-A1', () => {
        const shoalCentreLon = deg(30) + deg(500); // west edge ≈ 30 m east of lon 0
        const haz = [hz('DEPARE', square(shoalCentreLon, 0, deg(500)), 2)];
        expect(zocIdx(haz, 3).segmentAreaGraze(...vseg(0))).not.toBeNull(); // B ±50 → flags
        const a1 = zocIdx(haz, 1).segmentAreaGraze(...vseg(0)); // A1 ±5 → 30 m is clear
        expect(a1).toBeNull();
    });

    it('a leg that CROSSES the polygon is a crossing, never a graze (returned null here)', () => {
        const i = idx('A', [hz('DEPARE', square(0, 0, deg(500)), 2)]);
        expect(i.segmentAreaGraze(0, -0.01, 0, 0.01)).toBeNull(); // W→E straight through
    });

    it('ignores DEEP water — a route hugging a deep-enough channel edge does NOT graze-flag', () => {
        const i = idx('A', [hz('DEPARE', square(deg(30) + deg(500), 0, deg(500)), 25)]); // 25 m deep
        expect(i.segmentAreaGraze(...vseg(0))).toBeNull();
    });

    it('LAND (drying bank / islet) outranks a CLOSER shoal near-miss', () => {
        // Shoal 22 m east, land 44 m west — both inside the ±50 m ZOC-B margin.
        const i = idx('A', [
            hz('DEPARE', square(deg(22) + deg(500), 0, deg(500)), 2), // west edge ≈22 m east
            hz('LNDARE', square(-(deg(44) + deg(500)), 0, deg(500))), // east edge ≈44 m west
        ]);
        const g = i.segmentAreaGraze(...vseg(0));
        expect(g).not.toBeNull();
        expect(g!.type).toBe('land'); // land wins despite the shoal being closer
        expect(Math.abs(g!.clearanceM - 44)).toBeLessThan(8);
    });

    it('carries the CATZOC through so the advisory can name the survey band', () => {
        const g = zocIdx([hz('DEPARE', square(deg(30) + deg(500), 0, deg(500)), 2)], 3).segmentAreaGraze(...vseg(0));
        expect(g?.catzoc).toBe(3);
    });

    it('is DRAFT-AWARE — a 10 m DEPARE edge over-warns at the static ceiling but NOT a 2.4 m keel (cycle-4 audit #8)', () => {
        // A depth area 30 m away whose bed is 10 m down — deep for a 2.4 m keel
        // (threshold ≈4.1 m), shallow only under the old static 15 m ceiling.
        const i = idx('A', [hz('DEPARE', square(deg(30) + deg(500), 0, deg(500)), 10)]);
        expect(i.segmentAreaGraze(...vseg(0))).not.toBeNull(); // default 15 m ceiling → over-warns
        expect(i.segmentAreaGraze(...vseg(0), 4.1)).toBeNull(); // draft-aware keel threshold → clear
        // Land is unconditional — the draft threshold never suppresses it.
        const land = idx('A', [hz('LNDARE', square(deg(30) + deg(500), 0, deg(500)))]);
        expect(land.segmentAreaGraze(...vseg(0), 4.1)?.type).toBe('land');
    });
});

describe('EncSpatialIndex.segmentHazard — COALNE-only land crossing (audit #4)', () => {
    // A coastline LINE islet (closed ring) charted with NO backing LNDARE.
    const ring: Geometry = {
        type: 'LineString',
        coordinates: [
            [-1, -1],
            [1, -1],
            [1, 1],
            [-1, 1],
            [-1, -1],
        ],
    };
    const coast = (geometry: Geometry): EncCoastline => ({ geometry });
    const idxC = (hazards: EncHazard[], coastlines: EncCoastline[]) =>
        new EncSpatialIndex('A', hazards, [], coastlines);

    it('a leg crossing a COALNE-only islet is flagged as land (the gap this fix closes)', () => {
        const i = idxC([], [coast(ring)]);
        // lat=0 leg from lon -2 to 2 crosses the ring at lon -1 and +1.
        expect(i.segmentHazard(0, -2, 0, 2)).toMatchObject({ covered: true, hazard: true, hazardType: 'land' });
    });

    it('a leg clear of the islet is not flagged', () => {
        const i = idxC([], [coast(ring)]);
        expect(i.segmentHazard(5, -2, 5, 2).covered).toBe(false); // far north — no crossing
    });

    it('a coincident LNDARE polygon still yields exactly one land verdict (no double-count / throw)', () => {
        const i = idxC([hz('LNDARE', square(0, 0, 1))], [coast(ring)]);
        expect(i.segmentHazard(0, -2, 0, 2)).toMatchObject({ covered: true, hazard: true, hazardType: 'land' });
    });

    it('a crossing within the berth radius of an exempt terminal is waived', () => {
        // Open coastline line at lon=0; a leg starting ~110 m west of it.
        const wall = coast({
            type: 'LineString',
            coordinates: [
                [0, -1],
                [0, 1],
            ],
        });
        const i = idxC([], [wall]);
        expect(i.segmentHazard(0, -0.001, 0, 0.5).hazardType).toBe('land'); // no exemption → flagged
        expect(i.segmentHazard(0, -0.001, 0, 0.5, true, false).covered).toBe(false); // exemptStart → waived
    });
});
