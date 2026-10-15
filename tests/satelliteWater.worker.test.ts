/**
 * The satellite water check's pictures, read in the route worker (131-05).
 *
 * While Auto worked out a route, the phone could still stop for a moment,
 * twice, while it read the satellite picture for land and water at each end
 * of the route. The tiles are still fetched on the main thread
 * (services/satelliteWater.ts); their pictures are decoded, classified and
 * outlined in the route worker (services/routing/satelliteWaterJob.ts), and on
 * the main thread through the same function only where no worker can.
 *
 * The pictures are real PNG bytes of an invented canal through an invented
 * suburb (tests/helpers/satelliteTiles.ts), at real z14 tile places in the
 * synthetic archipelago's waters. vitest has no picture decoder, so the one
 * the page and a worker both have (createImageBitmap + OffscreenCanvas) is
 * stood in for by a reader of those PNG bytes: the worker and the main thread
 * decode with the same stand-in here, so this proves the plumbing (the same
 * crop reaches both, stitched and classified the same). Real decoders in
 * WebKit and Chromium are compared in browser-tests/route-worker.spec.ts.
 *
 * TestWorker runs the real route worker script (startRouteWorker) a turn
 * later, as a worker would, on a structured clone of each message; the main
 * thread's own reads go through ROUTE_ENGINE.water, which the tests spy on.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeatureCollection } from 'geojson';
import { fetchSatelliteWater } from '../services/satelliteWater';
import { ROUTE_ENGINE, startRouteWorker } from '../services/routing/routeJob';
import {
    __resetRouteWorkerHostForTest,
    __setRouteWorkerHostForTest,
    runRouteJobHosted,
    trimRouteWorkers,
} from '../services/routing/routeWorkerHost';
import { DEFAULT_CLASSIFY, satelliteCropWater, type SatelliteCrop } from '../services/routing/satelliteWaterJob';
import { tinyRouteJob } from './helpers/routeJobScenes';
import {
    CANAL_BBOX,
    SAT_ZOOM,
    canalTiles,
    canalWaterProblems,
    decodePng,
    landTile,
    satelliteTileOf,
} from './helpers/satelliteTiles';

const TOKEN = 'pk.test-not-a-token';
/** The worker's console stays this test's own: lines it would forward are dropped here. */
const quiet = () => ({ warn() {}, error() {} });

/** The picture decoder the page and a worker both have, reading the helper's PNG bytes. */
function stubPictureDecoder(): { decodes: () => number } {
    let decodes = 0;
    vi.stubGlobal('createImageBitmap', async (blob: Blob) => {
        decodes++;
        const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as ArrayBuffer);
            reader.onerror = () => reject(reader.error);
            reader.readAsArrayBuffer(blob);
        });
        const { rgba, w, h } = decodePng(new Uint8Array(bytes));
        return { width: w, height: h, rgba };
    });
    vi.stubGlobal(
        'OffscreenCanvas',
        class {
            private pixels: Uint8ClampedArray | null = null;
            getContext() {
                return {
                    drawImage: (bmp: { rgba: Uint8ClampedArray }) => (this.pixels = bmp.rgba),
                    getImageData: () => ({ data: this.pixels }),
                };
            }
        },
    );
    return { decodes: () => decodes };
}

/** The satellite tile server: the canal scene's two tiles, each request counted. */
function serveCanalTiles(): { requests: () => number } {
    const tiles = canalTiles();
    let requests = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        requests++;
        const t = satelliteTileOf(String(input));
        const png = t && tiles.get(`${t.x}/${t.y}`);
        return png ? new Response(png.slice()) : new Response(null, { status: 404 });
    });
    return { requests: () => requests };
}

/** The crop fetchSatelliteWater hands over for the canal scene. */
function canalCrop(): SatelliteCrop {
    const tiles = [...canalTiles()].map(([key, png]) => {
        const [x, y] = key.split('/').map(Number);
        return { x, y, bytes: png.slice().buffer as ArrayBuffer, mime: 'image/png' };
    });
    return { bbox: CANAL_BBOX.slice() as SatelliteCrop['bbox'], zoom: SAT_ZOOM, tiles, classify: DEFAULT_CLASSIFY };
}

type Behaviour = 'script' | 'hold' | 'crash' | 'init-error' | 'silent' | 'no-decoder' | 'unpostable';

