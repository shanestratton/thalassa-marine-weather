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
vi.mock('../services/enc/EncCellMetadata', () => ({ cellsForBBox: async () => [], listCells: () => [] }));
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
        // Tier-2 surface: Step-3 accepted pairs are exposed for the Seaway
        // Graph's regionalGates (one pair per midpoint, same count).
        expect(r.acceptedPairs).toHaveLength(r.midpoints.length);
        expect(r.midpoints).toHaveLength(3);
        expect(r.diag?.considered).toBeGreaterThan(0);
    });
});

describe('pairing — minimum gate-width floor (PAIR_MIN_DIST_M)', () => {
    it('rejects a sub-channel mispair (two marks 16 m apart are not a gate)', async () => {
        // The live marker-stepping root cause (reply 30): a port + starboard
        // only 16 m apart — a mark and its own light, two piles, or a mark
        // paired across an adjacent feature — pair as a phantom 16 m "gate"
        // (half-width 8 m), which then chokes the engine's fairing guard and
        // pins the bead-kink so the route steps. A real channel gate is tens
        // to hundreds of metres wide; 16 m is physically impossible.
        const mPerLon = 111_320 * Math.cos((-27.4 * Math.PI) / 180);
        const feats = [mark(153.5, -27.4, 'port'), mark(153.5 + 16 / mPerLon, -27.4, 'starboard')];
        stubMarkers(feats);
        const r = await fetchRegionalMarkers('test://subgrid-mispair', []);
        expect(r.midpoints).toHaveLength(0); // no phantom gate
        expect(r.acceptedPairs).toHaveLength(0);
        // The two marks degrade to solo hazards via the existing unpaired
        // path — already the intended IALA-A semantics for a lone mark.
        expect(r.hazards.length).toBeGreaterThan(0);
    });

    it('a real narrow gate just above the floor (40 m) still pairs', async () => {
        // The floor is conservative: a genuine 40 m entrance gate (> 30 m)
        // survives. Confirms we kill mispairs without walling off tight-but-
        // real channels.
        const mPerLon = 111_320 * Math.cos((-27.4 * Math.PI) / 180);
        const feats = [mark(154.5, -27.4, 'port'), mark(154.5 + 40 / mPerLon, -27.4, 'starboard')];
        stubMarkers(feats);
        const r = await fetchRegionalMarkers('test://narrow-gate', []);
        expect(r.midpoints).toHaveLength(1); // 40 m > 30 m floor → kept
        expect(r.hazards).toHaveLength(0);
    });
});

describe('pairing — over-pairing fan dedup (MIDPOINT_DEDUP_M)', () => {
    const E = (m: number, lat = -27.4): number => m / (111_320 * Math.cos((lat * Math.PI) / 180));
    const N = (m: number): number => m * M_PER_LAT;

    it('collapses a 3-port→1-starboard fan to its widest pair, keeps a distinct gate', async () => {
        // The live root cause: the pairing loop lets several ports claim the
        // SAME starboard (no consumed-stbd exclusion), so ONE physical gate
        // emits a cloud of near-coincident midpoints (the field's 283 / 23 NM).
        // Here three ports west of a single starboard all pair to it, at
        // monotonically increasing widths (120/130/140 m) so the widest is
        // unambiguous. A fourth port + its own dedicated starboard form a
        // SECOND, genuinely-distinct gate 400 m up-channel (different mark →
        // never merged). Pre-fix: 4 midpoints (the 3-fan + the distinct gate).
        // Post-fix: 2 (fan collapses to its widest, distinct gate survives).
        const lon = 158.5;
        const lat = -27.4;
        const S = mark(lon + E(120), lat, 'starboard'); // shared starboard
        const feats = [
            S,
            mark(lon, lat, 'port'), // 120 m west of S
            mark(lon - E(10), lat + N(20), 'port'), // ~131.5 m from S
            mark(lon - E(20), lat - N(20), 'port'), // ~141.4 m from S — widest
            // distinct gate 400 m north, its OWN starboard
            mark(lon, lat + N(400), 'port'),
            mark(lon + E(120), lat + N(400), 'starboard'),
        ];
        stubMarkers(feats);
        const r = await fetchRegionalMarkers('test://dedup-fan', []);

        expect(r.midpoints).toHaveLength(2); // fan→1 + distinct gate→1
        expect(r.acceptedPairs).toHaveLength(2); // lockstep: wings stay 1:1

        // The surviving fan gate is the WIDEST (≈141 m), not an average and
        // not a narrower copy.
        const widths = r.midpoints.map(
            (m) => (m as { properties: { _pairDistanceM: number } }).properties._pairDistanceM,
        );
        expect(Math.max(...widths)).toBe(141);

        // Siding preserved: the surviving fan midpoint sits BETWEEN its kept
        // port (lon-20m) and the shared starboard (lon+120m) — a real
        // in-channel mark-to-mark centre, never shifted to the wrong side.
        const fanMid = r.midpoints.map(coordsOf).find(([, mlat]) => Math.abs(mlat - lat) < N(50));
        expect(fanMid).toBeDefined();
        if (fanMid) {
            expect(fanMid[0]).toBeGreaterThan(lon - E(20)); // east of the kept port
            expect(fanMid[0]).toBeLessThan(lon + E(120)); // west of the shared stbd
        }
    });

    it('does NOT merge two distinct gates that do not share a mark (200 m apart)', async () => {
        // Two clean 100 m gates, each its own port+starboard pair, 200 m
        // apart along-channel. They share NO mark, so the shared-starboard
        // dedup can never touch them even though 200 m > the 60 m cap is the
        // only thing a naive global-distance dedup would lean on.
        const lon = 159.5;
        const lat = -27.4;
        const feats = [
            mark(lon, lat, 'port'),
            mark(lon + E(100), lat, 'starboard'),
            mark(lon, lat + N(200), 'port'),
            mark(lon + E(100), lat + N(200), 'starboard'),
        ];
        stubMarkers(feats);
        const r = await fetchRegionalMarkers('test://dedup-distinct', []);
        expect(r.midpoints).toHaveLength(2); // both distinct gates survive
        expect(r.acceptedPairs).toHaveLength(2);
    });
});
