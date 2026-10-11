/**
 * ENC Chart Auto-Decrypt Watcher
 *
 * Watches the o-charts chart tree and fires the extractor whenever new charts
 * appear:
 *
 *   buy on o-charts.org
 *     → OpenCPN downloads to ~/Charts/oeuSENC-XX/
 *     → decryptBatch writes /opt/thalassa-pi-cache/enc-charts/
 *     → pi-cache /api/enc/installed exposes the new cells
 *     → iOS auto-sync on next app launch pulls them
 *     → cells render, router uses them
 *
 * Zero user taps from chart purchase to in-app routing. o-charts drops a
 * directory of new files per chart set, so the watcher batches by directory.
 *
 * It watches .oesu only. ChartWorld S-63 charts open in OpenCPN on the Pi,
 * never in Thalassa (the o-charts shop terms make S-63 OpenCPN-only), so the
 * S-63 eSENC watcher and the ChartWorld poller were retired in 127.
 *
 * Design notes:
 *   - chokidar handles the cross-platform fs-watch quirks; on Linux it sits on
 *     inotify, which is reliable for our single-directory recursive watch.
 *   - 30-second debounce after the last fs activity — OpenCPN drops many files
 *     in quick succession during a chart-set download, no point firing
 *     decryptBatch per-file.
 *   - Startup, chart updates and key/producer metadata changes reconcile sets.
 *     --skip-existing checks input content hashes, including the key XML.
 *   - Spawned as a child process so a misbehaving decrypt run can't crash the
 *     main Express server. stdout/stderr piped to the pi-cache journal.
 *
 * Env config:
 *   ENC_WATCH_DIR             — root chart dir to watch (default: $HOME/Charts)
 *   ENC_EXTRACTOR_DIR         — path to senc-extractor (default: $HOME/thalassa-marine-weather/tools/senc-extractor)
 *   ENC_CHART_DIR             — pi-cache chart store (default: ./enc-charts)
 *   ENC_WATCHER_DEBOUNCE_MS   — debounce window after last fs event (default: 30000)
 *   ENC_WATCHER_ENABLED       — set to 'false' to disable entirely (default: enabled)
 */

import { spawn } from 'node:child_process';
import { existsSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, dirname, resolve } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { PiWorkloadBusyError, piWorkloadGovernor } from './workloadGovernor.js';

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
const EXTRACTOR_TIMEOUT_MS = 30 * 60 * 1000;

let watcher: FSWatcher | null = null;
let pendingTimer: NodeJS.Timeout | null = null;
const pendingChartSets = new Set<string>();
let currentDecryptRun: { chartSet: string; promise: Promise<void> } | null = null;
let initialScanComplete = false;
let lastDecryptResult: { chartSet: string; success: boolean; finishedAt: string; error?: string } | null = null;

/**
 * Settles once the startup reconcile of WATCH_DIR is over: the initial scan
 * found nothing to reconcile, or the drain that followed it finished with
 * nothing left pending. Background work that must follow it (the re-conversion
 * of installer-retained sources, encSourceReconvert) waits on this.
 */
let initialReconcile: { promise: Promise<void>; settle: () => void } | null = null;

function settleInitialReconcile(): void {
    initialReconcile?.settle();
}

/** Resolves at once when the watcher is not running. */
export function whenInitialReconcileSettled(): Promise<void> {
    return initialReconcile?.promise ?? Promise.resolve();
}

/**
 * Start watching chart sets, including installed files missed while offline.
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

    initialScanComplete = false;
    let settle!: () => void;
    const promise = new Promise<void>((resolve) => {
        settle = resolve;
    });
    initialReconcile = { promise, settle };
    watcher = chokidar.watch(WATCH_DIR, {
        ignored: (p: string, stats?: Stats) => {
            if (!stats) return false; // allow directories through so we can recurse
            if (stats.isDirectory()) return false;
            return !isOChartsInput(p);
        },
        persistent: true,
        ignoreInitial: false,
        depth: 3, // ~/Charts/oeuSENC-AU/file.oesu — depth 3 is plenty
        awaitWriteFinish: {
            stabilityThreshold: 2000,
            pollInterval: 200,
        },
    });

    const queue = (filePath: string, kind: string): void => {
        if (!isOChartsInput(filePath)) return;
        const chartSet = dirname(filePath);
        console.log(`[encWatcher] chart input ${kind}: ${basename(filePath)} in ${chartSet}`);
        pendingChartSets.add(chartSet);
        if (initialScanComplete) scheduleDecrypt();
    };
    watcher.on('add', (filePath) => queue(filePath, 'added'));
    watcher.on('change', (filePath) => queue(filePath, 'updated'));
    watcher.on('ready', () => {
        initialScanComplete = true;
        if (pendingChartSets.size > 0) scheduleDecrypt();
        else settleInitialReconcile();
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
    initialScanComplete = false;
    pendingChartSets.clear();
    settleInitialReconcile();
}

/** Key-only updates and verified provenance changes must invalidate input fingerprints. */
export function isOChartsInput(filePath: string): boolean {
    const file = basename(filePath);
    return (
        /\.oesu$/i.test(file) || /^oeuSENC-.*-sgl[0-9A-F]+\.xml$/i.test(file) || file === 'thalassa-chart-source.json'
    );
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
            lastDecryptResult = { chartSet, success: true, finishedAt: new Date().toISOString() };
        } catch (err) {
            lastDecryptResult = {
                chartSet,
                success: false,
                finishedAt: new Date().toISOString(),
                error: err instanceof Error ? err.message : String(err),
            };
            console.warn(`[encWatcher] decrypt failed for ${chartSet}:`, err);
            if (err instanceof PiWorkloadBusyError) {
                pendingChartSets.add(chartSet);
                scheduleDecrypt();
            }
        }
    }
    if (initialScanComplete && pendingChartSets.size === 0 && !pendingTimer) settleInitialReconcile();
}

/**
 * Spawn the senc-extractor's decryptBatch CLI for one chart-set directory.
 * Uses --skip-existing so already-decrypted cells are no-ops; only fresh
 * downloads get processed.
 */
async function runDecryptForChartSet(chartSet: string): Promise<void> {
    const lease = await piWorkloadGovernor.admit('conversion').lease;
    try {
        await new Promise<void>((resolve, reject) => {
            const args = [
                'tsx',
                join(EXTRACTOR_DIR, 'src', 'decryptBatch.ts'),
                '--charts',
                chartSet,
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
                timeout: EXTRACTOR_TIMEOUT_MS,
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
                currentDecryptRun = null;
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
                currentDecryptRun = null;
                console.warn(`[encWatcher] failed to spawn decryptBatch:`, err);
                reject(err);
            });

            currentDecryptRun = {
                chartSet,
                promise: new Promise<void>((res) => child.on('exit', () => res())),
            };
        });
    } finally {
        lease.release();
    }
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
    lastDecryptResult: typeof lastDecryptResult;
} {
    return {
        enabled: ENABLED,
        watching: watcher !== null,
        watchDir: WATCH_DIR,
        chartStoreDir: CHART_STORE_DIR,
        extractorDir: EXTRACTOR_DIR,
        pendingSets: [...pendingChartSets],
        currentDecrypt: currentDecryptRun?.chartSet ?? null,
        lastDecryptResult,
    };
}
