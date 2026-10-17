import './helpers/noPrivateRoutingAreas';

/**
 * The router prep's answers can land in any order: the route does not move by
 * a byte (128-ROUTE-P).
 *
 * Shane: Auto takes "more like a minute :)", and most of that minute is the
 * prep waiting on the network, one answer after another. 128 asks for the
 * independent ones together (the cells, the OSM water, the satellite water,
 * the curated bridges, the Notice to Mariners zones and the tides), and after
 * the router the notice lookups beside the ETOPO check. Auto is "unbelievably
 * cool. fucken unreal", so what it decides must not change: every answer is
 * still merged where it was, in the order it was.
 *
 * Every IO seam here is a fake with a fixed, non-trivial answer (three
 * synthetic chart cells, OSM water, satellite water at the departure, vector
 * water at the destination, a curated low bridge, an NtM survey zone, a tide,
 * ETOPO, a notice pack and a local notice), held until the driver lands it
 * (tests/helpers/prepWaits.ts). Each order below lands them differently; the
 * route (tryInshoreRoute) and Auto's proposal with its warnings
 * (calculateThalassaProposal) must equal goldens captured on the unchanged
 * 127 code (5366f6784), where the prep asked for them one at a time. So must
 * every route job the prep posted (the *-job goldens): its merged layers in
 * their order, so a lost or reordered answer fails even where it does not
 * move the line (the bridge here is off the route, the NtM zone in deep water).
 * 139-04 extends those contracts with actual RESARE/TSEZNE inputs and missing
 * class coverage. The updated goldens retain the same route geometry while
 * including the new explicit restriction-check caveat and job metadata.
 *
 * The scene is the invented archipelago at 161.0E 20.3S (no real place, no
 * real chart; tests/fixtures/syntheticArchipelago.ts). The notices and the
 * bridge are made up here.
 * Goldens: ROUTEJOB_GOLDEN_WRITE=1 rewrites tests/fixtures/routeJob/prep-orders-*.json.
 * Run: NODE_OPTIONS=--max-old-space-size=4096 npx vitest run tests/inshoreRouter.prepParity.test.ts --maxWorkers=1
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Feature, FeatureCollection } from 'geojson';
import {
    AIR_DRAFT_M,
    DRAFT_M,
    FIXED_NOW,
    golden,
    installArchipelago,
    routeSummary,
    scene,
    sha256,
} from './helpers/routeJobScenes';
import { byName, firstAsked, lastAsked, seeded, waits, type PickWait } from './helpers/prepWaits';

// This scene has no saved private tracks. Keep the IO seam explicit rather
// than falling through an incomplete global Supabase mock after 139-02.
vi.mock('../services/shiplog/EntryCrud', () => ({ getLogEntries: async () => [] }));

const fake = vi.hoisted(() => ({
    ends: null as null | { from: [number, number]; to: [number, number] },
    /** Cells not on the phone yet (hasCellGeoJSON says no): the satellite crops wait for them. */
    missing: new Set<string>(),
    /** Each route job the prep posted, as canonical JSON at the moment it was posted. */
    jobs: [] as { text: string; layers: Record<string, number>; cells: string[] }[],
}));

type LonLat = [number, number];
const square = ([lon, lat]: LonLat, halfM: number): Feature => {
    const dLat = halfM / 111_320;
    const dLon = halfM / (111_320 * Math.cos((lat * Math.PI) / 180));
    return {
        type: 'Feature',
        properties: {},
        geometry: {
            type: 'Polygon',
            coordinates: [
                [
                    [lon - dLon, lat - dLat],
                    [lon + dLon, lat - dLat],
                    [lon + dLon, lat + dLat],
                    [lon - dLon, lat + dLat],
                    [lon - dLon, lat - dLat],
                ],
            ],
        },
    };
};
const fc = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
const inBox = (b: readonly number[], [lon, lat]: LonLat): boolean =>
    lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];
