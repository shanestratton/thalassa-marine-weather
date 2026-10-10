/**
 * The route job crosses to a worker as a structured clone, and its answer
 * comes back the same way (127-ROUTE-W). So neither may hold a function or a
 * class instance that a clone would lose: the old result's chart-water probe
 * was a function, which is why the job now answers with chart verdicts.
 *
 * The jobs here are the ones tryInshoreRoute really posts (the host is
 * replaced by one that keeps them): a synthetic archipelago route, a
 * Seaway-promoted route and a refusal, all synthetic.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    AIR_DRAFT_M,
    DRAFT_M,
    FIXED_NOW,
    installArchipelago,
    installAtlanticChannel,
    installAtlanticWall,
} from './helpers/routeJobScenes';

const kept = vi.hoisted(() => ({ jobs: [] as unknown[] }));

vi.mock('../services/routing/routeWorkerHost', async (original) => {
    const { runRouteJob } = await import('../services/routing/routeJob');
    return {
        ...(await original<Record<string, unknown>>()),
        runRouteJobHosted: async (job: never) => {
            kept.jobs.push(structuredClone(job));
            return { output: runRouteJob(job), where: 'main', waitMs: 0, handoffMs: 0, backMs: 0 };
        },
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
vi.mock('../services/OsmRouteOverlayService', async (original) => {
    const { scene } = await import('./helpers/routeJobScenes');
    return {
        ...(await original<Record<string, unknown>>()),
        getOsmRouteOverlay: async () => (scene.osm ? structuredClone(scene.osm) : null),
    };
});
vi.mock('../services/satelliteWater', () => ({
    fetchSatelliteWater: async () => ({ type: 'FeatureCollection', features: [] }),
}));
vi.mock('../services/mapboxWater', () => ({
    fetchMapboxWater: async () => ({ type: 'FeatureCollection', features: [] }),
}));
vi.mock('../services/lowBridges', async (original) => ({
    ...(await original<Record<string, unknown>>()),
    loadLowBridges: async () => [],
}));
vi.mock('../services/ntmRouting', () => ({
    activeNtmZonesFor: async () => ({ features: [], tracklines: [] }),
    packsForCorridor: async () => [],
}));
vi.mock('../services/TideHeightService', async (original) => {
    const { scene, syntheticTideCurve } = await import('./helpers/routeJobScenes');
    return {
        ...(await original<Record<string, unknown>>()),
        fetchTideCurve: async (_lat: number, _lon: number, startMs: number, endMs: number) =>
            scene.tide ? syntheticTideCurve(scene.tide.meanM, scene.tide.ampM, startMs, endMs) : null,
    };
});

import { tryInshoreRoute } from '../services/InshoreRouter';
import { runRouteJob, type RouteJob } from '../services/routing/routeJob';
import { trimNavGridCache } from '../services/engine/navGrid';

/** Every function or non-plain object anywhere in a value, by path. */
function unclonable(value: unknown, path = '$', out: string[] = []): string[] {
    if (typeof value === 'function') out.push(`${path}: function`);
    else if (value && typeof value === 'object') {
        const proto = Object.getPrototypeOf(value);
        const plain = proto === Object.prototype || proto === null || Array.isArray(value) || ArrayBuffer.isView(value);
        if (!plain) out.push(`${path}: ${proto?.constructor?.name ?? 'object'}`);
        else if (!ArrayBuffer.isView(value))
            for (const [k, v] of Object.entries(value as Record<string, unknown>)) unclonable(v, `${path}.${k}`, out);
    }
    return out;
}

const withoutTimings = (out: ReturnType<typeof runRouteJob>) => {
    const r = out.result as Record<string, unknown> | null;
    return r && 'elapsedMs' in r ? { ...r, elapsedMs: 0 } : r;
};

async function postedJob(install: () => { from: [number, number]; to: [number, number] }): Promise<RouteJob> {
    kept.jobs = [];
    trimNavGridCache(0);
    const { from, to } = install();
    await tryInshoreRoute({ lat: from[1], lon: from[0] }, { lat: to[1], lon: to[0] }, DRAFT_M, AIR_DRAFT_M, 'safest', {
        departureMs: FIXED_NOW,
    });
    expect(kept.jobs).toHaveLength(1);
    return kept.jobs[0] as RouteJob;
}

beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in the clone tests'));
});

describe('the job and its answer survive a structured clone', () => {
    it.each([
        ['an archipelago route (5 NM)', () => installArchipelago()['5nm']],
        ['a Seaway-promoted route', installAtlanticChannel],
        ['a refusal (a land wall with no way round)', installAtlanticWall],
    ] as const)(
        '%s',
        async (_name, install) => {
            const job = await postedJob(install);
            expect(unclonable(job), 'the job carries no function or class instance').toEqual([]);
            const copy = structuredClone(job);
            trimNavGridCache(0);
            const direct = runRouteJob(job);
            trimNavGridCache(0);
            const cloned = runRouteJob(copy);
            expect(withoutTimings(cloned)).toEqual(withoutTimings(direct));
            expect(unclonable(direct), 'the answer carries no function or class instance').toEqual([]);
            expect(structuredClone(direct)).toEqual(direct);
        },
        120_000,
    );
});
