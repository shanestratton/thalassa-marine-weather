/**
 * Owner decision 2, as Phase 2b leaves it (2026-10-01): the offline Newport
 * canal routes WHEN its water is in the phone's pack, and says "no route" —
 * and why — when it is not.
 *
 * The charts alone paint the canal estate as land: newport-shane's only chart
 * water there is the harbour cell's 0–2 m band under every cell's land paint,
 * and tests/inshoreRouter.chartLeads.test.ts pins that the strict router
 * refuses it (hard-land-crossing, ~922 m). The OSM overlay carries the canal.
 * Offline, with no Pi and no cloud, the only OSM water left is the pack.
 *
 * The pack here is filled through the real WaterPackStore (an in-memory
 * Filesystem) from tests/fixtures/newport-canal-osm.json.gz — a Pi capture of
 * OpenStreetMap data round the Newport canal (© OpenStreetMap contributors,
 * ODbL). FIXTURE HONESTY: the test treats that capture as the COMPLETE overlay
 * of [153.03, -27.27, 153.17, -27.13], which fills the four tiles 3061/3062 ×
 * -545/-544 (153.05–153.15° E, 27.15–27.25° S). Its features all lie inside
 * those tiles, but nothing was captured for the rest of that box: the claim is
 * a test convention, not a survey. The destination end (Scarborough, 2 km past
 * the last water the capture holds) is asserted only as "not saved".
 *
 * Measured 2026-10-01 in a scratch probe (the same layers fed straight to the
 * engine): with the canal overlay 23.52 NM, 40 points, 0 m unvouched land,
 * 0 m from the canal pin, 2043 m short of the destination, 32 caution
 * segments; chart-only REFUSED hard-land-crossing 922 m. Pack assembly order
 * does not change it (the probe reversed and sorted the features).
 *
 * Fix-up (2026-10-02): the phone is offline here (navigator.onLine false), as
 * the scenario says — so the cloud is not asked and the refusal's advice is
 * "route once you're online". And a passage routed online must route the
 * same offline from the pack its own fetch filled: the overlay is now fetched
 * on the tile grid, so every tile the route's bbox touches is saved whole.
 * That test uses the newport-rivergate capture's OSM overlay (© OpenStreetMap
 * contributors, ODbL) as the online answer for the newport-shane request: a
 * capture from before berths, sent with an empty berths class (a test
 * convention, as above — it was measured 2026-10-01 to shed 46 of 306 water
 * features, 24.718 → 24.670 NM, when only the tiles wholly inside the route's
 * own bbox were saved).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cloud = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@capacitor/filesystem', async () => (await import('../helpers/memoryFilesystem')).memoryFilesystemModule());
// The cloud is down unless a test says otherwise: every call rejects.
vi.mock('../../services/supabase', async () => {
    const { vi: v } = await import('vitest');
    return {
        supabaseUrl: 'https://test.supabase.co',
        supabaseAnonKey: 'test-anon-key',
        isSupabaseConfigured: () => true,
        supabase: {
            functions: { invoke: cloud.invoke },
            auth: {
                getSession: v.fn().mockResolvedValue({ data: { session: null }, error: null }),
                onAuthStateChange: v.fn().mockReturnValue({ data: { subscription: { unsubscribe: v.fn() } } }),
            },
        },
    };
});

import { memoryFs } from '../helpers/memoryFilesystem';
import { savedIndex } from '../helpers/waterPackIndex';
import { assembleLayers, loadFixture } from '../helpers/corridorFixture';
import { haversineM } from '../../services/engine/geometry';
import { auditUnvouchedHardLand } from '../../services/engine/safetyAudit';
import { routeInshore } from '../../services/inshoreRouterEngine';
import { navLineLeads } from '../../services/leadingLine';
import { inshoreOverlayBbox } from '../../services/InshoreRouter';
import { piCache } from '../../services/PiCacheService';
import {
    __resetOsmRouteOverlayForTests,
    getOsmRouteOverlay,
    type OsmRouteOverlay,
} from '../../services/OsmRouteOverlayService';
import { WaterPackStore, __resetWaterPackStoreForTests } from '../../services/waterPack/WaterPackStore';
import { applyWaterPack, waterPackUseFor } from '../../services/waterPack/waterPackWords';
import type { Bbox } from '../../services/waterPack/waterPackTiles';

const fx = loadFixture('newport-shane.corridor.json.gz');
const canal = JSON.parse(
    gunzipSync(readFileSync(join(__dirname, '..', 'fixtures', 'newport-canal-osm.json.gz'))).toString(),
) as OsmRouteOverlay;
/** The box the capture is treated as the complete overlay of (see header). */
const CAPTURE: Bbox = [153.03, -27.27, 153.17, -27.13];
/** When the capture was committed (a2220720) — the tiles' OSM date. */
const CAPTURED_AT = Date.UTC(2026, 6, 30, 18);

const ORIGIN = { lat: fx.request.fromLat, lon: fx.request.fromLon };
const DESTINATION = { lat: fx.request.toLat, lon: fx.request.toLon };

/** The chartLeads recipe: assembleLayers + the chart's CATNAV 3 leads, as
 *  InshoreRouter merges them. */
function productionLayers(osm: OsmRouteOverlay) {
    const layers = assembleLayers({ ...fx, osm: osm as unknown as typeof fx.osm });
    layers.NAVLINE.features.push(...navLineLeads(fx.cells.NAVLNE?.features ?? [], 'NAVLNE'));
    return layers;
}

const within = (value: number | undefined, pin: number, frac: number): void => {
    expect(value).toBeGreaterThan(pin * (1 - frac));
    expect(value).toBeLessThan(pin * (1 + frac));
};

