/**
 * Tests for nativeStorage service
 * Validates save/load/delete with mocked Capacitor Filesystem
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Capacitor Filesystem
const mockWriteFile = vi.fn().mockResolvedValue(undefined);
const mockReadFile = vi.fn();
const mockDeleteFile = vi.fn().mockResolvedValue(undefined);
const mockReaddir = vi.fn();

vi.mock('@capacitor/filesystem', () => ({
    Filesystem: {
        writeFile: (...args: unknown[]) => mockWriteFile(...args),
        readFile: (...args: unknown[]) => mockReadFile(...args),
        deleteFile: (...args: unknown[]) => mockDeleteFile(...args),
        readdir: (...args: unknown[]) => mockReaddir(...args),
    },
    Directory: { Documents: 'DOCUMENTS' },
    Encoding: { UTF8: 'utf8' },
}));

import { saveLargeData, loadLargeData, deleteLargeData, DATA_CACHE_KEY, VOYAGE_CACHE_KEY } from '../services/nativeStorage';

describe('nativeStorage constants', () => {
    it('exports expected cache keys', () => {
        expect(DATA_CACHE_KEY).toBeDefined();
        expect(typeof DATA_CACHE_KEY).toBe('string');
        expect(VOYAGE_CACHE_KEY).toBeDefined();
    });
});

describe('saveLargeData', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
    });

    it('debounces writes by 1 second', async () => {
        const promise = saveLargeData('test_key', { value: 42 });

        // Before debounce fires
        expect(mockWriteFile).not.toHaveBeenCalled();

        // Advance past debounce
        vi.advanceTimersByTime(1100);
        await promise;

        expect(mockWriteFile).toHaveBeenCalledTimes(1);
        expect(mockWriteFile).toHaveBeenCalledWith(
            expect.objectContaining({
                path: 'test_key.json',
                data: JSON.stringify({ value: 42 }),
            })
        );

        vi.useRealTimers();
    });

    it('resolves even if write fails', async () => {
        mockWriteFile.mockRejectedValueOnce(new Error('Disk full'));
        const promise = saveLargeData('fail_key', { data: 'x' });
        vi.advanceTimersByTime(1100);

        // Should NOT throw
        await expect(promise).resolves.toBeUndefined();
        vi.useRealTimers();
    });
});

describe('loadLargeData', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useRealTimers();
        localStorage.clear();
    });

    it('returns parsed JSON when file exists', async () => {
        const payload = { temp: 22, wind: 15 };
        mockReaddir.mockResolvedValue({ files: [{ name: 'my_cache.json' }] });
        mockReadFile.mockResolvedValue({ data: JSON.stringify(payload) });

        const result = await loadLargeData('my_cache');
        expect(result).toEqual(payload);
    });

    it('returns null when file does not exist and no localStorage fallback', async () => {
        mockReaddir.mockResolvedValue({ files: [] });
        const result = await loadLargeData('missing_key');
        expect(result).toBeNull();
    });

    it('falls back to localStorage for legacy migration', async () => {
        mockReaddir.mockResolvedValue({ files: [] });
        localStorage.setItem('legacy_key', JSON.stringify({ migrated: true }));

        const result = await loadLargeData('legacy_key');
        expect(result).toEqual({ migrated: true });

        // Should remove from localStorage after migration
        expect(localStorage.getItem('legacy_key')).toBeNull();
    });

    it('rejects corrupted future data (poison pill)', async () => {
        const corrupted = {
            hourly: [{ time: '2030-01-01T00:00:00Z' }]
        };
        mockReaddir.mockResolvedValue({ files: [{ name: 'poison.json' }] });
        mockReadFile.mockResolvedValue({ data: JSON.stringify(corrupted) });

        const result = await loadLargeData('poison');
        expect(result).toBeNull();
    });
});

describe('deleteLargeData', () => {
    beforeEach(() => vi.clearAllMocks());

    it('calls Filesystem.deleteFile with correct path', async () => {
        await deleteLargeData('old_data');
        expect(mockDeleteFile).toHaveBeenCalledWith(
            expect.objectContaining({ path: 'old_data.json' })
        );
    });

    it('does not throw if file does not exist', async () => {
        mockDeleteFile.mockRejectedValueOnce(new Error('Not found'));
        await expect(deleteLargeData('nonexistent')).resolves.toBeUndefined();
    });
});
