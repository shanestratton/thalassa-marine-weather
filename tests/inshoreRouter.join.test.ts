/**
 * tryInshoreRoute can be stopped (127-ROUTE-W decision 7).
 *
 * Callers asking for the same leg share one run (the dedupe map); each one
 * that stops detaches alone, and the run stops when the last caller has
 * gone. A run stopped in the prep leaves the dedupe map at once (critic), so
 * a re-tap of the same leg starts afresh instead of joining a stopped run.
 * The 85 s watchdog now really stops the router, with today's words.
 *
 * The prep runs for real on a small synthetic scene in the open North
 * Atlantic; the OSM water can be held to keep a run in the prep. The route
 * worker's host is a fake that holds each job until the test lets it go.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AIR_DRAFT_M, DRAFT_M, FIXED_NOW, installAtlanticChannel, scene } from './helpers/routeJobScenes';

const host = vi.hoisted(() => ({
    jobs: [] as { aborted: boolean; release: () => void; job: unknown }[],
    osmHold: null as null | Promise<void>,
    osmCalls: 0,
    /** The prep's later waits: the satellite and vector water, and the notices. */
    satCalls: 0,
    vectorCalls: 0,
    ntmCalls: 0,
}));

vi.mock('../services/routing/routeWorkerHost', async (original) => {
    const { runRouteJob } = await import('../services/routing/routeJob');
    return {
        ...(await original<Record<string, unknown>>()),
        runRouteJobHosted: (job: never, opts: { signal?: AbortSignal; onStage?: (s: string) => void } = {}) =>
            new Promise((resolve, reject) => {
                const entry = {
                    job,
                    aborted: false,
                    release: () => {
                        opts.onStage?.('done');
                        resolve({ output: runRouteJob(job), where: 'worker', waitMs: 0, handoffMs: 0, backMs: 0 });
                    },
                };
                opts.signal?.addEventListener('abort', () => {
                    entry.aborted = true;
                    reject(new DOMException('Stopped', 'AbortError'));
                });
                opts.onStage?.('routing');
                host.jobs.push(entry);
            }),
        trimRouteWorkers: () => {},
    };
});
vi.mock('../services/enc/EncCellMetadata', async (original) => {
    const { scene } = await import('./helpers/routeJobScenes');
    const cells = () => scene.cells as { bbox: [number, number, number, number] }[];
    return {
        ...(await original<Record<string, unknown>>()),
        cellsForBBox: (b: [number, number, number, number]) =>
            cells().filter((c) => !(c.bbox[2] < b[0] || c.bbox[0] > b[2] || c.bbox[3] < b[1] || c.bbox[1] > b[3])),
        listCells: () => cells(),
    };
});
vi.mock('../services/enc/EncCellStore', async (original) => {
    const { scene } = await import('./helpers/routeJobScenes');
    return {
        ...(await original<Record<string, unknown>>()),
        loadCellGeoJSON: async (id: string) => {
            const blob = scene.blobs.get(id);
            return blob ? structuredClone(blob) : null;
        },
    };
});
vi.mock('../services/OsmRouteOverlayService', async (original) => ({
    ...(await original<Record<string, unknown>>()),
    getOsmRouteOverlay: async () => {
        host.osmCalls++;
        if (host.osmHold) await host.osmHold;
        return null;
    },
}));
vi.mock('../services/satelliteWater', () => ({
    fetchSatelliteWater: async () => {
        host.satCalls++;
        return { type: 'FeatureCollection', features: [] };
    },
}));
vi.mock('../services/mapboxWater', () => ({
    fetchMapboxWater: async () => {
        host.vectorCalls++;
        return { type: 'FeatureCollection', features: [] };
    },
}));
vi.mock('../services/lowBridges', async (original) => ({
    ...(await original<Record<string, unknown>>()),
    loadLowBridges: async () => [],
}));
vi.mock('../services/ntmRouting', () => ({
    activeNtmZonesFor: async () => {
        host.ntmCalls++;
        return { features: [], tracklines: [] };
    },
    packsForCorridor: async () => [],
}));
vi.mock('../services/TideHeightService', async (original) => ({
    ...(await original<Record<string, unknown>>()),
    fetchTideCurve: async () => null,
}));

import { tryInshoreRoute } from '../services/InshoreRouter';

let ends: ReturnType<typeof installAtlanticChannel>;
const ask = (opts: { signal?: AbortSignal; onStage?: (s: string) => void } = {}) =>
    tryInshoreRoute(
        { lat: ends.from[1], lon: ends.from[0] },
        { lat: ends.to[1], lon: ends.to[0] },
        DRAFT_M,
        AIR_DRAFT_M,
        'safest',
        { departureMs: FIXED_NOW, ...opts },
    );
const posted = async (n: number): Promise<void> => {
    for (let i = 0; i < 400 && host.jobs.length < n; i++) await new Promise((r) => setTimeout(r, 5));
    expect(host.jobs.length).toBe(n);
};
const settle = () => new Promise((r) => setTimeout(r, 30));

