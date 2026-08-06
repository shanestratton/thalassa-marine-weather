import { Capacitor, registerPlugin } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';

import { createLogger } from '../utils/createLogger';

const log = createLogger('nativeStorage');

export const DATA_CACHE_KEY = 'thalassa_weather_cache_v9';
export const VOYAGE_CACHE_KEY = 'thalassa_voyage_cache_v2';
export const HISTORY_CACHE_KEY = 'thalassa_history_cache_v3';

const CACHE_VERSION_STORAGE_KEY = 'thalassa_cache_version';
const VERSION_FILE_NAME = 'thalassa_cache_version.txt';
const SMART_POLAR_STORAGE_KEY = 'thalassa_smart_polars_v1';
const SATLINK_STATE_STORAGE_KEY = 'thalassa_grib_download_state';
const WEATHER_SCHEMA_STORAGE_KEY = 'thalassa_weather_cache_schema';
const NEXT_UPDATE_STORAGE_KEY = 'thalassa_next_update';
const TRACK_STORAGE_PREFIX = 'thalassa_track_v3_';
const MAX_LOGICAL_KEY_BYTES = 4096;

const exactEncryptedKeys = new Set([
    DATA_CACHE_KEY,
    VOYAGE_CACHE_KEY,
    HISTORY_CACHE_KEY,
    WEATHER_SCHEMA_STORAGE_KEY,
    NEXT_UPDATE_STORAGE_KEY,
    CACHE_VERSION_STORAGE_KEY,
    SMART_POLAR_STORAGE_KEY,
    SATLINK_STATE_STORAGE_KEY,
]);
const scopedEncryptedBaseKeys = [
    DATA_CACHE_KEY,
    VOYAGE_CACHE_KEY,
    HISTORY_CACHE_KEY,
    WEATHER_SCHEMA_STORAGE_KEY,
    NEXT_UPDATE_STORAGE_KEY,
] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface EncryptedLargeStoragePlugin {
    get(options: { key: string }): Promise<{ value: string | null }>;
    set(options: { key: string; value: string }): Promise<void>;
    remove(options: { key: string }): Promise<void>;
}

const NativeEncryptedLargeStorage = registerPlugin<EncryptedLargeStoragePlugin>('EncryptedLargeStorage');

function usesNativeEncryptedLargeStorage(): boolean {
    return Capacitor.getPlatform() === 'ios';
}

function isAllowedIdentityScope(value: string): boolean {
    return value === 'anonymous' || (value.startsWith('user:') && UUID_PATTERN.test(value.slice(5)));
}

function containsControlCharacter(value: string): boolean {
    return Array.from(value).some((character) => {
        const codePoint = character.codePointAt(0)!;
        return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    });
}

function decodeFileToken(token: string): string | null {
    if (!token || token.length > 2048) return null;
    const codePoints: number[] = [];
    for (const component of token.split('-')) {
        if (!/^[0-9a-f]{1,6}$/i.test(component)) return null;
        const codePoint = Number.parseInt(component, 16);
        if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return null;
        codePoints.push(codePoint);
    }
    try {
        return String.fromCodePoint(...codePoints);
    } catch {
        return null;
    }
}

/** The exact logical-key boundary mirrored by EncryptedLargeStoragePlugin.swift. */
export function isAllowedEncryptedLargeStorageKey(key: string): boolean {
    if (!key || new TextEncoder().encode(key).byteLength > MAX_LOGICAL_KEY_BYTES || containsControlCharacter(key)) {
        return false;
    }
    if (exactEncryptedKeys.has(key)) return true;
    for (const base of scopedEncryptedBaseKeys) {
        const prefix = `${base}::`;
        if (!key.startsWith(prefix)) continue;
        try {
            return isAllowedIdentityScope(decodeURIComponent(key.slice(prefix.length)));
        } catch {
            return false;
        }
    }
    if (!key.startsWith(TRACK_STORAGE_PREFIX)) return false;
    const remainder = key.slice(TRACK_STORAGE_PREFIX.length);
    const separator = remainder.indexOf('_');
    if (separator <= 0 || separator === remainder.length - 1) return false;
    const scope = decodeFileToken(remainder.slice(0, separator));
    const voyageID = decodeFileToken(remainder.slice(separator + 1));
    return (
        scope !== null &&
        voyageID !== null &&
        isAllowedIdentityScope(scope) &&
        voyageID.length > 0 &&
        new TextEncoder().encode(voyageID).byteLength <= 256 &&
        !containsControlCharacter(voyageID)
    );
}