/** A Worker running the real route worker script a turn later, or failing as asked. */
class TestWorker {
    static instances: TestWorker[] = [];
    static behaviour: Behaviour = 'script';
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;
    terminated = false;
    sent: string[] = [];
    trims = 0;
    held: unknown[] = [];
    behaviour: Behaviour = TestWorker.behaviour;
    private scope = {
        onmessage: null as null | ((ev: MessageEvent) => void),
        postMessage: (message: unknown) => {
            const data = structuredClone(message);
            setTimeout(() => this.emit(data), 0);
        },
    };

    constructor(
        readonly url: string | URL,
        readonly options?: WorkerOptions,
    ) {
        TestWorker.instances.push(this);
        if (this.behaviour === 'init-error')
            setTimeout(() => this.emit({ type: 'init-error', message: 'module failed to load' }), 0);
        else if (this.behaviour !== 'silent') startRouteWorker(this.scope as never, quiet());
    }

    postMessage(message: { type: string }): void {
        if (this.behaviour === 'unpostable' && message.type === 'water')
            throw new DOMException('The object could not be cloned.', 'DataCloneError');
        const data = structuredClone(message);
        this.sent.push(data.type);
        if (data.type === 'trim') this.trims++;
        if (this.behaviour === 'hold' && data.type !== 'trim') this.held.push(data);
        else this.deliver(data);
    }

    /** Hand the held messages to the script, as if the worker had been busy. */
    release(): void {
        for (const data of this.held.splice(0)) this.deliver(data);
    }

    crash(): void {
        this.onerror?.(new Event('error'));
    }

