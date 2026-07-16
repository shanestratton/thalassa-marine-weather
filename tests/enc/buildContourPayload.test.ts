/**
 * buildContourPayload — the merge's sounding-cloud → worker-input packer.
 * Extracted from the buildMergedVectorData monolith so the one piece of it
 * that IS pure gets function-level coverage (the merge core resists
 * isolation — heavy module + loop state).
 */
import { describe, it, expect } from 'vitest';
import type { Feature } from 'geojson';

import { buildContourPayload, createEmptyMergedVectorData } from '../../services/enc/EncHazardService';

const soundg = (lon: number, lat: number, d: unknown): Feature => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { _d: d },
});

describe('buildContourPayload', () => {
    it('packs each Point sounding into {lon,lat,d}', () => {
        const out = buildContourPayload([soundg(153.1, -27.4, 3.2), soundg(153.2, -27.5, 5.7)]);
        expect(out).toEqual([
            { lon: 153.1, lat: -27.4, d: 3.2 },
            { lon: 153.2, lat: -27.5, d: 5.7 },
        ]);
    });

    it('skips non-Point geometries (never a bogus contour vertex)', () => {
        const line: Feature = {
            type: 'Feature',
            geometry: {
                type: 'LineString',
                coordinates: [
                    [0, 0],
                    [1, 1],
                ],
            },
            properties: { _d: 2 },
        };
        expect(buildContourPayload([line])).toEqual([]);
    });

    it('coerces a string-quoted depth and preserves a drying (negative) sounding', () => {
        expect(buildContourPayload([soundg(1, 2, '4.5')])[0].d).toBe(4.5);
        expect(buildContourPayload([soundg(1, 2, -0.3)])[0].d).toBe(-0.3);
    });

    it('empty in → empty out', () => {
        expect(buildContourPayload([])).toEqual([]);
    });
});

describe('createEmptyMergedVectorData', () => {
    it('starts every ENC layer as an empty FeatureCollection with cellCount 0', () => {
        const m = createEmptyMergedVectorData();
        expect(m.cellCount).toBe(0);
        for (const [key, v] of Object.entries(m)) {
            if (key === 'cellCount') continue;
            expect(v).toEqual({ type: 'FeatureCollection', features: [] });
        }
    });

    it('returns a FRESH shell each call (no shared feature arrays across merges)', () => {
        const a = createEmptyMergedVectorData();
        const b = createEmptyMergedVectorData();
        a.DEPARE.features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} });
        expect(b.DEPARE.features).toHaveLength(0); // b unaffected — arrays not shared
    });
});
