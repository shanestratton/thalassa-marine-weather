/**
 * ENC Chart Auto-Decrypt Watcher
 *
 * Watches the user's o-charts download directory (typically `~/Charts/`) and
 * fires `decryptBatch` whenever new `.oesu` files appear. Closes the
 * "wanker-proof" loop:
 *
 *   buy chart on o-charts.org
 *     → OpenCPN downloads .oesu files to ~/Charts/oeuSENC-XX/
 *     → THIS WATCHER fires decryptBatch on the new files
 *     → decryptBatch writes to /opt/thalassa-pi-cache/enc-charts/
 *     → pi-cache /api/enc/installed exposes the new cells
 *     → iOS auto-sync on next app launch pulls them
 *     → cells render, router uses them
 *
 * Zero user taps from chart purchase to in-app routing.
 *
 * Design notes:
 *   - chokidar handles the cross-platform fs-watch quirks; on Linux it sits on
 *     inotify, which is reliable for our single-directory recursive watch.
 *   - 30-second debounce after the last fs activity — OpenCPN drops many files
 *     in quick succession during a chart-set download, no point firing
 *     decryptBatch per-file.
 *   - --skip-existing on decryptBatch means already-decrypted cells aren't
 *     re-run; only the actually-new ones get processed.
 *   - Spawned as a child process so a misbehaving decrypt run can't crash the
 *     main Express server. stdout/stderr piped to the pi-cache journal.
 *
 * Env config:
 *   ENC_WATCH_DIR             — root chart dir to watch (default: $HOME/Charts)
 *   ENC_EXTRACTOR_DIR         — path to senc-extractor (default: $HOME/thalassa-marine-weather/tools/senc-extractor)
 *   ENC_CHART_DIR             — pi-cache chart store (default: ./enc-charts)
 *   ENC_WATCHER_DEBOUNCE_MS   — debounce window after last fs event (default: 30000)
 *   ENC_WATCHER_ENABLED       — set to 'false' to disable entirely (default: enabled)
 *   ENC_DEFAULT_SOURCE_HO     — hydrographic-office code to tag cells with (default: AU)
 */

import { spawn } from 'node:child_process';
import { existsSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';

const HOME = homedir();

const WATCH_DIR = process.env.ENC_WATCH_DIR || join(HOME, 'Charts');
const EXTRACTOR_DIR = process.env.ENC_EXTRACTOR_DIR || join(HOME, 'thalassa-marine-weather', 'tools', 'senc-extractor');
const CHART_STORE_DIR = process.env.ENC_CHART_DIR || './enc-charts';
const DEBOUNCE_MS = parseInt(process.env.ENC_WATCHER_DEBOUNCE_MS || '30000', 10);
const ENABLED = process.env.ENC_WATCHER_ENABLED !== 'false';
const DEFAULT_SOURCE_HO = process.env.ENC_DEFAULT_SOURCE_HO || 'AU';

let watcher: FSWatcher | null = null;
let pendingTimer: NodeJS.Timeout | null = null;
const pendingChartSets = new Set<string>();
let currentDecryptRun: { chartSet: string; promise: Promise<void> } | null = null;

/**
 * Start watching for new .oesu files. Idempotent — calling twice is a no-op.
 */
export function startEncWatcher(): void {
    if (!ENABLED) {
        console.log('[encWatcher] disabled via ENC_WATCHER_ENABLED=false');
        return;
    }
    if (watcher) {
        console.log('[encWatcher] already running');
        return;
    }
    if (!existsSync(WATCH_DIR)) {
        console.log(`[encWatcher] watch dir does not exist yet: ${WATCH_DIR} — will start watching anyway`);
    }
    if (!existsSync(EXTRACTOR_DIR)) {
        console.warn(
            `[encWatcher] extractor dir not found: ${EXTRACTOR_DIR} — set ENC_EXTRACTOR_DIR to override. Watcher will start but decrypts will fail.`,
        );
    }

    console.log(`[encWatcher] watching ${WATCH_DIR} for new .oesu files (debounce=${DEBOUNCE_MS}ms)`);

    watcher = chokidar.watch(WATCH_DIR, {
        // Match the .oesu chart files; ignore everything else.
        // Future: also watch for .oernc / .oesenc legacy formats.
        ignored: (p: string, stats?: Stats) => {
            if (!stats) return false; // allow directories through so we can recurse
            if (stats.isDirectory()) return false;
            return !p.toLowerCase().endsWith('.oesu');
        },
        persistent: true,
        ignoreInitial: true, // don't fire for files already on disk at startup
        depth: 3, // ~/Charts/oeuSENC-AU/file.oesu — depth 3 is plenty
        awaitWriteFinish: {
            stabilityThreshold: 2000,
            pollInterval: 200,
        },
    });

    watcher.on('add', (filePath) => {
        const chartSet = dirname(filePath);
        console.log(`[encWatcher] new chart file: ${basename(filePath)} in ${chartSet}`);
        pendingChartSets.add(chartSet);
        scheduleDecrypt();
    });

    watcher.on('error', (err) => {
        console.warn(`[encWatcher] error:`, err);
    });
}

/**
 * Stop watching. Used for clean shutdown — pi-cache calls this on SIGTERM.
 * In-flight decrypts are NOT aborted (they're short and harmless to let finish).
 */
export async function stopEncWatcher(): Promise<void> {
    if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
    }
    if (watcher) {
        await watcher.close();
        watcher = null;
        console.log('[encWatcher] stopped');
    }
}

