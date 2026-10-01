/**
 * The OSM overlay ladder on the phone (Phase 2b, 2026-10-01): Pi → cloud →
 * the offline water pack → nothing — and every answer says where it came
 * from (provenance), so a route can say so.
 *
 * Three bugs this pins shut:
 *   (2)  the pre-2b Pi answers a failure with an EMPTY 200. The phone used to
 *        remember it for 30 minutes and write it over its last good copy —
 *        the marina became land until the next good fetch.
 *   (2b) a Pi that answered non-2xx returned empty at once, never trying the
 *        cloud or the saved copy.
 *   (2c) on the Pi itself (pi-cache/src/services/osm.test.mts).
 *
 * The Filesystem is in memory (tests/helpers/memoryFilesystem); the Pi, the
 * cloud and Satellite Mode are mocks. Synthetic squares only, at Newport and
 * in the Whitsundays; no real chart or OSM data.
 */
import type { Feature } from 'geojson';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    piAvailable: vi.fn(() => false),
    pinned: vi.fn(),
    invoke: vi.fn(),
    sat: vi.fn(() => false),
}));

vi.mock('@capacitor/filesystem', async () => (await import('./helpers/memoryFilesystem')).memoryFilesystemModule());
vi.mock('../services/PiCacheService', () => ({
    piCache: { isAvailable: m.piAvailable, baseUrl: 'https://pi.test:3001' },
}));
vi.mock('../services/PiPairingService', () => ({ pinnedPiRequest: m.pinned }));
vi.mock('../services/supabase', () => ({
    supabase: { functions: { invoke: m.invoke } },
    isSupabaseConfigured: () => true,
}));
vi.mock('../services/networkPolicy', () => ({ satelliteModeBlocks: m.sat }));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { memoryFs } from './helpers/memoryFilesystem';
import { savedIndex } from './helpers/waterPackIndex';
import {
    __resetOsmRouteOverlayForTests,
    getOsmRouteOverlay,
    prefetchWaterPack,
} from '../services/OsmRouteOverlayService';
import { WATER_PACK_DIR, WaterPackStore, __resetWaterPackStoreForTests } from '../services/waterPack/WaterPackStore';
import { tileAlignedFetchBbox, tileBounds, type Bbox } from '../services/waterPack/waterPackTiles';

const DAY = 86_400_000;

const square = (w: number, s: number, e: number, n: number, props: Record<string, unknown> = {}): Feature => ({
    type: 'Feature',
    properties: props,
    geometry: {
        type: 'Polygon',
        coordinates: [
            [
                [w, s],
                [e, s],
                [e, n],
                [w, n],
                [w, s],
            ],
        ],
    },
});
const waterIn = (tileKey: string, props: Record<string, unknown> = {}): Feature => {
    const [w, s] = tileBounds(tileKey);
    return square(w + 0.02, s + 0.02, w + 0.03, s + 0.03, { natural: 'water', _osmId: 1, ...props });
};
const fc = (features: Feature[] = []) => ({ type: 'FeatureCollection', features });
const payload = (water: Feature[] = [], berths: Feature[] = []) => ({
    water: fc(water),
    reef: fc(),
    coastline: fc(),
    marina: fc(),
    breakwater: fc(),
    aeroway: fc(),
    canalLines: fc(),
    navLines: fc(),
    berths: fc(berths),
});
const piReply = (body: unknown, headers: Record<string, string> = {}, status = 200) => ({
    status,
    headers,
    data: typeof body === 'string' ? body : JSON.stringify(body),
    peerSpki: '',
});

// The 2×2 tiles round the Newport canal: fetched with the 0.01° margin, and a
// route bbox inside them.
const A = '3061_-545';
const B = '3062_-545';
const FETCH: Bbox = [153.04, -27.26, 153.16, -27.14];
const ROUTE: Bbox = [153.06, -27.24, 153.14, -27.16];
const store = () => new WaterPackStore({ tick: async () => undefined, flushDelayMs: 0 });
let pack: WaterPackStore;
const tileFile = (key: string) => memoryFs.files.get(`DATA/${WATER_PACK_DIR}/t/${key}.json`)?.data;

