/**
 * The route worker's host (127-ROUTE-W): the main thread's side of routing
 * off the main thread. Modelled on services/engine/navGridWorkerHost.ts.
 *
 * Shane, 2026-10-10: "yes for a short while it looked as though the app had
 * frozen". The route job (routeJob.ts) runs here in a worker, so the chart
 * pans, the panel scrolls and the buttons answer while the router works.
 *
 * - One worker, kept alive while nothing stops it, so its grid cache stays
 *   warm between routes as it did on the main thread. It is started from the
 *   engine chunk's own URL (ROUTE_ENGINE.url): in the production build that
 *   chunk is the worker script, so there is one copy of the router.
 * - One job at a time, first come first served. Every job can be stopped: a
 *   waiting job is dropped before it starts, and the running one ends the
 *   worker (the next job starts a fresh one, with a cold cache).
 * - A route always comes back where it does today. With no Worker (vitest, an
 *   old webview), a worker that will not start or never says it is ready, a
 *   crash mid-job or a job that cannot be posted, THAT job runs on the main
 *   thread through the same runRouteJob, with a warn line; after three crashes
 *   the rest of the session routes there. Deliberate stops are not crashes.
 * - A job that throws inside the worker is today's "local inshore route compute
 *   threw": no route, never run again on the main thread. The one exception
 *   is a stack overflow: the worker's stack is far shallower than the page's,
 *   so that job is routed again here (not a crash; the worker is kept).
 *
 * The tracer's grids (services/engine/navGridWorkerHost, 127-ROUTE-W2) run in
 * a SECOND instance of the same script, with its own queue and its own crash
 * count, so a tracer grid never waits behind a route and a route never waits
 * behind a grid. The navGrid worker, a second copy of the grid code, is gone.
 *
 * Nothing here reads or writes a chart: the job's layers live in the worker's
 * memory while it routes and are dropped when it answers (o-charts,
 * 2026-10-10).
 */
import {
    ROUTE_ENGINE,
    type NavGridJobArgs,
    type RouteJob,
    type RouteJobOutput,
    type RouteWorkerReply,
    type RouteWorkerRequest,
} from './routeJob';
import type { NavGrid } from '../engine/types';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('routeWorkerHost');

/**
 * Where a route job is: waiting behind another ('queued'), in the worker
 * ('routing'), on the main thread because no worker could take it
 * ('routing-main': the screen may pause), or finished ('done').
 */
export type RouteStage = 'queued' | 'routing' | 'routing-main' | 'done';

export interface HostedRouteJob {
    output: RouteJobOutput;
    where: 'worker' | 'main';
    /** Waiting for the job before it, posting it to the worker, and its answer's way back (ms). */
    waitMs: number;
    handoffMs: number;
    backMs: number;
}

interface PendingJob {
    id: number;
    job: RouteJob;
    signal?: AbortSignal;
    onStage?: (stage: RouteStage) => void;
    resolve: (hosted: HostedRouteJob) => void;
    reject: (err: unknown) => void;
    enqueuedAt: number;
    /** Given to the worker (waiting for it to be ready, or posted). */
    onWorker?: boolean;
    postedAt?: number;
    waitMs: number;
    onAbort?: () => void;
}

interface RouteWorker {
    worker: Worker;
    ready: boolean;
    readyTimer?: ReturnType<typeof setTimeout>;
}

/** Crashes before the rest of the session routes on the main thread (navGridWorkerHost's cap). */
const MAX_CRASHES = 3;
/** A worker that has not said it is ready by then will not: its job runs on the main thread. */
let readyTimeoutMs = 10_000;
/** Lets "the screen may pause" paint before the main thread is held. */
let mainYieldMs = 50;

let instance: RouteWorker | null = null;
let crashes = 0;
let mainOnly = false;
let seq = 0;
const queue: PendingJob[] = [];
let running: PendingJob | null = null;

/** The error a stopped route rejects with: the signal's own reason, or an AbortError. */
export const routeStopped = (signal?: AbortSignal): unknown =>
    signal?.reason instanceof Error ? signal.reason : new DOMException('Route stopped', 'AbortError');

const stage = (p: PendingJob, s: RouteStage): void => p.onStage?.(s);

