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
 * this never occupies a queue slot a skipper's install could need. Never
 * blocks the server: it runs detached, and its state is reported by
 * GET /api/enc/health as `sourceReconvert`.
 *
 * Env:
 *   ENC_SOURCE_RECONVERT_ENABLED — 'false' disables it (default: enabled)
 *   ENC_CHART_DIR, ENC_EXTRACTOR_DIR — as encWatcher
 */

import fs from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { whenInitialReconcileSettled } from './encWatcher.js';
import {
    reconvertRetainedOChartsSources,
    type SourceReconvertOutcome,
    type SourceReconvertProgress,
} from './oChartsInstaller.js';
import { piWorkloadGovernor, type PiWorkloadGovernor, type PiWorkloadLease } from './workloadGovernor.js';

/** The watcher's reconcile is bounded by its 30-minute extractor timeout; never wait forever on it. */
const RECONCILE_WAIT_CAP_MS = 45 * 60 * 1000;
const IDLE_LANE_POLL_MS = 30 * 1000;

export interface SourceReconvertStatus {
    state: 'disabled' | 'not-started' | 'waiting' | 'running' | 'done';
    targetSchema: number | null;
    startedAt: string | null;
    finishedAt: string | null;
    current: SourceReconvertProgress | null;
    outcomes: SourceReconvertOutcome[];
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

export function getSourceReconvertStatus(): SourceReconvertStatus {
    return structuredClone(status);
}

/** Take the conversion lease only when nobody holds or waits for it. */
export async function acquireIdleConversionLease(
    governor: PiWorkloadGovernor = piWorkloadGovernor,
    pollMs = IDLE_LANE_POLL_MS,
): Promise<PiWorkloadLease> {
    for (;;) {
        const lane = governor.snapshot('conversion');
        if (lane.active === 0 && lane.queued === 0) return governor.admit('conversion').lease;
        await delay(pollMs, undefined, { ref: false });
    }
}

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
        acquireLease?: () => Promise<{ release(): void }>;
        runExtractor?: Parameters<typeof reconvertRetainedOChartsSources>[0]['runExtractor'];
        logger?: Pick<Console, 'log' | 'warn'>;
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
    const chartStoreDir = options.chartStoreDir ?? resolve(process.env.ENC_CHART_DIR || './enc-charts');
    const extractorDir =
        options.extractorDir ??
        process.env.ENC_EXTRACTOR_DIR ??
        join(homedir(), 'thalassa-marine-weather', 'tools', 'senc-extractor');
    const workRoot = options.workRoot ?? join(tmpdir(), 'thalassa-enc-reconvert');
    status = { ...status, state: 'waiting', startedAt: new Date().toISOString() };
    run = (async () => {
        await Promise.race([
            (options.waitForReconcile ?? whenInitialReconcileSettled)(),
            delay(RECONCILE_WAIT_CAP_MS, undefined, { ref: false }),
        ]);
        status = { ...status, state: 'running' };
        // Only this pass uses the work root; clear what a killed pass left.
        await fs.rm(workRoot, { recursive: true, force: true });
        const result = await reconvertRetainedOChartsSources({
            chartStoreDir,
            extractorDir,
            workRoot,
            runExtractor: options.runExtractor,
            acquireLease: options.acquireLease ?? (() => acquireIdleConversionLease()),
            onProgress: (progress) => {
                status = { ...status, current: progress };
            },
            logger,
        });
        status = {
            ...status,
            targetSchema: result.targetSchema,
            outcomes: result.outcomes,
        };
    })()
        .catch((error: unknown) => {
            logger.warn(
                `[encReconvert] reconvert-unexpected: ${error instanceof Error ? error.message : String(error)} — installed charts were left as they are.`,
            );
        })
        .finally(() => {
            status = { ...status, state: 'done', current: null, finishedAt: new Date().toISOString() };
        });
    return run;
}
