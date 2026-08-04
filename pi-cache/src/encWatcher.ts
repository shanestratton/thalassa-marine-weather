/**
 * ENC Chart Auto-Decrypt Watcher
 *
 * Watches both chart sources the Pi can decrypt and fires the matching
 * extractor whenever new charts appear. Closes the "wanker-proof" loop:
 *
 *   o-charts (.oesu)                    S-63 (.es57)
 *   buy on o-charts.org                 buy cells from a VAR (ChartWorld)
 *     → OpenCPN downloads to             → import in OpenCPN's S63 plugin,
 *       ~/Charts/oeuSENC-XX/               which builds ~/.opencpn/s63/s63SENC/
 *     → decryptBatch                     → extractS63
 *              ↓                                    ↓
 *          both write /opt/thalassa-pi-cache/enc-charts/
 *     → pi-cache /api/enc/installed exposes the new cells
 *     → iOS auto-sync on next app launch pulls them
 *     → cells render, router uses them
 *
 * Zero user taps from chart purchase to in-app routing.
 *
 * The two sources differ in what changes on disk. o-charts drops a directory
 * of new files per chart set, so the .oesu watcher batches by directory. The
 * S63 plugin rewrites one `<CELL>.es57` in a single flat directory per import
 * or update, so that watcher batches by cell id and passes `--only` — a new
 * cell must not trigger re-extraction of the whole library.
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
 *   ENC_S63_SENC_DIR          — s63 plugin's eSENC cache (default: $HOME/.opencpn/s63/s63SENC)
 *   ENC_S63_CHART_DIR         — s63 plugin's cell/permit dir (default: $HOME/.opencpn/s63/s63charts)
 *   ENC_S63_CONF              — opencpn.conf holding the S-63 permits (default: $HOME/.opencpn/opencpn.conf)
 *   ENC_S63_WATCHER_ENABLED   — set to 'false' to watch only .oesu (default: enabled)
 */

import { spawn } from 'node:child_process';
import { existsSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, dirname, extname, resolve } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { startChartworldSync, stopChartworldSync } from './chartworldSync.js';

const HOME = homedir();

const WATCH_DIR = process.env.ENC_WATCH_DIR || join(HOME, 'Charts');
const EXTRACTOR_DIR = process.env.ENC_EXTRACTOR_DIR || join(HOME, 'thalassa-marine-weather', 'tools', 'senc-extractor');
/**
 * Absolute path to the chart store.
 *
 * `ENC_CHART_DIR` defaults to the relative './enc-charts', which is correct
 * for the server itself (cwd is /opt/thalassa-pi-cache) but NOT for the
 * extractors we spawn: those run with cwd set to the senc-extractor directory,
 * so a relative path resolved there and quietly created a second, orphaned
 * store that pi-cache never serves. Resolve once, against the server's cwd,
 * and hand children the absolute path.
 */
const CHART_STORE_DIR = resolve(process.env.ENC_CHART_DIR || './enc-charts');
const DEBOUNCE_MS = parseInt(process.env.ENC_WATCHER_DEBOUNCE_MS || '30000', 10);
const ENABLED = process.env.ENC_WATCHER_ENABLED !== 'false';
const DEFAULT_SOURCE_HO = process.env.ENC_DEFAULT_SOURCE_HO || 'AU';

const S63_SENC_DIR = process.env.ENC_S63_SENC_DIR || join(HOME, '.opencpn', 's63', 's63SENC');
const S63_CHART_DIR = process.env.ENC_S63_CHART_DIR || join(HOME, '.opencpn', 's63', 's63charts');
const S63_CONF = process.env.ENC_S63_CONF || join(HOME, '.opencpn', 'opencpn.conf');
const S63_ENABLED = process.env.ENC_S63_WATCHER_ENABLED !== 'false';

let watcher: FSWatcher | null = null;
let pendingTimer: NodeJS.Timeout | null = null;
const pendingChartSets = new Set<string>();
let currentDecryptRun: { chartSet: string; promise: Promise<void> } | null = null;

let s63Watcher: FSWatcher | null = null;
let s63PendingTimer: NodeJS.Timeout | null = null;
const pendingS63Cells = new Set<string>();
let currentS63Run: string | null = null;

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

    console.log(
        `[encWatcher] watching ${WATCH_DIR} for new .oesu files (debounce=${DEBOUNCE_MS}ms, store=${CHART_STORE_DIR})`,
    );

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

    startS63Watcher();

    // Upstream of both watchers: pull new purchases off the chart vendor so
    // there is nothing to download or copy by hand. No-op unless configured.
    void startChartworldSync();
}

/**
 * Watch the S63 plugin's eSENC cache. Unlike the .oesu side we watch for
 * `change` as well as `add`: an updated cell keeps its filename and the
 * plugin rewrites it in place, which must trigger a re-extract.
 */