function settle(p: PendingJob): void {
    if (p.onAbort) p.signal?.removeEventListener('abort', p.onAbort);
    if (running === p) running = null;
}

function finish(p: PendingJob, output: RouteJobOutput, where: 'worker' | 'main', receivedAt = Date.now()): void {
    settle(p);
    stage(p, 'done');
    p.resolve({
        output,
        where,
        waitMs: p.waitMs,
        handoffMs: where === 'worker' && p.postedAt ? Math.max(0, output.timings.startedAt - p.postedAt) : 0,
        backMs: where === 'worker' ? Math.max(0, receivedAt - output.timings.endedAt) : 0,
    });
    pump();
}

/**
 * Start one instance of the route worker's script (the engine chunk itself).
 * Its forwarded console lines are printed here; every other reply goes to
 * `onReply`, and `onFail` hears of a crash, or a start that never says it is
 * ready.
 */
function startInstance(
    onReply: (reply: RouteWorkerReply, from: RouteWorker) => void,
    onFail: (from: RouteWorker, why: string) => void,
): RouteWorker {
    const worker = new Worker(ROUTE_ENGINE.url, { type: 'module' });
    const created: RouteWorker = { worker, ready: false };
    worker.onmessage = (ev: MessageEvent<RouteWorkerReply>) => {
        const d = ev.data;
        if (d.type === 'console') {
            // The worker's lines, printed here with the same text (Xcode
            // shows this thread's console, not a worker's).
            if (d.level === 'error') console.error(d.text);
            else console.warn(d.text);
            return;
        }
        if (d.type === 'ready') {
            created.ready = true;
            clearTimeout(created.readyTimer);
        }
        onReply(d, created);
    };
    worker.onerror = () => onFail(created, created.ready ? 'crashed' : 'failed to start');
    created.readyTimer = setTimeout(() => {
        if (!created.ready) onFail(created, `not ready in ${readyTimeoutMs} ms`);
    }, readyTimeoutMs);
    return created;
}

function stopInstance(w: RouteWorker): void {
    clearTimeout(w.readyTimer);
    try {
        w.worker.terminate();
    } catch {
        /* already gone */
    }
}

/** Ends the worker. A crash counts toward the cap; a deliberate stop never does. */
function endWorker(crashed: boolean): void {
    if (!instance) return;
    stopInstance(instance);
    instance = null;
    if (crashed && ++crashes >= MAX_CRASHES) {
        mainOnly = true;
        log.warn(`route worker failed ${crashes}× — main thread from now on`);
    }
}

/** Run `p` here after all, saying why the worker could not. */
function backToMain(p: PendingJob, why: string): void {
    p.onWorker = false;
    p.postedAt = undefined;
    log.warn(`${why} — routing on the main thread`);
    runOnMain(p);
}

/** The worker could not take the running job: end it (a crash) and run that job here. */
function workerFailed(why: string): void {
    const p = running?.onWorker ? running : null;
    endWorker(true);
    if (p) backToMain(p, `route worker ${why}`);
}

function onReply(d: RouteWorkerReply, from: RouteWorker): void {
    if (from !== instance) return;
    if (d.type === 'ready') {
        if (running?.onWorker && running.postedAt === undefined) post(running);
        return;
    }
    if (d.type === 'init-error') {
        workerFailed(`failed to start (${d.message})`);
        return;
    }
    const p = running;
    if (!p || (d.type !== 'result' && d.type !== 'error') || d.id !== p.id) return;
    if (d.type === 'result') {
        // Too deep for the worker's stack (routeJob runRouteJob): the main
        // thread's is far deeper. Not a crash: the worker is kept.
        if (d.output.outOfStack) backToMain(p, 'route worker ran out of stack');
        else finish(p, d.output, 'worker');
    } else {
        // Today's "local inshore route compute threw": no route, not re-run.
        log.warn(`local inshore route compute threw: ${d.message}`);
        const now = Date.now();
        finish(p, { result: null, timings: { startedAt: now, engineMs: 0, shadowMs: 0, endedAt: now } }, 'worker');
    }
}

