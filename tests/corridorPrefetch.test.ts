/**
 * corridorPrefetch — bbox formula parity with the inshore engine + the
 * fetch-missing-cells wiring (registry/store/ladder mocked; no network).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cells: Array<{ id: string; bbox: [number, number, number, number] }> = [];
const localCells = new Set<string>();
const laddered: string[] = [];

vi.mock('../services/enc/EncCellMetadata', () => ({
    cellsForBBox: (bbox: [number, number, number, number]) =>
        cells.filter((c) => c.bbox[0] < bbox[2] && c.bbox[2] > bbox[0] && c.bbox[1] < bbox[3] && c.bbox[3] > bbox[1]),
}));
vi.mock('../services/enc/EncCellStore', () => ({
    hasCellGeoJSON: async (id: string) => localCells.has(id),
    loadCellGeoJSON: async (id: string) => {
        laddered.push(id);
        localCells.add(id); // pretend the ladder (Pi/cloud) landed it
        return { cellId: id, layers: {} };
    },
}));
vi.mock('../services/enc/cloudCellSync', () => ({
    registerCloudCells: async () => 0,
}));

import { corridorBBox, prefetchCorridorCells } from '../services/enc/corridorPrefetch';

describe('corridorPrefetch', () => {
    beforeEach(() => {
        cells.length = 0;
        localCells.clear();
        laddered.length = 0;
    });

    it('corridorBBox mirrors the engine padding — max(span×0.5, 0.08°)', () => {
        // Wide route: span 0.4° lat → pad 0.2°.
        const wide = corridorBBox([
            { lat: -27.0, lon: 153.0 },
            { lat: -27.4, lon: 153.1 },
        ]);
        expect(wide[1]).toBeCloseTo(-27.6, 5); // -27.4 - 0.2
        expect(wide[3]).toBeCloseTo(-26.8, 5); // -27.0 + 0.2
        // Short hop: span 0.02° → the 0.08° floor wins.
        const short = corridorBBox([
            { lat: -27.0, lon: 153.0 },
            { lat: -27.02, lon: 153.0 },
        ]);
        expect(short[1]).toBeCloseTo(-27.1, 5);
        expect(short[2]).toBeCloseTo(153.08, 5);
    });

    it('pulls only the MISSING cells covering the corridor, via the ladder', async () => {
        cells.push(
            { id: 'LOCAL', bbox: [153.0, -27.2, 153.2, -27.0] },
            { id: 'MISSING_IN', bbox: [153.0, -27.4, 153.2, -27.2] },
            { id: 'MISSING_OUT', bbox: [150.0, -30.5, 150.2, -30.3] }, // outside corridor
        );
        localCells.add('LOCAL');
        const r = await prefetchCorridorCells([
            { lat: -27.05, lon: 153.05 },
            { lat: -27.3, lon: 153.1 },
        ]);
        expect(r.needed).toBe(1);
        expect(r.fetched).toBe(1);
        expect(laddered).toEqual(['MISSING_IN']);
    });

    it('under 2 pins → no-op; everything local → no fetches', async () => {
        expect(await prefetchCorridorCells([{ lat: -27, lon: 153 }])).toEqual({ needed: 0, fetched: 0 });
        cells.push({ id: 'A', bbox: [152.9, -27.2, 153.2, -26.9] });
        localCells.add('A');
        const r = await prefetchCorridorCells([
            { lat: -27.0, lon: 153.0 },
            { lat: -27.1, lon: 153.1 },
        ]);
        expect(r).toEqual({ needed: 0, fetched: 0 });
        expect(laddered).toEqual([]);
    });
});
