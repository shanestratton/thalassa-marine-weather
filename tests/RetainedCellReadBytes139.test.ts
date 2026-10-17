import { afterEach, describe, expect, it } from 'vitest';
import type { EncConversionResult } from '../services/enc/types';
import {
    saveCellGeoJSON,
    peekCellGeoJSON,
    readRetainedCellGeoJSONBytes,
    clearProtectedBlobs,
} from '../services/enc/EncCellStore';
const blob: EncConversionResult = {
    cellId: 'AU500001',
    sourceHO: 'AHO',
    edition: 1,
    issued: '2026-10-01',
    bbox: [153, -28, 154, -27],
    layers: { DEPARE: { type: 'FeatureCollection', features: [] } },
};
afterEach(() => clearProtectedBlobs());
describe('actual retained parse-cache byte evidence', () => {
    it('binds exact measured bytes to the current borrowed object and retires on replacement/clear', async () => {
        const saved = await saveCellGeoJSON(blob.cellId, blob, undefined, 'protected');
        const held = peekCellGeoJSON(blob.cellId)!;
        expect(held).toBeDefined();
        expect(readRetainedCellGeoJSONBytes(blob.cellId, held)).toBe(saved.sizeBytes);
        expect(readRetainedCellGeoJSONBytes(blob.cellId, { ...held })).toBeNull();
        expect(readRetainedCellGeoJSONBytes(blob.cellId, JSON.parse(JSON.stringify(held)))).toBeNull();
        await saveCellGeoJSON(blob.cellId, { ...blob, edition: 2 }, undefined, 'protected');
        expect(readRetainedCellGeoJSONBytes(blob.cellId, held)).toBeNull();
        const replacement = peekCellGeoJSON(blob.cellId)!;
        expect(readRetainedCellGeoJSONBytes(blob.cellId, replacement)).not.toBeNull();
        clearProtectedBlobs();
        expect(readRetainedCellGeoJSONBytes(blob.cellId, replacement)).toBeNull();
    });
});
