/**
 * Routing off the main thread changes nothing about the route (127-ROUTE-W).
 *
 * Shane, 2026-10-10: "yes for a short while it looked as though the app had
 * frozen" — so the router moves into a worker. Auto is "unbelievably cool.
 * fucken unreal", so what it decides must not move by a bit. Each case runs
 * the real prep, engine, shadows and result through `tryInshoreRoute` (the
 * one seam every caller uses) and compares a canonical-JSON sha256 with a
 * golden captured on b127 (9b94cbf0f) BEFORE the change. `elapsedMs` is left
 * out; the chart-water probe the old result carried is replaced by its
 * verdict at every backstop sample, which is what the result carries now
 * (`chartVerdicts`). In vitest there is no Worker, so the job runs on the main
 * thread through the same runRouteJob the worker runs.
 *
 * Scenes are synthetic or NOAA only (tests/helpers/routeJobScenes.ts). The
 * NOAA cases skip, saying why, without THALASSA_ENC_SAMPLES.
 *
 * Goldens: ROUTEJOB_GOLDEN_WRITE=1 rewrites tests/fixtures/routeJob/*.json.
 * Run: NODE_OPTIONS=--max-old-space-size=4096 npx vitest run tests/routeJob.parity.test.ts --maxWorkers=1
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    AIR_DRAFT_M,
    DRAFT_M,
    FIXED_NOW,
    NOAA_ROUTE,
    golden,
    installArchipelago,
    installAtlanticChannel,
    installNoaa,
    noaaCellPath,
    routeSummary,
    scene,
} from './helpers/routeJobScenes';

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
vi.mock('../services/localNotices', () => ({
    loadLocalNotices: async () => [],
    localNoticesNearPolyline: () => [],
}));
vi.mock('../services/TideHeightService', async (original) => {
    const { scene, syntheticTideCurve } = await import('./helpers/routeJobScenes');
    return {
        ...(await original<Record<string, unknown>>()),
        fetchTideCurve: async (_lat: number, _lon: number, startMs: number, endMs: number) =>
            scene.tide ? syntheticTideCurve(scene.tide.meanM, scene.tide.ampM, startMs, endMs) : null,
    };
});
vi.mock('../services/GebcoDepthService', async (original) => {
    const { scene } = await import('./helpers/routeJobScenes');
    const mod = await original<Record<string, unknown>>();
    const service = Object.create(mod.GebcoDepthService as object) as Record<string, unknown>;
    service.queryRouteRelief = async (points: { lat: number; lon: number }[]) =>
        scene.relief === 'water'
            ? { depths: points.map((p) => ({ lat: p.lat, lon: p.lon, depth_m: -25 })) }
            : { depths: null, failure: { kind: 'offline' } };
    return { ...mod, GebcoDepthService: service };
});
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: {
        getState: () => ({ settings: { autorouteTrialEnabled: true } }),
        subscribe: () => () => {},
    },
}));

import { tryInshoreRoute } from '../services/InshoreRouter';
import { samplePolyline } from '../services/routing/landBackstop';
import { calculateThalassaProposal } from '../services/autoroutingThalassa';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { trimNavGridCache } from '../services/engine/navGrid';
import { routeInshore } from '../services/inshoreRouterEngine';

/** The route as the parity goldens hold it: no timing, and the chart verdicts as data. */
function parityShape(res: unknown): unknown {
    if (!res || typeof res !== 'object' || !('polyline' in res)) return res ?? null;
    const {
        elapsedMs: _elapsed,
        chartWater,
        chartVerdicts,
        ...rest
    } = res as Record<string, unknown> & {
        polyline: [number, number][];
        chartWater?: (lon: number, lat: number) => string;
        chartVerdicts?: string[];
    };
    const verdicts =
        chartVerdicts ??
        (chartWater
            ? samplePolyline(rest.polyline as [number, number][]).map(([lon, lat]) => {
                  try {
                      return chartWater(lon, lat);
                  } catch {
                      return 'unchecked';
                  }
              })
            : undefined);
    return { ...rest, ...(verdicts ? { chartVerdicts: verdicts } : {}) };
}

const route = (from: [number, number], to: [number, number]) =>
    tryInshoreRoute({ lat: from[1], lon: from[0] }, { lat: to[1], lon: to[0] }, DRAFT_M, AIR_DRAFT_M, 'safest', {
        departureMs: FIXED_NOW,
    });

beforeAll(() => {
    setAuthIdentityScope('routejob-parity');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in the parity tests'));
});
afterAll(() => {
    setAuthIdentityScope(null);
    vi.restoreAllMocks();
});
beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXED_NOW);
    // Every case starts cold, as a first route of the day does.
    trimNavGridCache(0);
    scene.relief = 'water';
    return () => vi.useRealTimers();
});

describe('the synthetic archipelago, strict, through tryInshoreRoute', () => {
    it.each(['5nm', '12nm', '20nm'] as const)(
        'marina → %s anchorage: the same route, bit for bit',
        async (leg) => {
            const routes = installArchipelago();
            const res = await route(routes[leg].from, routes[leg].to);
            expect(res && 'polyline' in res, 'the archipelago routes').toBe(true);
            const shape = parityShape(res);
            const [actual, expected] = golden(`archipelago-${leg}`, shape, routeSummary(shape));
            expect(actual).toEqual(expected);
        },
        120_000,
    );
});

describe('a Seaway-promoted route (a buoyed channel in the open North Atlantic)', () => {
    it('promotes the graph route, and it is the same route', async () => {
        const { from, to } = installAtlanticChannel();
        const res = await route(from, to);
        const shape = parityShape(res);
        const summary = routeSummary(shape);
        expect(summary.promoted, 'the graph route is promoted').toBe(true);
        const [actual, expected] = golden('atlantic-promoted', shape, summary);
        expect(actual).toEqual(expected);
    }, 60_000);
});