/** When seedPack's water came from OSM: a month back. */
const SEEDED_AGO = 30 * DAY;

/** Fill the pack the way a good cloud fetch a month ago would. */
async function seedPack(water: Feature[], bbox: Bbox = FETCH): Promise<void> {
    await pack.fillFromOverlay(payload(water) as never, bbox, {
        source: 'cloud',
        verified: true,
        fetchedAt: Date.now() - SEEDED_AGO,
    });
    await pack.whenIdle();
}

beforeEach(() => {
    memoryFs.reset();
    pack = store();
    __resetWaterPackStoreForTests(pack);
    __resetOsmRouteOverlayForTests();
    m.piAvailable.mockReset().mockReturnValue(false);
    m.pinned.mockReset();
    m.invoke.mockReset().mockResolvedValue({ data: null, error: new Error('offline') });
    m.sat.mockReset().mockReturnValue(false);
});
afterEach(() => {
    __resetWaterPackStoreForTests(null);
    vi.useRealTimers();
});

describe('the ladder', () => {
    it('a 2b Pi fresh reply → source pi, the overlay as sent, and the pack filled (verified)', async () => {
        m.piAvailable.mockReturnValue(true);
        const fetchedAt = new Date(Date.now() - 3 * DAY).toISOString();
        m.pinned.mockResolvedValue(
            piReply(payload([waterIn(A)]), { 'X-Osm-Overlay': 'cache', 'X-Osm-Fetched-At': fetchedAt }),
        );
        const overlay = await getOsmRouteOverlay(FETCH);
        expect(overlay.provenance).toMatchObject({ source: 'pi', coverage: 'full' });
        expect(overlay.water.features).toHaveLength(1);
        expect(m.invoke).not.toHaveBeenCalled();
        expect((await savedIndex(pack, memoryFs)).get(A)).toMatchObject({
            source: 'pi',
            verified: true,
            fetchedAt: Date.parse(fetchedAt),
        });
        // Remembered: the next call asks no one.
        await getOsmRouteOverlay(FETCH);
        expect(m.pinned).toHaveBeenCalledTimes(1);
    });

    it('headers are read whatever their case', async () => {
        m.piAvailable.mockReturnValue(true);
        m.pinned.mockResolvedValue(
            piReply(payload([waterIn(A)]), { 'x-osm-overlay': 'fresh', 'x-osm-fetched-at': new Date().toISOString() }),
        );
        expect((await getOsmRouteOverlay(FETCH)).provenance?.source).toBe('pi');
    });

    it('REGRESSION (bug 2): a pre-2b Pi empty 200 is neither remembered nor written — the ladder falls through to the pack', async () => {
        await seedPack([waterIn(A)]);
        const before = tileFile(A);
        expect(before).toBeDefined();
        m.piAvailable.mockReturnValue(true);
        m.pinned.mockResolvedValue(piReply(payload()));
        const overlay = await getOsmRouteOverlay(ROUTE);
        expect(m.invoke).toHaveBeenCalledTimes(1);
        expect(overlay.provenance).toMatchObject({ source: 'pack', coverage: 'full' });
        expect(overlay.water.features).toHaveLength(1);
        await pack.whenIdle();
        expect(tileFile(A)).toBe(before);
        // Not remembered as an answer: after the pack's 2-minute hold the Pi
        // is asked again.
        vi.useFakeTimers({ now: Date.now() + 3 * 60_000, toFake: ['Date'] });
        await getOsmRouteOverlay(ROUTE);
        expect(m.pinned).toHaveBeenCalledTimes(2);
    });

    it('a pre-2b Pi reply with features counts, unverified: it fills only tiles the pack lacks', async () => {
        await seedPack([waterIn(A, { v: 'pack' })], [153.04, -27.26, 153.11, -27.19]);
        const before = tileFile(A);
        m.piAvailable.mockReturnValue(true);
        m.pinned.mockResolvedValue(piReply(payload([waterIn(A, { v: 'old pi' }), waterIn(B)])));
        const overlay = await getOsmRouteOverlay(FETCH);
        expect(overlay.provenance?.source).toBe('pi-legacy');
        await pack.whenIdle();
        expect(tileFile(A)).toBe(before);
        expect((await savedIndex(pack, memoryFs)).get(B)).toMatchObject({ source: 'pi-legacy', verified: false });
    });

    it('(bug 2b) a Pi 503 tries the cloud, then the pack — it no longer answers empty at once', async () => {
        await seedPack([waterIn(A)]);
        m.piAvailable.mockReturnValue(true);
        m.pinned.mockResolvedValue(piReply({ code: 'OSM_OVERLAY_UNAVAILABLE', error: 'no internet' }, {}, 503));
        const overlay = await getOsmRouteOverlay(ROUTE);
        expect(m.invoke).toHaveBeenCalledTimes(1);
        expect(overlay.provenance?.source).toBe('pack');
        expect(overlay.water.features).toHaveLength(1);

        // …and a cloud that answers wins over the pack, and refreshes it.
        __resetOsmRouteOverlayForTests();
        m.invoke.mockResolvedValue({ data: payload([waterIn(A, { name: 'fresh' })]), error: null });
        const cloud = await getOsmRouteOverlay(FETCH);
        expect(cloud.provenance?.source).toBe('cloud');
        await pack.whenIdle();
        expect(JSON.parse(tileFile(A)!).overlay.water.features[0].properties.name).toBe('fresh');
    });

    it('a Pi throw or bad JSON also falls through', async () => {
        m.piAvailable.mockReturnValue(true);
        m.pinned.mockRejectedValueOnce(new Error('-1001 timed out'));
        expect((await getOsmRouteOverlay(ROUTE)).provenance?.source).toBe('none');
        __resetOsmRouteOverlayForTests();
        m.pinned.mockResolvedValueOnce(piReply('<html>'));
        expect((await getOsmRouteOverlay(ROUTE)).provenance?.source).toBe('none');
        expect(m.invoke).toHaveBeenCalledTimes(2);
    });

    it("the Pi's stale copy beats a partial pack, and fills only the tiles the pack lacks", async () => {
        // The pack holds A only; the route needs four tiles.
        await seedPack([waterIn(A, { v: 'pack' })], [153.04, -27.26, 153.11, -27.19]);
        const before = tileFile(A);
        m.piAvailable.mockReturnValue(true);
        const savedAt = Date.now() - 40 * DAY;
        m.pinned.mockResolvedValue(
            piReply(payload([waterIn(A, { v: 'stale' }), waterIn(B)]), {
                'X-Osm-Overlay': 'stale',
                'X-Osm-Fetched-At': new Date(savedAt).toISOString(),
            }),
        );
        const overlay = await getOsmRouteOverlay(FETCH);
        expect(overlay.provenance).toMatchObject({ source: 'pi-stale', dataAsOf: savedAt });
        expect(overlay.water.features).toHaveLength(2);
        await pack.whenIdle();
        expect(tileFile(A)).toBe(before);
        expect((await savedIndex(pack, memoryFs)).get(B)).toMatchObject({
            source: 'pi-stale',
            verified: false,
            fetchedAt: savedAt,
        });
    });

    it("a pack that covers the whole bbox beats the Pi's stale copy", async () => {
        await seedPack([waterIn(A, { v: 'pack' })]);
        m.piAvailable.mockReturnValue(true);
        m.pinned.mockResolvedValue(
            piReply(payload([waterIn(A, { v: 'stale' })]), {
                'X-Osm-Overlay': 'stale',
                'X-Osm-Fetched-At': new Date(Date.now() - 40 * DAY).toISOString(),
            }),
        );
        const overlay = await getOsmRouteOverlay(ROUTE);
        expect(overlay.provenance?.source).toBe('pack');
        expect(overlay.water.features[0].properties?.v).toBe('pack');
    });

    it('Pi down, cloud failing, the pack covers the bbox → pack, full, with its date and tiles', async () => {
        const savedAt = Date.now() - SEEDED_AGO;
        await seedPack([waterIn(A)]);
        m.invoke.mockRejectedValue(new Error('FunctionsFetchError'));
        const overlay = await getOsmRouteOverlay(ROUTE);
        expect(overlay.provenance).toMatchObject({ source: 'pack', coverage: 'full' });
        expect(overlay.provenance!.dataAsOf).toBeGreaterThanOrEqual(savedAt);
        expect(overlay.provenance!.dataAsOf).toBeLessThan(savedAt + DAY);
        expect(overlay.provenance!.presentTiles!.sort()).toEqual(['3061_-544', '3061_-545', '3062_-544', '3062_-545']);
        expect(overlay.water.features).toHaveLength(1);
    });

    it('nothing anywhere → an empty overlay with source none', async () => {
        const overlay = await getOsmRouteOverlay(ROUTE);
        expect(overlay.provenance).toEqual({ source: 'none', coverage: 'none', presentTiles: [] });
        expect(overlay.water.features).toHaveLength(0);
        expect(Object.keys(overlay).sort()).toEqual(
            [
                'aeroway',
                'berths',
                'breakwater',
                'canalLines',
                'coastline',
                'marina',
                'navLines',
                'provenance',
                'reef',
                'water',
            ].sort(),
        );
    });
});

