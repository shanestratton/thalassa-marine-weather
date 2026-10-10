/**
 * The route worker's host (127-ROUTE-W): one worker kept alive, one job at a
 * time, every job stoppable, and a route always comes back where it does
 * today — on the main thread when the worker cannot start or dies.
 *
 * The fake Worker below speaks the real protocol (services/routing/routeJob.ts)
 * and runs the real runRouteJob on a structured clone of each message, a turn
 * later, as a worker would. The main thread's own runs go through
 * ROUTE_ENGINE.run, which the tests spy on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tinyRouteJob } from './helpers/routeJobScenes';
import { ROUTE_ENGINE, runRouteJob } from '../services/routing/routeJob';
import {
    __resetRouteWorkerHostForTest,
    __setRouteWorkerHostForTest,
    runRouteJobHosted,
    trimRouteWorkers,
    type RouteStage,
} from '../services/routing/routeWorkerHost';

type Behaviour = 'run' | 'hold' | 'crash' | 'init-error' | 'silent' | 'throw' | 'shallow-stack';

/**
 * A job's layers that overflow the stack the moment the engine reads them.
 * Measured 2026-10-11 in Playwright WebKit: a module worker's stack held
 * 3,145 frames of a trivial recursion, the page's main thread 39,923.
 */
const overflowingLayers = () =>
    new Proxy(
        {},
        {
            get() {
                throw new RangeError('Maximum call stack size exceeded.');
            },
        },
    );

class FakeWorker {
    static instances: FakeWorker[] = [];
    static behaviour: Behaviour = 'run';
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;
    terminated = false;
    started: number[] = [];
    trims = 0;
    held = new Map<number, unknown>();
    behaviour: Behaviour = FakeWorker.behaviour;

    constructor(
        readonly url: string | URL,
        readonly options?: WorkerOptions,
    ) {
        FakeWorker.instances.push(this);
        setTimeout(() => {
            if (this.behaviour === 'init-error') this.emit({ type: 'init-error', message: 'module failed to load' });
            else if (this.behaviour !== 'silent') this.emit({ type: 'ready' });
        }, 0);
    }

    postMessage(message: unknown): void {
        // Throws DataCloneError for a function, as postMessage does.
        const data = structuredClone(message) as { type: string; id: number; job: never };
        if (data.type === 'trim') {
            this.trims++;
            return;
        }
        this.started.push(data.id);
        if (this.behaviour === 'hold') {
            this.held.set(data.id, data.job);
            return;
        }
        setTimeout(() => {
            if (this.behaviour === 'crash') this.onerror?.(new Event('error'));
            else if (this.behaviour === 'throw') this.emit({ type: 'error', id: data.id, message: 'boom' });
            // The real runRouteJob, on a stack too shallow for this job.
            else if (this.behaviour === 'shallow-stack')
                this.reply(data.id, { ...(data.job as object), layers: overflowingLayers() } as never);
            else this.reply(data.id, data.job);
        }, 0);
    }

    release(id: number): void {
        const job = this.held.get(id);
        this.held.delete(id);
        this.reply(id, job as never);
    }

    private reply(id: number, job: never): void {
        this.emit({ type: 'result', id, output: structuredClone(runRouteJob(job)) });
    }

    emit(data: unknown): void {
        if (!this.terminated) this.onmessage?.({ data } as MessageEvent);
    }

    terminate(): void {
        this.terminated = true;
    }
}

const until = async (check: () => boolean, label: string): Promise<void> => {
    for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
    if (!check()) throw new Error(`timed out waiting for ${label}`);
};

let mainRuns: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    FakeWorker.instances = [];
    FakeWorker.behaviour = 'run';
    vi.stubGlobal('Worker', FakeWorker);
    __resetRouteWorkerHostForTest();
    __setRouteWorkerHostForTest({ readyTimeoutMs: 200, mainYieldMs: 0 });
    mainRuns = vi.spyOn(ROUTE_ENGINE, 'run');
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    __resetRouteWorkerHostForTest();
});