    private deliver(data: unknown): void {
        setTimeout(() => {
            if (this.terminated) return;
            if (this.behaviour === 'crash') return this.crash();
            if (this.behaviour !== 'no-decoder') return this.scope.onmessage?.({ data } as MessageEvent);
            // A worker whose canvas cannot decode a picture (the page's still can).
            const pageCanvas = (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;
            (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = undefined;
            try {
                this.scope.onmessage?.({ data } as MessageEvent);
            } finally {
                (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = pageCanvas;
            }
        }, 0);
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

let decoder: { decodes: () => number };
let mainReads: ReturnType<typeof vi.spyOn>;
/** The canal crop's water, read once on this thread with no worker in sight. */
let reference: FeatureCollection;

beforeAll(async () => {
    stubPictureDecoder();
    reference = await satelliteCropWater(canalCrop());
    vi.unstubAllGlobals();
});
beforeEach(() => {
    TestWorker.instances = [];
    TestWorker.behaviour = 'script';
    decoder = stubPictureDecoder();
    vi.stubGlobal('Worker', TestWorker);
    __resetRouteWorkerHostForTest();
    __setRouteWorkerHostForTest({ readyTimeoutMs: 200, mainYieldMs: 0 });
    mainReads = vi.spyOn(ROUTE_ENGINE, 'water');
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    __resetRouteWorkerHostForTest();
});

describe("the route worker's script reads a satellite crop", () => {
    it('the canal is water across both tiles, the suburb is not, and the main thread reads the same', async () => {
        expect(canalWaterProblems(reference)).toEqual([]);
        const posted: { type: string; id?: number; water?: FeatureCollection; message?: string }[] = [];
        const scope = {
            onmessage: null as null | ((ev: MessageEvent) => void),
            postMessage: (message: (typeof posted)[number]) => posted.push(message),
        };
        startRouteWorker(scope as never, quiet());
        expect(posted.map((m) => m.type)).toEqual(['ready']);
        scope.onmessage!({ data: { type: 'water', id: 7, crop: structuredClone(canalCrop()) } } as MessageEvent);
        await until(() => posted.length === 2, 'the answer');
        expect(posted[1]).toMatchObject({ type: 'water', id: 7 });
        expect(posted[1].water).toEqual(reference);
        // Each of the two tiles decoded once.
        expect(decoder.decodes()).toBe(2);
    });

    it('the land and water check would see a canal that stops at the seam, and no water at all', async () => {
        const crop = canalCrop();
        crop.tiles[1].bytes = landTile().slice().buffer as ArrayBuffer;
        expect(canalWaterProblems(await satelliteCropWater(crop))).toEqual(['the canal misses the second tile']);
        expect(canalWaterProblems({ type: 'FeatureCollection', features: [] })).toEqual(['no water']);
    });

    it('says so when it has no picture decoder, rather than answering no water', async () => {
        vi.stubGlobal('OffscreenCanvas', undefined);
        const posted: { type: string; id?: number; message?: string }[] = [];
        const scope = {
            onmessage: null as null | ((ev: MessageEvent) => void),
            postMessage: (message: (typeof posted)[number]) => posted.push(message),
        };
        startRouteWorker(scope as never, quiet());
        scope.onmessage!({ data: { type: 'water', id: 8, crop: canalCrop() } } as MessageEvent);
        expect(posted[1]).toEqual({ type: 'error', id: 8, message: 'route worker has no picture decoder' });
    });
});

describe('fetchSatelliteWater reads its pictures in the route worker', () => {
    it('fetches the tiles here, reads them there, and nothing is decoded on the main thread', async () => {
        const server = serveCanalTiles();
        const water = await fetchSatelliteWater(CANAL_BBOX, TOKEN);
        expect(server.requests()).toBe(2);
        // The route worker: the engine chunk itself, as a module worker. The
        // crop waited for it to say it was ready, then went to it.
        expect(TestWorker.instances).toHaveLength(1);
        const [w] = TestWorker.instances;
        expect(String(w.url)).toBe(ROUTE_ENGINE.url);
        expect(w.options).toEqual({ type: 'module' });
        expect(w.sent).toEqual(['water']);
        expect(mainReads).not.toHaveBeenCalled();
        expect(water).toEqual(reference);
    });

    it("a route's two crops and then its job go to one route worker, which is kept for the next route", async () => {
        serveCanalTiles();
        const [a, b] = await Promise.all([
            fetchSatelliteWater(CANAL_BBOX, TOKEN),
            fetchSatelliteWater(CANAL_BBOX, TOKEN),
        ]);
        expect(a).toEqual(reference);
        expect(b).toEqual(reference);
        const hosted = await runRouteJobHosted(tinyRouteJob() as never);
        expect(hosted.where).toBe('worker');
        expect(TestWorker.instances).toHaveLength(1);
        expect(TestWorker.instances[0].sent).toEqual(['water', 'water', 'job']);
        expect(TestWorker.instances[0].terminated).toBe(false);
        expect(mainReads).not.toHaveBeenCalled();
    });

    it('a crop asked for while another route is in the worker is read after it, in the same worker', async () => {
        serveCanalTiles();
        TestWorker.behaviour = 'hold';
        const route = runRouteJobHosted(tinyRouteJob() as never);
        await until(() => TestWorker.instances[0]?.held.length === 1, 'the route');
        const w = TestWorker.instances[0];
        const crop = fetchSatelliteWater(CANAL_BBOX, TOKEN);
        await until(() => w.held.length === 2, 'the crop');
        w.release();
        expect((await route).where).toBe('worker');
        expect(await crop).toEqual(reference);
        expect(w.sent).toEqual(['job', 'water']);
        expect(mainReads).not.toHaveBeenCalled();
    });
});

describe('the main thread reads a crop where the worker cannot, with the same land and water', () => {
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
        warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    const fellBack = () =>
        warn.mock.calls.some((args: unknown[]) => String(args[1]).endsWith('satellite crop read on the main thread'));

    it('no Worker at all (vitest, an old webview): no worker is started', async () => {
        vi.stubGlobal('Worker', undefined);
        serveCanalTiles();
        expect(await fetchSatelliteWater(CANAL_BBOX, TOKEN)).toEqual(reference);
        expect(mainReads).toHaveBeenCalledTimes(1);
        expect(TestWorker.instances).toHaveLength(0);
    });

    it.each<[string, Behaviour]>([
        ['the worker crashes mid-crop', 'crash'],
        ['the worker cannot start (init-error)', 'init-error'],
        ['the worker never says it is ready', 'silent'],
        ["the worker's canvas cannot decode a picture", 'no-decoder'],
        ["the crop can't be posted (DataCloneError)", 'unpostable'],
    ])('%s', async (_why, behaviour) => {
        __setRouteWorkerHostForTest({ readyTimeoutMs: 30, mainYieldMs: 0 });
        TestWorker.behaviour = behaviour;
        serveCanalTiles();
        expect(await fetchSatelliteWater(CANAL_BBOX, TOKEN)).toEqual(reference);
        expect(mainReads).toHaveBeenCalledTimes(1);
        expect(TestWorker.instances).toHaveLength(1);
        expect(fellBack()).toBe(true);
    });

    it('a stop that ends the worker under a crop (another route stopped mid-job) is no crash: that crop is read here', async () => {
        serveCanalTiles();
        TestWorker.behaviour = 'hold';
        const stop = new AbortController();
        const route = runRouteJobHosted(tinyRouteJob() as never, { signal: stop.signal });
        await until(() => TestWorker.instances[0]?.held.length === 1, 'the route');
        const crop = fetchSatelliteWater(CANAL_BBOX, TOKEN);
        await until(() => TestWorker.instances[0].held.length === 2, 'the crop');
        stop.abort();
        await expect(route).rejects.toMatchObject({ name: 'AbortError' });
        expect(await crop).toEqual(reference);
        expect(mainReads).toHaveBeenCalledTimes(1);
        expect(fellBack()).toBe(true);
        // Not a crash: the next crop goes to a fresh worker.
        TestWorker.behaviour = 'script';
        expect(await fetchSatelliteWater(CANAL_BBOX, TOKEN)).toEqual(reference);
        expect(mainReads).toHaveBeenCalledTimes(1);
        expect(TestWorker.instances).toHaveLength(2);
    });

    it('after three route-worker crashes the crops are read here for the rest of the session, as routes are', async () => {
        serveCanalTiles();
        TestWorker.behaviour = 'crash';
        for (let i = 0; i < 3; i++) expect(await fetchSatelliteWater(CANAL_BBOX, TOKEN)).toEqual(reference);
        expect(TestWorker.instances).toHaveLength(3);
        TestWorker.behaviour = 'script';
        expect(await fetchSatelliteWater(CANAL_BBOX, TOKEN)).toEqual(reference);
        expect((await runRouteJobHosted(tinyRouteJob() as never)).where).toBe('main');
        // No fourth worker.
        expect(TestWorker.instances).toHaveLength(3);
        expect(mainReads).toHaveBeenCalledTimes(4);
    });
});

describe('a stopped route reads no crop on the main thread (128-ROUTE-P)', () => {
    it("a crop stopped while the worker reads it answers no water, and the worker's answer is dropped", async () => {
        serveCanalTiles();
        TestWorker.behaviour = 'hold';
        const stop = new AbortController();
        const crop = fetchSatelliteWater(CANAL_BBOX, TOKEN, undefined, undefined, stop.signal);
        await until(() => TestWorker.instances[0]?.held.length === 1, 'the crop');
        stop.abort();
        TestWorker.instances[0].release();
        expect(await crop).toEqual({ type: 'FeatureCollection', features: [] });
        expect(mainReads).not.toHaveBeenCalled();
    });

    it('a stopped crop whose worker then crashes is not read on the main thread', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        serveCanalTiles();
        TestWorker.behaviour = 'hold';
        const stop = new AbortController();
        const crop = fetchSatelliteWater(CANAL_BBOX, TOKEN, undefined, undefined, stop.signal);
        await until(() => TestWorker.instances[0]?.held.length === 1, 'the crop');
        stop.abort();
        TestWorker.instances[0].crash();
        expect(await crop).toEqual({ type: 'FeatureCollection', features: [] });
        expect(mainReads).not.toHaveBeenCalled();
        expect(decoder.decodes()).toBe(0);
    });
});

describe('an iOS memory warning while the worker reads a crop', () => {
    it('trims the worker and never ends it: the crop is still read there', async () => {
        serveCanalTiles();
        TestWorker.behaviour = 'hold';
        const crop = fetchSatelliteWater(CANAL_BBOX, TOKEN);
        await until(() => TestWorker.instances[0]?.held.length === 1, 'the crop');
        const w = TestWorker.instances[0];
        trimRouteWorkers();
        expect(w.trims).toBe(1);
        expect(w.terminated).toBe(false);
        w.release();
        expect(await crop).toEqual(reference);
        expect(mainReads).not.toHaveBeenCalled();
        // Idle again: the next warning ends it, as before.
        trimRouteWorkers();
        expect(w.terminated).toBe(true);
    });
});
