/**
 * encHazardParse — the GeoJSON → EncHazard parse path that feeds the
 * router's grounding-avoidance index. The audit flagged this whole path
 * as untested while the display math had 91 tests; the readers here make
 * safety decisions (depth known/unknown, hazard kept/dropped), so the
 * tests that matter are the case-defensive and fail-safe ones.
 */
import { describe, it, expect } from 'vitest';
import type { Feature, FeatureCollection } from 'geojson';

import {
    buildCatzocZones,
    buildCoastlines,
    buildHazardsForCell,
    buildSoundingHazards,
    explodeSoundings,
    featuresToHazards,
    readNumber,
    readString,
} from '../../services/enc/encHazardParse';
import type { EncConversionResult } from '../../services/enc/types';

const pt = (props: Record<string, unknown>): Feature => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [153.1, -27.4] },
    properties: props,
});
const fc = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
const blob = (layers: EncConversionResult['layers']): EncConversionResult => ({
    cellId: 'AU5TEST',
    sourceHO: 'AU',
    edition: 1,
    issued: '2026-01-01',
    bbox: [153, -28, 154, -27],
    layers,
});

describe('readNumber — case + string-quote defensive', () => {
    it('reads the canonical uppercase attr', () => {
        expect(readNumber(pt({ DRVAL1: 5.2 }), 'DRVAL1')).toBe(5.2);
    });
    it('reads a lowercased (ogr2ogr) attr from the uppercase name', () => {
        expect(readNumber(pt({ drval1: 5.2 }), 'DRVAL1')).toBe(5.2);
    });
    it('parses a string-quoted numeric', () => {
        expect(readNumber(pt({ VALSOU: '3.4' }), 'VALSOU')).toBe(3.4);
    });
    it('returns null for a missing attr', () => {
        expect(readNumber(pt({ FOO: 1 }), 'DRVAL1')).toBeNull();
    });
    it('returns null for a non-finite value (never a bogus depth)', () => {
        expect(readNumber(pt({ DRVAL1: 'not a number' }), 'DRVAL1')).toBeNull();
        expect(readNumber(pt({ DRVAL1: null }), 'DRVAL1')).toBeNull();
    });
    it('takes the first finite value across names', () => {
        expect(readNumber(pt({ A: 'x', B: 7 }), 'A', 'B')).toBe(7);
    });
    it('keeps a negative value (drying VALSOU is signed)', () => {
        expect(readNumber(pt({ VALSOU: -0.3 }), 'VALSOU')).toBe(-0.3);
    });
});

describe('readString — the OBJNAM sibling', () => {
    it('reads uppercase OBJNAM', () => {
        expect(readString(pt({ OBJNAM: 'Cape Pt' }), 'OBJNAM')).toBe('Cape Pt');
    });
    it('reads a lowercased objnam from the uppercase name', () => {
        expect(readString(pt({ objnam: 'Cape Pt' }), 'OBJNAM')).toBe('Cape Pt');
    });
    it('undefined for missing / blank / non-string', () => {
        expect(readString(pt({}), 'OBJNAM')).toBeUndefined();
        expect(readString(pt({ OBJNAM: '' }), 'OBJNAM')).toBeUndefined();
        expect(readString(pt({ OBJNAM: 42 }), 'OBJNAM')).toBeUndefined();
    });
});