function scheduleDecrypt(): void {
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
        pendingTimer = null;
        void drainPending();
    }, DEBOUNCE_MS);
}

async function drainPending(): Promise<void> {
    const sets = [...pendingChartSets];
    pendingChartSets.clear();
    for (const chartSet of sets) {
        try {
            await runDecryptForChartSet(chartSet);
        } catch (err) {
            console.warn(`[encWatcher] decrypt failed for ${chartSet}:`, err);
        }
    }
}

/**
 * Spawn the senc-extractor's decryptBatch CLI for one chart-set directory.
 * Uses --skip-existing so already-decrypted cells are no-ops; only fresh
 * downloads get processed.
 */
function runDecryptForChartSet(chartSet: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const args = [
            'tsx',
            join(EXTRACTOR_DIR, 'src', 'decryptBatch.ts'),
            '--charts',
            chartSet,
            '--source-ho',
            DEFAULT_SOURCE_HO,
            '--pi-cache-store',
            CHART_STORE_DIR,
            '--skip-existing',
        ];

        console.log(`[encWatcher] spawning decryptBatch for ${chartSet}`);
        const t0 = Date.now();

        const child = spawn('npx', args, {
            cwd: EXTRACTOR_DIR,
            env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let lastLine = '';
        const captureLine = (chunk: Buffer): void => {
            const text = chunk.toString();
            for (const line of text.split('\n')) {
                if (!line.trim()) continue;
                lastLine = line;
                // Pi-cache journal is verbose enough already — emit only the
                // summary lines, not every per-cell log.
                if (line.startsWith('Done.') || line.includes('Wrote pi-cache') || line.includes('IMPORTED')) {
                    console.log(`[encWatcher:decrypt] ${line}`);
                }
            }
        };
        child.stdout.on('data', captureLine);
        child.stderr.on('data', (chunk) => console.warn(`[encWatcher:decrypt] stderr: ${chunk.toString().trim()}`));

        child.on('exit', (code) => {
            const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
            if (code === 0) {
                console.log(`[encWatcher] decryptBatch finished in ${elapsed}s — ${lastLine}`);
                resolve();
            } else {
                console.warn(`[encWatcher] decryptBatch exited code=${code} after ${elapsed}s`);
                reject(new Error(`decryptBatch exit ${code}`));
            }
        });

        child.on('error', (err) => {
            console.warn(`[encWatcher] failed to spawn decryptBatch:`, err);
            reject(err);
        });

        currentDecryptRun = {
            chartSet,
            promise: new Promise<void>((res) => child.on('exit', () => res())),
        };
    });
}

/** Diagnostic — what's the watcher doing right now? Used by the /api/enc/health endpoint. */
export function getWatcherStatus(): {
    enabled: boolean;
    watching: boolean;
    watchDir: string;
    extractorDir: string;
    pendingSets: string[];
    currentDecrypt: string | null;
} {
    return {
        enabled: ENABLED,
        watching: watcher !== null,
        watchDir: WATCH_DIR,
        extractorDir: EXTRACTOR_DIR,
        pendingSets: [...pendingChartSets],
        currentDecrypt: currentDecryptRun?.chartSet ?? null,
    };
}