function startS63Watcher(): void {
    if (!S63_ENABLED) {
        console.log('[encWatcher] s63 watching disabled via ENC_S63_WATCHER_ENABLED=false');
        return;
    }
    if (s63Watcher) return;

    console.log(`[encWatcher] watching ${S63_SENC_DIR} for .es57 files (debounce=${DEBOUNCE_MS}ms)`);

    s63Watcher = chokidar.watch(S63_SENC_DIR, {
        ignored: (p: string, stats?: Stats) => {
            if (!stats) return false;
            if (stats.isDirectory()) return false;
            return !p.toLowerCase().endsWith('.es57');
        },
        persistent: true,
        ignoreInitial: true,
        depth: 1, // flat directory of <CELL>.es57
        awaitWriteFinish: {
            // A cell plus its updates can take a while to build; wait longer
            // than the .oesu side for the file to settle.
            stabilityThreshold: 5000,
            pollInterval: 250,
        },
    });

    const queue = (filePath: string, kind: string): void => {
        const cellId = basename(filePath, extname(filePath)).toUpperCase();
        console.log(`[encWatcher] s63 cell ${kind}: ${cellId}`);
        pendingS63Cells.add(cellId);
        if (s63PendingTimer) clearTimeout(s63PendingTimer);
        s63PendingTimer = setTimeout(() => {
            s63PendingTimer = null;
            void drainPendingS63();
        }, DEBOUNCE_MS);
    };

    s63Watcher.on('add', (p) => queue(p, 'added'));
    s63Watcher.on('change', (p) => queue(p, 'updated'));
    s63Watcher.on('error', (err) => {
        console.warn('[encWatcher] s63 error:', err);
    });
}

async function drainPendingS63(): Promise<void> {
    const cells = [...pendingS63Cells];
    pendingS63Cells.clear();
    if (cells.length === 0) return;
    try {
        await runExtractS63(cells);
    } catch (err) {
        console.warn(`[encWatcher] extractS63 failed for ${cells.join(', ')}:`, err);
    }
}

/**
 * Spawn extractS63 for the cells that changed. Permits are read by the CLI
 * itself from opencpn.conf and the .os63 descriptors, so nothing sensitive
 * passes through argv (and nothing lands in the process table).
 */
function runExtractS63(cellIds: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const args = [
            'tsx',
            join(EXTRACTOR_DIR, 'src', 'extractS63.ts'),
            '--senc-dir',
            S63_SENC_DIR,
            '--chart-dir',
            S63_CHART_DIR,
            '--conf',
            S63_CONF,
            '--pi-cache-store',
            CHART_STORE_DIR,
            '--only',
            cellIds.join(','),
        ];

        console.log(`[encWatcher] spawning extractS63 for ${cellIds.join(', ')}`);
        const t0 = Date.now();
        currentS63Run = cellIds.join(',');

        const child = spawn('npx', args, {
            cwd: EXTRACTOR_DIR,
            env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let lastLine = '';
        child.stdout.on('data', (chunk: Buffer) => {
            for (const line of chunk.toString().split('\n')) {
                if (!line.trim()) continue;
                lastLine = line.trim();
                // Surface the per-cell summary and anything the extractor
                // flags — withheld geometry means a cell needs a human.
                if (line.includes('emitted') || line.includes('WARNING') || line.includes('Wrote pi-cache')) {
                    console.log(`[encWatcher:s63] ${line.trim()}`);
                }
            }
        });
        child.stderr.on('data', (chunk: Buffer) => console.warn(`[encWatcher:s63] stderr: ${chunk.toString().trim()}`));

        child.on('exit', (code) => {
            currentS63Run = null;
            const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
            if (code === 0) {
                console.log(`[encWatcher] extractS63 finished in ${elapsed}s — ${lastLine}`);
                resolve();
            } else {
                console.warn(`[encWatcher] extractS63 exited code=${code} after ${elapsed}s`);
                reject(new Error(`extractS63 exit ${code}`));
            }
        });
        child.on('error', (err) => {
            currentS63Run = null;
            console.warn('[encWatcher] failed to spawn extractS63:', err);
            reject(err);
        });
    });
}

/**
 * Stop watching. Used for clean shutdown — pi-cache calls this on SIGTERM.
 * In-flight decrypts are NOT aborted (they're short and harmless to let finish).
 */
export async function stopEncWatcher(): Promise<void> {
    stopChartworldSync();
    if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
    }
    if (s63PendingTimer) {
        clearTimeout(s63PendingTimer);
        s63PendingTimer = null;
    }
    if (s63Watcher) {
        await s63Watcher.close();
        s63Watcher = null;
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
    chartStoreDir: string;
    extractorDir: string;
    pendingSets: string[];
    currentDecrypt: string | null;
    s63: {
        enabled: boolean;
        watching: boolean;
        sencDir: string;
        pendingCells: string[];
        currentExtract: string | null;
    };
} {
    return {
        enabled: ENABLED,
        watching: watcher !== null,
        watchDir: WATCH_DIR,
        chartStoreDir: CHART_STORE_DIR,
        extractorDir: EXTRACTOR_DIR,
        pendingSets: [...pendingChartSets],
        currentDecrypt: currentDecryptRun?.chartSet ?? null,
        s63: {
            enabled: S63_ENABLED,
            watching: s63Watcher !== null,
            sencDir: S63_SENC_DIR,
            pendingCells: [...pendingS63Cells],
            currentExtract: currentS63Run,
        },
    };
}
