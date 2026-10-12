/**
 * The protected chart registry lives in memory too (127-C-c decision 6).
 *
 * A licensed cell's record — id, extent, edition — is part of the chart
 * catalogue, and the licence keeps the catalogue on the boat: the record goes
 * to a session overlay, never to localStorage. A relaunch away from the Pi
 * therefore holds no licensed cell, and every consumer takes its honest "no
 * chart here" path. Fictional ids only (OC-99-ZZ…, US5ZZ01M).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EncCell } from '../services/enc/types';

const record = (id: string, sourceHO: string, overrides: Partial<EncCell> = {}): EncCell => ({
    id,
    sourceHO,
    edition: 3,
    issued: '2026-09-01',
    importedAt: '2026-09-02T00:00:00.000Z',
    bbox: [-63.2, 17.9, -63.0, 18.1],
    geojsonPath: 'vault',
    hazardCount: 4,
    usage: 'navigation',
    sizeBytes: 120_000,
    ...overrides,
});

const cellKeys = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.map((call) => String(call[0])).filter((k) => k.startsWith('thalassa.enc.cell:'));

describe('the protected registry overlay', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it('putCell of a protected cell writes no thalassa.enc.cell record, and listCells includes it', async () => {
        const meta = await import('../services/enc/EncCellMetadata');
        const setItem = vi.spyOn(Storage.prototype, 'setItem');
        meta.putCell(record('OC-99-ZZ0101', 'ZZ'));
        expect(cellKeys(setItem)).toEqual([]);
        expect(meta.listCells().map((c) => c.id)).toEqual(['OC-99-ZZ0101']);
        expect(meta.getCell('oc-99-zz0101')?.id).toBe('OC-99-ZZ0101');
    });

    it('a relaunch forgets the protected record and keeps the open one', async () => {
        let meta = await import('../services/enc/EncCellMetadata');
        meta.putCell(record('OC-99-ZZ0102', 'ZZ'));
        meta.putCell(record('US5ZZ01M', 'US'));
        expect(meta.listCells()).toHaveLength(2);
        vi.resetModules();
        meta = await import('../services/enc/EncCellMetadata');
        expect(meta.listCells().map((c) => c.id)).toEqual(['US5ZZ01M']);
        expect(meta.boatRegistryLoaded()).toBe(false);
    });

    it('a byte-identical re-put of a protected record bumps nothing (kill #41)', async () => {
        const meta = await import('../services/enc/EncCellMetadata');
        const heard = vi.fn();
        meta.subscribe(heard);
        meta.putCell(record('OC-99-ZZ0103', 'ZZ'));
        const version = meta.getVersion();
        meta.putCell(record('OC-99-ZZ0103', 'ZZ'));
        expect(meta.getVersion()).toBe(version);
        expect(heard).toHaveBeenCalledTimes(1);
    });

    it('removeCell, clearBoatRecords and clearAllCellMetadata clear the overlay', async () => {
        const meta = await import('../services/enc/EncCellMetadata');
        meta.putCell(record('OC-99-ZZ0104', 'ZZ'));
        meta.removeCell('OC-99-ZZ0104');
        expect(meta.listCells()).toEqual([]);
        meta.putCell(record('OC-99-ZZ0105', 'ZZ'));
        meta.markBoatRegistryLoaded();
        expect(meta.boatRegistryLoaded()).toBe(true);
        meta.clearBoatRecords();
        expect(meta.listCells()).toEqual([]);
        expect(meta.boatRegistryLoaded()).toBe(false);
        meta.putCell(record('OC-99-ZZ0106', 'ZZ'));
        meta.clearAllCellMetadata();
        expect(meta.listCells()).toEqual([]);
    });

    it('the fingerprint covers the overlay', async () => {
        const meta = await import('../services/enc/EncCellMetadata');
        meta.putCell(record('OC-99-ZZ0107', 'ZZ'));
        expect(meta.getRegistryFingerprint()).toContain('OC-99-ZZ0107@3');
    });

    it('a protected record left in localStorage by an older build is never read', async () => {
        localStorage.setItem('thalassa.enc.cell.index', JSON.stringify(['OC-99-ZZ0108']));
        localStorage.setItem('thalassa.enc.cell:OC-99-ZZ0108', JSON.stringify(record('OC-99-ZZ0108', 'ZZ')));
        const meta = await import('../services/enc/EncCellMetadata');
        expect(meta.listCells()).toEqual([]);
        expect(localStorage.getItem('thalassa.enc.cell:OC-99-ZZ0108')).toBeNull();
    });

    it('forgetPairing clears the overlay, the vault and the protected parse-cache entries', async () => {
        const meta = await import('../services/enc/EncCellMetadata');
        const vault = await import('../services/enc/boatCellVault');
        const store = await import('../services/enc/EncCellStore');
        const { forgetPairing } = await import('../services/PiPairingService');
        meta.putCell(record('OC-99-ZZ0109', 'ZZ'));
        vault.put('OC-99-ZZ0109', '{"cellId":"OC-99-ZZ0109"}');
        store.parseAndCacheCellText(
            'OC-99-ZZ0109',
            JSON.stringify({
                cellId: 'OC-99-ZZ0109',
                sourceHO: 'ZZ',
                edition: 3,
                issued: '2026-09-01',
                bbox: [-63.2, 17.9, -63.0, 18.1],
                layers: {},
            }),
        );
        expect(store.blobCacheStats().entries).toBe(1);
        forgetPairing();
        await vi.waitFor(() => expect(meta.listCells()).toEqual([]));
        expect(vault.has('OC-99-ZZ0109')).toBe(false);
        expect(store.blobCacheStats().entries).toBe(0);
    });
});
