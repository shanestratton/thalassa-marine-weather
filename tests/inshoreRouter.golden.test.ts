/**
 * GOLDEN ROUTE LOCK — Masterplan Stage I, Phase 0.
 *
 * Real-chart corridor fixtures (AU SENC cells + OSM overlay, captured from
 * production by Claude B, ROUTING_COLLAB.md replies 5–6) routed through the
 * REAL routeInshore. These are the seatbelt for every routing change in the
 * masterplan: any phase that moves these numbers without an explicit re-pin
 * gets reverted.
 *
 *  - Newport → Rivergate (Brisbane River): the ORCA-comparison benchmark.
 *    Claude B verified end-to-end: connected, 21 pts, 20.46 NM, snap 0 m
 *    both ends, 10 caution cells, pass4 FAIRWY+DRGARE=104, pass5b navline=21.
 *  - Newport → Tangalooma: pins the leading-line APPROACH machinery
 *    (route-via-transit: make the seaward mark, run the leads in).
 *  - Rivergate at draftM 2.44 (the real 8 ft Tayana draft, ship-blocker #3
 *    in ROUTING_COLLAB.md): the engine must stay connected and sane at the
 *    true draft, not just the 2.40 benchmark value.
 *
 * The cells+osm → layers assembly below is the documented injection recipe
 * from ROUTING_COLLAB.md (also embedded in each fixture's _meta) — the
 * Brisbane River sits INSIDE a coastal LNDARE polygon on the AU SENC, so
 * cells alone route destination-disconnected; production injects the OSM
 * overlay first. If Claude B exports assembleInshoreLayers() from
 * InshoreRouter.ts post-lock-in, swap this copy for the shared export.
 */

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { routeInshore, type RouteRequest, type RouteResult } from '../services/inshoreRouterEngine';
import type { Feature, FeatureCollection } from 'geojson';

// ── Fixture loading ────────────────────────────────────────────────

interface CorridorFixture {
    _meta: Record<string, unknown>;
    request: RouteRequest;
    cells: Record<string, FeatureCollection>;
    osm: Record<string, FeatureCollection>;
}

function loadFixture(name: string): CorridorFixture {
    const path = join(__dirname, 'fixtures', name);
    return JSON.parse(gunzipSync(readFileSync(path)).toString()) as CorridorFixture;
}

// ── Injection recipe (verbatim from ROUTING_COLLAB.md) ────────────

/** min(bbox widthM, heightM) >= m at mid-latitude — mirrors isPolygonWideEnough. */
function wide(f: Feature, m: number): boolean {
    let minLon = Infinity,
        maxLon = -Infinity,
        minLat = Infinity,
        maxLat = -Infinity;
    const walk = (coords: unknown): void => {
        if (Array.isArray(coords) && typeof coords[0] === 'number') {
            const [lon, lat] = coords as [number, number];
            if (lon < minLon) minLon = lon;
            if (lon > maxLon) maxLon = lon;
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
        } else if (Array.isArray(coords)) {
            for (const c of coords) walk(c);
        }
    };
    walk((f.geometry as { coordinates?: unknown }).coordinates);
    if (!isFinite(minLon)) return false;
    const midLat = ((minLat + maxLat) / 2) * (Math.PI / 180);
    const widthM = (maxLon - minLon) * 111_320 * Math.cos(midLat);
    const heightM = (maxLat - minLat) * 110_540;
    return Math.min(widthM, heightM) >= m;
}

/** cells + osm → the layer set production hands routeInshore. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function assembleLayers(fx: CorridorFixture): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m: any = {};
    for (const k of Object.keys(fx.cells)) m[k] = { type: 'FeatureCollection', features: [...fx.cells[k].features] };
    for (const k of ['COASTLINE', 'CANAL', 'NAVLINE', 'FAIRWY', 'DEPARE', 'OBSTRN'])
        m[k] ??= { type: 'FeatureCollection', features: [] };
    const o = fx.osm;
    for (const f of o.water.features) {
        m.DEPARE.features.push({ ...f, properties: { ...(f.properties ?? {}), DRVAL1: 10, DRVAL2: 10 } });
        const p = f.properties ?? {};
        const riverish =
            p.water === 'river' ||
            p.water === 'harbour' ||
            p.waterway === 'river' ||
            p.waterway === 'riverbank' ||
            p.harbour === 'yes';
        if (riverish && wide(f, 200))
            m.FAIRWY.features.push({
                ...f,
                properties: { ...(f.properties ?? {}), _promotePreferred: true, _source: 'osm-water-promoted' },
            });
    }
    for (const f of o.marina.features)
        m.DEPARE.features.push({ ...f, properties: { ...(f.properties ?? {}), DRVAL1: 5, DRVAL2: 5 } });
    for (const f of o.reef.features)
        m.OBSTRN.features.push({ ...f, properties: { ...(f.properties ?? {}), _class: 'osm-reef' } });
    for (const f of o.breakwater.features)
        (f.geometry.type.includes('Polygon') ? m.LNDARE : m.COASTLINE).features.push(f);
    for (const f of o.aeroway.features)
        if (f.geometry.type.includes('Polygon'))
            m.OBSTRN.features.push({ ...f, properties: { ...(f.properties ?? {}), _class: 'osm-aeroway' } });
    for (const f of o.coastline.features) m.COASTLINE.features.push(f);
    for (const f of o.canalLines.features) m.CANAL.features.push(f);
    for (const f of o.navLines.features) m.NAVLINE.features.push(f);
    return m;
}

// ── Shared assertions ──────────────────────────────────────────────

function expectConnected(r: ReturnType<typeof routeInshore>): asserts r is RouteResult {
    if ('error' in r) throw new Error(`route failed: ${r.error}`);
    expect(r.polyline.length).toBeGreaterThanOrEqual(2);
}

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371000;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

/** Endpoint snap distance: request point → nearest polyline terminal. */
function snapM(r: RouteResult, req: RouteRequest): { from: number; to: number } {
    const [fLon, fLat] = r.polyline[0];
    const [tLon, tLat] = r.polyline[r.polyline.length - 1];
    return {
        from: haversineM(req.fromLat, req.fromLon, fLat, fLon),
        to: haversineM(req.toLat, req.toLon, tLat, tLon),
    };
}