describe('featuresToHazards — depth sourcing + descriptor', () => {
    it('DEPARE minDepth comes from DRVAL1 (upper AND lower case)', () => {
        expect(featuresToHazards('DEPARE', fc([pt({ DRVAL1: 4.1 })]))[0].minDepthM).toBe(4.1);
        expect(featuresToHazards('DEPARE', fc([pt({ drval1: 4.1 })]))[0].minDepthM).toBe(4.1);
    });
    it('OBSTRN / WRECKS minDepth comes from VALSOU', () => {
        expect(featuresToHazards('OBSTRN', fc([pt({ VALSOU: 2.0 })]))[0].minDepthM).toBe(2.0);
        expect(featuresToHazards('WRECKS', fc([pt({ valsou: 8.5 })]))[0].minDepthM).toBe(8.5);
    });
    it('LNDARE / UWTROC carry NO depth → null (always a hazard, any draft)', () => {
        expect(featuresToHazards('LNDARE', fc([pt({ DRVAL1: 99 })]))[0].minDepthM).toBeNull();
        expect(featuresToHazards('UWTROC', fc([pt({ VALSOU: 99 })]))[0].minDepthM).toBeNull();
    });
    it('unknown/garbage DRVAL1 → minDepthM null (fail-safe: caller must treat as hazard)', () => {
        expect(featuresToHazards('DEPARE', fc([pt({ DRVAL1: 'x' })]))[0].minDepthM).toBeNull();
        expect(featuresToHazards('DEPARE', fc([pt({})]))[0].minDepthM).toBeNull();
    });
    it('REGRESSION: descriptor is read case-defensively (lowercased objnam)', () => {
        // The exact bug the audit caught — was OBJNAM-uppercase-only, so an
        // ogr2ogr-lowercased cell silently dropped every hazard name.
        expect(featuresToHazards('WRECKS', fc([pt({ objnam: 'SS Dicky' })]))[0].description).toBe('SS Dicky');
        expect(featuresToHazards('WRECKS', fc([pt({ OBJNAM: 'SS Dicky' })]))[0].description).toBe('SS Dicky');
    });
    it('keeps a negative (drying) VALSOU verbatim — S-57 sign convention', () => {
        expect(featuresToHazards('OBSTRN', fc([pt({ VALSOU: -0.5 })]))[0].minDepthM).toBe(-0.5);
    });
    it('DRGARE (dredged area) sources depth from DRVAL1 like DEPARE — no longer dropped', () => {
        expect(featuresToHazards('DRGARE', fc([pt({ DRVAL1: 2 })]))[0].minDepthM).toBe(2);
        expect(featuresToHazards('DRGARE', fc([pt({ drval1: 8 })]))[0].minDepthM).toBe(8);
    });
    it('EXPLODES a MultiPoint hazard into per-point Point hazards (else the cluster is undetectable)', () => {
        const multi: Feature = {
            type: 'Feature',
            geometry: {
                type: 'MultiPoint',
                coordinates: [
                    [1, 1],
                    [2, 2],
                ],
            },
            properties: { VALSOU: 3, OBJNAM: 'foul' },
        };
        const out = featuresToHazards('UWTROC', fc([multi]));
        expect(out).toHaveLength(2);
        expect(out[0].geometry).toEqual({ type: 'Point', coordinates: [1, 1] });
        expect(out[1].geometry).toEqual({ type: 'Point', coordinates: [2, 2] });
        expect(out.every((h) => h.description === 'foul')).toBe(true);
    });
    it('skips features with no geometry, never a bogus hazard', () => {
        const bad: Feature = { type: 'Feature', geometry: null as unknown as Feature['geometry'], properties: {} };
        expect(featuresToHazards('OBSTRN', fc([bad]))).toEqual([]);
    });
});

describe('buildHazardsForCell — aggregation', () => {
    it('includes DRGARE (dredged areas) in the hazard model', () => {
        const h = buildHazardsForCell(blob({ DRGARE: fc([pt({ DRVAL1: 2 })]) }));
        expect(h).toHaveLength(1);
        expect(h[0]).toMatchObject({ layer: 'DRGARE', minDepthM: 2 });
    });
    it('collects hazards across all hazard layers and skips absent ones', () => {
        const h = buildHazardsForCell(
            blob({
                DEPARE: fc([pt({ DRVAL1: 3 })]),
                UWTROC: fc([pt({})]),
                // OBSTRN/WRECKS/LNDARE absent → skipped, no throw
            }),
        );
        expect(h.map((x) => x.layer).sort()).toEqual(['DEPARE', 'UWTROC']);
    });
    it('never pulls COALNE or M_QUAL into the hazard set', () => {
        const h = buildHazardsForCell(blob({ COALNE: fc([pt({})]), M_QUAL: fc([pt({ CATZOC: 1 })]) }));
        expect(h).toEqual([]);
    });
    it('folds shoal SOUNDG spot soundings into the hazard model (defense-in-depth)', () => {
        const soundg: Feature = {
            type: 'Feature',
            geometry: { type: 'MultiPoint', coordinates: [[153, -27]] },
            properties: { depths: [1.2] },
        };
        const h = buildHazardsForCell(blob({ DEPARE: fc([pt({ DRVAL1: 25 })]), SOUNDG: fc([soundg]) }));
        expect(h.some((x) => x.layer === 'SOUNDG' && x.minDepthM === 1.2)).toBe(true);
    });
});

describe('buildSoundingHazards — shoal soundings only', () => {
    const soundg = (depths: number[]): EncConversionResult =>
        blob({
            SOUNDG: fc([
                {
                    type: 'Feature',
                    geometry: { type: 'MultiPoint', coordinates: depths.map((_, i) => [153 + i * 0.001, -27]) },
                    properties: { depths },
                },
            ]),
        });

    it('keeps a shoal sounding as a Point SOUNDG hazard carrying its depth', () => {
        const h = buildSoundingHazards(soundg([1.2]));
        expect(h).toHaveLength(1);
        expect(h[0]).toMatchObject({ layer: 'SOUNDG', minDepthM: 1.2 });
        expect(h[0].geometry.type).toBe('Point');
    });
    it('drops deep soundings (≥ 15 m) — they can never ground a modelled vessel', () => {
        expect(buildSoundingHazards(soundg([20, 30]))).toHaveLength(0);
        expect(buildSoundingHazards(soundg([2, 20]))).toHaveLength(1); // keeps only the shoal one
    });
    it('keeps a drying (negative) sounding — it is the shallowest of all', () => {
        expect(buildSoundingHazards(soundg([-0.4]))[0].minDepthM).toBe(-0.4);
    });
    it('no SOUNDG layer → no sounding hazards', () => {
        expect(buildSoundingHazards(blob({}))).toEqual([]);
    });
});

