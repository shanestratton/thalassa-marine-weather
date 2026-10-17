/**
 * The router prep waits for its slowest answer, not for the sum of them (128-ROUTE-P).
 *
 * Shane, 2026-10-10: Auto takes "more like a minute :)", and "for a short
 * while it looked as though the app had frozen". 127 moved the router off the
 * main thread; most of the rest of that minute is the prep waiting on the
 * network, one answer after another (scratchpad routew127/measure.md §1-2):
 * the cells one at a time, then the OSM water, then the satellite water, the
 * bridges and the Notice to Mariners zones, and after the router the ETOPO
 * check, then the notice packs, then the local notices. Only the tides
 * overlapped. 128 asks for the independent ones together.
 *
 * Auto's real path runs here (calculateThalassaProposal → tryInshoreRoute →
 * the route job → the checks) on the invented archipelago at 161.0E 20.3S.
 * Every wait is a fake on a virtual clock (tests/helpers/prepWaits.ts) with
 * the measurement's phone-like delays; CPU takes no virtual time. Cell reads
 * queue on ONE lane, as every plugin call does on the iOS bridge (and
 * @capacitor/filesystem reads the whole file inline there), then parse on the
 * one parse worker.
 *
 * Today (127, 5366f6784), measured here: the prep waits 4,875 ms (3 × (150 +
 * 25) for the cells + 2,500 OSM + 1,500 satellite + 50 bridges + 300 NtM) and
 * the checks 1,700 ms (1,100 ETOPO + 300 packs + 300 local notices): 6,575 ms.
 * After: 2,500 ms (the OSM water) and 1,100 ms (ETOPO): 3,600 ms. With two
 * cells to pull from the boat's Pi first, the satellite crops wait for them:
 * 2,775 ms (127: 5,975 ms).
 *
 * Run: NODE_OPTIONS=--max-old-space-size=4096 npx vitest run tests/inshoreRouter.prepTimeline.test.ts --maxWorkers=1
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRAFT_M, FIXED_NOW, installArchipelago } from './helpers/routeJobScenes';
import { waits } from './helpers/prepWaits';

/** The measurement's delays (routew127/measure.md §2), in virtual ms. */
const t = vi.hoisted(() => ({
    ms: {
        read: 150,
        parse: 25,
        pi: 400,
        osm: 2_500,
        sat: 1_500,
        vec: 0,
        tide: 1_500,
        bridges: 50,
        ntm: 300,
        relief: 1_100,
        packs: 300,
        notices: 300,
    } as Record<string, number>,
    /** Cells that are not on the phone yet: they come from the boat's Pi. */
    missing: new Set<string>(),
    pi: { now: 0, max: 0 },
}));

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
// loadCellGeoJSON as EncCellStore runs it: the read on the bridge lane; a
// cell not on the phone climbs the remote ladder (the Pi), through the
// caller's one-at-a-time gate when it passes one, and is read again; then the
// parse worker. hasCellGeoJSON (a Filesystem.stat, no read) answers at once
// here; on the phone it is one short bridge call per cell not in the parse
// cache.
vi.mock('../services/enc/EncCellStore', async (original) => {
    const { scene } = await import('./helpers/routeJobScenes');
    const { waits } = await import('./helpers/prepWaits');
    type Climb = <T>(climb: () => Promise<T>) => Promise<T>;
    return {
        ...(await original<Record<string, unknown>>()),
        hasCellGeoJSON: async (id: string) => !t.missing.has(id),
        loadCellGeoJSON: async (id: string, _remote = true, climbOneAtATime: Climb = (climb) => climb()) => {
            const onPhone = await waits.ask(`read:${id}`, () => !t.missing.has(id), t.ms.read, 'bridge');
            if (!onPhone)
                await climbOneAtATime(async () => {
                    t.pi.max = Math.max(t.pi.max, ++t.pi.now);
                    try {
                        await waits.ask(`pi:${id}`, () => true, t.ms.pi);
                    } finally {
                        t.pi.now--;
                    }
                    await waits.ask(`read:${id}`, () => true, t.ms.read, 'bridge');
                });
            await waits.ask(`parse:${id}`, () => null, t.ms.parse, 'parse');
            const blob = scene.blobs.get(id);
            return blob ? structuredClone(blob) : null;
        },
    };
});
vi.mock('../services/OsmRouteOverlayService', async (original) => {
    const { scene } = await import('./helpers/routeJobScenes');
    const { waits } = await import('./helpers/prepWaits');
    return {
        ...(await original<Record<string, unknown>>()),
        getOsmRouteOverlay: () => waits.ask('osm', () => structuredClone(scene.osm), t.ms.osm),
    };
});
vi.mock('../services/satelliteWater', async () => {
    const { waits } = await import('./helpers/prepWaits');
    return {
        fetchSatelliteWater: () => waits.ask('sat', () => ({ type: 'FeatureCollection', features: [] }), t.ms.sat),
    };
});
vi.mock('../services/mapboxWater', async () => {
    const { waits } = await import('./helpers/prepWaits');
    return {
        fetchMapboxWater: () => waits.ask('vec', () => ({ type: 'FeatureCollection', features: [] }), t.ms.vec),
    };
});
vi.mock('../services/lowBridges', async (original) => {
    const { waits } = await import('./helpers/prepWaits');
    return {
        ...(await original<Record<string, unknown>>()),
        loadLowBridges: () => waits.ask('bridges', () => [], t.ms.bridges),
    };
});
vi.mock('../services/ntmRouting', async () => {
    const { waits } = await import('./helpers/prepWaits');
    return {
        activeNtmZonesFor: () => waits.ask('ntm', () => ({ features: [], tracklines: [], packIds: [] }), t.ms.ntm),
        packsForCorridor: () => waits.ask('packs', () => [], t.ms.packs),
    };
});
vi.mock('../services/localNotices', async (original) => {
    const { waits } = await import('./helpers/prepWaits');
    return {
        ...(await original<Record<string, unknown>>()),
        loadLocalNotices: () => waits.ask('notices', () => [], t.ms.notices),
    };
});
vi.mock('../services/TideHeightService', async (original) => {
    const { syntheticTideCurve } = await import('./helpers/routeJobScenes');
    const { waits } = await import('./helpers/prepWaits');
    return {
        ...(await original<Record<string, unknown>>()),
        fetchTideCurve: (_lat: number, _lon: number, startMs: number, endMs: number) =>
            waits.ask('tide', () => syntheticTideCurve(1.3, 1.1, startMs, endMs), t.ms.tide),
    };
});
vi.mock('../services/GebcoDepthService', async (original) => {
    const { waits } = await import('./helpers/prepWaits');
    const mod = await original<Record<string, unknown>>();
    const service = Object.create(mod.GebcoDepthService as object) as Record<string, unknown>;
    service.queryRouteRelief = (points: { lat: number; lon: number }[]) =>
        waits.ask(
            'relief',
            () => ({ depths: points.map((p) => ({ lat: p.lat, lon: p.lon, depth_m: -25 })) }),
            t.ms.relief,
        );
    return { ...mod, GebcoDepthService: service };
});
// These synthetic chart scenes have an explicitly empty private overlay library.
// Keep the real exclusion admission, auth fences and retained-MPA checks.
vi.mock('../services/userOverlays/store', async (original) => ({
    ...(await original<typeof import('../services/userOverlays/store')>()),
    loadUserOverlays: async () => ({ schema: 1, charts: true, position: 'boat', overlays: [] }),
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: {
        getState: () => ({ settings: { autorouteTrialEnabled: true } }),
        subscribe: () => () => {},
    },
}));

