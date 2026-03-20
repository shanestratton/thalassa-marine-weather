import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';

import { createLogger } from '../utils/createLogger';

const log = createLogger('nativeStorage');

export const DATA_CACHE_KEY = 'thalassa_weather_cache_v9';
export const VOYAGE_CACHE_KEY = 'thalassa_voyage_cache_v2';
export const HISTORY_CACHE_KEY = 'thalassa_history_cache_v3';

const VERSION_FILE_NAME = 'thalassa_cache_version.txt';

// --- DEBOUNCE TIMERS ---
const saveTimers: Record<string, NodeJS.Timeout> = {};

// --- HELPER: SAVE FILE (Debounced) ---
export const saveLargeData = async (key: string, data: unknown) => {
    // Clear pending write for this key
    if (saveTimers[key]) {
        clearTimeout(saveTimers[key]);
    }

    // Schedule new write
    return new Promise<void>((resolve) => {
        saveTimers[key] = setTimeout(async () => {
            const jsonString = JSON.stringify(data);
            try {
                const fileName = `${key}.json`;

                await Filesystem.writeFile({
                    path: fileName,
                    data: jsonString,
                    directory: Directory.Documents,
                    encoding: Encoding.UTF8,
                });
            } catch (e) {
                // Capacitor Filesystem not available (web browser) — use localStorage fallback
                try {
                    localStorage.setItem(key, jsonString);
                } catch (e) {
                    log.warn('[nativeStorage] quota exceeded — ignore:', e);
                }
            } finally {
                delete saveTimers[key];
                resolve();
            }
        }, 1000); // 1s Debounce
    });
};

// --- HELPER: SYNC READ (localStorage only) ---
// Returns cached data instantly from localStorage. Used for immediate display
// on app boot while the async filesystem read catches up.
// This is the key to eliminating the 2-3s spinner on iOS: Capacitor's
// Filesystem bridge is async (readdir + readFile), but localStorage is synchronous.
export const loadLargeDataSync = (key: string): unknown | null => {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (e) {
        return null;
    }
};

// --- HELPER: SAVE FILE (Immediate, no debounce) ---
// Used for critical data (primary weather cache) that MUST survive app closure.
// On iOS, swiping the app closed kills the JS runtime — pending setTimeouts never fire.
// DUAL-WRITE: Writes to BOTH filesystem (durability) AND localStorage (fast startup).
export const saveLargeDataImmediate = async (key: string, data: unknown): Promise<void> => {
    // Cancel any pending debounced write for this key (we're writing NOW)
    if (saveTimers[key]) {
        clearTimeout(saveTimers[key]);
        delete saveTimers[key];
    }

    const jsonString = JSON.stringify(data);

    // 1. ALWAYS write to localStorage for instant reads on next boot
    try {
        localStorage.setItem(key, jsonString);
    } catch (_lsErr) {
        /* quota exceeded — non-fatal, filesystem is the primary */
    }

    // 2. Write to filesystem for durability (survives iOS localStorage eviction)
    try {
        await Filesystem.writeFile({
            path: `${key}.json`,
            data: jsonString,
            directory: Directory.Documents,
            encoding: Encoding.UTF8,
        });
    } catch (e) {
        // Filesystem unavailable (web) — localStorage already written above
    }
};

// --- HELPER: FLUSH PENDING SAVES ---
// Call on app lifecycle events (pause/close) to ensure debounced writes complete.
export const flushPendingSaves = async (): Promise<void> => {
    const pendingKeys = Object.keys(saveTimers);
    if (pendingKeys.length === 0) return;

    // Note: We can't easily retrieve the pending data from the setTimeout closures.
    // Instead, this function is a safety net — the real fix is saveLargeDataImmediate
    // for critical data. This just logs a warning.
    log.warn(`[nativeStorage] ${pendingKeys.length} pending debounced write(s) on flush:`, pendingKeys);
};