describe('one worker, one job at a time', () => {
    it('starts the worker from the engine chunk itself, as a module worker, and routes there', async () => {
        const hosted = await runRouteJobHosted(tinyRouteJob() as never);
        expect(FakeWorker.instances).toHaveLength(1);
        expect(String(FakeWorker.instances[0].url)).toBe(ROUTE_ENGINE.url);
        expect(FakeWorker.instances[0].options).toEqual({ type: 'module' });
        expect(hosted.where).toBe('worker');
        expect(hosted.output.result && 'polyline' in hosted.output.result).toBe(true);
        expect(mainRuns).not.toHaveBeenCalled();
        // The worker is kept for the next route (its grid cache stays warm).
        await runRouteJobHosted(tinyRouteJob() as never);
        expect(FakeWorker.instances).toHaveLength(1);
    });

    it('runs jobs one at a time, first come first served', async () => {
        FakeWorker.behaviour = 'hold';
        const order: string[] = [];
        const a = runRouteJobHosted(tinyRouteJob() as never).then(() => order.push('a'));
        const b = runRouteJobHosted(tinyRouteJob() as never).then(() => order.push('b'));
        const w = () => FakeWorker.instances[0];
        await until(() => w()?.started.length === 1, 'the first job');
        await new Promise((r) => setTimeout(r, 20));
        expect(w().started).toHaveLength(1);
        w().release(w().started[0]);
        await until(() => w().started.length === 2, 'the second job');
        w().release(w().started[1]);
        await Promise.all([a, b]);
        expect(order).toEqual(['a', 'b']);
    });

    it('tells its caller the stages in order: queued → routing → done', async () => {
        FakeWorker.behaviour = 'hold';
        const first: RouteStage[] = [];
        const second: RouteStage[] = [];
        const a = runRouteJobHosted(tinyRouteJob() as never, { onStage: (s) => first.push(s) });
        const b = runRouteJobHosted(tinyRouteJob() as never, { onStage: (s) => second.push(s) });
        const w = () => FakeWorker.instances[0];
        await until(() => w()?.started.length === 1, 'the first job');
        w().release(w().started[0]);
        await until(() => w().started.length === 2, 'the second job');
        w().release(w().started[1]);
        await Promise.all([a, b]);
        expect(first).toEqual(['routing', 'done']);
        expect(second).toEqual(['queued', 'routing', 'done']);
    });

    it('prints the lines the worker forwards on the main side, with the same text', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        FakeWorker.behaviour = 'hold';
        const run = runRouteJobHosted(tinyRouteJob() as never);
        await until(() => FakeWorker.instances[0]?.started.length === 1, 'the job');
        const w = FakeWorker.instances[0];
        w.emit({ type: 'console', level: 'warn', text: '[InshoreRouter] SEAWAY SHADOW: no graph route (12 ms)' });
        expect(warn).toHaveBeenCalledWith('[InshoreRouter] SEAWAY SHADOW: no graph route (12 ms)');
        w.release(w.started[0]);
        await run;
    });
});

