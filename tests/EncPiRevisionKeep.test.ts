/**
 * A route-time Pi pull keeps a held chart's Pi identity (2026-10-01 review).
 *
 * piCellSync downloadPiCell pulls one chart when a route needs a blob the
 * phone lacks. It has no index row, so it used to replace the record with no
 * contentSha256 and no piSizeBytes — and the chart sheet then counted a chart
 * it holds as "Sync 1 chart" again until a manual sync (services/enc/
 * piSyncPlan). The import now keeps the replaced record's values when the
 * bytes are the same revision: same edition, update and stored size.
 * Synthetic cell only.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EncCell, EncConversionResult } from '../services/enc/types';

const mocks = vi.hoisted(() => ({
    storedCell: null as EncCell | null,
    saveCellGeoJSON: vi.fn(),
}));

vi.mock('../services/enc/EncCellStore', () => ({
    saveCellGeoJSON: mocks.saveCellGeoJSON,
    loadCellGeoJSON: vi.fn(),
    deleteCellGeoJSON: vi.fn(),
}));

vi.mock('../services/enc/EncCellMetadata', () => ({
    getCell: (id: string) => (mocks.storedCell?.id === id ? mocks.storedCell : null),
    getDisplayCell: (id: string) => (mocks.storedCell?.id === id ? mocks.storedCell : null),
    getRegisteredCell: (id: string) =>
        mocks.storedCell?.id.trim().toUpperCase() === id.trim().toUpperCase() ? mocks.storedCell : null,
    listDisplayCells: () => (mocks.storedCell ? [mocks.storedCell] : []),
    listRegisteredCells: () => (mocks.storedCell ? [mocks.storedCell] : []),
    listPendingCells: () => [],
    putCell: (cell: EncCell) => {
        mocks.storedCell = { ...cell };
    },
    removeCell: () => {
        mocks.storedCell = null;
    },
    subscribe: () => () => undefined,
    getVersion: () => 0,
}));

import { importCell } from '../services/enc/EncHazardService';

const SHA = 'a'.repeat(64);

function conversion(edition = 3, updateNumber = 1): EncConversionResult {
    return {
        cellId: 'OC-99-SYNPI1',
        sourceHO: 'AU',
        edition,
        updateNumber,
        issued: '2026-08-01',
        bbox: [160, -31, 161, -30],
        layers: { DEPARE: { type: 'FeatureCollection', features: [] } },
    };
}

function held(sizeBytes: number): EncCell {
    return {
        id: 'OC-99-SYNPI1',
        sourceHO: 'AU',
        edition: 3,
        updateNumber: 1,
        contentSha256: SHA,
        piSizeBytes: 1_085_565,
        issued: '2026-08-01',
        importedAt: '2026-09-01T00:00:00.000Z',
        bbox: [160, -31, 161, -30],
        geojsonPath: 'enc/OC-99-SYNPI1.json',
        hazardCount: 0,
        usage: 'navigation',
        catzocRange: null,
        sizeBytes,
    };
}

describe('a route-time Pi pull keeps the held chart’s Pi identity', () => {
    beforeEach(() => {
        mocks.saveCellGeoJSON.mockReset();
        mocks.storedCell = null;
    });

    it('the same revision with the same stored bytes keeps contentSha256 and piSizeBytes', async () => {
        mocks.storedCell = held(1_084_874);
        mocks.saveCellGeoJSON.mockResolvedValue({ path: 'enc/OC-99-SYNPI1.json', sizeBytes: 1_084_874 });
        const cell = await importCell(conversion(), { keepPiRevisionWhenUnchanged: true });
        expect(cell.contentSha256).toBe(SHA);
        expect(cell.piSizeBytes).toBe(1_085_565);
        expect(mocks.storedCell?.piSizeBytes).toBe(1_085_565);
    });

    it('a new update or a new edition is a new revision: nothing is carried over', async () => {
        for (const blob of [conversion(3, 2), conversion(4, 0)]) {
            mocks.storedCell = held(1_084_874);
            mocks.saveCellGeoJSON.mockResolvedValue({ path: 'vault', sizeBytes: 1_084_874 });
            const cell = await importCell(blob, { keepPiRevisionWhenUnchanged: true });
            expect(cell.contentSha256).toBeUndefined();
            expect(cell.piSizeBytes).toBeUndefined();
        }
    });

    it('an open (NOAA) cell with different bytes is a new revision: nothing is carried over', async () => {
        mocks.storedCell = { ...held(1_084_874), id: 'US5ZZ01M', sourceHO: 'US' };
        mocks.saveCellGeoJSON.mockResolvedValue({ path: 'enc-cells/US5ZZ01M.geojson', sizeBytes: 1_084_000 });
        const cell = await importCell(
            { ...conversion(), cellId: 'US5ZZ01M', sourceHO: 'US' },
            { keepPiRevisionWhenUnchanged: true },
        );
        expect(cell.contentSha256).toBeUndefined();
        expect(cell.piSizeBytes).toBeUndefined();
        expect(cell.sizeBytes).toBe(1_084_000);
    });

    // 127-C-c decision 7: a licensed cell's identity is the Pi's revision.
    // Its bytes are held in memory and checked against the registered sha by
    // the pull itself, so the phone's own byte count is never its identity:
    // registering then importing leaves the chart library's fingerprint as it was.
    it('a licensed cell keeps the registered sha and the Pi size as its size, whatever the phone measured', async () => {
        mocks.storedCell = { ...held(1_085_565), licence: 'protected' };
        mocks.saveCellGeoJSON.mockResolvedValue({ path: 'vault', sizeBytes: 1_084_000 });
        const cell = await importCell(conversion(), { keepPiRevisionWhenUnchanged: true });
        expect(cell.contentSha256).toBe(SHA);
        expect(cell.piSizeBytes).toBe(1_085_565);
        expect(cell.sizeBytes).toBe(1_085_565);
    });

    it('without the option (every other import) nothing is carried over, as before', async () => {
        mocks.storedCell = held(1_084_874);
        mocks.saveCellGeoJSON.mockResolvedValue({ path: 'enc/OC-99-SYNPI1.json', sizeBytes: 1_084_874 });
        const cell = await importCell(conversion());
        expect(cell.contentSha256).toBeUndefined();
        expect(cell.piSizeBytes).toBeUndefined();
    });

    it('values handed in by a Pi sync still win', async () => {
        mocks.storedCell = held(1_084_874);
        mocks.saveCellGeoJSON.mockResolvedValue({ path: 'enc/OC-99-SYNPI1.json', sizeBytes: 1_084_874 });
        const cell = await importCell(conversion(), {
            contentSha256: 'b'.repeat(64),
            piSizeBytes: 2_000,
            keepPiRevisionWhenUnchanged: true,
        });
        expect(cell.contentSha256).toBe('b'.repeat(64));
        expect(cell.piSizeBytes).toBe(2_000);
    });

    it('the route-time pull asks for it', () => {
        const src = readFileSync('services/enc/piCellSync.ts', 'utf8');
        expect(src).toContain('keepPiRevisionWhenUnchanged: true');
        // …and checks the bytes against the registered revision (127-C-c).
        expect(src).toContain('expectedSha256: held?.contentSha256');
    });
});
