/**
 * Pairing pipeline regression tests — the cluster→pair→midpoint stage of
 * fetchRegionalMarkers, which the golden fixtures are structurally blind to
 * (they assemble cells+OSM and call routeInshore directly, never executing
 * the pairing). These pin the PAIR_PROJ_MAX_M stagger-gate semantics from
 * masterplan §3 Phase 2 and the 2026-06-11 adversarial review:
 *
 *   1. A diagonal artifact (port whose only candidate sits ~520 m UP-CHANNEL
 *      at the next gate) must NOT pair — its midpoint would sit between
 *      gates and skew the ribbon. (The old 0.01° degree gate was dead code —
 *      stagger ≤ PAIR_MAX_DIST_M 600 m ≈ 0.006° could never trip it — so
 *      this is the gate's first real enforcement.)
 *   2. An ISOLATED 2-mark abeam gate (1 port + 1 stbd, 550 m wide) MUST
 *      still pair: with only 2 points the cluster PCA axis IS the
 *      cross-channel line, so the raw stagger projection reads the full
 *      gate width — the axis-flip guard must bypass the gate there, or the
 *      legitimate gate's marks become blocking half-disc hazards.
 *   3. Genuine abeam gates in a normal chain keep pairing (sanity).
 *
 * Synthetic markers via a stubbed fetch — no network, CI-safe. Distinct
 * regions per test (the documented NavGrid-style cache dodge: the raw-fetch
 * cache keys on URL, so each test uses its own URL).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@capacitor/core', () => ({ CapacitorHttp: { get: async () => ({ status: 599, data: null }) } }));
vi.mock('../services/enc/EncCellMetadata', () => ({ cellsForBBox: async () => [] }));
vi.mock('../services/enc/EncCellStore', () => ({ loadCellGeoJSON: async () => null }));
vi.mock('../services/PiCacheService', () => ({
    piCache: { isAvailable: () => false, baseUrl: 'http://test.invalid' },
}));
vi.mock('../services/OsmRouteOverlayService', () => ({ getOsmRouteOverlay: async () => null }));

import { fetchRegionalMarkers } from '../services/InshoreRouter';

type MarkerFeature = {
    type: 'Feature';
    properties: Record<string, unknown>;
    geometry: { type: 'Point'; coordinates: [number, number] };
};
const mark = (lon: number, lat: number, side: 'port' | 'starboard'): MarkerFeature => ({
    type: 'Feature',
    properties: { _class: side, _type: `beacon_lateral` },
    geometry: { type: 'Point', coordinates: [lon, lat] },
});
const stubMarkers = (features: MarkerFeature[]): void => {
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ features }) }));
};
const coordsOf = (f: unknown): [number, number] =>
    (f as { geometry: { coordinates: [number, number] } }).geometry.coordinates;

const M_PER_LAT = 1 / 110_540; // degrees per metre (lat)

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('pairing — along-channel stagger gate (PAIR_PROJ_MAX_M)', () => {
    it('rejects a diagonal pairing with the next gate up the channel', async () => {
        // N-S channel at lon 150.50 (region unique to this test): a 3-mark
        // mixed cluster — a port mark, its abeam starboard 560 m UP-channel
        // (diagonal candidate, stagger ≈ 560 m > 500), plus a second port
        // 520 m further on to make the along-channel axis estimable. No
        // candidate within the stagger gate → no midpoint between gates.
        const lat0 = -27.4;
        const stag = 560 * M_PER_LAT;
        const feats = [
            mark(150.5, lat0, 'port'),
            mark(150.5005, lat0 - stag, 'starboard'), // ~50 m east, 560 m south — diagonal
            mark(150.5, lat0 - stag - 520 * M_PER_LAT, 'port'),
        ];
        stubMarkers(feats);
        const r = await fetchRegionalMarkers('test://diagonal', []);
        expect(r.midpoints).toHaveLength(0); // diagonal rejected — no between-gates midpoint
    });

    it('AXIS-FLIP GUARD: an isolated 2-mark abeam gate still pairs', async () => {
        // 1 port + 1 stbd, 550 m abeam (a legitimate wide entrance gate,
        // within PAIR_MAX_DIST_M=600). The 2-point PCA axis IS the
        // cross-channel line, so raw stagger reads 550 m — without the
        // guard this gate dies and both marks become blocking hazards.
        const mPerLon = 111_320 * Math.cos((-27.4 * Math.PI) / 180);
        const feats = [mark(151.5, -27.4, 'port'), mark(151.5 + 550 / mPerLon, -27.4, 'starboard')];
        stubMarkers(feats);
        const r = await fetchRegionalMarkers('test://isolated-gate', []);
        expect(r.midpoints).toHaveLength(1); // the gate pairs
        const [lon] = coordsOf(r.midpoints[0]);
        expect(Math.abs(lon - (151.5 + 275 / mPerLon))).toBeLessThan(1e-4); // midpoint mid-gate
        expect(r.hazards).toHaveLength(0); // and neither mark became a wall
    });

    it('genuine abeam gates in a chain keep pairing (one midpoint per gate)', async () => {
        // Three clean gates, 100 m wide, 700 m apart along a N-S channel.
        const mPerLon = 111_320 * Math.cos((-27.4 * Math.PI) / 180);
        const w = 100 / mPerLon;
        const feats: MarkerFeature[] = [];
        for (let g = 0; g < 3; g++) {
            const lat = -27.4 - g * 700 * M_PER_LAT;
            feats.push(mark(152.5, lat, 'port'), mark(152.5 + w, lat, 'starboard'));
        }
        stubMarkers(feats);
        const r = await fetchRegionalMarkers('test://chain', []);
        expect(r.midpoints).toHaveLength(3);
        expect(r.diag?.considered).toBeGreaterThan(0);
    });
});