function assertEncryptedKeyAllowed(key: string): void {
    if (!isAllowedEncryptedLargeStorageKey(key)) {
        throw new Error('Encrypted large-storage key is not allowed');
    }
}

function serialize(data: unknown): string {
    const value = JSON.stringify(data);
    if (typeof value !== 'string') throw new TypeError('Large-storage value is not JSON serializable');
    return value;
}

function scrubLegacyLocalStorage(key: string): void {
    localStorage.removeItem(key);
    if (localStorage.getItem(key) !== null) {
        throw new Error(`Could not clear legacy plaintext storage for ${key}`);
    }
}

async function writeEncryptedString(key: string, value: string): Promise<void> {
    assertEncryptedKeyAllowed(key);
    try {
        await NativeEncryptedLargeStorage.set({ key, value });
    } catch (error) {
        scrubLegacyLocalStorage(key);
        throw error;
    }
    const verified = await NativeEncryptedLargeStorage.get({ key });
    if (verified.value !== value) {
        await NativeEncryptedLargeStorage.remove({ key }).catch(() => undefined);
        scrubLegacyLocalStorage(key);
        throw new Error('Encrypted large-storage write verification failed');
    }
    try {
        scrubLegacyLocalStorage(key);
    } catch (error) {
        await NativeEncryptedLargeStorage.remove({ key }).catch(() => undefined);
        throw error;
    }
}

async function readEncryptedString(key: string): Promise<string | null> {
    assertEncryptedKeyAllowed(key);
    let encrypted: { value: string | null };
    try {
        encrypted = await NativeEncryptedLargeStorage.get({ key });
    } catch (error) {
        scrubLegacyLocalStorage(key);
        throw error;
    }
    if (encrypted.value !== null) {
        try {
            scrubLegacyLocalStorage(key);
        } catch (error) {
            await NativeEncryptedLargeStorage.remove({ key }).catch(() => undefined);
            throw error;
        }
        return encrypted.value;
    }

    // One-time WKWebView localStorage migration. Native Documents migration is
    // performed inside the plugin before it reports a miss. We return legacy
    // data only after encrypted write/readback and strict plaintext deletion.
    const legacy = localStorage.getItem(key);
    if (legacy === null) return null;
    await writeEncryptedString(key, legacy);
    return legacy;
}

async function removeEncryptedString(key: string): Promise<void> {
    assertEncryptedKeyAllowed(key);
    let nativeError: unknown;
    try {
        await NativeEncryptedLargeStorage.remove({ key });
    } catch (error) {
        nativeError = error;
    }
    scrubLegacyLocalStorage(key);
    if (nativeError) throw nativeError;
}

interface PendingSave {
    data: unknown;
    timer: ReturnType<typeof setTimeout>;
    waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
}

const pendingSaves = new Map<string, PendingSave>();
const writeTails = new Map<string, Promise<void>>();

function queueWrite(key: string, operation: () => Promise<void>): Promise<void> {
    const previous = writeTails.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(
        () => undefined,
        () => undefined,
    );
    writeTails.set(key, settled);
    void settled.then(() => {
        if (writeTails.get(key) === settled) writeTails.delete(key);
    });
    return result;
}

function settlePending(pending: PendingSave, result: Promise<void>): void {
    void result.then(
        () => pending.waiters.forEach(({ resolve }) => resolve()),
        (error) => pending.waiters.forEach(({ reject }) => reject(error)),
    );
}

function takePendingSave(key: string): PendingSave | null {
    const pending = pendingSaves.get(key);
    if (!pending) return null;
    clearTimeout(pending.timer);
    pendingSaves.delete(key);
    return pending;
}