describe('every job can be stopped', () => {
    it('a stopped job waiting in the queue never starts', async () => {
        FakeWorker.behaviour = 'hold';
        const a = runRouteJobHosted(tinyRouteJob() as never);
        const stop = new AbortController();
        const b = runRouteJobHosted(tinyRouteJob() as never, { signal: stop.signal });
        const w = () => FakeWorker.instances[0];
        await until(() => w()?.started.length === 1, 'the first job');
        stop.abort();
        await expect(b).rejects.toMatchObject({ name: 'AbortError' });
        w().release(w().started[0]);
        await a;
        await new Promise((r) => setTimeout(r, 20));
        expect(w().started).toHaveLength(1);
        expect(mainRuns).not.toHaveBeenCalled();
    });

    it('stopping the running job ends the worker, and the next job starts a fresh one', async () => {
        FakeWorker.behaviour = 'hold';
        const stop = new AbortController();
        const a = runRouteJobHosted(tinyRouteJob() as never, { signal: stop.signal });
        await until(() => FakeWorker.instances[0]?.started.length === 1, 'the job');
        stop.abort();
        await expect(a).rejects.toMatchObject({ name: 'AbortError' });
        expect(FakeWorker.instances[0].terminated).toBe(true);
        FakeWorker.behaviour = 'run';
        const next = await runRouteJobHosted(tinyRouteJob() as never);
        expect(FakeWorker.instances).toHaveLength(2);
        expect(next.where).toBe('worker');
        expect(mainRuns).not.toHaveBeenCalled();
    });

    it('a job stopped before it is posted is refused at once', async () => {
        const stop = new AbortController();
        stop.abort();
        await expect(runRouteJobHosted(tinyRouteJob() as never, { signal: stop.signal })).rejects.toMatchObject({
            name: 'AbortError',
        });
        expect(FakeWorker.instances).toHaveLength(0);
    });

    it('three deliberate stops do NOT move routing to the main thread; three crashes do', async () => {
        FakeWorker.behaviour = 'hold';
        for (let i = 0; i < 3; i++) {
            const stop = new AbortController();
            const run = runRouteJobHosted(tinyRouteJob() as never, { signal: stop.signal });
            await until(() => FakeWorker.instances[i]?.started.length === 1, `job ${i}`);
            stop.abort();
            await expect(run).rejects.toMatchObject({ name: 'AbortError' });
        }
        FakeWorker.behaviour = 'run';
        expect((await runRouteJobHosted(tinyRouteJob() as never)).where).toBe('worker');
        expect(FakeWorker.instances).toHaveLength(4);

        __resetRouteWorkerHostForTest();
        FakeWorker.instances = [];
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        FakeWorker.behaviour = 'crash';
        for (let i = 0; i < 3; i++) expect((await runRouteJobHosted(tinyRouteJob() as never)).where).toBe('main');
        expect(FakeWorker.instances).toHaveLength(3);
        FakeWorker.behaviour = 'run';
        expect((await runRouteJobHosted(tinyRouteJob() as never)).where).toBe('main');
        // No fourth spawn: the rest of the session routes on the main thread.
        expect(FakeWorker.instances).toHaveLength(3);
        expect(mainRuns).toHaveBeenCalledTimes(4);
    });
});