describe('NOAA US5GA22M (Savannah River, public domain)', () => {
    const noaa = noaaCellPath();
    const skip = 'skip' in noaa ? noaa.skip : null;
    if (skip) console.warn(`[routeJob.parity] NOAA cases skipped: ${skip}`);

    it.skipIf(!!skip)(
        'strict: the same refusal, code and words',
        async () => {
            installNoaa((noaa as { path: string }).path);
            const res = await route(NOAA_ROUTE.from, NOAA_ROUTE.to);
            const shape = parityShape(res);
            const [actual, expected] = golden('noaa-strict-refusal', shape, routeSummary(shape));
            expect(actual).toEqual(expected);
            expect(res && 'code' in res ? res.code : null).toBe('uncharted-corridor');
        },
        60_000,
    );

    it.skipIf(!!skip)(
        'permissive, through runRouteJob: the engine route on real NOAA geometry is unchanged',
        async () => {
            const { blob } = installNoaa((noaa as { path: string }).path);
            const layers = Object.fromEntries(
                ['LNDARE', 'DEPARE', 'OBSTRN', 'WRECKS', 'FAIRWY', 'DRGARE', 'BOYLAT', 'BCNLAT'].map((k) => [
                    k,
                    blob.layers[k] ?? { type: 'FeatureCollection', features: [] },
                ]),
            );
            const req = {
                fromLat: NOAA_ROUTE.from[1],
                fromLon: NOAA_ROUTE.from[0],
                toLat: NOAA_ROUTE.to[1],
                toLon: NOAA_ROUTE.to[0],
                draftM: DRAFT_M,
                safetyM: 0.5,
                obstructionBufferM: 60,
                unchartedPolicy: 'permissive' as const,
                routeProfile: 'safest' as const,
            };
            // What the engine itself answers on these layers (the golden, captured before the change).
            const engine = routeInshore(structuredClone(layers) as never, req);
            expect('polyline' in engine, 'permissive routes the river').toBe(true);
            const engineFields = (r: Record<string, unknown>) =>
                Object.fromEntries(
                    ['polyline', 'distanceNM', 'cautionMask', 'canalMask', 'channelMask', 'offshoreMask'].map((k) => [
                        k,
                        r[k],
                    ]),
                );
            const [actual, expected] = golden(
                'noaa-permissive-engine',
                engineFields(engine as never),
                routeSummary(engineFields(engine as never)),
            );
            expect(actual).toEqual(expected);
            // …and the route job hands the same engine route back.
            trimNavGridCache(0);
            // A variable specifier: the module does not exist before the change (captured first).
            const routeJobModule = '../services/routing/routeJob';
            const { runRouteJob } = (await import(
                /* @vite-ignore */ routeJobModule
            )) as typeof import('../services/routing/routeJob');
            const out = runRouteJob({
                layers: structuredClone(layers) as never,
                routeOpts: { ...req, surveyUncheckedCells: [] },
                origin: { lat: req.fromLat, lon: req.fromLon },
                destination: { lat: req.toLat, lon: req.toLon },
                airDraftM: AIR_DRAFT_M,
                cellsUsed: ['US5GA22M'],
                structuresUnknownCells: [],
                structuresUnknownBboxes: [],
                regionalPairs: [],
                leadGraph: null,
                tideCeilings: [],
            });
            expect(out.result && 'polyline' in out.result).toBe(true);
            expect(engineFields(out.result as never)).toEqual(engineFields(engine as never));
        },
        60_000,
    );
});

describe("Auto's provider: the same proposal", () => {
    const proposalShape = (p: Awaited<ReturnType<typeof calculateThalassaProposal>>) => {
        const { id: _id, createdAt: _at, engine, ...rest } = p;
        const { elapsedMs: _elapsed, ...engineRest } = engine ?? ({} as Record<string, unknown>);
        return { ...rest, engine: engineRest };
    };
    const request = (from: [number, number], to: [number, number]) => ({
        departure: { lat: from[1], lon: from[0] },
        destination: { lat: to[1], lon: to[0] },
        draftM: DRAFT_M,
        speedKts: 6,
    });

    it('archipelago 5 NM, ETOPO verified: equals its golden apart from id, createdAt and elapsedMs', async () => {
        const routes = installArchipelago();
        const p = await calculateThalassaProposal(request(routes['5nm'].from, routes['5nm'].to) as never);
        expect(p.engine?.backstop).toBe('verified');
        const shape = proposalShape(p);
        const [actual, expected] = golden('provider-archipelago-5nm-verified', shape, {
            points: p.coordinates.length,
            warnings: p.warnings.length,
            backstop: p.engine?.backstop,
        });
        expect(actual).toEqual(expected);
    }, 120_000);

    it('Atlantic channel, ETOPO unavailable: the chart verdicts are kept for Retry', async () => {
        const { from, to } = installAtlanticChannel();
        scene.relief = 'none';
        const p = await calculateThalassaProposal(request(from, to) as never);
        expect(p.engine?.backstop).toBe('unavailable');
        expect(p.engine?.backstopCharts?.length).toBe(samplePolyline(p.coordinates).length);
        const shape = proposalShape(p);
        const [actual, expected] = golden('provider-atlantic-unavailable', shape, {
            points: p.coordinates.length,
            warnings: p.warnings.length,
            backstop: p.engine?.backstop,
            backstopCharts: p.engine?.backstopCharts?.length ?? null,
        });
        expect(actual).toEqual(expected);
    }, 60_000);
});