let pack: WaterPackStore;
let onLine: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
    memoryFs.reset();
    pack = new WaterPackStore({ tick: async () => undefined, flushDelayMs: 0 });
    __resetWaterPackStoreForTests(pack);
    __resetOsmRouteOverlayForTests();
    vi.spyOn(piCache, 'isAvailable').mockReturnValue(false);
    cloud.invoke.mockReset().mockRejectedValue(new Error('FunctionsFetchError: no signal'));
    // Offline, as owner decision 2's scenario is.
    onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
});
afterEach(() => {
    onLine.mockRestore();
    __resetWaterPackStoreForTests(null);
});

/**
 * Each test routes inside its body (a strict refusal tries every fallback
 * first): the same suite-local ceiling as chartLeads, for the 8 GB Mac and
 * CI's runners with coverage on. A time limit is not an assertion.
 */
describe('offline Newport canal with the water pack (owner decision 2)', { timeout: 90_000 }, () => {
    it('the pack holds the canal: the offline route leaves the canal pin and crosses no unvouched land', async () => {
        expect(fx.request.fromLat).toBe(-27.2127);
        await pack.fillFromOverlay(canal, CAPTURE, { source: 'pi', verified: true, fetchedAt: CAPTURED_AT });
        const saved = await savedIndex(pack, memoryFs);
        expect([...saved.keys()].sort()).toEqual(['3061_-544', '3061_-545', '3062_-544', '3062_-545']);

        const overlay = await getOsmRouteOverlay(inshoreOverlayBbox(ORIGIN, DESTINATION));
        expect(overlay.provenance).toMatchObject({ source: 'pack', coverage: 'partial', dataAsOf: CAPTURED_AT });
        // Every canal feature came back: all of them lie inside the saved tiles.
        expect(overlay.water.features).toHaveLength(canal.water.features.length);
        expect(overlay.canalLines.features).toHaveLength(canal.canalLines.features.length);
        expect(overlay.berths.features).toHaveLength(canal.berths.features.length);
        expect(waterPackUseFor(overlay.provenance, ORIGIN, DESTINATION)).toEqual({
            source: 'pack',
            dataAsOf: CAPTURED_AT,
            missing: ['destination'],
            offline: true,
        });

        const layers = productionLayers(overlay);
        const r = routeInshore(layers, { ...fx.request, unchartedPolicy: 'strict' });
        expect('error' in r ? r : null).toBeNull();
        if ('error' in r) return;
        within(r.distanceNM, 23.52, 0.02);
        expect(auditUnvouchedHardLand(layers, r.polyline).maxRunM).toBe(0);
        const [startLon, startLat] = r.polyline[0];
        expect(haversineM(ORIGIN.lat, ORIGIN.lon, startLat, startLon)).toBeLessThanOrEqual(50);
    });

    it('an empty pack: still no route — and the refusal says the harbour water is not on this phone yet', async () => {
        const overlay = await getOsmRouteOverlay(inshoreOverlayBbox(ORIGIN, DESTINATION));
        expect(overlay.provenance).toEqual({ source: 'none', coverage: 'none', presentTiles: [], offline: true });
        const use = waterPackUseFor(overlay.provenance, ORIGIN, DESTINATION);
        expect(use).toEqual({ source: 'none', missing: ['departure', 'destination'], offline: true });

        const r = routeInshore(productionLayers(overlay), { ...fx.request, unchartedPolicy: 'strict' });
        expect('error' in r).toBe(true);
        if (!('error' in r)) return;
        expect(r.code).toBe('hard-land-crossing');
        within(r.debug?.hardLandMaxRunM, 922, 0.05);
        const said = applyWaterPack({ error: r.error, code: r.code }, use);
        expect(said.code).toBe('hard-land-crossing');
        expect(
            said.error.startsWith(
                "No route: the harbour water for the departure and the destination isn't on this phone yet",
            ),
        ).toBe(true);
        expect(said.error).toContain(r.error);
        expect(cloud.invoke).not.toHaveBeenCalled();
    });

    it('a passage routed online routes the same offline, from the pack its own fetch filled', async () => {
        const rivergate = loadFixture('newport-rivergate.corridor.json.gz');
        const online = { ...(rivergate.osm as unknown as Record<string, unknown>) };
        online.berths = { type: 'FeatureCollection', features: [] };
        const bbox = inshoreOverlayBbox(ORIGIN, DESTINATION);

        onLine.mockReturnValue(true);
        cloud.invoke.mockResolvedValueOnce({ data: online, error: null });
        const live = await getOsmRouteOverlay(bbox);
        expect(live.provenance?.source).toBe('cloud');
        await pack.whenIdle();

        onLine.mockReturnValue(false);
        __resetOsmRouteOverlayForTests();
        const saved = await getOsmRouteOverlay(bbox);
        expect(saved.provenance).toMatchObject({ source: 'pack', coverage: 'full' });
        expect(waterPackUseFor(saved.provenance, ORIGIN, DESTINATION)?.missing).toEqual([]);
        for (const k of [
            'water',
            'reef',
            'coastline',
            'marina',
            'breakwater',
            'aeroway',
            'canalLines',
            'navLines',
        ] as const)
            expect(saved[k].features.length, k).toBe(live[k].features.length);

        const a = routeInshore(productionLayers(live), { ...fx.request, unchartedPolicy: 'strict' });
        const b = routeInshore(productionLayers(saved), { ...fx.request, unchartedPolicy: 'strict' });
        expect('error' in a ? a : null).toBeNull();
        expect('error' in b ? b : null).toBeNull();
        if ('error' in a || 'error' in b) return;
        expect(b.distanceNM).toBe(a.distanceNM);
        expect(b.polyline).toEqual(a.polyline);
    });
});
