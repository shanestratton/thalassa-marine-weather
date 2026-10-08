/**
 * The debug AIS injector (services/debug/aisInjector.ts, build 125, 125-01)
 * must never ship in a release build.
 *
 * It compiles only when the build runs with THALASSA_DEBUG_AIS_INJECTOR=1
 * (vite.config.ts defines __THALASSA_DEBUG_AIS_INJECTOR__ from it, and
 * components/settings/debugAisInjectorGate.ts is the only way in). This is
 * the second lock: vite.config.ts's releaseDebugAisInjectorFence fails the
 * build if the injector's marker is in any chunk while the flag is off.
 */

/** A string the injector keeps in its shipped code (a console.warn). */
export const DEBUG_AIS_INJECTOR_MARKER = 'thalassa-debug-ais-injector';
export const DEBUG_AIS_INJECTOR_ENV = 'THALASSA_DEBUG_AIS_INJECTOR';

/**
 * @param {{ fileName: string, code: string }[]} chunks
 * @param {boolean} enabled the build's THALASSA_DEBUG_AIS_INJECTOR=1
 * @returns {string | null} the build error, or null
 */
export function debugAisInjectorFenceError(chunks, enabled) {
    if (enabled) return null;
    const carriers = chunks
        .filter((chunk) => typeof chunk.code === 'string' && chunk.code.includes(DEBUG_AIS_INJECTOR_MARKER))
        .map((chunk) => chunk.fileName);
    if (carriers.length === 0) return null;
    return (
        `The debug AIS injector reached a release build (${carriers.join(', ')}). ` +
        `It may compile only with ${DEBUG_AIS_INJECTOR_ENV}=1, through components/settings/debugAisInjectorGate.ts.`
    );
}

/**
 * The files under `dir` (recursively, .js only) that carry the injector's
 * marker. For the iOS copy of the web build (ios/App/App/public): an Xcode
 * archive does not rebuild the JavaScript, so a smoke build synced there
 * would ship in the next archive unless something looks.
 *
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
export async function filesCarryingDebugAisInjector(dir) {
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const found = [];
    async function walk(at) {
        let entries;
        try {
            entries = await readdir(at, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const path = join(at, entry.name);
            if (entry.isDirectory()) await walk(path);
            else if (entry.name.endsWith('.js') && (await readFile(path, 'utf8')).includes(DEBUG_AIS_INJECTOR_MARKER)) {
                found.push(path);
            }
        }
    }
    await walk(dir);
    return found;
}

/**
 * `node scripts/debug-ais-injector-fence.mjs [dir]`: fail (exit 1) when the
 * injector is in the iOS web copy (default ios/App/App/public). Run it before
 * any archive or upload; a smoke build is the only time it may pass with the
 * marker present, and then only with THALASSA_DEBUG_AIS_INJECTOR=1 set.
 */
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
    void (async () => {
        const dir = process.argv[2] ?? 'ios/App/App/public';
        const carriers = await filesCarryingDebugAisInjector(dir);
        if (carriers.length === 0) {
            console.log(`No debug AIS injector in ${dir}.`);
        } else if (process.env[DEBUG_AIS_INJECTOR_ENV] === '1') {
            console.warn(`The debug AIS injector is in ${dir} (smoke build): never archive or upload this.`);
        } else {
            console.error(
                `The debug AIS injector is in ${dir} (${carriers.join(', ')}). Rebuild without ${DEBUG_AIS_INJECTOR_ENV} and sync before archiving.`,
            );
            process.exit(1);
        }
    })();
}
