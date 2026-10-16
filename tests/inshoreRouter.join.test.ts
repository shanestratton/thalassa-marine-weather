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
 * Atlantic; the OSM water, the satellite water and the cells can be held to
 * keep a run in the prep. The route worker's host is a fake that holds each
 * job until the test lets it go.
 *
 * 128-ROUTE-P: the prep asks for its independent waits together (the OSM
 * water, the satellite water, the notice zones beside the cells), so a run
 * stopped in the prep has usually asked for them already. What a stop
 * guarantees now: the run ends at once, never posts its job, starts nothing
 * after the stop (no further cell read, no vector water, no second ask), and
 * the satellite crops it asked for are told to stop before their main-thread
 * read. A run that ends without its asks (no cell could be read) tells them
 * the same, and a cell the phone does not hold yet is fetched before the
 * crops are asked for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    AIR_DRAFT_M,
    DRAFT_M,
    FIXED_NOW,
    installArchipelago,
    installAtlanticChannel,
    scene,
} from './helpers/routeJobScenes';

const host = vi.hoisted(() => ({
    jobs: [] as { aborted: boolean; release: () => void; job: unknown }[],
    osmHold: null as null | Promise<void>,
    osmCalls: 0,
    satHold: null as null | Promise<void>,
    /** The stop signal each satellite crop was handed (128-ROUTE-P). */
    satSignals: [] as (AbortSignal | undefined)[],
    cellHold: null as null | Promise<void>,
    cellCalls: 0,
    /** Cells not on the phone: each read pulls it from the boat's Pi first. */
    missing: new Set<string>(),
    /** Cells on the phone that cannot be read (a bad blob): loadCellGeoJSON answers null. */
    unreadable: new Set<string>(),
    pullHold: null as null | Promise<void>,
    pulls: 0,
    /** The prep's later waits: the satellite and vector water, and the notices. */
    satCalls: 0,
    vectorCalls: 0,
    ntmCalls: 0,
    packageCalls: [] as { cells: string[]; bounds: number[] }[],
    packageHold: null as null | Promise<void>,
    packageFailure: false,
    packageLeases: 0,
    packageReleases: 0,
    chartVersion: 0,
}));

