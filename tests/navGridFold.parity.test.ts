/**
 * The tracer's grids after the navGrid fold (127-ROUTE-W2): the same grids,
 * byte for byte.
 *
 * Until 127 the tracer's depth grids (services/routeTracer.ts, through
 * services/engine/navGridWorkerHost.ts) were built in their own worker,
 * services/engine/navGridWorker.ts, a second copy of the navGrid code in the
 * bundle (35,001 B). That worker is gone: buildNavGridAsync now posts its grid
 * jobs to a SECOND instance of the route worker (the router-engine chunk), so
 * a tracer grid never waits behind a route and a route never waits behind a
 * grid, and with no worker it builds the grid on the main thread as before.
 *
 * The goldens (tests/fixtures/routeJob/tracer-grid-*.json) were captured from
 * today's navGrid worker itself, on b127 2f83331f6 BEFORE it was deleted:
 * each job given to navGridWorker.ts exactly as navGridWorkerHost posted it,
 * and its reply received with its transfer list as the main thread received
 * it. Each holds the sha256 of every field (a typed array by kind, length and
 * bytes), the fields that came back transferred, and a short summary. Scenes
 * are synthetic or NOAA US5GA22M (public domain): tests/helpers/tracerGridScenes.ts.
 * The NOAA case skips, saying why, without THALASSA_ENC_SAMPLES.
 *
 * Run: THALASSA_ENC_SAMPLES=<main checkout>/public/enc-samples \
 *   NODE_OPTIONS=--max-old-space-size=4096 npx vitest run tests/navGridFold.parity.test.ts --maxWorkers=1
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROUTE_ENGINE, startRouteWorker } from '../services/routing/routeJob';
import { __resetRouteWorkerHostForTest } from '../services/routing/routeWorkerHost';
import { buildNavGridAsync } from '../services/engine/navGridWorkerHost';
import { receiveGrid, tracerGridCases, tracerGridGolden, type TracerGridArgs } from './helpers/tracerGridScenes';
import type { NavGrid } from '../services/engine/types';

type Posted = { msg: { type: string; id?: number; grid?: NavGrid }; transfer: ArrayBuffer[] };

/** The worker's console stays this test's own: lines it would forward are dropped here. */
const quiet = () => ({ warn() {}, error() {} });

/** A Worker running the real route worker script (routeJob.ts) a turn later, as a worker would. */
class ScriptWorker {
    static instances: ScriptWorker[] = [];
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;
    posted: Posted[] = [];
    jobs: string[] = [];
    private scope = {
        onmessage: null as null | ((ev: MessageEvent) => void),
        postMessage: (msg: Posted['msg'], transfer: ArrayBuffer[] = []) => {
            this.posted.push({ msg, transfer });
            const data = structuredClone(msg, { transfer });
            setTimeout(() => this.onmessage?.({ data } as MessageEvent), 0);
        },
    };

    constructor(
        readonly url: string | URL,
        readonly options?: WorkerOptions,
    ) {
        ScriptWorker.instances.push(this);
        startRouteWorker(this.scope as never, quiet());
    }

    postMessage(message: { type: string }): void {
        const data = structuredClone(message);
        this.jobs.push(data.type);
        setTimeout(() => this.scope.onmessage?.({ data } as MessageEvent), 0);
    }

    terminate(): void {}
}

const cases = tracerGridCases();
const noaa = cases['tracer-grid-noaa'];
if ('skip' in noaa) console.warn(`[navGridFold.parity] NOAA case skipped: ${noaa.skip}`);
const names = Object.keys(cases).filter((name) => !('skip' in cases[name]));
const argsOf = (name: string) => structuredClone(cases[name]) as TracerGridArgs;
const callAsync = (a: TracerGridArgs) =>
    buildNavGridAsync(
        a.layers,
        a.bbox,
        a.resolutionM,
        a.draftM,
        a.safetyM,
        a.obstructionBufferM,
        a.relaxedLndare,
        a.relaxZones,
        a.routeProfile,
    );

beforeEach(() => {
    ScriptWorker.instances = [];
    __resetRouteWorkerHostForTest();
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    __resetRouteWorkerHostForTest();
});

describe("the route worker's script builds today's tracer grids", () => {
    it.each(names)('%s: its grid reply is the navGrid worker’s, byte for byte, transfers included', (name) => {
        const posted: Posted[] = [];
        const scope = {
            onmessage: null as null | ((ev: MessageEvent) => void),
            postMessage: (msg: Posted['msg'], transfer: ArrayBuffer[] = []) => posted.push({ msg, transfer }),
        };
        startRouteWorker(scope as never, quiet());
        expect(posted.map((p) => p.msg.type)).toEqual(['ready']);
        scope.onmessage!({ data: { type: 'grid', id: 7, args: argsOf(name) } } as MessageEvent);
        expect(posted).toHaveLength(2);
        const reply = posted[1];
        expect(reply.msg).toMatchObject({ type: 'grid', id: 7 });
        const { grid, transferred } = receiveGrid(reply.msg.grid!, reply.transfer);
        const [actual, expected] = tracerGridGolden(name, grid, transferred);
        expect(actual).toEqual(expected);
    });
});

describe('buildNavGridAsync (the tracer’s one call) after the fold', () => {
    it.each(names)('%s: built in a second instance of the route worker, the same grid comes back', async (name) => {
        vi.stubGlobal('Worker', ScriptWorker);
        const onMain = vi.spyOn(ROUTE_ENGINE, 'grid');
        const grid = await callAsync(argsOf(name));
        expect(ScriptWorker.instances).toHaveLength(1);
        const [w] = ScriptWorker.instances;
        // The route worker's own script, as a module worker: no navGrid worker build.
        expect(String(w.url)).toBe(ROUTE_ENGINE.url);
        expect(w.options).toEqual({ type: 'module' });
        expect(w.jobs).toEqual(['grid']);
        expect(onMain).not.toHaveBeenCalled();
        const reply = w.posted.find((p) => p.msg.type === 'grid')!;
        const transferred = Object.keys(reply.msg.grid!)
            .filter((k) => ArrayBuffer.isView((reply.msg.grid as unknown as Record<string, unknown>)[k]))
            .sort();
        expect(reply.transfer).toHaveLength(transferred.length);
        const [actual, expected] = tracerGridGolden(name, grid, transferred);
        expect(actual).toEqual(expected);
    });

    it.each(names)('%s: with no Worker (vitest, an old webview) the main thread builds the same grid', async (name) => {
        vi.stubGlobal('Worker', undefined);
        const onMain = vi.spyOn(ROUTE_ENGINE, 'grid');
        const grid = await callAsync(argsOf(name));
        expect(onMain).toHaveBeenCalledTimes(1);
        const [actual, expected] = tracerGridGolden(name, grid, null);
        expect(actual).toEqual(expected);
    });
});
