/**
 * Background re-conversion of installer-retained o-charts sources.
 *
 * Charts installed through the app (oChartsInstaller.installOChartsDelivery)
 * keep a private source copy under <chart store>/sources/. When the Pi's
 * extractor moves to a new output schema, the ~/Charts watcher re-extracts its
 * own sets, but nothing re-read these copies, so app-installed charts kept the
 * older conversion (2026-10-01: 96 AU newer editions, Brisbane harbour and
 * Moreton Bay among them, and 91 New Caledonia cells without the bridge and
 * overhead-clearance layers).
 *
 * Once per start, after the watcher's own startup reconcile, each retained
 * source whose installed cells predate the extractor's schema is converted
 * again and published as a refresh of its own package
 * (oChartsInstaller.reconvertRetainedOChartsSources). One source at a time,
 * each under the conversion lane's lease, taken only when that lane is idle so
 * this never occupies a queue slot a skipper's install could need, with the
 * converter at a lower scheduling priority than the service's own. Never
 * blocks the server: it runs detached, and its state is reported by
 * GET /api/enc/health as `sourceReconvert`.
 *
 * Shutdown: server.ts awaits stopSourceReconvert() before it exits. The pass
 * stops between sources and before a publication, never inside one: a
 * publication cut off half-way leaves enc-charts/.index.lock behind (it is
 * never reclaimed automatically) and every later chart write fails
 * chart-store-busy until someone removes it by hand.
 *
 * Mixed deploys: Pi files are copied into /opt one at a time, so this module
 * may run next to an older encWatcher.js or oChartsInstaller.js. Both are
 * namespace imports, checked at run time, so a missing export skips the pass
 * with a warning instead of failing module linking (which would take the
 * whole service down with it).
 *
 * Env:
 *   ENC_SOURCE_RECONVERT_ENABLED — 'false' disables it (default: enabled)
 *   ENC_CHART_DIR, ENC_EXTRACTOR_DIR — as encWatcher
 */

import fs from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as watcher from './encWatcher.js';
import * as installer from './oChartsInstaller.js';
import { piWorkloadGovernor, type PiWorkloadGovernor, type PiWorkloadLease } from './workloadGovernor.js';

/** The watcher's reconcile is bounded by its 30-minute extractor timeout; never wait forever on it. */
const RECONCILE_WAIT_CAP_MS = 45 * 60 * 1000;
const IDLE_LANE_POLL_MS = 30 * 1000;
/** Absolute niceness for the converter: below the service (Nice=-5), Signal K and the telemetry loggers. */
export const RECONVERT_NICENESS = 10;

export interface SourceReconvertStatus {
    state: 'disabled' | 'not-started' | 'waiting' | 'running' | 'stopped' | 'done';
    targetSchema: number | null;
    startedAt: string | null;
    finishedAt: string | null;
    current: installer.SourceReconvertProgress | null;
    outcomes: installer.SourceReconvertOutcome[];
    /** Why the whole pass was skipped (reconvert-schema-unknown, reconvert-store-unsupported, ...). */
    code?: string;
}

let status: SourceReconvertStatus = {
    state: 'not-started',
    targetSchema: null,
    startedAt: null,
    finishedAt: null,
    current: null,
    outcomes: [],
};
let run: Promise<void> | null = null;
const stopping = new AbortController();

export function getSourceReconvertStatus(): SourceReconvertStatus {
    return structuredClone(status);
}

/**
 * Take the conversion lease only when nobody holds or waits for it. Polls on
 * an unref'd timer by default, so a waiting pass never holds the process open;
 * `wait` lets a caller (a test) poll on a timer that does.
 */
export async function acquireIdleConversionLease(
    options: {
        governor?: PiWorkloadGovernor;
        pollMs?: number;
        signal?: AbortSignal;
        wait?: (ms: number, signal?: AbortSignal) => Promise<unknown>;
    } = {},
): Promise<PiWorkloadLease> {
    const governor = options.governor ?? piWorkloadGovernor;
    const wait = options.wait ?? ((ms, signal) => delay(ms, undefined, { ref: false, signal }));
    for (;;) {
        options.signal?.throwIfAborted();
        const lane = governor.snapshot('conversion');
        if (lane.active === 0 && lane.queued === 0) return governor.admit('conversion').lease;
        await wait(options.pollMs ?? IDLE_LANE_POLL_MS, options.signal);
    }
}

const exported = (module: object, name: string): boolean =>
    typeof (module as Record<string, unknown>)[name] === 'function';

/**
 * Start the once-per-start pass in the background. Safe to call more than
 * once; returns the running pass (tests await it; the server does not).
 */
