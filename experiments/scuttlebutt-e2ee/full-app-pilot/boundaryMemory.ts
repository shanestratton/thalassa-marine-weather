/** Isolated volatile storage only. No native/browser storage, encryption,
 * durable recovery, migration or account authority is supplied by this module.
 * Cache operations settle immediately so real provider loading can complete.
 */
export const DATA_CACHE_KEY = 'thalassa_weather_cache_v9';
export const VOYAGE_CACHE_KEY = 'thalassa_voyage_cache_v2';
export const HISTORY_CACHE_KEY = 'thalassa_history_cache_v3';
export const FULL_APP_MEMORY_MAX_ENTRIES = 128;
export const FULL_APP_MEMORY_MAX_VALUE_BYTES = 262_144;
export const FULL_APP_MEMORY_MAX_TOTAL_BYTES = 1_048_576;
export const FULL_APP_MEMORY_COUNTER_LIMIT = 1_024;
const VERSION_KEY = Symbol('isolated-cache-version');

export class FullAppMemoryUnavailableError extends Error {
    readonly code = 'full-app-research-memory-unavailable';
    constructor() {
        super('Full app Research memory storage is unavailable.');
        this.name = 'FullAppMemoryUnavailableError';
    }
}

const initialCounters = () => ({
    preferenceReads: 0,
    preferenceWrites: 0,
    preferenceRemovals: 0,
    preferenceClears: 0,
    preferenceKeys: 0,
    cacheReads: 0,
    cacheWrites: 0,
    cacheRemovals: 0,
    cacheFlushes: 0,
    versionReads: 0,
    versionWrites: 0,
    refusals: 0,
});
export type FullAppMemoryCounters = Readonly<ReturnType<typeof initialCounters>>;

/** Fresh local fixtures/compositions only; never clears another application's storage. */
export function createFullAppMemoryBoundary() {
    const counters = initialCounters();
    const preferences = new Map<string, string>();
    const cache = new Map<string | symbol, string>();
    const encoder = new TextEncoder();
    const count = (key: keyof typeof counters) => {
        counters[key] = Math.min(FULL_APP_MEMORY_COUNTER_LIMIT, counters[key] + 1);
    };
    const refuse = (): never => {
        count('refusals');
        throw new FullAppMemoryUnavailableError();
    };
    const keyValue = (value: unknown): string => {
        if (
            typeof value !== 'string' ||
            value.length < 1 ||
            value.length > 4_096 ||
            Array.from(value).some((character) => {
                const code = character.charCodeAt(0);
                return code <= 0x1f || code === 0x7f;
            })
        )
            return refuse();
        return value;
    };
    const option = (value: unknown, name: 'key' | 'value'): unknown => {
        try {
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FullAppMemoryUnavailableError();
            return Reflect.get(value, name);
        } catch {
            return refuse();
        }
    };
    const bytes = (value: string) => encoder.encode(value).byteLength;
    const put = <K>(store: Map<K, string>, key: K, value: string) => {
        const length = bytes(value);
        if (length > FULL_APP_MEMORY_MAX_VALUE_BYTES) return refuse();
        if (!store.has(key) && store.size >= FULL_APP_MEMORY_MAX_ENTRIES) return refuse();
        let total = length;
        for (const [entryKey, entryValue] of store) {
            if (entryKey !== key) total += bytes(entryValue);
        }
        if (total > FULL_APP_MEMORY_MAX_TOTAL_BYTES) return refuse();
        store.set(key, value);
    };
    const serialize = (value: unknown): string => {
        let serialized: string | undefined;
        try {
            serialized = JSON.stringify(value);
        } catch {
            return refuse();
        }
        return typeof serialized === 'string' ? serialized : refuse();
    };
    const save = (key: unknown, value: unknown) => put(cache, keyValue(key), serialize(value));
    const load = (key: unknown): unknown | null => {
        const value = cache.get(keyValue(key));
        return value === undefined ? null : JSON.parse(value);
    };

    const Preferences = Object.freeze({
        async get(options: { key: string }): Promise<{ value: string | null }> {
            count('preferenceReads');
            return { value: preferences.get(keyValue(option(options, 'key'))) ?? null };
        },
        async set(options: { key: string; value: string }): Promise<void> {
            count('preferenceWrites');
            const key = keyValue(option(options, 'key'));
            const value = option(options, 'value');
            if (typeof value !== 'string') return refuse();
            put(preferences, key, value);
        },
        async remove(options: { key: string }): Promise<void> {
            count('preferenceRemovals');
            preferences.delete(keyValue(option(options, 'key')));
        },
        async clear(): Promise<void> {
            count('preferenceClears');
            preferences.clear();
        },
        async keys(): Promise<{ keys: string[] }> {
            count('preferenceKeys');
            return { keys: [...preferences.keys()] };
        },
        // No native group, migration or previously persisted records exist.
        async configure(..._options: unknown[]): Promise<never> {
            return refuse();
        },
        async migrate(): Promise<never> {
            return refuse();
        },
        async removeOld(): Promise<never> {
            return refuse();
        },
    });
    const nativeStorage = Object.freeze({
        DATA_CACHE_KEY,
        VOYAGE_CACHE_KEY,
        HISTORY_CACHE_KEY,
        usesNativeEncryptedLargeStorage: () => false,
        isAllowedEncryptedLargeStorageKey: (..._key: unknown[]) => false,
        async saveLargeData(key: string, value: unknown): Promise<void> {
            count('cacheWrites');
            save(key, value);
        },
        async saveLargeDataImmediate(key: string, value: unknown): Promise<void> {
            count('cacheWrites');
            save(key, value);
        },
        loadLargeDataSync(key: string): unknown | null {
            count('cacheReads');
            return load(key);
        },
        async loadLargeData(key: string): Promise<unknown | null> {
            count('cacheReads');
            return load(key);
        },
        async deleteLargeData(key: string): Promise<void> {
            count('cacheRemovals');
            cache.delete(keyValue(key));
        },
        async flushPendingSaves(): Promise<void> {
            count('cacheFlushes');
            // Writes above settle immediately; there is no debounce or timer.
        },
        async readCacheVersion(): Promise<string | null> {
            count('versionReads');
            return cache.get(VERSION_KEY) ?? null;
        },
        async writeCacheVersion(version: string): Promise<void> {
            count('versionWrites');
            if (typeof version !== 'string' || version.length === 0) return refuse();
            put(cache, VERSION_KEY, version);
        },
    });
    return Object.freeze({
        Preferences,
        nativeStorage,
        readCounters: (): FullAppMemoryCounters => Object.freeze({ ...counters }),
    });
}

const memory = createFullAppMemoryBoundary();
export const Preferences = memory.Preferences;
export const {
    usesNativeEncryptedLargeStorage,
    isAllowedEncryptedLargeStorageKey,
    saveLargeData,
    saveLargeDataImmediate,
    loadLargeDataSync,
    loadLargeData,
    deleteLargeData,
    flushPendingSaves,
    readCacheVersion,
    writeCacheVersion,
} = memory.nativeStorage;
export const readFullAppMemoryCounters = memory.readCounters;