describe('buildCatzocZones — quality zones', () => {
    const poly = (props: Record<string, unknown>): Feature => ({
        type: 'Feature',
        geometry: {
            type: 'Polygon',
            coordinates: [
                [
                    [153, -27],
                    [153.1, -27],
                    [153.1, -27.1],
                    [153, -27],
                ],
            ],
        },
        properties: props,
    });
    it('keeps valid CATZOC 1..6 (case-defensive) and rounds', () => {
        expect(buildCatzocZones(blob({ M_QUAL: fc([poly({ CATZOC: 3 })]) }))[0].catzoc).toBe(3);
        expect(buildCatzocZones(blob({ M_QUAL: fc([poly({ catzoc: '2' })]) }))[0].catzoc).toBe(2);
        expect(buildCatzocZones(blob({ M_QUAL: fc([poly({ CATZOC: 4.4 })]) }))[0].catzoc).toBe(4);
    });
    it('drops out-of-range CATZOC and non-polygon geometry', () => {
        expect(buildCatzocZones(blob({ M_QUAL: fc([poly({ CATZOC: 0 }), poly({ CATZOC: 7 })]) }))).toEqual([]);
        expect(buildCatzocZones(blob({ M_QUAL: fc([pt({ CATZOC: 3 })]) }))).toEqual([]); // point, not polygon
    });
    it('missing M_QUAL → empty', () => {
        expect(buildCatzocZones(blob({}))).toEqual([]);
    });
});

describe('buildCoastlines — COALNE line filter', () => {
    const line: Feature = {
        type: 'Feature',
        geometry: {
            type: 'LineString',
            coordinates: [
                [153, -27],
                [153.1, -27.1],
            ],
        },
        properties: {},
    };
    it('keeps LineString/MultiLineString and drops polygon/point junk', () => {
        const polyJunk = pt({}); // point junk GDAL sometimes emits into COALNE
        expect(buildCoastlines(blob({ COALNE: fc([line, polyJunk]) }))).toHaveLength(1);
    });
    it('missing COALNE → empty', () => {
        expect(buildCoastlines(blob({}))).toEqual([]);
    });
});

describe('explodeSoundings — MultiPoint clouds → labelled points', () => {
    const multi = (coords: number[][], props: Record<string, unknown> = {}): Feature => ({
        type: 'Feature',
        geometry: { type: 'MultiPoint', coordinates: coords },
        properties: props,
    });

    it('explodes a MultiPoint cloud, one {_d} point per coordinate', () => {
        const out = explodeSoundings(
            fc([
                multi(
                    [
                        [153, -27],
                        [153.1, -27.1],
                    ],
                    { depths: [3.2, 5.7] },
                ),
            ]),
        );
        expect(out).toHaveLength(2);
        expect(out[0].geometry).toEqual({ type: 'Point', coordinates: [153, -27] });
        expect(out[0].properties?._d).toBe(3.2);
        expect(out[1].properties?._d).toBe(5.7);
    });

    it('depth priority: depths[i] → z(coord[2]) → VALSOU → DEPTH', () => {
        expect(explodeSoundings(fc([multi([[153, -27]], { depths: [1.1], VALSOU: 9 })]))[0].properties?._d).toBe(1.1);
        expect(explodeSoundings(fc([multi([[153, -27, 2.5]], {})]))[0].properties?._d).toBe(2.5); // z
        expect(explodeSoundings(fc([multi([[153, -27]], { VALSOU: 4 })]))[0].properties?._d).toBe(4);
        expect(explodeSoundings(fc([multi([[153, -27]], { DEPTH: 6 })]))[0].properties?._d).toBe(6);
    });

    it('handles a single Point geometry too', () => {
        const out = explodeSoundings(
            fc([{ type: 'Feature', geometry: { type: 'Point', coordinates: [153, -27, 4.4] }, properties: {} }]),
        );
        expect(out).toHaveLength(1);
        expect(out[0].properties?._d).toBe(4.4);
    });

    it('rounds _d to 0.1 m', () => {
        expect(explodeSoundings(fc([multi([[153, -27]], { depths: [3.14159] })]))[0].properties?._d).toBe(3.1);
    });

    it('carries _minZoom when present', () => {
        expect(explodeSoundings(fc([multi([[153, -27]], { depths: [3], _minZoom: 12 })]))[0].properties?._minZoom).toBe(
            12,
        );
    });

    it('skips non-finite coords and non-finite depths — never a bogus 0 m point', () => {
        const out = explodeSoundings(
            fc([
                multi(
                    [
                        [NaN, -27],
                        [153, -27],
                        [153.1, -27.1],
                    ],
                    { depths: [3, 'bad', 5] },
                ),
            ]),
        );
        // point 0 dropped (NaN lon); point 1 dropped (depth 'bad' → NaN); point 2 kept (depth 5)
        expect(out).toHaveLength(1);
        expect(out[0].properties?._d).toBe(5);
    });

    it('empty / undefined collection → []', () => {
        expect(explodeSoundings(undefined)).toEqual([]);
        expect(explodeSoundings(fc([]))).toEqual([]);
    });
});