describe('prefetchWaterPack — the ends of a settled trace', () => {
    const AIRLIE = { lat: -20.2653, lon: 148.7082 };
    const HAMILTON = { lat: -20.3487, lon: 148.9567 };
    const bboxes = () => m.invoke.mock.calls.map((c) => (c[1] as { body: { bbox: string } }).body.bbox);

    // Each area holds some water: an all-empty answer saves nothing.
    const areaWater = () => payload([waterIn('2974_-406'), waterIn('2979_-407')]);

    it('fetches the aligned 0.15° square (±0.01°) round each end, and saves its nine tiles', async () => {
        m.invoke.mockResolvedValue({ data: areaWater(), error: null });
        await prefetchWaterPack([AIRLIE, { lat: -20.3, lon: 148.8 }, HAMILTON]);
        expect(bboxes()).toEqual(['148.64,-20.36,148.81,-20.19', '148.89,-20.41,149.06,-20.24']);
        const entries = await savedIndex(pack, memoryFs);
        expect(entries.size).toBe(18);
        expect(entries.has('2974_-406')).toBe(true);
        expect(entries.has('2979_-408')).toBe(true);
    });

    it('asks the Pi first when it is reachable', async () => {
        m.piAvailable.mockReturnValue(true);
        m.pinned.mockResolvedValue(
            piReply(areaWater(), { 'X-Osm-Overlay': 'fresh', 'X-Osm-Fetched-At': new Date().toISOString() }),
        );
        await prefetchWaterPack([AIRLIE]);
        expect(m.pinned).toHaveBeenCalledTimes(1);
        expect(String(m.pinned.mock.calls[0][0].url)).toContain('/api/osm/overlay?bbox=148.64,-20.36,148.81,-20.19');
        expect(m.invoke).not.toHaveBeenCalled();
    });

    it('skips an end whose nine tiles are all saved, verified and under 30 days old', async () => {
        m.invoke.mockResolvedValue({ data: areaWater(), error: null });
        await prefetchWaterPack([AIRLIE, HAMILTON]);
        await pack.whenIdle();
        m.invoke.mockClear();
        await prefetchWaterPack([AIRLIE, HAMILTON]);
        expect(m.invoke).not.toHaveBeenCalled();
        // 31 days on (the cloud's answer is dated a week back), they are
        // fetched again.
        vi.useFakeTimers({ now: Date.now() + 31 * DAY, toFake: ['Date'] });
        await prefetchWaterPack([AIRLIE, HAMILTON]);
        expect(m.invoke).toHaveBeenCalledTimes(2);
    });

    // Fix-up (2026-10-02): unverified tiles (a pre-2b Pi's reply may be cut
    // short) are not a reason to skip.
    it('does not skip an end whose tiles are saved but unverified', async () => {
        const AIRLIE_SQUARE: Bbox = [148.64, -20.36, 148.81, -20.19];
        const everyTile: Feature[] = [];
        for (let x = 2973; x <= 2975; x++) for (let y = -407; y <= -405; y++) everyTile.push(waterIn(`${x}_${y}`));
        await pack.fillFromOverlay(payload(everyTile) as never, AIRLIE_SQUARE, {
            source: 'pi-legacy',
            verified: false,
            fetchedAt: Date.now(),
        });
        expect((await savedIndex(pack, memoryFs)).size).toBe(9);
        m.invoke.mockResolvedValue({ data: areaWater(), error: null });
        await prefetchWaterPack([AIRLIE]);
        expect(m.invoke).toHaveBeenCalledTimes(1);
    });

    it('an area that answered with nothing is not asked again for six hours', async () => {
        m.invoke.mockResolvedValue({ data: payload(), error: null });
        await prefetchWaterPack([AIRLIE]);
        expect(m.invoke).toHaveBeenCalledTimes(1);
        expect((await savedIndex(pack, memoryFs)).size).toBe(0);
        await prefetchWaterPack([AIRLIE]);
        expect(m.invoke).toHaveBeenCalledTimes(1);
        vi.useFakeTimers({ now: Date.now() + 7 * 3_600_000, toFake: ['Date'] });
        await prefetchWaterPack([AIRLIE]);
        expect(m.invoke).toHaveBeenCalledTimes(2);
    });

    it('fetches nothing in Satellite Mode or offline', async () => {
        m.sat.mockReturnValue(true);
        await prefetchWaterPack([AIRLIE, HAMILTON]);
        expect(m.invoke).not.toHaveBeenCalled();
        m.sat.mockReturnValue(false);
        const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        try {
            await prefetchWaterPack([AIRLIE, HAMILTON]);
        } finally {
            online.mockRestore();
        }
        expect(m.invoke).not.toHaveBeenCalled();
        expect(m.pinned).not.toHaveBeenCalled();
    });

    it('is single-flight', async () => {
        let release!: () => void;
        m.invoke.mockImplementation(
            () =>
                new Promise((resolve) => {
                    release = () => resolve({ data: areaWater(), error: null });
                }),
        );
        const first = prefetchWaterPack([AIRLIE]);
        const second = prefetchWaterPack([AIRLIE]);
        expect(second).toBe(first);
        await vi.waitFor(() => expect(m.invoke).toHaveBeenCalledTimes(1));
        release();
        await first;
    });
});