const midpoint = (): LonLat => {
    const { from, to } = fake.ends!;
    return [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
};

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
    const { waits } = await import('./helpers/prepWaits');
    return {
        ...(await original<Record<string, unknown>>()),
        hasCellGeoJSON: async (id: string) => !fake.missing.has(id),
        loadCellGeoJSON: (id: string) =>
            waits.ask(`cell:${id}`, () => {
                const blob = scene.blobs.get(id);
                return blob ? structuredClone(blob) : null;
            }),
    };
});
// The route job as the prep posts it (the merged layers in their order: the
// cells, the OSM and endpoint water, the bridges' bars, the NtM zone), so the
// goldens see every merge, not only the ones that move the line.
vi.mock('../services/routing/routeWorkerHost', async (original) => {
    const { canonicalJson } = await import('./helpers/routeJobScenes');
    const mod = await original<typeof import('../services/routing/routeWorkerHost')>();
    return {
        ...mod,
        runRouteJobHosted: (job: Parameters<typeof mod.runRouteJobHosted>[0], opts: never) => {
            const layers: Record<string, number> = {};
            for (const [k, v] of Object.entries(job.layers as Record<string, { features?: unknown[] } | undefined>))
                if (v?.features?.length) layers[k] = v.features.length;
            fake.jobs.push({ text: canonicalJson(job), layers, cells: [...job.cellsUsed] });
            return mod.runRouteJobHosted(job, opts);
        },
    };
});
vi.mock('../services/OsmRouteOverlayService', async (original) => {
    const { scene } = await import('./helpers/routeJobScenes');
    const { waits } = await import('./helpers/prepWaits');
    return {
        ...(await original<Record<string, unknown>>()),
        getOsmRouteOverlay: () => waits.ask('osm', () => (scene.osm ? structuredClone(scene.osm) : null)),
    };
});
// Satellite water at the departure's crop; none at the destination's, which
// then falls back to the vector water (the per-crop ladder).
vi.mock('../services/satelliteWater', async () => {
    const { waits } = await import('./helpers/prepWaits');
    return {
        fetchSatelliteWater: (b: number[]) =>
            waits.ask('sat', () => fc(inBox(b, fake.ends!.from) ? [square(fake.ends!.from, 60)] : [])),
    };
});
vi.mock('../services/mapboxWater', async () => {
    const { waits } = await import('./helpers/prepWaits');
    return {
        fetchMapboxWater: (b: number[]) =>
            waits.ask('vec', () => fc(inBox(b, fake.ends!.to) ? [square(fake.ends!.to, 80)] : [])),
    };
});
// A made-up low bridge ~3 km south of the departure, off the route: its bars
// still join the chart's OBSTRN, after the chart's own structures.
vi.mock('../services/lowBridges', async (original) => {
    const { waits } = await import('./helpers/prepWaits');
    return {
        ...(await original<Record<string, unknown>>()),
        loadLowBridges: () =>
            waits.ask('bridges', () => {
                const [lon, lat] = fake.ends!.from;
                return [
                    {
                        id: 'zz-bridge-1',
                        name: 'Synthetic Bridge',
                        clearanceM: 5,
                        span: [
                            [lon + 0.01, lat - 0.027],
                            [lon + 0.012, lat - 0.027],
                        ] as [number, number][],
                    },
                ];
            }),
    };
});
vi.mock('../services/ntmRouting', async () => {
    const { waits } = await import('./helpers/prepWaits');
    return {
        // A made-up surveyed zone (25 m) at the leg's middle, as activeNtmZonesFor shapes one.
        activeNtmZonesFor: () =>
            waits.ask('ntm', () => {
                const zone = square(midpoint(), 300);
                zone.properties = {
                    _class: 'ntm-survey',
                    depthM: 25,
                    _noticeKey: 'ZZ NtM 1/2026#r1',
                    _label: 'Synthetic Sound',
                };
                return { features: [zone], tracklines: [], packIds: ['zz-ntm-1'] };
            }),
        packsForCorridor: () =>
            waits.ask('packs', () => [
                {
                    pack: {
                        noticeKey: 'ZZ NtM 1/2026',
                        title: 'Synthetic Sound — surveyed depths',
                        surveyed: '2026-09-01',
                    },
                    status: { status: 'current' },
                    optedOut: false,
                },
            ]),
    };
});
vi.mock('../services/localNotices', async (original) => {
    const { waits } = await import('./helpers/prepWaits');
    return {
        ...(await original<Record<string, unknown>>()),
        loadLocalNotices: () =>
            waits.ask('notices', () => {
                const [lon, lat] = midpoint();
                return [
                    {
                        id: 'zz-local-1',
                        title: 'Synthetic Sound — works',
                        category: 'works',
                        lat,
                        lon,
                        radiusM: 3000,
                        summary: 'Made up for the test.',
                        detail: 'Made up for the test.',
                    },
                ];
            }),
    };
});
vi.mock('../services/TideHeightService', async (original) => {
    const { scene, syntheticTideCurve } = await import('./helpers/routeJobScenes');
    const { waits } = await import('./helpers/prepWaits');
    return {
        ...(await original<Record<string, unknown>>()),
        fetchTideCurve: (_lat: number, _lon: number, startMs: number, endMs: number) =>
            waits.ask('tide', () =>
                scene.tide ? syntheticTideCurve(scene.tide.meanM, scene.tide.ampM, startMs, endMs) : null,
            ),
    };
});
vi.mock('../services/GebcoDepthService', async (original) => {
    const { waits } = await import('./helpers/prepWaits');
    const mod = await original<Record<string, unknown>>();
    const service = Object.create(mod.GebcoDepthService as object) as Record<string, unknown>;
    service.queryRouteRelief = (points: { lat: number; lon: number }[]) =>
        waits.ask('relief', () => ({ depths: points.map((p) => ({ lat: p.lat, lon: p.lon, depth_m: -25 })) }));
    return { ...mod, GebcoDepthService: service };
});
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: {
        getState: () => ({ settings: { autorouteTrialEnabled: true } }),
        subscribe: () => () => {},
    },
}));