import { calculateThalassaProposal } from '../services/autoroutingThalassa';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { trimNavGridCache } from '../services/engine/navGrid';

const DELAYS = { ...t.ms };
let warn: { mock: { calls: unknown[][] } };

/** Auto's archipelago 5 NM leg on the virtual clock: when the router started, the checks started, and it ended. */
async function timeAuto(): Promise<{ prepMs: number; checksMs: number; totalMs: number; exitLine: string }> {
    const { from, to } = installArchipelago()['5nm'];
    let routingAt = -1;
    let checkingAt = -1;
    const proposal = await waits.drive(
        calculateThalassaProposal(
            {
                departure: { lat: from[1], lon: from[0] },
                destination: { lat: to[1], lon: to[0] },
                draftM: DRAFT_M,
                speedKts: 6,
            } as never,
            undefined,
            (message) => {
                if (routingAt < 0 && message.startsWith('Routing round the land')) routingAt = waits.now;
                if (checkingAt < 0 && message.startsWith('Checking the route')) checkingAt = waits.now;
            },
        ),
    );
    expect(proposal.coordinates.length, 'Auto routes the leg').toBeGreaterThan(1);
    const exitLine =
        warn.mock.calls.map((c) => c.map(String).join(' ')).find((l) => l.includes('EXIT: success')) ??
        '(no EXIT line)';
    return { prepMs: routingAt, checksMs: waits.now - checkingAt, totalMs: waits.now, exitLine };
}

