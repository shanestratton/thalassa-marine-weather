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

import {
    saveLargeData,
    saveLargeDataImmediate,
    loadLargeData,
    deleteLargeData,
    readCacheVersion,
    writeCacheVersion,
    DATA_CACHE_KEY,
    VOYAGE_CACHE_KEY,
} from '../services/nativeStorage';

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
            }),
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

describe('saveLargeDataImmediate', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useRealTimers();
    });

    it('writes immediately without debounce', async () => {
        await saveLargeDataImmediate('urgent_key', { temp: 28 });

        expect(mockWriteFile).toHaveBeenCalledTimes(1);
        expect(mockWriteFile).toHaveBeenCalledWith(
            expect.objectContaining({
                path: 'urgent_key.json',
                data: JSON.stringify({ temp: 28 }),
            }),
        );
    });

    it('cancels any pending debounced write for the same key', async () => {
        vi.useFakeTimers();

        // Start a debounced write
        saveLargeData('same_key', { old: true });
        expect(mockWriteFile).not.toHaveBeenCalled();

        // Immediate write should cancel the debounced one and write now
        vi.useRealTimers();
        await saveLargeDataImmediate('same_key', { new: true });

        expect(mockWriteFile).toHaveBeenCalledTimes(1);
        expect(mockWriteFile).toHaveBeenCalledWith(
            expect.objectContaining({
                data: JSON.stringify({ new: true }),
            }),
        );
    });

    it('falls back to localStorage when Filesystem fails', async () => {
        mockWriteFile.mockRejectedValueOnce(new Error('Not native'));
        localStorage.clear();

        await saveLargeDataImmediate('web_key', { browser: true });

        expect(localStorage.getItem('web_key')).toBe(JSON.stringify({ browser: true }));
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

        // NOTE: localStorage is intentionally NOT removed after migration
        // because in browser environments Capacitor Filesystem is unavailable
        // and localStorage IS the persistence layer.
        expect(localStorage.getItem('legacy_key')).not.toBeNull();
    });

    it('rejects corrupted future data (poison pill)', async () => {
        const corrupted = {
            hourly: [{ time: '2030-01-01T00:00:00Z' }],
        };
        mockReaddir.mockResolvedValue({ files: [{ name: 'poison.json' }] });
        mockReadFile.mockResolvedValue({ data: JSON.stringify(corrupted) });

        const result = await loadLargeData('poison');
        expect(result).toBeNull();
    });
});

describe('readCacheVersion / writeCacheVersion', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useRealTimers();
        localStorage.clear();
    });

    it('reads version from filesystem when file exists', async () => {
        mockReaddir.mockResolvedValue({ files: [{ name: 'thalassa_cache_version.txt' }] });
        mockReadFile.mockResolvedValue({ data: 'v19.2-WEATHERKIT-FIX' });

        const ver = await readCacheVersion();
        expect(ver).toBe('v19.2-WEATHERKIT-FIX');
    });

    it('returns null when no version file and no localStorage', async () => {
        mockReaddir.mockResolvedValue({ files: [] });

        const ver = await readCacheVersion();
        expect(ver).toBeNull();
    });

    it('migrates version from localStorage to filesystem on first read', async () => {
        mockReaddir.mockResolvedValue({ files: [] });
        localStorage.setItem('thalassa_cache_version', 'v18-OLD');

        const ver = await readCacheVersion();
        expect(ver).toBe('v18-OLD');
        // Should have written to filesystem
        expect(mockWriteFile).toHaveBeenCalledWith(
            expect.objectContaining({
                path: 'thalassa_cache_version.txt',
                data: 'v18-OLD',
            }),
        );
    });

    it('falls back to localStorage when readdir fails (web)', async () => {
        mockReaddir.mockRejectedValue(new Error('Not native'));
        localStorage.setItem('thalassa_cache_version', 'v19-WEB');

        const ver = await readCacheVersion();
        expect(ver).toBe('v19-WEB');
    });

    it('writeCacheVersion writes to both filesystem and localStorage', async () => {
        await writeCacheVersion('v20-NEW');

        expect(mockWriteFile).toHaveBeenCalledWith(
            expect.objectContaining({
                path: 'thalassa_cache_version.txt',
                data: 'v20-NEW',
            }),
        );
        expect(localStorage.getItem('thalassa_cache_version')).toBe('v20-NEW');
    });
});

describe('deleteLargeData', () => {
    beforeEach(() => vi.clearAllMocks());

    it('calls Filesystem.deleteFile with correct path', async () => {
        await deleteLargeData('old_data');
        expect(mockDeleteFile).toHaveBeenCalledWith(expect.objectContaining({ path: 'old_data.json' }));
    });

    it('does not throw if file does not exist', async () => {
        mockDeleteFile.mockRejectedValueOnce(new Error('Not found'));
        await expect(deleteLargeData('nonexistent')).resolves.toBeUndefined();
    });
});