// ── Fix-up, 2026-10-02 ───────────────────────────────────────────────

describe('fix-up 2026-10-02: what the ladder asks for, saves and says', () => {
    it('asks the Pi on the tile grid, and for its stale copy (&stale=1): a pre-2b phone never gets one', async () => {
        m.piAvailable.mockReturnValue(true);
        m.pinned.mockResolvedValue(
            piReply(payload([waterIn(A)]), { 'X-Osm-Overlay': 'fresh', 'X-Osm-Fetched-At': new Date().toISOString() }),
        );
        await getOsmRouteOverlay(ROUTE);
        const url = String(m.pinned.mock.calls[0][0].url);
        expect(url).toContain(`/api/osm/overlay?bbox=${tileAlignedFetchBbox(ROUTE).join(',')}&stale=1`);
    });

    it('an online answer for an unaligned bbox reads back from the pack whole, the same features', async () => {
        const unaligned: Bbox = [153.0612, -27.2433, 153.1388, -27.1611];
        const edge = square(153.135, -27.2, 153.16, -27.19, { natural: 'water', _osmId: 2 });
        const beyond = square(153.15, -27.2, 153.16, -27.19, { natural: 'water', _osmId: 3 });
        m.invoke.mockResolvedValueOnce({ data: payload([waterIn(A), edge, beyond]), error: null });
        const online = await getOsmRouteOverlay(unaligned);
        expect(online.provenance?.source).toBe('cloud');
        expect(m.invoke.mock.calls[0][1].body.bbox).toBe(tileAlignedFetchBbox(unaligned).join(','));
        // The router gets the features that meet its own bbox.
        expect(online.water.features.map((f) => f.properties?._osmId).sort()).toEqual([1, 2]);
        await pack.whenIdle();
        __resetOsmRouteOverlayForTests();
        m.invoke.mockRejectedValue(new Error('FunctionsFetchError'));
        const offline = await getOsmRouteOverlay(unaligned);
        expect(offline.provenance).toMatchObject({ source: 'pack', coverage: 'full' });
        expect(offline.water.features.map((f) => f.properties?._osmId).sort()).toEqual([1, 2]);
    });

    it("reclaimed water: a newer tile without the basin drops the older neighbour's copy (the real store)", async () => {
        const JUNE = Date.now() - 120 * DAY;
        const SEPT = Date.now() - 10 * DAY;
        const juneBasin = square(153.07, -27.23, 153.13, -27.21, { leisure: 'marina', _osmId: 1 });
        const septBasin = square(153.07, -27.23, 153.095, -27.21, { leisure: 'marina', _osmId: 1 });
        const marina = (f: Feature) => ({ ...payload(), marina: fc([f]) });
        // June: both tiles. September: a verified refresh that covers only B.
        await pack.fillFromOverlay(marina(juneBasin) as never, [153.04, -27.26, 153.16, -27.19], {
            source: 'pi',
            verified: true,
            fetchedAt: JUNE,
        });
        await pack.fillFromOverlay(marina(septBasin) as never, [153.09, -27.26, 153.16, -27.19], {
            source: 'pi',
            verified: true,
            fetchedAt: SEPT,
        });
        await pack.whenIdle();
        const route: Bbox = [153.06, -27.24, 153.14, -27.21];
        const overlay = await getOsmRouteOverlay(route);
        expect(overlay.provenance).toMatchObject({ source: 'pack', coverage: 'full' });
        expect(overlay.marina.features).toEqual([]);
        // September's refresh of A: the new basin is used.
        await pack.fillFromOverlay(marina(septBasin) as never, [153.04, -27.26, 153.11, -27.19], {
            source: 'pi',
            verified: true,
            fetchedAt: SEPT + DAY,
        });
        await pack.whenIdle();
        __resetOsmRouteOverlayForTests();
        expect((await getOsmRouteOverlay(route)).marina.features).toEqual([septBasin]);
    });

    it("the cloud's answer is dated a week back (its own cache's age): it never displaces yesterday's Pi tile", async () => {
        const yesterday = Date.now() - DAY;
        // Yesterday's Pi answer holds A only; B is not saved.
        await pack.fillFromOverlay(payload([waterIn(A, { v: 'pi' })]) as never, [153.04, -27.26, 153.11, -27.19], {
            source: 'pi',
            verified: true,
            fetchedAt: yesterday,
        });
        await pack.whenIdle();
        const before = tileFile(A);
        m.invoke.mockResolvedValue({ data: payload([waterIn(A, { v: 'cloud' }), waterIn(B)]), error: null });
        const t0 = Date.now();
        await getOsmRouteOverlay(ROUTE);
        const index = await savedIndex(pack, memoryFs);
        expect(tileFile(A)).toBe(before);
        expect(index.get(A)!.source).toBe('pi');
        expect(index.get(B)!.source).toBe('cloud');
        expect(index.get(B)!.fetchedAt).toBeLessThanOrEqual(t0 - 7 * DAY + 1_000);
        expect(index.get(B)!.fetchedAt).toBeGreaterThan(t0 - 7 * DAY - 60_000);
    });

    it('a payload that lacks a class is used for the route but never saved: "no berths key" is not "no berths"', async () => {
        const noBerths: Record<string, unknown> = payload([waterIn(A)]);
        delete noBerths.berths;
        m.invoke.mockResolvedValue({ data: noBerths, error: null });
        const overlay = await getOsmRouteOverlay(ROUTE);
        expect(overlay.provenance?.source).toBe('cloud');
        expect(overlay.water.features).toHaveLength(1);
        expect((await savedIndex(pack, memoryFs)).size).toBe(0);
        // Nor a pre-2b Pi's.
        __resetOsmRouteOverlayForTests();
        m.piAvailable.mockReturnValue(true);
        m.pinned.mockResolvedValue(piReply(noBerths));
        expect((await getOsmRouteOverlay(ROUTE)).provenance?.source).toBe('pi-legacy');
        expect((await savedIndex(pack, memoryFs)).size).toBe(0);
    });

    it('offline: the cloud is not asked, and the answer says the phone was offline', async () => {
        const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        try {
            const overlay = await getOsmRouteOverlay(ROUTE);
            expect(overlay.provenance).toEqual({ source: 'none', coverage: 'none', presentTiles: [], offline: true });
        } finally {
            online.mockRestore();
        }
        expect(m.invoke).not.toHaveBeenCalled();
    });

    it('a partial pack lists the water it left out for a missing tile', async () => {
        // Water in A reaching B; only A saved.
        const reaching = square(153.09, -27.21, 153.11, -27.205, { natural: 'water', _osmId: 9 });
        await pack.fillFromOverlay(payload([reaching]) as never, [153.04, -27.26, 153.11, -27.19], {
            source: 'pi',
            verified: true,
            fetchedAt: Date.now() - DAY,
        });
        await pack.whenIdle();
        const overlay = await getOsmRouteOverlay(ROUTE);
        expect(overlay.provenance).toMatchObject({ source: 'pack', coverage: 'partial' });
        expect(overlay.water.features).toEqual([]);
        expect(overlay.provenance?.unsavedWater).toEqual([[153.09, -27.21, 153.11, -27.205]]);
    });
});