vi.mock('../services/enc/noaaPackageWindow', () => ({
    loadNoaaPackageCohort: async (cells: { id: string }[], bounds: number[], assertCurrent: () => void = () => {}) => {
        const { scene } = await import('./helpers/routeJobScenes');
        const version = host.chartVersion;
        host.packageCalls.push({ cells: cells.map((c) => c.id), bounds });
        if (host.packageHold) await host.packageHold;
        assertCurrent();
        if (host.packageFailure) throw Error('Incomplete package');
        host.packageLeases++;
        const blobs = new Map(cells.map((c) => [c.id, structuredClone(scene.blobs.get(c.id))]));
        return {
            blobs,
            check: () => {
                assertCurrent();
                if (host.chartVersion !== version) throw Error('Chart revision changed');
            },
            release: () => {
                blobs.clear();
                host.packageLeases--;
                host.packageReleases++;
            },
        };
    },
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
        hasCellGeoJSON: async (id: string) => !host.missing.has(id),
        // A cell in host.missing is not on the phone: it climbs the remote
        // ladder (a Pi pull) through the caller's gate, as EncCellStore does.
        loadCellGeoJSON: async (
            id: string,
            _remote = true,
            climbOneAtATime: <T>(climb: () => Promise<T>) => Promise<T> = (climb) => climb(),
        ) => {
            host.cellCalls++;
            if (host.cellHold) await host.cellHold;
            if (host.missing.has(id))
                await climbOneAtATime(async () => {
                    host.pulls++;
                    if (host.pullHold) await host.pullHold;
                });
            if (host.unreadable.has(id)) return null;
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
    fetchSatelliteWater: async (_b: unknown, _token: unknown, _z: unknown, _c: unknown, signal?: AbortSignal) => {
        host.satCalls++;
        host.satSignals.push(signal);
        if (host.satHold) await host.satHold;
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

import { tryInshoreRoute, assembleTracerLayers } from '../services/InshoreRouter';

let ends: { from: [number, number]; to: [number, number] };
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
    host.satHold = null;
    host.satSignals = [];
    host.cellHold = null;
    host.cellCalls = 0;
    host.missing.clear();
    host.unreadable.clear();
    host.pullHold = null;
    host.pulls = 0;
    host.satCalls = 0;
    host.vectorCalls = 0;
    host.ntmCalls = 0;
    host.packageCalls = [];
    host.packageHold = null;
    host.packageFailure = false;
    host.packageLeases = 0;
    host.packageReleases = 0;
    host.chartVersion = 0;
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
    const asked = () => ({
        osm: host.osmCalls,
        sat: host.satCalls,
        vector: host.vectorCalls,
        ntm: host.ntmCalls,
        cells: host.cellCalls,
    });
    const exitLines = () =>
        (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
            .map((c) => c.map(String).join(' '))
            .filter((l) => l.includes('EXIT:'));

    it('ends the run at once, never posts the job, and starts nothing after the stop', async () => {
        let releaseOsm!: () => void;
        let releaseSat!: () => void;
        host.osmHold = new Promise<void>((r) => (releaseOsm = r));
        host.satHold = new Promise<void>((r) => (releaseSat = r));
        const stop = new AbortController();
        const a = ask({ signal: stop.signal });
        for (let i = 0; i < 200 && host.osmCalls === 0; i++) await new Promise((r) => setTimeout(r, 5));
        // Let the prep read every cell and settle onto the OSM wait (the OSM
        // water is asked for before the cells, so its count alone says nothing
        // about where the prep is): the stop lands there, where a phone's
        // 2.5-45 s of OSM waiting is.
        await settle();
        expect(host.cellCalls).toBe((scene.cells as unknown[]).length);
        expect(exitLines()).toHaveLength(0);
        const satAskedBesideOsm = host.satCalls;
        const before = asked();
        stop.abort();
        await expect(a).rejects.toMatchObject({ name: 'AbortError' });
        await settle();
        // The run's EXIT line is written now. (It reads "stopped" in the app;
        // here vitest's AbortSignal hands back Node's DOMException, which the
        // jsdom global does not claim, so the same line reads "threw".)
        const endedAtOnce = exitLines().length === 1;
        releaseOsm();
        releaseSat();
        await settle();
        expect(host.jobs).toHaveLength(0);
        // Review 2026-10-11: beside a re-tap's fresh prep, the stopped run
        // starts nothing new (no vector water, no second ask, no cell read)…
        expect(asked()).toEqual(before);
        // 128-ROUTE-P: the satellite crops were asked for beside the OSM
        // water; they read nothing on the main thread, each handed the run's
        // stop, now aborted…
        expect(satAskedBesideOsm).toBe(2);
        expect(host.satSignals).toHaveLength(2);
        expect(host.satSignals.every((s) => s?.aborted)).toBe(true);
        // …and the run itself ended at the stop, not when its OSM wait (up to
        // 20-45 s) ended.
        expect(endedAtOnce).toBe(true);
    });

    it('a stop while the cells load reads no more cells', async () => {
        const archipelago = installArchipelago()['5nm'];
        ends = { from: archipelago.from, to: archipelago.to };
        let releaseCells!: () => void;
        host.cellHold = new Promise<void>((r) => (releaseCells = r));
        const stop = new AbortController();
        const a = ask({ signal: stop.signal });
        for (let i = 0; i < 200 && host.cellCalls === 0; i++) await new Promise((r) => setTimeout(r, 5));
        await settle();
        const before = asked();
        stop.abort();
        await expect(a).rejects.toMatchObject({ name: 'AbortError' });
        releaseCells();
        await settle();
        expect(asked().cells).toBe(before.cells);
        expect(host.jobs).toHaveLength(0);
        // Two of the three cells read at once (128-ROUTE-P), never more.
        expect(before.cells).toBe(2);
    });

    it('a run that ends without its asks (no cell could be read) stops them: no crop is read, no vector water asked', async () => {
        // Listed and on the phone, but unreadable: the run ends at "No cells
        // could be loaded" with its satellite crops still in flight.
        for (const c of scene.cells as { id: string }[]) host.unreadable.add(c.id);
        let releaseSat!: () => void;
        host.satHold = new Promise<void>((r) => (releaseSat = r));
        let releaseCells!: () => void;
        host.cellHold = new Promise<void>((r) => (releaseCells = r));
        const run = ask();
        for (let i = 0; i < 200 && host.satCalls < 2; i++) await new Promise((r) => setTimeout(r, 5));
        releaseCells();
        const res = await run;
        expect(res).toBeNull();
        expect(host.satCalls).toBe(2);
        // The crops were told the run has ended, so they read nothing on the
        // main thread and fall back to no vector water when they land.
        expect(host.satSignals.every((s) => s?.aborted)).toBe(true);
        releaseSat();
        await settle();
        expect(host.vectorCalls).toBe(0);
        expect(host.jobs).toHaveLength(0);
    });

    it('a cell the phone does not hold yet comes before the satellite crops; a stop meanwhile asks for none', async () => {
        const archipelago = installArchipelago()['5nm'];
        ends = { from: archipelago.from, to: archipelago.to };
        const [first] = scene.cells as { id: string }[];
        host.missing.add(first.id);
        let releasePull!: () => void;
        host.pullHold = new Promise<void>((r) => (releasePull = r));
        const stop = new AbortController();
        const a = ask({ signal: stop.signal });
        a.catch(() => {});
        try {
            for (let i = 0; i < 200 && host.pulls === 0; i++) await new Promise((r) => setTimeout(r, 5));
            await settle();
            // The OSM water is asked for beside the pull; the crops wait for the cells.
            expect({ osm: host.osmCalls, sat: host.satCalls, pulls: host.pulls }).toEqual({ osm: 1, sat: 0, pulls: 1 });
            stop.abort();
            await expect(a).rejects.toMatchObject({ name: 'AbortError' });
            releasePull();
            await settle();
            expect({ sat: host.satCalls, vector: host.vectorCalls }).toEqual({ sat: 0, vector: 0 });
            expect(host.jobs).toHaveLength(0);
        } finally {
            // A failure above must not leave this leg's run in the dedupe map for the next test.
            stop.abort();
            releasePull();
        }
    });

    it("a stop during a Pi pull pulls no more cells, though the next one's read had already started", async () => {
        const archipelago = installArchipelago()['5nm'];
        ends = { from: archipelago.from, to: archipelago.to };
        // None of the three cells is on the phone yet: each comes from the boat's Pi.
        for (const c of scene.cells as { id: string }[]) host.missing.add(c.id);
        let releasePull!: () => void;
        host.pullHold = new Promise<void>((r) => (releasePull = r));
        const stop = new AbortController();
        const a = ask({ signal: stop.signal });
        for (let i = 0; i < 200 && host.pulls === 0; i++) await new Promise((r) => setTimeout(r, 5));
        await settle();
        // One pull at a time, as when the cells loaded one by one.
        expect(host.pulls).toBe(1);
        stop.abort();
        await expect(a).rejects.toMatchObject({ name: 'AbortError' });
        releasePull();
        await settle();
        // The cell read ahead was waiting for the Pi: after the stop it pulls nothing.
        expect(host.pulls).toBe(1);
        expect(host.jobs).toHaveLength(0);
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

        // The stopped run's OSM wait now ends; its late clean-up must not
        // remove the fresh run from the dedupe map…
        const freshAsked = { sat: host.satCalls, vector: host.vectorCalls, ntm: host.ntmCalls };
        releaseFirst();
        await settle();
        expect(host.jobs).toHaveLength(1);
        // …and it starts nothing beside the fresh run once that wait ends: no
        // water and no notices.
        expect({ sat: host.satCalls, vector: host.vectorCalls, ntm: host.ntmCalls }).toEqual(freshAsked);
        // …so a third ask for the same leg joins the fresh run.
        const joined = ask();
        await settle();
        expect(host.osmCalls).toBe(2);
        host.jobs[0].release();
        const [rf, rj] = await Promise.all([fresh, joined]);
        expect(rf && 'polyline' in rf).toBe(true);
        expect(rj).toBe(rf);
        // 128-ROUTE-P: the crops are asked once the prep has looked which
        // cells the phone holds; the first run was stopped before that, so it
        // asked for none, and these two are the fresh run's.
        expect(freshAsked.sat).toBe(2);
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

describe('complete NOAA inshore cohort and its real borrower', () => {
    const packageCells = () => {
        for (const c of scene.cells as Array<{ noaaPackage?: object }>) c.noaaPackage = {};
    };

    it('keeps ordinary and packaged chart layers identical through the real prep and engine', async () => {
        const ordinary = ask();
        await posted(1);
        const layers = structuredClone((host.jobs[0].job as { layers: unknown }).layers);
        host.jobs[0].release();
        const first = await ordinary;
        packageCells();
        const packaged = ask();
        await posted(2);
        expect((host.jobs[1].job as { layers: unknown }).layers).toEqual(layers);
        expect(host.packageLeases).toBe(1);
        host.jobs[1].release();
        const second = await packaged;
        expect(first && 'polyline' in first ? first.polyline : first).toEqual(
            second && 'polyline' in second ? second.polyline : second,
        );
        expect(host.packageLeases).toBe(0);
        expect(host.packageReleases).toBe(1);
        // Generic whole-cell / Pi / cloud reads never see a package.
        expect(host.cellCalls).toBe(1);
    });

    it('includes a package outside the pin envelope but inside the full long-leg engine padding', async () => {
        ends.to = [ends.from[0] + 0.6, ends.from[1]];
        const coarse = scene.cells[0] as { bbox: number[] };
        coarse.bbox = [ends.from[0] - 1, ends.from[1] - 1, ends.to[0] + 1, ends.to[1] + 1];
        const id = 'US5SYN01';
        const bbox = [ends.from[0] + 0.1, ends.from[1] + 0.2, ends.from[0] + 0.2, ends.from[1] + 0.25];
        scene.cells.push({ ...coarse, id, bbox, noaaPackage: {} });
        scene.blobs.set(id, { ...(scene.blobs.values().next().value as object), cellId: id, bbox });
        const run = ask();
        await posted(1);
        const pad = 0.3;
        expect(host.packageCalls).toHaveLength(1);
        expect(host.packageCalls[0].cells).toEqual([id]);
        const wanted = [ends.from[0] - pad, ends.from[1] - pad, ends.to[0] + pad, ends.to[1] + pad];
        host.packageCalls[0].bounds.forEach((v, i) => expect(v).toBeCloseTo(wanted[i], 10));
        expect((host.jobs[0].job as { cellsUsed: string[] }).cellsUsed).toContain(id);
        host.jobs[0].release();
        await run;
        expect(host.packageLeases).toBe(0);
    });

    it('refuses a missing fine package before its extent can hide the coarse chart', async () => {
        const coarse = scene.cells[0] as { bbox: number[] };
        scene.cells.push({ ...coarse, id: 'US5SYN01', noaaPackage: {} });
        host.packageFailure = true;
        await expect(ask()).resolves.toMatchObject({ code: 'chart-window-unavailable' });
        expect(host.cellCalls).toBe(0);
        expect(host.jobs).toHaveLength(0);
        expect(host.packageLeases).toBe(0);
    });

    it('never accepts a result computed from a superseded package revision', async () => {
        packageCells();
        const run = ask();
        await posted(1);
        host.chartVersion++;
        host.jobs[0].release();
        await expect(run).rejects.toThrow('revision');
        expect(host.packageLeases).toBe(0);
    });

    it('an outer caller abort retains chart geometry until the actual prep wait ends', async () => {
        packageCells();
        let release!: () => void;
        host.osmHold = new Promise<void>((r) => (release = r));
        const stop = new AbortController();
        const run = ask({ signal: stop.signal });
        await vi.waitFor(() => expect(host.packageLeases).toBe(1));
        await vi.waitFor(() => expect(host.osmCalls).toBe(1));
        stop.abort();
        await expect(run).rejects.toMatchObject({ name: 'AbortError' });
        expect(host.packageLeases).toBe(1);
        release();
        await vi.waitFor(() => expect(host.packageLeases).toBe(0));
        expect(host.packageReleases).toBe(1);
        expect(host.jobs).toHaveLength(0);
    });

    it('a watchdog retains chart geometry until the actual prep wait ends', async () => {
        packageCells();
        let release!: () => void;
        host.osmHold = new Promise<void>((r) => (release = r));
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const run = ask();
        await vi.waitFor(() => expect(host.packageLeases).toBe(1));
        await vi.waitFor(() => expect(host.osmCalls).toBe(1));
        await vi.advanceTimersByTimeAsync(85_000);
        await expect(run).resolves.toMatchObject({ code: 'watchdog-timeout' });
        expect(host.packageLeases).toBe(1);
        release();
        await vi.waitFor(() => expect(host.packageLeases).toBe(0));
        expect(host.jobs).toHaveLength(0);
    });

    it('the tracer transfers its complete window lease instead of releasing borrowed geometry on assembly', async () => {
        packageCells();
        const bbox: [number, number, number, number] = [-30.06, 39.95, -29.94, 40.05];
        const bundle = await assembleTracerLayers(bbox, { chartedDepthOnly: true });
        expect(bundle?.cellsUsed.length).toBe(1);
        expect(host.packageCalls).toEqual([{ cells: ['ZZ5ATL01'], bounds: bbox }]);
        expect(host.cellCalls).toBe(0);
        expect(host.packageLeases).toBe(1);
        bundle?.chartView?.release();
        expect(host.packageLeases).toBe(0);
    });

    it('the tracer refuses a package read failure before coarse/fine deconfliction', async () => {
        packageCells();
        host.packageFailure = true;
        const bundle = await assembleTracerLayers([-30.06, 39.95, -29.94, 40.05]);
        expect(bundle).toBeNull();
        expect(host.cellCalls).toBe(0);
        expect(host.packageLeases).toBe(0);
    });
});
