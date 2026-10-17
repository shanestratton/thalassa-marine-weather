import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@capacitor/filesystem', () => ({ Filesystem: {}, Directory: { Data: 'DATA' }, Encoding: { UTF8: 'utf8' } }));
import {
    noaaResidentBytes,
    reserveNoaaResident,
    setBlobCachePlottingMode,
    parseAndCacheCellText,
    blobCacheStats,
    peekCellGeoJSON,
    readCellRaw,
} from '../services/enc/EncCellStore';
import { clearMergedData, putMergedData, setMergedCleanup, retainMergedData } from '../services/enc/mergedDataCache';
import { putCell, removeCell } from '../services/enc/EncCellMetadata';
const MB = 1024 * 1024;
beforeEach(() => {
    clearMergedData();
    setBlobCachePlottingMode(false);
    expect(noaaResidentBytes()).toBe(0);
});
describe('shared public package residency', () => {
    it('uses48MiB total and16MiB per lease; it refuses the next byte without weakening the cap', () => {
        const leases = [reserveNoaaResident(16 * MB), reserveNoaaResident(16 * MB), reserveNoaaResident(16 * MB)];
        try {
            expect(() => reserveNoaaResident(1)).toThrow();
            expect(() => leases[0].resize(16 * MB + 1)).toThrow();
            expect(noaaResidentBytes()).toBe(48 * MB);
        } finally {
            leases.forEach((l) => l.release());
        }
    });
    it('strictly evicts ordinary blobs below the old four-entry floor when parts need their bytes', () => {
        for (let i = 0; i < 4; i++) {
            const cellId = `US5ABCD${i}`;
            parseAndCacheCellText(
                cellId,
                JSON.stringify({
                    cellId,
                    sourceHO: 'US',
                    edition: 1,
                    issued: '2026-01-01',
                    bbox: [0, 0, 1, 1],
                    layers: {},
                    synthetic: 'x'.repeat(9 * MB),
                }),
            );
        }
        const lease = reserveNoaaResident(16 * MB);
        try {
            expect(blobCacheStats().entries).toBeLessThan(4);
            expect(blobCacheStats().textMB + 16).toBeLessThanOrEqual(48);
        } finally {
            lease.release();
        }
    });
    it('keeps borrowed merged geometry charged until eviction or plotting detaches it', () => {
        const lease = reserveNoaaResident(12 * MB),
            released = vi.fn(lease.release);
        putMergedData('package-window', { cellCount: 1 } as never, [{ id: 'US3AK1EX', sizeBytes: 12 * MB }]);
        setMergedCleanup('package-window', released);
        expect(noaaResidentBytes()).toBe(12 * MB);
        setBlobCachePlottingMode(true);
        expect(released).toHaveBeenCalledOnce();
        expect(noaaResidentBytes()).toBe(0);
        expect(() => reserveNoaaResident(16 * MB + 1)).toThrow();
    });
    it('memo clear cannot free a still-displayed source; final detach frees exactly once', () => {
        const lease = reserveNoaaResident(12 * MB),
            data = { cellCount: 1 } as never,
            cleanup = vi.fn(lease.release);
        putMergedData('displayed-package', data, [{ id: 'US3AK1EX', sizeBytes: 12 * MB }]);
        setMergedCleanup('displayed-package', cleanup);
        const detach = retainMergedData(data);
        clearMergedData();
        expect(cleanup).not.toHaveBeenCalled();
        expect(noaaResidentBytes()).toBe(12 * MB);
        setBlobCachePlottingMode(true);
        expect(() => reserveNoaaResident(4 * MB + 1)).toThrow();
        detach();
        detach();
        expect(cleanup).toHaveBeenCalledOnce();
        expect(noaaResidentBytes()).toBe(0);
        expect(() => retainMergedData(data)).toThrow(/invalidated/);
    });
    it('a newly active package cannot read an obsolete cached monolith or enter a remote fallback', async () => {
        const id = 'US3AK1EX';
        parseAndCacheCellText(
            id,
            JSON.stringify({
                cellId: id,
                sourceHO: 'US',
                edition: 1,
                issued: '2026-01-01',
                bbox: [0, 0, 1, 1],
                layers: {},
            }),
        );
        putCell({
            id,
            sourceHO: 'US',
            edition: 1,
            issued: '2026-01-01',
            bbox: [0, 0, 1, 1],
            importedAt: '2026-01-01',
            geojsonPath: 'manifest',
            hazardCount: 1,
            noaaPackage: { owner: 'anonymous', manifestSha256: 'a'.repeat(64), path: 'owned' },
            licence: 'open',
        });
        try {
            expect(peekCellGeoJSON(id)).toBeUndefined();
            expect(await readCellRaw(id)).toEqual({ kind: 'missing', notFound: false });
        } finally {
            removeCell(id);
        }
    });
});