async function persistSerialized(key: string, jsonString: string, immediate: boolean): Promise<void> {
    if (usesNativeEncryptedLargeStorage()) {
        await writeEncryptedString(key, jsonString);
        return;
    }

    if (immediate) {
        try {
            localStorage.setItem(key, jsonString);
        } catch {
            // Quota exhaustion is non-fatal when the filesystem write succeeds.
        }
    }

    try {
        await Filesystem.writeFile({
            path: `${key}.json`,
            data: jsonString,
            directory: Directory.Documents,
            encoding: Encoding.UTF8,
        });
        invalidateDirCache();
    } catch (error) {
        if (immediate) return;
        try {
            localStorage.setItem(key, jsonString);
        } catch (fallbackError) {
            log.warn('[nativeStorage] quota exceeded — ignore:', fallbackError ?? error);
        }
    }
}

function runPendingSave(key: string, expected: PendingSave): Promise<void> {
    if (pendingSaves.get(key) !== expected) return Promise.resolve();
    pendingSaves.delete(key);
    const result = queueWrite(key, () => persistSerialized(key, serialize(expected.data), false));
    settlePending(expected, result);
    return result;
}

// --- HELPER: SAVE FILE (Debounced) ---
export const saveLargeData = (key: string, data: unknown): Promise<void> =>
    new Promise<void>((resolve, reject) => {
        const existing = pendingSaves.get(key);
        if (existing) {
            clearTimeout(existing.timer);
            existing.data = data;
            existing.waiters.push({ resolve, reject });
            existing.timer = setTimeout(() => void runPendingSave(key, existing), 1000);
            return;
        }

        const pending: PendingSave = {
            data,
            timer: setTimeout(() => void runPendingSave(key, pending), 1000),
            waiters: [{ resolve, reject }],
        };
        pendingSaves.set(key, pending);
    });

// --- HELPER: SYNC READ (web/non-iOS localStorage only) ---
export const loadLargeDataSync = (key: string): unknown | null => {
    if (usesNativeEncryptedLargeStorage()) {
        // Native AES-GCM I/O is necessarily asynchronous. Never surface the
        // old plaintext startup mirror on iOS; scrub it and fail closed.
        try {
            scrubLegacyLocalStorage(key);
        } catch (error) {
            log.warn('[nativeStorage] could not scrub legacy synchronous cache:', error);
        }
        return null;
    }
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch {
        return null;
    }
};

// --- HELPER: SAVE FILE (Immediate, no debounce) ---
export const saveLargeDataImmediate = async (key: string, data: unknown): Promise<void> => {
    const pending = takePendingSave(key);
    const result = queueWrite(key, () => persistSerialized(key, serialize(data), true));
    if (pending) settlePending(pending, result);
    return result;
};

// --- HELPER: FLUSH PENDING SAVES ---
export const flushPendingSaves = async (): Promise<void> => {
    const entries = [...pendingSaves.entries()];
    await Promise.all(
        entries.map(([key, pending]) => {
            clearTimeout(pending.timer);
            return runPendingSave(key, pending);
        }),
    );
};

// --- CACHE VERSION ---
export const readCacheVersion = async (): Promise<string | null> => {
    if (usesNativeEncryptedLargeStorage()) {
        try {
            return await readEncryptedString(CACHE_VERSION_STORAGE_KEY);
        } catch (error) {
            log.warn('[nativeStorage] encrypted cache-version read failed:', error);
            return null;
        }
    }

    try {
        const result = await Filesystem.readdir({ path: '', directory: Directory.Documents });
        const fileFound = result.files.some((file: { name: string } | string) => {
            const name = typeof file === 'string' ? file : file.name;
            return name === VERSION_FILE_NAME;
        });
        if (!fileFound) {
            const legacyVersion = localStorage.getItem(CACHE_VERSION_STORAGE_KEY);
            if (legacyVersion) {
                await writeCacheVersion(legacyVersion);
                return legacyVersion;
            }
            return null;
        }
        const contents = await Filesystem.readFile({
            path: VERSION_FILE_NAME,
            directory: Directory.Documents,
            encoding: Encoding.UTF8,
        });
        return (contents.data as string).trim();
    } catch {
        return localStorage.getItem(CACHE_VERSION_STORAGE_KEY);
    }
};

