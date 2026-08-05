import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EncCell } from '../services/enc/types';

const sampleCell = (usage?: EncCell['usage']): EncCell => ({
    id: 'US5GA22M',
    sourceHO: 'NOAA',
    edition: 7,
    issued: '2026-01-01',
    importedAt: '2026-08-04T00:00:00.000Z',
    bbox: [-81.3, 31.8, -80.8, 32.3],
    geojsonPath: 'enc/US5GA22M.geojson',
    hazardCount: 42,
    usage,
});

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
});

describe('ENC demo-cell navigation boundary', () => {
    it('excludes explicitly tagged demos from inventory, coverage, and direct metadata reads', async () => {
        const metadata = await import('../services/enc/EncCellMetadata');
        metadata.putCell(sampleCell('demo'));

        expect(metadata.listCells()).toEqual([]);
        expect(metadata.cellsForBBox([-82, 31, -80, 33])).toEqual([]);
        expect(metadata.getCell('US5GA22M')).toBeNull();
    });

    it('quarantines an old untagged auto-seed but permits a later classified user import', async () => {
        const legacy = sampleCell(undefined);
        delete legacy.usage;
        localStorage.setItem('thalassa.enc.cell.index', JSON.stringify([legacy.id]));
        localStorage.setItem(`thalassa.enc.cell:${legacy.id}`, JSON.stringify(legacy));
        localStorage.setItem('thalassa.enc.samplesImported.v7', '1');

        const metadata = await import('../services/enc/EncCellMetadata');
        expect(metadata.listCells()).toEqual([]);
        expect(metadata.getCell(legacy.id)).toBeNull();

        metadata.putCell(sampleCell('navigation'));
        expect(metadata.listCells()).toEqual([expect.objectContaining({ id: legacy.id, usage: 'navigation' })]);
        expect(metadata.cellsForBBox([-82, 31, -80, 33])).toHaveLength(1);
    });
});
