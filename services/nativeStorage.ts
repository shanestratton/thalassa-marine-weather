import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';

export const DATA_CACHE_KEY = 'thalassa_weather_cache_v9';
export const VOYAGE_CACHE_KEY = 'thalassa_voyage_cache_v2';
export const HISTORY_CACHE_KEY = 'thalassa_history_cache_v3';

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
                } catch (e) { console.warn('[nativeStorage] quota exceeded — ignore:', e); }
            } finally {
                delete saveTimers[key];
                resolve();
            }
        }, 1000); // 1s Debounce
    });
};

// --- HELPER: LOAD FILE (With LocalStorage Migration) ---
export const loadLargeData = async (key: string) => {
    const fileName = `${key}.json`;

    // 1. Check Existence First (Prevent Native "File Not Found" Log)
    let fileFound = false;
    try {
        const result = await Filesystem.readdir({
            path: '',
            directory: Directory.Documents
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
                const hasCorruption = data.hourly.some((h: { time: string }) => new Date(h.time).getTime() > poisonThreshold);

                if (hasCorruption) {
                    return null;
                }
            }

            return data;
        } catch (readErr) {
            // localStorage fallback read failed — return undefined
        }
    }

    // 2. Not Found in Filesystem? Check Legacy Storage...
    // Use warn only if it's NOT just a missing file (which we know it is now)
    // console.log(`[Filesystem] ${key} not in file. Checking Legacy...`);

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
        } catch (migErr) {
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