import { tryInshoreRoute } from '../services/InshoreRouter';
import { calculateThalassaProposal } from '../services/autoroutingThalassa';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { trimNavGridCache } from '../services/engine/navGrid';

/**
 * The jobs the prep posted, as their golden holds them: each one's canonical
 * JSON hashed (every merged layer, in its order), and each one's cells and
 * layer counts to read.
 */
function jobsGolden(name: string): [unknown, unknown] {
    return golden(
        name,
        fake.jobs.map((j) => sha256(j.text)),
        { jobs: fake.jobs.map(({ cells, layers }) => ({ cells, layers })) },
    );
}

/** The route as the goldens hold it: no timing. */
function routeShape(res: unknown): unknown {
    if (!res || typeof res !== 'object' || !('polyline' in res)) return res ?? null;
    const { elapsedMs: _elapsed, ...rest } = res as Record<string, unknown>;
    return rest;
}

const ORDERS: [string, PickWait][] = [
    ['as asked', firstAsked],
    ['last asked first', lastAsked],
    [
        'the network first, the cells last and backwards',
        byName(['osm', 'sat', 'vec', 'ntm', 'bridges', 'tide', 'cell']),
    ],
    [
        'the cells first and backwards, the OSM water last',
        byName(['cell', 'tide', 'bridges', 'ntm', 'vec', 'sat', 'osm']),
    ],
    ['seeded 7', seeded(7)],
    ['seeded 2026', seeded(2026)],
];

beforeAll(() => {
    setAuthIdentityScope('prep-parity');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in the prep parity tests'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    waits.reset();
    fake.missing.clear();
    fake.jobs = [];
    // A (fictional) Mapbox token, so the prep fetches its water crops.
    vi.stubEnv('VITE_MAPBOX_ACCESS_TOKEN', 'pk.test-not-a-token');
    return () => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
    };
});

