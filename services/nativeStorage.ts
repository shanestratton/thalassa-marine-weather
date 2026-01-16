import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';

const DATA_CACHE_KEY = 'thalassa_weather_cache_v6';
const VOYAGE_CACHE_KEY = 'thalassa_voyage_cache_v2';
const HISTORY_CACHE_KEY = 'thalassa_history_cache_v2';

// --- DEBOUNCE TIMERS ---
const saveTimers: Record<string, NodeJS.Timeout> = {};

// --- HELPER: SAVE FILE (Debounced) ---
export const saveLargeData = async (key: string, data: any) => {
    // Clear pending write for this key
    if (saveTimers[key]) {
        clearTimeout(saveTimers[key]);
    }

    // Schedule new write
    return new Promise<void>((resolve) => {
        saveTimers[key] = setTimeout(async () => {
            try {
                const start = Date.now();
                const jsonString = JSON.stringify(data);
                const fileName = `${key}.json`;

                await Filesystem.writeFile({
                    path: fileName,
                    data: jsonString,
                    directory: Directory.Documents,
                    encoding: Encoding.UTF8,
                });

                const sizeKB = (new Blob([jsonString]).size / 1024).toFixed(2);

                resolve();
            } catch (e) {
                console.error(`[Filesystem] Error saving ${key}`, e);
                resolve(); // Resolve anyway to not block
            } finally {
                delete saveTimers[key];
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
        fileFound = result.files.some((f: any) => {
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

            return JSON.parse(contents.data as string);
        } catch (readErr) {
            console.warn(`[Filesystem] Error parsing ${fileName}`, readErr);
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

            // Save to File
            await saveLargeData(key, parsed);

            // CRITICAL: Delete from LocalStorage to free quota (The whole point!)
            localStorage.removeItem(key);


            return parsed;
        } catch (migErr) {
            console.error(`[Filesystem] Migration Failed for ${key}`, migErr);
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
