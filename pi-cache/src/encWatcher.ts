/**
 * The ~/Charts watcher, retired by Pi update 3 (127-C-d decision 11).
 *
 * It used to watch OpenCPN's o-charts downloads and spawn the extractor
 * (decryptBatch), which wrote every decrypted cell into the chart store as a
 * file: the unencrypted copy the o-charts licences forbid. Since Pi update 3
 * the chart vault (src/vault, its own process) reads ~/Charts itself and
 * opens the cells in its own memory, so this module decrypts nothing, spawns
 * nothing and watches nothing, whatever ENC_WATCHER_ENABLED says (calypso has
 * it false). A set dropped into ~/Charts opens at the vault's next rescan: an
 * install through the app, or `systemctl restart thalassa-chart-vault`.
 *
 * The exports stay, so server.ts and /api/enc/health keep their shape.
 */
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const HOME = homedir();
let told = false;

/** Resolves at once: there is no startup reconcile any more. */
export function whenInitialReconcileSettled(): Promise<void> {
    return Promise.resolve();
}

/** Says once that o-charts sets open in the vault, and starts nothing. */
export function startEncWatcher(): void {
    if (told) return;
    told = true;
    console.log(
        '[encWatcher] o-charts sets open in the chart vault’s memory (Pi update 3); nothing is decrypted to disk and nothing is watched here',
    );
}

export async function stopEncWatcher(): Promise<void> {
    // Nothing runs.
}

/** Key-only updates and verified provenance changes count as o-charts inputs (the vault reads them). */
export function isOChartsInput(filePath: string): boolean {
    const file = basename(filePath);
    return (
        /\.oesu$/i.test(file) || /^oeuSENC-.*-sgl[0-9A-F]+\.xml$/i.test(file) || file === 'thalassa-chart-source.json'
    );
}

/** Diagnostic, for /api/enc/health. */
export function getWatcherStatus(): {
    enabled: boolean;
    watching: boolean;
    mode: 'vault';
    watchDir: string;
    chartStoreDir: string;
    pendingSets: string[];
    currentDecrypt: string | null;
    lastDecryptResult: null;
} {
    return {
        enabled: process.env.ENC_WATCHER_ENABLED === 'true',
        watching: false,
        mode: 'vault',
        watchDir: process.env.ENC_WATCH_DIR || join(HOME, 'Charts'),
        chartStoreDir: resolve(process.env.ENC_CHART_DIR || './enc-charts'),
        pendingSets: [],
        currentDecrypt: null,
        lastDecryptResult: null,
    };
}