beforeEach(() => {
    host.jobs = [];
    host.osmHold = null;
    host.osmCalls = 0;
    host.satCalls = 0;
    host.vectorCalls = 0;
    host.ntmCalls = 0;
    // A (fictional) Mapbox token, so the prep always fetches its water crops.
    vi.stubEnv('VITE_MAPBOX_ACCESS_TOKEN', 'pk.test-not-a-token');
    ends = installAtlanticChannel();
    void scene;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in the join tests'));
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe('callers asking for the same leg share one run', () => {
    it('two callers, one run, one answer', async () => {
        const a = ask();
        const b = ask();
        await posted(1);
        host.jobs[0].release();
        const [ra, rb] = await Promise.all([a, b]);
        expect(ra && 'polyline' in ra).toBe(true);
        expect(rb).toBe(ra);
        expect(host.osmCalls).toBe(1);
        // One prep: both water crops and the notices, once.
        expect(host.satCalls).toBe(2);
        expect(host.vectorCalls).toBe(2);
        expect(host.ntmCalls).toBe(1);
    });

    it('a joining caller hears the stage the run is already at', async () => {
        const first = ask();
        await posted(1);
        const stages: string[] = [];
        const second = ask({ onStage: (s) => stages.push(s) });
        expect(stages).toEqual(['routing']);
        host.jobs[0].release();
        await Promise.all([first, second]);
        expect(stages).toEqual(['routing', 'done']);
    });

    it('when A stops, only A detaches: A rejects with AbortError and B still gets the route', async () => {
        const stopA = new AbortController();
        const a = ask({ signal: stopA.signal });
        const b = ask();
        await posted(1);
        stopA.abort();
        await expect(a).rejects.toMatchObject({ name: 'AbortError' });
        expect(host.jobs[0].aborted).toBe(false);
        host.jobs[0].release();
        const rb = await b;
        expect(rb && 'polyline' in rb).toBe(true);
    });

    it('when every caller stops, the run itself is stopped', async () => {
        const stopA = new AbortController();
        const stopB = new AbortController();
        const a = ask({ signal: stopA.signal });
        const b = ask({ signal: stopB.signal });
        await posted(1);
        stopA.abort();
        expect(host.jobs[0].aborted).toBe(false);
        stopB.abort();
        await expect(a).rejects.toMatchObject({ name: 'AbortError' });
        await expect(b).rejects.toMatchObject({ name: 'AbortError' });
        expect(host.jobs[0].aborted).toBe(true);
    });

    it('a caller that is already stopped is refused before anything runs', async () => {
        const stop = new AbortController();
        stop.abort();
        await expect(ask({ signal: stop.signal })).rejects.toMatchObject({ name: 'AbortError' });
        await settle();
        expect(host.osmCalls).toBe(0);
    });
});

describe('a stop during the prep', () => {
    it('never posts the job, and the stopped prep starts nothing after its current wait', async () => {
        let release!: () => void;
        host.osmHold = new Promise<void>((r) => (release = r));
        const stop = new AbortController();
        const a = ask({ signal: stop.signal });
        for (let i = 0; i < 200 && host.osmCalls === 0; i++) await new Promise((r) => setTimeout(r, 5));
        stop.abort();
        await expect(a).rejects.toMatchObject({ name: 'AbortError' });
        release();
        await settle();
        expect(host.jobs).toHaveLength(0);
        // Review 2026-10-11: it drops out when the OSM wait ends, so no
        // satellite or vector water is fetched (or read on the main thread)
        // and no notices are asked for, beside a re-tap's fresh prep.
        expect(host.satCalls).toBe(0);
        expect(host.vectorCalls).toBe(0);
        expect(host.ntmCalls).toBe(0);
    });

    it('leaves the dedupe map at once: a re-tap starts a fresh run, which the stopped run never disturbs', async () => {
        let releaseFirst!: () => void;
        host.osmHold = new Promise<void>((r) => (releaseFirst = r));
        const stop = new AbortController();
        const stopped = ask({ signal: stop.signal });
        for (let i = 0; i < 200 && host.osmCalls === 0; i++) await new Promise((r) => setTimeout(r, 5));
        stop.abort();
        await expect(stopped).rejects.toMatchObject({ name: 'AbortError' });

        // The re-tap: a fresh run (a second prep), not the stopped one.
        host.osmHold = null;
        const fresh = ask();
        await posted(1);
        expect(host.osmCalls).toBe(2);

        // The stopped run's prep now finishes; its late clean-up must not
        // remove the fresh run from the dedupe map…
        releaseFirst();
        await settle();
        expect(host.jobs).toHaveLength(1);
        // …and runs no second prep beside it: only the fresh run's water and notices.
        expect(host.satCalls).toBe(2);
        expect(host.ntmCalls).toBe(1);
        // …so a third ask for the same leg joins the fresh run.
        const joined = ask();
        await settle();
        expect(host.osmCalls).toBe(2);
        host.jobs[0].release();
        const [rf, rj] = await Promise.all([fresh, joined]);
        expect(rf && 'polyline' in rf).toBe(true);
        expect(rj).toBe(rf);
    });
});

describe('the 85 s watchdog', () => {
    it("stops the run and answers with today's watchdog-timeout", async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const run = ask();
        await vi.waitFor(() => expect(host.jobs.length).toBe(1));
        await vi.advanceTimersByTimeAsync(85_000);
        const res = await run;
        expect(res).toMatchObject({ code: 'watchdog-timeout' });
        expect(host.jobs[0].aborted).toBe(true);
    });
});