describe('fix-up 2026-10-02: a cloud that cannot be reached is not asked again for two minutes', () => {
    it('after a network error, the next bbox goes straight to the pack', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        m.invoke.mockRejectedValue(new Error('FunctionsFetchError: Failed to send a request'));
        await getOsmRouteOverlay(ROUTE);
        await getOsmRouteOverlay([150.06, -25.24, 150.14, -25.16]);
        expect(m.invoke).toHaveBeenCalledTimes(1);
        vi.setSystemTime(Date.now() + 2 * 60_000 + 1);
        await getOsmRouteOverlay([149.06, -24.24, 149.14, -24.16]);
        expect(m.invoke).toHaveBeenCalledTimes(2);
    });

    it('a reachable cloud that answers an error (a 503, a quota) is asked again next time', async () => {
        m.invoke.mockResolvedValue({
            data: null,
            error: Object.assign(new Error('503'), { name: 'FunctionsHttpError' }),
        });
        await getOsmRouteOverlay(ROUTE);
        await getOsmRouteOverlay([150.06, -25.24, 150.14, -25.16]);
        expect(m.invoke).toHaveBeenCalledTimes(2);
    });

    it('a cloud that never answers: 45 s, then not asked again for two minutes', async () => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        m.invoke.mockReturnValue(new Promise(() => undefined));
        const first = getOsmRouteOverlay(ROUTE);
        await vi.advanceTimersByTimeAsync(44_000);
        let done = false;
        void first.then(() => (done = true));
        await vi.advanceTimersByTimeAsync(0);
        expect(done).toBe(false);
        await vi.advanceTimersByTimeAsync(2_000);
        expect((await first).provenance?.source).toBe('none');
        await getOsmRouteOverlay([150.06, -25.24, 150.14, -25.16]);
        expect(m.invoke).toHaveBeenCalledTimes(1);
    });

    it('when the Pi has just said it has no internet, the cloud gets 10 s, not 45', async () => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        m.piAvailable.mockReturnValue(true);
        m.pinned.mockResolvedValue(piReply({ code: 'OSM_OVERLAY_UNAVAILABLE', error: 'no internet' }, {}, 503));
        m.invoke.mockReturnValue(new Promise(() => undefined));
        const pending = getOsmRouteOverlay(ROUTE);
        await vi.advanceTimersByTimeAsync(10_500);
        expect((await pending).provenance?.source).toBe('none');
    });
});
