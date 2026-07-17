/**
 * buildMergedVectorData END-TO-END (burn-down task #27): drive the real merge
 * fold through the public getMergedVectorData over a synthetic coarse+fine
 * two-cell library, asserting the orchestration glue the extracted pure
 * helpers can't cover — scale-shadow drops, the presence-gated line de-dup,
 * provenance tagging, caution-area folding, SEAARE label reduction, and the
 * sounding explode + density ladder — all in one pass.
 *
 * The store + metadata modules are mocked; everything else (scaleShadow,
 * clipDepareOverlap, seaareLabels, soundingDensity, caches) runs REAL.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Feature, FeatureCollection, Geometry } from 'geojson';

import type { EncCell, EncConversionResult } from '../../services/enc/types';

// ── Fixtures ───────────────────────────────────────────────────────

const square = (minLon: number, minLat: number, maxLon: number, maxLat: number): Geometry => ({
    type: 'Polygon',
    coordinates: [
        [
            [minLon, minLat],
            [maxLon, minLat],
            [maxLon, maxLat],
            [minLon, maxLat],
            [minLon, minLat],
        ],
    ],
});
const feat = (geometry: Geometry, properties: Record<string, unknown> = {}): Feature => ({
    type: 'Feature',
    geometry,
    properties,
});
const fc = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });

const cell = (id: string, bbox: [number, number, number, number]): EncCell =>
    ({
        id,
        sourceHO: 'AU',
        edition: 1,
        issued: '2026-01-01',
        importedAt: '2026-07-16T00:00:00Z',
        bbox,
        geojsonPath: `enc/${id}.json`,
    }) as EncCell;

// COARSE covers [0,0]-[4,4]; FINE is a 64×-finer survey inside [1,1]-[1.5,1.5].
const COARSE = cell('COARSE', [0, 0, 4, 4]);
const FINE = cell('FINE', [1, 1, 1.5, 1.5]);

const coarseBlob: EncConversionResult = {
    cellId: 'COARSE',
    sourceHO: 'AU',
    edition: 1,
    issued: '2026-01-01',
    bbox: COARSE.bbox,
    layers: {
        DEPARE: fc([feat(square(0, 0, 4, 4), { DRVAL1: 20 })]),
        // A contour LINE crossing the fine survey's extent at lat 1.25 —
        // the presence-gated de-dup must clip out its [1, 1.5] lon span.
        DEPCNT: fc([
            feat(
                {
                    type: 'LineString',
                    coordinates: [
                        [0, 1.25],
                        [4, 1.25],
                    ],
                },
                { VALDCO: 10 },
            ),
        ]),
        // An islet FULLY INSIDE the fine survey's DEPARE extent — the
        // scale-shadow drop must remove it (the finer cell owns that ground).
        LNDARE: fc([feat(square(1.1, 1.1, 1.2, 1.2), {})]),
        // Sounding cloud → exploded points with the density ladder stamped.
        SOUNDG: fc([
            feat(
                {
                    type: 'MultiPoint',
                    coordinates: [
                        [3, 3],
                        [3.2, 3.2],
                    ],
                } as Geometry,
                {
                    depths: [3.2, 15],
                },
            ),
        ]),
        // Named water → ONE label point.
        SEAARE: fc([feat(square(2.5, 2.5, 3, 3), { OBJNAM: 'Test Bay' })]),
        // Caution area → CAUTION_AREAS tagged _caution.
        RESARE: fc([feat(square(3.2, 0.2, 3.7, 0.7), { RESTRN: '7' })]),
    },
};

const fineBlob: EncConversionResult = {
    cellId: 'FINE',
    sourceHO: 'AU',
    edition: 1,
    issued: '2026-01-01',
    bbox: FINE.bbox,
    layers: {
        DEPARE: fc([feat(square(1, 1, 1.5, 1.5), { DRVAL1: 5 })]),
        // The fine survey CARRIES its own contours — this is what
        // presence-gates the coarse DEPCNT clip (a line-less ribbon cell
        // must never erase the coarse line).
        DEPCNT: fc([
            feat(
                {
                    type: 'LineString',
                    coordinates: [
                        [1, 1.2],
                        [1.5, 1.2],
                    ],
                },
                { VALDCO: 5 },
            ),
        ]),
    },
};

const blobs: Record<string, EncConversionResult> = { COARSE: coarseBlob, FINE: fineBlob };

// ── Module mocks (store + metadata only — the fold itself runs real) ──

vi.mock('../../services/enc/EncCellMetadata', () => ({
    listCells: () => [COARSE, FINE],
    getCell: (id: string) => (id === 'COARSE' ? COARSE : id === 'FINE' ? FINE : undefined),
    cellsForBBox: () => [COARSE, FINE],
    getVersion: () => 1,
    putCell: () => undefined,
    removeCell: () => undefined,
    subscribe: () => () => undefined,
}));

vi.mock('../../services/enc/EncCellStore', () => ({
    loadCellGeoJSON: async (id: string) => blobs[id] ?? null,
    // The merge's read-ahead pipeline (audit #11): serve the fixture blob as
    // a "cached" hit so no parse path is exercised.
    readCellRaw: async (id: string) =>
        blobs[id] ? { kind: 'cached' as const, blob: blobs[id] } : { kind: 'missing' as const },
    parseAndCacheCellText: (_id: string, text: string) => JSON.parse(text),
    saveCellGeoJSON: async () => undefined,
    deleteCellGeoJSON: async () => undefined,
}));

import { getMergedVectorData, type EncMergedVectorData } from '../../services/enc/EncHazardService';

// One real merge, asserted across all the seams (full merge: no window, no
// zoom → no derived contours, no glaze, no worker — pure fold).
let merged: EncMergedVectorData;

describe('buildMergedVectorData e2e (real fold over a coarse+fine library)', () => {
    beforeEach(async () => {
        merged = (await getMergedVectorData())!;
        expect(merged).not.toBeNull();
    });

    it('merges both cells with provenance tags on every feature', () => {
        expect(merged.cellCount).toBe(2);
        const depareCells = merged.DEPARE.features.map((f) => f.properties?._cellId).sort();
        expect(depareCells).toEqual(['COARSE', 'FINE']);
        expect(merged.DEPARE.features.every((f) => f.properties?._sourceHO === 'AU')).toBe(true);
    });

    it('SCALE-SHADOW drop: a coarse islet fully inside the finer survey is gone', () => {
        expect(merged.LNDARE.features).toHaveLength(0);
    });

    it('LINE DE-DUP: the coarse contour is clipped where the fine survey carries its own', () => {
        const coarseCnt = merged.DEPCNT.features.filter((f) => f.properties?._cellId === 'COARSE');
        expect(coarseCnt.length).toBeGreaterThan(0);
        // No surviving coarse-contour vertex strictly inside the fine extent's
        // lon span (1..1.5) — the clip keeps only the outside parts.
        for (const f of coarseCnt) {
            const lines =
                f.geometry.type === 'LineString'
                    ? [f.geometry.coordinates]
                    : f.geometry.type === 'MultiLineString'
                      ? f.geometry.coordinates
                      : [];
            for (const line of lines) {
                for (const [lon] of line as [number, number][]) {
                    expect(lon <= 1.000001 || lon >= 1.499999).toBe(true);
                }
            }
        }
        // The fine cell's own contour survives whole.
        expect(merged.DEPCNT.features.some((f) => f.properties?._cellId === 'FINE')).toBe(true);
    });

    it('CAUTION AREAS: RESARE folds in tagged with its class + provenance', () => {
        expect(merged.CAUTION_AREAS.features).toHaveLength(1);
        expect(merged.CAUTION_AREAS.features[0].properties).toMatchObject({
            _caution: 'RESARE',
            RESTRN: '7',
            _cellId: 'COARSE',
        });
    });

    it('SEAARE: named water reduces to ONE label point', () => {
        expect(merged.SEAARE_LABELS.features).toHaveLength(1);
        expect(merged.SEAARE_LABELS.features[0].properties).toMatchObject({ _name: 'Test Bay', _kind: 'water' });
        expect(merged.SEAARE_LABELS.features[0].geometry.type).toBe('Point');
    });

    it('SOUNDG: clouds explode to points with depth + density-ladder rungs', () => {
        expect(merged.SOUNDG.features).toHaveLength(2);
        const ds = merged.SOUNDG.features.map((f) => Number(f.properties?._d)).sort((a, b) => a - b);
        expect(ds).toEqual([3.2, 15]);
        // The shallowest claims the coarsest rung; every point got a rung.
        const rungs = merged.SOUNDG.features.map((f) => Number(f.properties?._minZoom));
        expect(Math.min(...rungs)).toBe(4);
        expect(rungs.every((r) => Number.isFinite(r))).toBe(true);
    });
});