describe('a route always comes back', () => {
    beforeEach(() => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    it('a crash mid-job runs THAT job on the main thread, with the same answer', async () => {
        FakeWorker.behaviour = 'crash';
        const job = tinyRouteJob();
        const hosted = await runRouteJobHosted(job as never);
        expect(hosted.where).toBe('main');
        expect(mainRuns).toHaveBeenCalledTimes(1);
        const { timings: _t, ...answer } = hosted.output;
        const { timings: _u, ...direct } = runRouteJob(structuredClone(job) as never);
        const strip = (r: unknown) => ({ ...(r as object), elapsedMs: 0 });
        expect(strip(answer.result)).toEqual(strip(direct.result));
    });

    it("an init-error, a worker that never says it is ready, or a job that can't be posted runs on the main thread", async () => {
        FakeWorker.behaviour = 'init-error';
        expect((await runRouteJobHosted(tinyRouteJob() as never)).where).toBe('main');

        __resetRouteWorkerHostForTest();
        __setRouteWorkerHostForTest({ readyTimeoutMs: 30, mainYieldMs: 0 });
        FakeWorker.behaviour = 'silent';
        expect((await runRouteJobHosted(tinyRouteJob() as never)).where).toBe('main');

        __resetRouteWorkerHostForTest();
        FakeWorker.behaviour = 'run';
        // A function can't cross to a worker (DataCloneError on posting).
        const unpostable = tinyRouteJob({ probe: () => 'water' });
        const stages: RouteStage[] = [];
        const hosted = await runRouteJobHosted(unpostable as never, { onStage: (s) => stages.push(s) });
        expect(hosted.where).toBe('main');
        expect(stages).toContain('routing-main');
        expect(mainRuns).toHaveBeenCalledTimes(3);
    });

    it('with no Worker at all (vitest, an old webview) the job runs on the main thread', async () => {
        vi.stubGlobal('Worker', undefined);
        const stages: RouteStage[] = [];
        const hosted = await runRouteJobHosted(tinyRouteJob() as never, { onStage: (s) => stages.push(s) });
        expect(hosted.where).toBe('main');
        expect(stages).toEqual(['routing-main', 'done']);
        expect(mainRuns).toHaveBeenCalledTimes(1);
    });

    it("a job too deep for the worker's stack is routed again on the main thread, with the main thread's answer", async () => {
        FakeWorker.behaviour = 'shallow-stack';
        const job = tinyRouteJob();
        const stages: RouteStage[] = [];
        const hosted = await runRouteJobHosted(job as never, { onStage: (s) => stages.push(s) });
        expect(hosted.where).toBe('main');
        expect(stages).toEqual(['routing', 'routing-main', 'done']);
        expect(mainRuns).toHaveBeenCalledTimes(1);
        const { timings: _u, ...direct } = runRouteJob(structuredClone(job) as never);
        const strip = (r: unknown) => ({ ...(r as object), elapsedMs: 0 });
        expect(strip(hosted.output.result)).toEqual(strip(direct.result));
        // Not a crash: the worker is kept, and the next job goes to it.
        expect(FakeWorker.instances[0].terminated).toBe(false);
        FakeWorker.instances[0].behaviour = 'run';
        expect((await runRouteJobHosted(tinyRouteJob() as never)).where).toBe('worker');
        expect(FakeWorker.instances).toHaveLength(1);
    });

    it('the job says when it ran out of stack, and only then', () => {
        const deep = runRouteJob({ ...tinyRouteJob(), layers: overflowingLayers() } as never);
        expect(deep.result).toBeNull();
        expect(deep.outOfStack).toBe(true);
        expect(runRouteJob(tinyRouteJob({ layers: null }) as never)).not.toHaveProperty('outOfStack');
        expect(runRouteJob(tinyRouteJob() as never)).not.toHaveProperty('outOfStack');
    });

    it('a job that throws in the worker gives no route, and the main thread never runs it again', async () => {
        FakeWorker.behaviour = 'throw';
        const thrown = await runRouteJobHosted(tinyRouteJob() as never);
        expect(thrown.where).toBe('worker');
        expect(thrown.output.result).toBeNull();
        // …and so does a job the engine itself throws on (today's "local inshore route compute threw").
        FakeWorker.behaviour = 'run';
        const broken = await runRouteJobHosted(tinyRouteJob({ layers: null }) as never);
        expect(broken.output.result).toBeNull();
        expect(mainRuns).not.toHaveBeenCalled();
    });
});

describe('iOS memory warnings reach the route worker (decision 12)', () => {
    it('trims a busy worker and ends an idle one', async () => {
        FakeWorker.behaviour = 'hold';
        const run = runRouteJobHosted(tinyRouteJob() as never);
        await until(() => FakeWorker.instances[0]?.started.length === 1, 'the job');
        const w = FakeWorker.instances[0];
        trimRouteWorkers();
        expect(w.trims).toBe(1);
        expect(w.terminated).toBe(false);
        w.release(w.started[0]);
        await run;
        trimRouteWorkers();
        expect(w.terminated).toBe(true);
        FakeWorker.behaviour = 'run';
        expect((await runRouteJobHosted(tinyRouteJob() as never)).where).toBe('worker');
        expect(FakeWorker.instances).toHaveLength(2);
    });

    it('ends an idle worker while a job that could not be posted runs on the main thread', async () => {
        await runRouteJobHosted(tinyRouteJob() as never);
        const w = FakeWorker.instances[0];
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const stages: RouteStage[] = [];
        // A function can't cross to a worker: this job runs here, the worker sits idle.
        const run = runRouteJobHosted(tinyRouteJob({ probe: () => 'water' }) as never, {
            onStage: (s) => stages.push(s),
        });
        expect(stages).toEqual(['routing', 'routing-main']);
        trimRouteWorkers();
        expect(w.terminated).toBe(true);
        expect((await run).where).toBe('main');
        expect((await runRouteJobHosted(tinyRouteJob() as never)).where).toBe('worker');
        expect(FakeWorker.instances).toHaveLength(2);
    });

    it('does nothing without a worker', () => {
        expect(() => trimRouteWorkers()).not.toThrow();
        expect(FakeWorker.instances).toHaveLength(0);
    });
});