// --- CACHE VERSION: FILESYSTEM-BACKED ---
// Stored in filesystem (not localStorage) to survive iOS localStorage eviction.
// This prevents iOS from nuking valid filesystem caches when localStorage is cleared.
export const readCacheVersion = async (): Promise<string | null> => {
    try {
        // Check if version file exists
        const result = await Filesystem.readdir({
            path: '',
            directory: Directory.Documents,
        });
        const fileFound = result.files.some((f: { name: string } | string) => {
            const name = typeof f === 'string' ? f : f.name;
            return name === VERSION_FILE_NAME;
        });

        if (!fileFound) {
            // Migrate from localStorage if present (one-time)
            const lsVer = localStorage.getItem('thalassa_cache_version');
            if (lsVer) {
                await writeCacheVersion(lsVer);
                return lsVer;
            }
            return null;
        }

        const contents = await Filesystem.readFile({
            path: VERSION_FILE_NAME,
            directory: Directory.Documents,
            encoding: Encoding.UTF8,
        });
        return (contents.data as string).trim();
    } catch (e) {
        // Filesystem unavailable (web) — fall back to localStorage
        return localStorage.getItem('thalassa_cache_version');
    }
};

export const writeCacheVersion = async (version: string): Promise<void> => {
    try {
        await Filesystem.writeFile({
            path: VERSION_FILE_NAME,
            data: version,
            directory: Directory.Documents,
            encoding: Encoding.UTF8,
        });
    } catch (e) {
        // Filesystem unavailable (web) — fall back to localStorage
        // (intentional — web still works via localStorage)
    }
    // Always write to localStorage as well (web compatibility)
    localStorage.setItem('thalassa_cache_version', version);
};

// --- HELPER: LOAD FILE (With LocalStorage Migration) ---
export const loadLargeData = async (key: string) => {
    const fileName = `${key}.json`;

    // 1. Check Existence First (Prevent Native "File Not Found" Log)
    let fileFound = false;
    try {
        const result = await Filesystem.readdir({
            path: '',
            directory: Directory.Documents,
        });
        // Capacitor 6 returns FileInfo[] objects, but handle strings for safety
        fileFound = result.files.some((f: { name: string } | string) => {
            const name = typeof f === 'string' ? f : f.name;
            return name === fileName;
        });
    } catch (e) {
        // If readdir fails, we just proceed to legacy check
    }

    if (fileFound) {
        try {
            const contents = await Filesystem.readFile({
                path: fileName,
                directory: Directory.Documents,
                encoding: Encoding.UTF8,
            });

            const data = JSON.parse(contents.data as string);

            // POISON PILL: Check for Corrupted Future Data (2030 Bug)
            // If we detect data from 2028+, we NUKE this cache hit immediately.
            if (data && data.hourly && Array.isArray(data.hourly) && data.hourly.length > 0) {
                const poisonThreshold = new Date('2028-01-01').getTime();
                const hasCorruption = data.hourly.some(
                    (h: { time: string }) => new Date(h.time).getTime() > poisonThreshold,
                );

                if (hasCorruption) {
                    return null;
                }
            }

            return data;
        } catch (_readErr) {
            // localStorage fallback read failed — return undefined
        }
    }

    // 2. Not Found in Filesystem? Check Legacy Storage...
    // Use warn only if it's NOT just a missing file (which we know it is now)
    // log.info(`[Filesystem] ${key} not in file. Checking Legacy...`);

    const legacyData = localStorage.getItem(key);
    if (legacyData) {
        try {
            // Parse to ensure valid JSON before saving
            const parsed = JSON.parse(legacyData);

            // Save to Filesystem (will fallback to localStorage via saveLargeData)
            await saveLargeData(key, parsed);

            // NOTE: Do NOT delete from localStorage here.
            // In browser environments, Capacitor Filesystem is unavailable,
            // so localStorage IS the persistence layer. Deleting it would
            // cause data loss on the next reload.

            return parsed;
        } catch (_migErr) {
            return null;
        }
    }

    return null;
};

// --- HELPER: DELETE FILE ---
export const deleteLargeData = async (key: string) => {
    try {
        await Filesystem.deleteFile({
            path: `${key}.json`,
            directory: Directory.Documents,
        });
    } catch (e) {
        // Ignore if file doesn't exist
    }
};