export function startSourceReconvert(
    options: {
        chartStoreDir?: string;
        extractorDir?: string;
        workRoot?: string;
        waitForReconcile?: () => Promise<void>;
        acquireLease?: (signal: AbortSignal) => Promise<{ release(): void }>;
        runExtractor?: Parameters<typeof installer.reconvertRetainedOChartsSources>[0]['runExtractor'];
        logger?: Pick<Console, 'log' | 'warn'>;
        /** Test seams for a mixed deploy (an older encWatcher.js / oChartsInstaller.js). */
        watcherModule?: object;
        installerModule?: object;
    } = {},
): Promise<void> {
    if (run) return run;
    const logger = options.logger ?? console;
    if (process.env.ENC_SOURCE_RECONVERT_ENABLED === 'false') {
        status = { ...status, state: 'disabled' };
        logger.log('[encReconvert] disabled via ENC_SOURCE_RECONVERT_ENABLED=false');
        run = Promise.resolve();
        return run;
    }
    const watcherModule = (options.watcherModule ?? watcher) as Partial<typeof watcher>;
    const installerModule = (options.installerModule ?? installer) as Partial<typeof installer>;
    const missing = [
        ...(options.waitForReconcile || exported(watcherModule, 'whenInitialReconcileSettled')
            ? []
            : ['encWatcher.whenInitialReconcileSettled']),
        ...(exported(installerModule, 'reconvertRetainedOChartsSources')
            ? []
            : ['oChartsInstaller.reconvertRetainedOChartsSources']),
    ];
    if (missing.length > 0) {
        status = { ...status, state: 'done', code: 'reconvert-unavailable', finishedAt: new Date().toISOString() };
        logger.warn(
            `[encReconvert] reconvert-unavailable: ${missing.join(', ')} missing (a partial deploy); installed charts were left as they are.`,
        );
        run = Promise.resolve();
        return run;
    }
    const signal = stopping.signal;
    const chartStoreDir = options.chartStoreDir ?? resolve(process.env.ENC_CHART_DIR || './enc-charts');
    const extractorDir =
        options.extractorDir ||
        process.env.ENC_EXTRACTOR_DIR ||
        join(homedir(), 'thalassa-marine-weather', 'tools', 'senc-extractor');
    const workRoot = options.workRoot ?? join(tmpdir(), 'thalassa-enc-reconvert');
    status = { ...status, state: 'waiting', startedAt: new Date().toISOString() };
    const aborted = new Promise<void>((settle) => {
        if (signal.aborted) settle();
        else signal.addEventListener('abort', () => settle(), { once: true });
    });
    run = (async () => {
        await Promise.race([
            (options.waitForReconcile ?? watcherModule.whenInitialReconcileSettled!)(),
            delay(RECONCILE_WAIT_CAP_MS, undefined, { ref: false }),
            aborted,
        ]);
        if (signal.aborted) return;
        status = { ...status, state: 'running' };
        // Only this pass uses the work root; clear what a killed pass left.
        await fs.rm(workRoot, { recursive: true, force: true });
        const result = await installerModule.reconvertRetainedOChartsSources!({
            chartStoreDir,
            extractorDir,
            workRoot,
            runExtractor: options.runExtractor,
            acquireLease: () =>
                options.acquireLease ? options.acquireLease(signal) : acquireIdleConversionLease({ signal }),
            onProgress: (progress) => {
                status = { ...status, current: progress };
            },
            logger,
            signal,
            niceness: RECONVERT_NICENESS,
        });
        status = {
            ...status,
            targetSchema: result.targetSchema,
            outcomes: result.outcomes,
            ...(result.code ? { code: result.code } : {}),
        };
    })()
        .catch((error: unknown) => {
            // Journal: the whole error. Health status: the code only (messages carry paths).
            logger.warn(
                `[encReconvert] reconvert-unexpected: ${error instanceof Error ? error.message : String(error)} — installed charts were left as they are.`,
            );
            const errno = (error as NodeJS.ErrnoException | undefined)?.code;
            status = {
                ...status,
                code: signal.aborted
                    ? 'reconvert-stopped'
                    : `reconvert-unexpected${typeof errno === 'string' ? `:${errno}` : ''}`,
            };
        })
        .finally(() => {
            status = {
                ...status,
                state: signal.aborted ? 'stopped' : 'done',
                current: null,
                finishedAt: new Date().toISOString(),
            };
        });
    return run;
}

/**
 * Stop the pass for a service shutdown and wait (at most `timeoutMs`) until it
 * is out of any chart-store publication: it stops between sources, before a
 * publication, or by stopping the converter; a publication already under way
 * is allowed to finish. 'timed-out': it had not wound down by the bound (most
 * likely a publication that is taking unusually long).
 */
export async function stopSourceReconvert(timeoutMs: number): Promise<'idle' | 'stopped' | 'timed-out'> {
    stopping.abort();
    if (!run) return 'idle';
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
        run.then(() => 'stopped' as const),
        new Promise<'timed-out'>((settle) => {
            timer = setTimeout(() => settle('timed-out'), timeoutMs);
        }),
    ]);
    clearTimeout(timer);
    return outcome;
}
