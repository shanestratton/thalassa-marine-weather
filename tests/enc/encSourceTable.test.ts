/**
 * Mount smoke test (closing audit): the source table is THE single list —
 * every source id declared in encLayerIds must have a row, no duplicates.
 * A source registered in one place but not the other used to ship a
 * permanently blank layer.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../services/enc/EncCellMetadata', () => ({
    listCells: vi.fn(() => []),
    getCell: vi.fn(),
    getVersion: vi.fn(() => 1),
    subscribe: vi.fn(() => () => {}),
}));
vi.mock('../../services/enc/EncCellStore', () => ({
    loadCellGeoJSON: vi.fn(async () => null),
    readCellRaw: vi.fn(async () => ({ kind: 'missing', notFound: true })),
    parseAndCacheCellText: vi.fn(() => null),
}));

import { ENC_SOURCE_TABLE } from '../../components/map/EncVectorLayer';
import { ENC_VEC_SRC } from '../../components/map/encLayerIds';
import { createEmptyMergedVectorData } from '../../services/enc/EncHazardService';

describe('ENC_SOURCE_TABLE completeness', () => {
    it('covers every ENC_VEC_SRC id exactly once', () => {
        const tableIds = ENC_SOURCE_TABLE.map((r) => r.id).sort();
        const declared = Object.values(ENC_VEC_SRC).sort();
        expect(tableIds).toEqual(declared);
        expect(new Set(tableIds).size).toBe(tableIds.length);
    });

    it('every row builds a FeatureCollection from an empty merge shell', () => {
        const shell = createEmptyMergedVectorData();
        for (const row of ENC_SOURCE_TABLE) {
            expect(row.build(shell).type).toBe('FeatureCollection');
        }
    });
});
