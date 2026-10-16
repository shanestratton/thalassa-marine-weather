import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EncCell, EncConversionResult } from '../../services/enc/types';
const cache = vi.hoisted(() => ({
    cells: [] as EncCell[],
    blobs: new Map<string, EncConversionResult>(),
    peek: vi.fn(),
    windows: vi.fn(),
}));
vi.mock('../../services/enc/EncCellMetadata', () => ({
    cellsForBBox: (box: unknown) => {
        cache.windows(box);
        return cache.cells;
    },
}));
vi.mock('../../services/enc/EncCellStore', () => ({
    peekCellGeoJSON: (id: string) => {
        cache.peek(id);
        return cache.blobs.get(id);
    },
}));
import { currentHoldingGroundAt } from '../../services/enc/holdingGround';

const cell = { id: 'US-synthetic', sourceHO: 'US', edition: 2 } as EncCell;
const blob = {
    cellId: cell.id,
    sourceHO: 'US',
    edition: 2,
    issued: '2026-10-01',
    bbox: [179, -1, 180, 1],
    layers: {
        SBDARE: {
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', geometry: { type: 'Point', coordinates: [180, 0] }, properties: { NATSUR: '9' } },
            ],
        },
    },
} as EncConversionResult;
describe('local loaded-chart holding advice', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        cache.cells = [cell];
        cache.blobs.clear();
        cache.blobs.set(cell.id, blob);
        vi.stubGlobal(
            'fetch',
            vi.fn(() => {
                throw new Error('Advice must not fetch');
            }),
        );
    });
    afterEach(() => vi.unstubAllGlobals());
    it('uses a loaded current chart at the dateline, without a global query or network read', () => {
        expect(currentHoldingGroundAt(0, 180)).toMatchObject({ kind: 'poor', pointSample: true });
        expect(cache.windows).toHaveBeenCalledTimes(2);
        for (const [box] of cache.windows.mock.calls) {
            expect(box[2] - box[0]).toBeLessThan(0.001);
        }
        expect(fetch).not.toHaveBeenCalled();
        expect(blob.layers.SBDARE!.features[0].properties).toEqual({ NATSUR: '9' });
    });
    it('does not load a missing chart or reuse a replaced edition/provider', () => {
        cache.blobs.clear();
        expect(currentHoldingGroundAt(0, 180).kind).toBe('unknown');
        cache.blobs.set(cell.id, { ...blob, edition: 1 });
        expect(currentHoldingGroundAt(0, 180).kind).toBe('unknown');
        cache.blobs.set(cell.id, { ...blob, sourceHO: 'NZ' });
        expect(currentHoldingGroundAt(0, 180).kind).toBe('unknown');
        expect(fetch).not.toHaveBeenCalled();
    });
    it('refuses reference charts and oversized work sets before geometry reads', () => {
        cache.cells = [{ ...cell, usage: 'reference' }];
        expect(currentHoldingGroundAt(0, 180).kind).toBe('unknown');
        cache.peek.mockClear();
        cache.cells = Array.from({ length: 65 }, (_, i) => ({ ...cell, id: `US-${i}` }));
        expect(currentHoldingGroundAt(0, 180).kind).toBe('unknown');
        expect(cache.peek).not.toHaveBeenCalled();
    });
});