beforeAll(async () => {
    // Load every module the route imports on the way, so an import is never a wait here.
    await Promise.all([
        import('../services/InshoreRouter'),
        import('../services/lowBridges'),
        import('../services/ntmRouting'),
        import('../services/localNotices'),
        import('../services/routing/landBackstop'),
    ]);
});
beforeEach(() => {
    setAuthIdentityScope('prep-timeline');
    Object.assign(t.ms, DELAYS);
    t.missing.clear();
    t.pi.now = 0;
    t.pi.max = 0;
    waits.reset();
    // The router's clock is the virtual one, so its EXIT line reads virtual milliseconds.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXED_NOW);
    waits.onTick = (now) => vi.setSystemTime(FIXED_NOW + now);
    trimNavGridCache(0);
    vi.stubEnv('VITE_MAPBOX_ACCESS_TOKEN', 'pk.test-not-a-token');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in the prep timeline'));
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    setAuthIdentityScope(null);
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

describe("Auto's waits, with the measurement's phone-like delays", () => {
    it('the prep waits for the OSM water alone and the checks for ETOPO alone: 3.6 s, not 6.6 s', async () => {
        const serialPrep =
            3 * (DELAYS.read + DELAYS.parse) + DELAYS.osm + DELAYS.sat + DELAYS.vec + DELAYS.bridges + DELAYS.ntm;
        const serialChecks = DELAYS.relief + DELAYS.packs + DELAYS.notices;
        expect(serialPrep + serialChecks, "today's serial sum").toBe(6_575);

        const { prepMs, checksMs, totalMs, exitLine } = await timeAuto();
        // The prep: the slowest wait (OSM), not the sum; the checks: ETOPO,
        // with the notices beside it; never more than two cell reads on the
        // bridge at once.
        expect({ prepMs, checksMs, totalMs, bridgeReads: waits.laneMax.get('bridge') }).toEqual({
            prepMs: DELAYS.osm,
            checksMs: DELAYS.relief,
            totalMs: 3_600,
            bridgeReads: 2,
        });
        // The EXIT line's prep is the wall clock of the overlapped waits, never a sum.
        expect(exitLine).toContain(` · prep ${DELAYS.osm} ms · `);
    }, 120_000);

    it('with every network answer instant, the cells are the whole wait: two reads at a time keep the bridge busy', async () => {
        for (const k of ['osm', 'sat', 'vec', 'tide', 'bridges', 'ntm', 'relief', 'packs', 'notices']) t.ms[k] = 0;
        const { prepMs } = await timeAuto();
        // One at a time: 3 × (150 + 25) = 525 ms. Two at a time: each read
        // overlaps the cell before it parsing, 3 × 150 + 25 = 475 ms. A third
        // would be no faster on one serial bridge, and would make any other
        // plugin call (a GPS fix, Preferences) wait one more read behind it.
        expect({ prepMs, bridgeReads: waits.laneMax.get('bridge') }).toEqual({
            prepMs: 3 * DELAYS.read + DELAYS.parse,
            bridgeReads: 2,
        });
    }, 120_000);

    it("cells only on the boat's Pi are pulled one at a time, as today, and before the satellite crops", async () => {
        const { scene } = await import('./helpers/routeJobScenes');
        installArchipelago();
        for (const c of (scene.cells as { id: string }[]).slice(0, 2)) t.missing.add(c.id);
        const { prepMs } = await timeAuto();
        const landed = (prefix: string) => waits.landed.filter((w) => w.name.startsWith(prefix));
        // The crops are asked only once the cells are in (as in 127: a cell
        // from the cloud would share the link with their 8 s tiles), and the
        // OSM water beside the pulls.
        const cellsInAt = Math.max(...landed('parse:').map((w) => w.at));
        const satAskedAt = Math.min(...landed('sat').map((w) => w.at)) - DELAYS.sat;
        expect(satAskedAt).toBeGreaterThanOrEqual(cellsInAt);
        expect(landed('osm')[0].at).toBe(DELAYS.osm);
        // Two pulls, one at a time, and five reads; the prep waits for the
        // later of the OSM water and the crops after the cells.
        expect({
            pulls: landed('pi:').length,
            piAtOnce: t.pi.max,
            prepMs,
        }).toEqual({ pulls: 2, piAtOnce: 1, prepMs: Math.max(DELAYS.osm, cellsInAt + DELAYS.sat) });
        // …still well under today's 5,975 ms for the same pulls.
        expect(prepMs).toBeLessThan(5_975);
        expect(waits.laneMax.get('bridge')).toBeLessThanOrEqual(2);
    }, 120_000);
});