describe('tryInshoreRoute: the archipelago 12 NM leg, whatever order the prep answers land in', () => {
    it.each(ORDERS)(
        '%s: the same route, bit for bit',
        async (_label, pick) => {
            const { from, to } = installArchipelago()['12nm'];
            fake.ends = { from, to };
            const res = await waits.drive(
                tryInshoreRoute(
                    { lat: from[1], lon: from[0] },
                    { lat: to[1], lon: to[0] },
                    DRAFT_M,
                    AIR_DRAFT_M,
                    'safest',
                    {
                        departureMs: FIXED_NOW,
                    },
                ),
                pick,
            );
            expect(res && 'polyline' in res, 'the archipelago routes').toBe(true);
            // Every fake answered: cells, OSM, both crops (one by the vector
            // fallback), the bridges, the NtM zone and the tides.
            for (const name of ['cell:', 'osm', 'sat', 'vec', 'bridges', 'ntm', 'tide'])
                expect(
                    waits.landed.some((w) => w.name.startsWith(name)),
                    name,
                ).toBe(true);
            const shape = routeShape(res);
            const [actual, expected] = golden('prep-orders-archipelago-12nm', shape, routeSummary(shape));
            expect(actual).toEqual(expected);
            // …and the job it routed, every merged layer in its order (the
            // bridges' bars and the NtM zone among them, which this line
            // never touches).
            const [jobs, expectedJobs] = jobsGolden('prep-orders-archipelago-12nm-job');
            expect(jobs).toEqual(expectedJobs);
        },
        120_000,
    );

    it('a cell the phone does not hold yet comes first: the satellite crops wait for it, and the route is the same', async () => {
        const { from, to } = installArchipelago()['12nm'];
        fake.ends = { from, to };
        const [first] = scene.cells as { id: string }[];
        fake.missing.add(first.id);
        const res = await waits.drive(
            tryInshoreRoute(
                { lat: from[1], lon: from[0] },
                { lat: to[1], lon: to[0] },
                DRAFT_M,
                AIR_DRAFT_M,
                'safest',
                {
                    departureMs: FIXED_NOW,
                },
            ),
            firstAsked,
        );
        // Landed as asked: the crops were asked only once every cell was in.
        const at = (prefix: string) => waits.landed.findIndex((w) => w.name.startsWith(prefix));
        const lastCell = waits.landed.reduce((n, w, i) => (w.name.startsWith('cell:') ? i : n), -1);
        expect(lastCell).toBeGreaterThan(-1);
        expect(at('sat'), 'the first crop lands after the last cell').toBeGreaterThan(lastCell);
        // The OSM water is still asked for beside the cells.
        expect(at('osm')).toBeLessThan(lastCell);
        const shape = routeShape(res);
        const [actual, expected] = golden('prep-orders-archipelago-12nm', shape, routeSummary(shape));
        expect(actual).toEqual(expected);
        const [jobs, expectedJobs] = jobsGolden('prep-orders-archipelago-12nm-job');
        expect(jobs).toEqual(expectedJobs);
    }, 120_000);

    it('asks for the OSM water, the satellite water, the bridges, the notice zones and the tides before the first cell lands', async () => {
        const { from, to } = installArchipelago()['12nm'];
        fake.ends = { from, to };
        await waits.drive(
            tryInshoreRoute(
                { lat: from[1], lon: from[0] },
                { lat: to[1], lon: to[0] },
                DRAFT_M,
                AIR_DRAFT_M,
                'safest',
                {
                    departureMs: FIXED_NOW,
                },
            ),
            byName(['osm', 'sat', 'vec', 'ntm', 'bridges', 'tide', 'cell']),
        );
        const firstCell = waits.landed.findIndex((w) => w.name.startsWith('cell:'));
        const at = (name: string) => waits.landed.findIndex((w) => w.name === name);
        for (const name of ['osm#1', 'sat#1', 'sat#2', 'bridges#1', 'ntm#1', 'tide#1'])
            expect(at(name), `${name} lands before the first cell`).toBeLessThan(firstCell);
        // …and the cells themselves land out of their listed order (merged in it all the same).
        const landedCells = waits.landed.filter((w) => w.name.startsWith('cell:')).map((w) => w.name);
        const listed = (scene.cells as { id: string }[]).map((c) => `cell:${c.id}#1`);
        expect(landedCells.length).toBeGreaterThan(1);
        expect(landedCells).not.toEqual(listed.filter((n) => landedCells.includes(n)));
    }, 120_000);
});

describe("Auto's provider: the archipelago 5 NM leg, its line and its warnings, whatever order", () => {
    const proposalShape = (p: Awaited<ReturnType<typeof calculateThalassaProposal>>) => {
        const { id: _id, createdAt: _at, engine, ...rest } = p;
        const { elapsedMs: _elapsed, ...engineRest } = engine ?? ({} as Record<string, unknown>);
        return { ...rest, engine: engineRest };
    };
    const PROVIDER_ORDERS: [string, PickWait][] = [
        ...ORDERS,
        ['the notices first, ETOPO last', byName(['notices', 'packs', 'osm', 'cell', 'sat', 'vec', 'relief'])],
        ['ETOPO first, the local notices before the packs', byName(['relief', 'notices', 'packs'])],
    ];

    it.each(PROVIDER_ORDERS)(
        '%s: the same proposal',
        async (_label, pick) => {
            const { from, to } = installArchipelago()['5nm'];
            fake.ends = { from, to };
            const p = await waits.drive(
                calculateThalassaProposal({
                    departure: { lat: from[1], lon: from[0] },
                    destination: { lat: to[1], lon: to[0] },
                    draftM: DRAFT_M,
                    speedKts: 6,
                } as never),
                pick,
            );
            expect(p.engine?.backstop).toBe('verified');
            // The notices are said, in today's order: the pack first, then the local notice.
            const pack = p.warnings.findIndex((w) => w.startsWith('Routing follows a current Notice to Mariners'));
            const local = p.warnings.findIndex((w) => w.startsWith('Notice to Mariners on this route'));
            expect(pack).toBeGreaterThan(-1);
            expect(local).toBe(pack + 1);
            const shape = proposalShape(p);
            const [actual, expected] = golden('prep-orders-provider-5nm', shape, {
                points: p.coordinates.length,
                warnings: p.warnings.length,
                backstop: p.engine?.backstop,
            });
            expect(actual).toEqual(expected);
            const [jobs, expectedJobs] = jobsGolden('prep-orders-provider-5nm-job');
            expect(jobs).toEqual(expectedJobs);
        },
        120_000,
    );
});
