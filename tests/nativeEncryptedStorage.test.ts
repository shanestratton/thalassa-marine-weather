import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const encrypted = new Map<string, string>();
    return {
        platform: 'ios',
        encrypted,
        get: vi.fn(async ({ key }: { key: string }) => ({ value: encrypted.get(key) ?? null })),
        set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
            encrypted.set(key, value);
        }),
        remove: vi.fn(async ({ key }: { key: string }) => {
            encrypted.delete(key);
        }),
        filesystemWrite: vi.fn(async () => {
            throw new Error('iOS encrypted storage must not use Capacitor Filesystem');
        }),
    };
});

vi.mock('@capacitor/core', () => ({
    Capacitor: { getPlatform: () => mocks.platform },
    registerPlugin: () => ({ get: mocks.get, set: mocks.set, remove: mocks.remove }),
}));

vi.mock('@capacitor/filesystem', () => ({
    Filesystem: {
        writeFile: mocks.filesystemWrite,
        readFile: vi.fn(),
        deleteFile: vi.fn(),
        readdir: vi.fn(),
    },
    Directory: { Documents: 'DOCUMENTS' },
    Encoding: { UTF8: 'utf8' },
}));

import {
    DATA_CACHE_KEY,
    isAllowedEncryptedLargeStorageKey,
    loadLargeData,
    loadLargeDataSync,
    saveLargeData,
    saveLargeDataImmediate,
} from '../services/nativeStorage';

function fileToken(value: string): string {
    return Array.from(value, (character) => character.codePointAt(0)!.toString(16)).join('-');
}

describe('native encrypted large storage', () => {
    beforeEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
        mocks.platform = 'ios';
        mocks.encrypted.clear();
        localStorage.clear();
        mocks.get.mockImplementation(async ({ key }: { key: string }) => ({ value: mocks.encrypted.get(key) ?? null }));
        mocks.set.mockImplementation(async ({ key, value }: { key: string; value: string }) => {
            mocks.encrypted.set(key, value);
        });
        mocks.remove.mockImplementation(async ({ key }: { key: string }) => {
            mocks.encrypted.delete(key);
        });
    });

    it('accepts only reviewed exact, scoped, and voyage-track key families', () => {
        const account = 'e5433b33-810c-41aa-91fa-e28473329bc8';
        const scope = `user:${account}`;
        const track = `thalassa_track_v3_${fileToken(scope)}_${fileToken('voyage-one')}`;

        expect(isAllowedEncryptedLargeStorageKey(DATA_CACHE_KEY)).toBe(true);
        expect(isAllowedEncryptedLargeStorageKey(`${DATA_CACHE_KEY}::anonymous`)).toBe(true);
        expect(isAllowedEncryptedLargeStorageKey(`${DATA_CACHE_KEY}::${encodeURIComponent(scope)}`)).toBe(true);
        expect(isAllowedEncryptedLargeStorageKey(track)).toBe(true);
        expect(isAllowedEncryptedLargeStorageKey(`${DATA_CACHE_KEY}::user%3Anot-a-uuid`)).toBe(false);
        expect(isAllowedEncryptedLargeStorageKey('thalassa_settings')).toBe(false);
        expect(isAllowedEncryptedLargeStorageKey('thalassa_track_v3_../../private')).toBe(false);
    });

    it('writes and verifies ciphertext through the native plugin without iOS plaintext mirrors', async () => {
        localStorage.setItem(DATA_CACHE_KEY, JSON.stringify({ legacy: true }));

        await saveLargeDataImmediate(DATA_CACHE_KEY, { wind: 18 });

        expect(mocks.set).toHaveBeenCalledWith({ key: DATA_CACHE_KEY, value: JSON.stringify({ wind: 18 }) });
        expect(mocks.get).toHaveBeenCalledWith({ key: DATA_CACHE_KEY });
        expect(mocks.filesystemWrite).not.toHaveBeenCalled();
        expect(localStorage.getItem(DATA_CACHE_KEY)).toBeNull();
    });

    it('migrates localStorage only after native encrypted write/readback and then strictly deletes it', async () => {
        localStorage.setItem(DATA_CACHE_KEY, JSON.stringify({ migrated: true }));

        await expect(loadLargeData(DATA_CACHE_KEY)).resolves.toEqual({ migrated: true });

        expect(mocks.set).toHaveBeenCalledTimes(1);
        expect(mocks.encrypted.get(DATA_CACHE_KEY)).toBe(JSON.stringify({ migrated: true }));
        expect(localStorage.getItem(DATA_CACHE_KEY)).toBeNull();
        expect(mocks.filesystemWrite).not.toHaveBeenCalled();
    });

    it('fails closed on synchronous iOS reads while purging the old plaintext mirror', () => {
        localStorage.setItem(DATA_CACHE_KEY, JSON.stringify({ preciseLocation: [-17.7, 168.3] }));

        expect(loadLargeDataSync(DATA_CACHE_KEY)).toBeNull();
        expect(localStorage.getItem(DATA_CACHE_KEY)).toBeNull();
    });

    it('settles every superseded debounce promise and persists only the latest value', async () => {
        vi.useFakeTimers();
        const first = saveLargeData(DATA_CACHE_KEY, { sequence: 1 });
        const second = saveLargeData(DATA_CACHE_KEY, { sequence: 2 });

        await vi.advanceTimersByTimeAsync(1_100);
        await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
        expect(mocks.set).toHaveBeenCalledTimes(1);
        expect(mocks.encrypted.get(DATA_CACHE_KEY)).toBe(JSON.stringify({ sequence: 2 }));
    });

    it('rejects an unverified native write and removes the unusable encrypted record', async () => {
        mocks.get.mockResolvedValue({ value: null });

        await expect(saveLargeDataImmediate(DATA_CACHE_KEY, { unsafe: true })).rejects.toThrow(
            'write verification failed',
        );
        expect(mocks.remove).toHaveBeenCalledWith({ key: DATA_CACHE_KEY });
        expect(localStorage.getItem(DATA_CACHE_KEY)).toBeNull();
    });

    it('does not fall back to plaintext when an encrypted native read is rejected', async () => {
        localStorage.setItem(DATA_CACHE_KEY, JSON.stringify({ mustNotLeak: true }));
        mocks.get.mockRejectedValueOnce(new Error('authentication failed'));

        await expect(loadLargeData(DATA_CACHE_KEY)).resolves.toBeNull();
        expect(mocks.set).not.toHaveBeenCalled();
        expect(localStorage.getItem(DATA_CACHE_KEY)).toBeNull();
    });
});