function spawn(): RouteWorker | null {
    if (mainOnly) return null;
    if (instance) return instance;
    if (typeof Worker === 'undefined') return null;
    try {
        instance = startInstance(onReply, (from, why) => {
            if (from === instance) workerFailed(why);
        });
        return instance;
    } catch (err) {
        crashes++;
        if (crashes >= MAX_CRASHES) mainOnly = true;
        log.warn(`route worker failed to start (${err instanceof Error ? err.message : String(err)})`);
        return null;
    }
}

function post(p: PendingJob): void {
    if (!instance) return runOnMain(p);
    p.onWorker = true;
    p.postedAt = Date.now();
    try {
        instance.worker.postMessage({ type: 'job', id: p.id, job: p.job } satisfies RouteWorkerRequest);
    } catch (err) {
        // A DataCloneError: something in the job cannot cross. The worker is
        // fine; only this job runs here.
        backToMain(p, `route job could not be posted (${err instanceof Error ? err.message : String(err)})`);
    }
}

function runOnMain(p: PendingJob): void {
    stage(p, 'routing-main');
    setTimeout(() => {
        // Stopped while the words painted? Else route here (runRouteJob
        // never throws: a job that does is no route, with today's words).
        if (running === p) finish(p, ROUTE_ENGINE.run(p.job), 'main');
    }, mainYieldMs);
}

function start(p: PendingJob): void {
    running = p;
    p.waitMs = Date.now() - p.enqueuedAt;
    const w = spawn();
    if (!w) return runOnMain(p);
    stage(p, 'routing');
    p.onWorker = true;
    if (w.ready) post(p);
    // …else it is posted when the worker says it is ready (onReply).
}

function pump(): void {
    if (running) return;
    const next = queue.shift();
    if (next) start(next);
}

/**
 * Route one job off the main thread, or on it where no worker can. Resolves
 * with the job's answer and where it ran; rejects with an AbortError when
 * `signal` stops it (a waiting job never starts; the running one ends the
 * worker).
 */
export function runRouteJobHosted(
    job: RouteJob,
    opts: { signal?: AbortSignal; onStage?: (stage: RouteStage) => void } = {},
): Promise<HostedRouteJob> {
    const { signal, onStage } = opts;
    if (signal?.aborted) return Promise.reject(routeStopped(signal));
    return new Promise<HostedRouteJob>((resolve, reject) => {
        const p: PendingJob = { id: ++seq, job, signal, onStage, resolve, reject, enqueuedAt: Date.now(), waitMs: 0 };
        p.onAbort = () => {
            const at = queue.indexOf(p);
            if (at >= 0) queue.splice(at, 1);
            else if (running === p) {
                // Stopped mid-route: the A* cannot be interrupted, so the
                // worker goes. Not a crash.
                if (p.onWorker) endWorker(false);
                running = null;
            } else return;
            settle(p);
            reject(routeStopped(signal));
            pump();
        };
        signal?.addEventListener('abort', p.onAbort, { once: true });
        queue.push(p);
        if (running) stage(p, 'queued');
        pump();
    });
}

// ── The tracer's grids: a second instance of the same script ───────

interface GridJob {
    id: number;
    args: NavGridJobArgs;
    resolve: (grid: NavGrid) => void;
    reject: (err: Error) => void;
    posted: boolean;
}

let gridInstance: RouteWorker | null = null;
/** The grid instance's own crash count: routes and grids never latch each other. */
let gridCrashes = 0;
const gridJobs = new Map<number, GridJob>();

/** The grid instance failed (a crash): end it, and each grid it held is built on the main thread by its caller. */
function gridFailed(why: string): void {
    if (!gridInstance) return;
    stopInstance(gridInstance);
    gridInstance = null;
    log.warn(`navGrid worker ${why} (${++gridCrashes}/${MAX_CRASHES})`);
    const failed = [...gridJobs.values()];
    gridJobs.clear();
    for (const g of failed) g.reject(new Error(`navGrid worker ${why}`));
}

function postGrid(g: GridJob): void {
    if (g.posted || !gridInstance) return;
    g.posted = true;
    try {
        gridInstance.worker.postMessage({ type: 'grid', id: g.id, args: g.args } satisfies RouteWorkerRequest);
    } catch (err) {
        // A DataCloneError: only this grid is built on the main thread.
        gridJobs.delete(g.id);
        g.reject(err instanceof Error ? err : new Error(String(err)));
    }
}