export const writeCacheVersion = async (version: string): Promise<void> => {
    if (usesNativeEncryptedLargeStorage()) {
        await writeEncryptedString(CACHE_VERSION_STORAGE_KEY, version);
        return;
    }
    try {
        await Filesystem.writeFile({
            path: VERSION_FILE_NAME,
            data: version,
            directory: Directory.Documents,
            encoding: Encoding.UTF8,
        });
    } catch {
        // Filesystem unavailable: localStorage remains the web persistence layer.
    }
    localStorage.setItem(CACHE_VERSION_STORAGE_KEY, version);
};

// --- CACHED DIRECTORY LISTING (non-iOS legacy/web path) ---
let directoryListingCache: { files: Set<string>; fetchedAt: number } | null = null;
const DIRECTORY_LISTING_TTL_MS = 3_000;

async function listDocumentsDir(): Promise<Set<string>> {
    if (directoryListingCache && Date.now() - directoryListingCache.fetchedAt < DIRECTORY_LISTING_TTL_MS) {
        return directoryListingCache.files;
    }
    try {
        const result = await Filesystem.readdir({ path: '', directory: Directory.Documents });
        const files = new Set<string>();
        for (const file of result.files) {
            files.add(typeof file === 'string' ? file : file.name);
        }
        directoryListingCache = { files, fetchedAt: Date.now() };
        return files;
    } catch {
        return new Set<string>();
    }
}

function invalidateDirCache(): void {
    directoryListingCache = null;
}

function containsPoisonedFutureWeather(data: unknown): boolean {
    if (!data || typeof data !== 'object') return false;
    const hourly = (data as { hourly?: unknown }).hourly;
    if (!Array.isArray(hourly) || hourly.length === 0) return false;
    const poisonThreshold = new Date('2028-01-01').getTime();
    return hourly.some(
        (entry) =>
            !!entry &&
            typeof entry === 'object' &&
            typeof (entry as { time?: unknown }).time === 'string' &&
            new Date((entry as { time: string }).time).getTime() > poisonThreshold,
    );
}

// --- HELPER: LOAD FILE (with encrypted iOS / legacy non-iOS migration) ---
export const loadLargeData = async (key: string): Promise<unknown | null> => {
    if (usesNativeEncryptedLargeStorage()) {
        try {
            const raw = await readEncryptedString(key);
            if (raw === null) return null;
            const parsed: unknown = JSON.parse(raw);
            if (containsPoisonedFutureWeather(parsed)) {
                await removeEncryptedString(key);
                return null;
            }
            return parsed;
        } catch (error) {
            try {
                scrubLegacyLocalStorage(key);
            } catch (scrubError) {
                log.warn('[nativeStorage] legacy plaintext scrub failed after native read rejection:', scrubError);
            }
            log.warn('[nativeStorage] encrypted cache read rejected:', error);
            return null;
        }
    }

    const fileName = `${key}.json`;
    const directory = await listDocumentsDir();
    if (directory.has(fileName)) {
        try {
            const contents = await Filesystem.readFile({
                path: fileName,
                directory: Directory.Documents,
                encoding: Encoding.UTF8,
            });
            const parsed: unknown = JSON.parse(contents.data as string);
            return containsPoisonedFutureWeather(parsed) ? null : parsed;
        } catch {
            // Fall through to the web/legacy copy.
        }
    }

    const legacyData = localStorage.getItem(key);
    if (legacyData) {
        try {
            const parsed: unknown = JSON.parse(legacyData);
            await saveLargeData(key, parsed);
            return parsed;
        } catch {
            return null;
        }
    }
    return null;
};

// --- HELPER: DELETE FILE ---
export const deleteLargeData = async (key: string): Promise<void> => {
    const pending = takePendingSave(key);
    const result = queueWrite(key, async () => {
        if (usesNativeEncryptedLargeStorage()) {
            await removeEncryptedString(key);
            return;
        }

        const fileName = `${key}.json`;
        const directory = await listDocumentsDir();
        if (directory.has(fileName)) {
            try {
                await Filesystem.deleteFile({ path: fileName, directory: Directory.Documents });
                invalidateDirCache();
            } catch {
                // Preserve historical best-effort semantics outside iOS.
            }
        }
        localStorage.removeItem(key);
    });
    if (pending) settlePending(pending, result);
    return result;
};