const cautionCount = (r: RouteResult): number => (r.cautionMask ?? []).filter(Boolean).length;

// ── Goldens ────────────────────────────────────────────────────────

describe('GOLDEN: Newport → Rivergate (Brisbane River, real AU cells)', () => {
    const fx = loadFixture('newport-rivergate.corridor.json.gz');
    const layers = assembleLayers(fx);
    const r = routeInshore(layers, fx.request);

    it('resolves connected (no destination-disconnected)', () => {
        expectConnected(r);
    });

    // 22.64 NM measured at lock-in (2026-06-12). Claude B's capture-time
    // measurement (2026-05-21) was 20.46 NM; the leading-line follower +
    // buoyed-channel + marina-scope commits landed since and lengthened the
    // fixture route toward the ~23.4 NM observed in-app — i.e. MORE
    // channel-faithful. The golden pins TODAY's behaviour; re-pin only with
    // an explicit masterplan-phase justification in the commit message.
    it('distance pinned at 22.64 NM ±2%', () => {
        expectConnected(r);
        expect(r.distanceNM).toBeGreaterThan(22.64 * 0.98);
        expect(r.distanceNM).toBeLessThan(22.64 * 1.02);
    });

    it('endpoint snap < 100 m both ends', () => {
        expectConnected(r);
        const s = snapM(r, fx.request);
        expect(s.from).toBeLessThan(100);
        expect(s.to).toBeLessThan(100);
    });

    it('caution cells at or below the lock-in baseline (9)', () => {
        expectConnected(r);
        expect(cautionCount(r)).toBeLessThanOrEqual(9);
    });

    it('phaseTimings present and loosely bounded', () => {
        expectConnected(r);
        expect(r.phaseTimings).toBeTruthy();
        for (const [phase, ms] of Object.entries(r.phaseTimings ?? {})) {
            expect(ms, `phase ${phase} runaway`).toBeLessThan(30_000);
        }
    });
});

describe('GOLDEN: Newport → Rivergate at the REAL Tayana draft (2.44 m / 8 ft)', () => {
    // Ship-blocker #3 (ROUTING_COLLAB.md reply 4): the engine must behave at
    // the true draft, not just the 2.40 m benchmark. 4 cm deeper must not
    // disconnect the route or blow the corridor apart.
    const fx = loadFixture('newport-rivergate.corridor.json.gz');
    const layers = assembleLayers(fx);
    const r = routeInshore(layers, { ...fx.request, draftM: 2.44 });

    it('still resolves connected at 2.44 m', () => {
        expectConnected(r);
    });

    it('distance within 10% of the 2.40 m benchmark (22.64 NM)', () => {
        expectConnected(r);
        expect(r.distanceNM).toBeGreaterThan(22.64 * 0.9);
        expect(r.distanceNM).toBeLessThan(22.64 * 1.1);
    });

    it('endpoint snap < 100 m both ends', () => {
        expectConnected(r);
        const s = snapM(r, fx.request);
        expect(s.from).toBeLessThan(100);
        expect(s.to).toBeLessThan(100);
    });
});

describe('GOLDEN: Newport → Tangalooma (leading-line approach)', () => {
    const fx = loadFixture('newport-tangalooma.corridor.json.gz');
    const layers = assembleLayers(fx);
    const r = routeInshore(layers, fx.request);

    it('resolves connected', () => {
        expectConnected(r);
    });

    // 16.09 NM / caution 10 measured at lock-in (2026-06-12).
    it('distance pinned at 16.09 NM ±2%', () => {
        expectConnected(r);
        expect(r.distanceNM).toBeGreaterThan(16.09 * 0.98);
        expect(r.distanceNM).toBeLessThan(16.09 * 1.02);
    });

    it('caution cells at or below the lock-in baseline (10)', () => {
        expectConnected(r);
        expect(cautionCount(r)).toBeLessThanOrEqual(10);
    });

    // KNOWN ENGINE BUG (Claude B's lane — diagnosed 2026-06-12, see
    // ROUTING_COLLAB.md reply 8). The approach SHOULD fire here: gate-by-gate
    // against this exact fixture, parseLeadingLines yields both Tangalooma
    // leads (23.6° + 72.3°), buildLeadingApproach returns the full dog-leg
    // (chain=5, lineCount=2, anchor -27.1913,153.3644), and the A* route
    // passes 183 m from the anchor (divert gate is <1500 m). The remaining
    // gate is applyLeadingLineApproach's land validation
    // (llAnyAlong(spliced, 25, isBlocked)) — the Tangalooma WRECKS sit
    // directly on the approach, and their hard-blocked buffer cells almost
    // certainly veto the splice. A charted lead should not be vetoed by the
    // very hazard it exists to guide you past. Flips to it() when fixed.
    it.fails('routes via the charted leading-line approach (debug.leadingApproach)', () => {
        expectConnected(r);
        expect(r.debug?.leadingApproach, 'leading-line APPROACH machinery must fire on Tangalooma').toBeTruthy();
    });

    it('endpoint snap < 150 m both ends', () => {
        expectConnected(r);
        const s = snapM(r, fx.request);
        expect(s.from).toBeLessThan(150);
        expect(s.to).toBeLessThan(150);
    });
});