function onGridReply(d: RouteWorkerReply, from: RouteWorker): void {
    if (from !== gridInstance) return;
    if (d.type === 'ready') {
        for (const g of gridJobs.values()) postGrid(g);
        return;
    }
    if (d.type === 'init-error') {
        gridFailed(`failed to start (${d.message})`);
        return;
    }
    if (d.type !== 'grid' && d.type !== 'error') return;
    const g = gridJobs.get(d.id);
    if (!g) return;
    gridJobs.delete(d.id);
    if (d.type === 'grid') g.resolve(d.grid);
    else g.reject(new Error(d.message || 'navGrid worker error'));
}

/**
 * Build one tracer grid in the grid instance (services/engine/navGridWorkerHost).
 * Grids go to it as they come; it builds them one after another, never behind
 * a route. Resolves with the grid, its typed arrays transferred; rejects when
 * the worker cannot build it (a crash, a start that fails, a throw, a job that
 * cannot be posted), and the caller builds it on the main thread. Null where
 * no worker can take it at all: no Worker (vitest, an old webview), a spawn
 * that throws, or three grid-instance crashes this session.
 */
export function runGridJobHosted(args: NavGridJobArgs): Promise<NavGrid> | null {
    if (gridCrashes >= MAX_CRASHES || typeof Worker === 'undefined') return null;
    if (!gridInstance) {
        try {
            gridInstance = startInstance(onGridReply, (from, why) => {
                if (from === gridInstance) gridFailed(why);
            });
        } catch {
            // As the navGrid worker's host did: a spawn that throws is not tried again.
            gridCrashes = MAX_CRASHES;
            return null;
        }
    }
    const w = gridInstance;
    return new Promise<NavGrid>((resolve, reject) => {
        const g: GridJob = { id: ++seq, args, resolve, reject, posted: false };
        gridJobs.set(g.id, g);
        if (w.ready) postGrid(g);
        // …else it is posted when the instance says it is ready (onGridReply).
    });
}

/** Ask a busy instance to drop its grids; end an idle one (the next job starts a fresh one). */
function trimOrEnd(w: RouteWorker, busy: boolean, end: () => void): void {
    if (!busy) return end();
    try {
        w.worker.postMessage({ type: 'trim' } satisfies RouteWorkerRequest);
    } catch {
        /* nothing to trim */
    }
}

/**
 * An iOS memory warning (services/native/memoryGauge.ts): the route worker's
 * grid cache (up to 48 MB) is dropped too, and the tracer's grid instance is
 * told the same. A busy worker trims after its job; an idle one is simply
 * ended (the next job starts a fresh one), also while a route that could not
 * be posted runs on the main thread. A worker still starting for its job
 * holds no grids and is left to start.
 */
export function trimRouteWorkers(): void {
    if (instance && !(running?.onWorker && running.postedAt === undefined))
        trimOrEnd(instance, !!running?.onWorker, () => endWorker(false));
    if (gridInstance) {
        const jobs = [...gridJobs.values()];
        if (jobs.length === 0 || jobs.some((g) => g.posted))
            trimOrEnd(gridInstance, jobs.length > 0, () => {
                stopInstance(gridInstance!);
                gridInstance = null;
            });
    }
}

/** Test seam. */
export function __setRouteWorkerHostForTest(t: { readyTimeoutMs?: number; mainYieldMs?: number }): void {
    if (t.readyTimeoutMs !== undefined) readyTimeoutMs = t.readyTimeoutMs;
    if (t.mainYieldMs !== undefined) mainYieldMs = t.mainYieldMs;
}

/** Test seam. */
export function __resetRouteWorkerHostForTest(): void {
    if (instance) stopInstance(instance);
    if (gridInstance) stopInstance(gridInstance);
    instance = null;
    gridInstance = null;
    gridCrashes = 0;
    gridJobs.clear();
    crashes = 0;
    mainOnly = false;
    queue.length = 0;
    running = null;
    readyTimeoutMs = 10_000;
    mainYieldMs = 50;
}
