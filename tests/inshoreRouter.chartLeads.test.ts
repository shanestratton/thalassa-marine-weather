/**
 * CHARACTERISATION — chart leading lines fed the PRODUCTION way (inshore
 * router Phase 1 review, 2026-09-29).
 *
 * The goldens (inshoreRouter.golden.test.ts) build their layers with
 * tests/helpers/corridorFixture.assembleLayers, which puts only the OSM
 * navigation lines into NAVLINE. Production also pushes the chart's own NAVLNE
 * CATNAV 3 leading lines there (InshoreRouter.ts: navLineLeads(navlne.features,
 * 'NAVLNE') into merged.NAVLINE), so "goldens identical" says nothing about
 * what Phase 1 did to chart leads. This file feeds them in the production
 * shape and pins what the router does, under both policies, so a later phase
 * cannot move it silently.
 *
 * Measured with the scratch prodleads probe (same requests as below):
 *
 *   case                               HEAD cfca0e77         Phase 1 (+ review fixes)
 *   newport-shane, strict (production)  24.58 NM, land 173 m  REFUSED hard-land-crossing, 2.6 km
 *   newport-shane, permissive           24.58 NM, land 173 m  19.62 NM, audit land run 2590 m
 *   Newport → Tangalooma, strict        REFUSED, 0.7 km       REFUSED, 0.7 km
 *   Newport → Tangalooma, permissive    23.80 NM, land 547 m  20.32 NM, audit land run 1993 m
 *
 * On the chart layers ALONE (this fixture's OSM capture is empty) the strict
 * refusal stands: HEAD's route leaned on land that the leading lines'
 * extensions used to vouch for (and that Pass 5b used to reopen). The
 * permissive runs are pinned AS THEY ARE — known bad, kilometres of charted
 * land — so that Phase 2 has to move them on purpose. Re-pin with the reason;
 * never loosen a bound to make a run pass.
 *
 * Production is never chart-only, though: the OSM overlay (canal lines,
 * marina basins, OSM water) is merged on top, and the grid treats the Newport
 * entrance channel as water through it. The GOLDEN at the end pins that shape
 * (review 2026-09-29): it routes, with no unvouched land.
 */
import { describe, expect, it } from 'vitest';
import { auditUnvouchedHardLand } from '../services/engine/safetyAudit';
import { routeInshore, type RouteRequest } from '../services/inshoreRouterEngine';
import { navLineLeads } from '../services/leadingLine';
import { assembleLayers, loadFixture } from './helpers/corridorFixture';

const fx = loadFixture('newport-shane.corridor.json.gz');
// The OSM overlay production merges on top (the rivergate capture's: marina
// basins, the canal lines, OSM water and coastline). newport-shane's own
// capture carries none — the characterisation below is chart layers alone.
const osmRivergate = loadFixture('newport-rivergate.corridor.json.gz');

/** assembleLayers + the chart's CATNAV 3 leads, as InshoreRouter merges them. */
function productionLayers(osm: typeof fx.osm = fx.osm) {
    const layers = assembleLayers({ ...fx, osm });
    layers.NAVLINE.features.push(...navLineLeads(fx.cells.NAVLNE?.features ?? [], 'NAVLNE'));
    return layers;
}

const TANGALOOMA: RouteRequest = {
    fromLat: -27.2135,
    fromLon: 153.0875,
    toLat: -27.176,
    toLon: 153.371,
    draftM: 2.4,
    safetyM: 0.2,
    obstructionBufferM: 60,
};

/**
 * These tests route inside the test body (the goldens route at file load,
 * outside any per-test limit). A strict refusal tries every fallback before
 * it gives up: 9.6 s on the 8 GB Mac with v8 coverage on, and CI's runners
 * with coverage went past the global 20 s limit (CI 36623741291). A time
 * limit is not an assertion: the pins below are unchanged.
 */
const ROUTE_TEST_TIMEOUT_MS = 90_000;

function run(req: RouteRequest, strict: boolean, osm: typeof fx.osm = fx.osm) {
    const layers = productionLayers(osm);
    const r = routeInshore(layers, strict ? { ...req, unchartedPolicy: 'strict' } : req);
    if ('error' in r) return { refused: true as const, code: r.code, hardLandMaxRunM: r.debug?.hardLandMaxRunM };
    const audit = auditUnvouchedHardLand(layers, r.polyline);
    return {
        refused: false as const,
        distanceNM: r.distanceNM,
        caution: (r.cautionMask ?? []).filter(Boolean).length,
        auditMaxRunM: audit.maxRunM,
    };
}

const within = (value: number | undefined, pin: number, frac: number): void => {
    expect(value).toBeGreaterThan(pin * (1 - frac));
    expect(value).toBeLessThan(pin * (1 + frac));
};

describe(
    'CHARACTERISATION: chart CATNAV 3 leads in the production shape (newport-shane cells)',
    { timeout: ROUTE_TEST_TIMEOUT_MS },
    () => {
        it('the fixture carries the chart leads this file is about', () => {
            const leads = navLineLeads(fx.cells.NAVLNE?.features ?? [], 'NAVLNE');
            expect(leads.length).toBe(31);
            expect(leads.every((f) => f.properties?.CATNAV === 3)).toBe(true);
        });

        it('newport-shane, strict (the production policy): refuses — the only candidate crosses ~2.6 km of charted land', () => {
            const r = run(fx.request, true);
            expect(r.refused).toBe(true);
            if (!r.refused) return;
            expect(r.code).toBe('hard-land-crossing');
            within(r.hardLandMaxRunM, 2_590, 0.05);
        });

        it('newport-shane, permissive: 19.62 NM with a ~2.6 km audit land run (known bad, pinned as is)', () => {
            const r = run(fx.request, false);
            expect(r.refused).toBe(false);
            if (r.refused) return;
            within(r.distanceNM, 19.622, 0.02);
            within(r.auditMaxRunM, 2_590, 0.05);
            expect(r.caution).toBeLessThanOrEqual(9);
        });

        it('Newport → Tangalooma, strict: refuses — ~0.7 km of charted land', () => {
            const r = run(TANGALOOMA, true);
            expect(r.refused).toBe(true);
            if (!r.refused) return;
            expect(r.code).toBe('hard-land-crossing');
            within(r.hardLandMaxRunM, 742, 0.05);
        });

        it('Newport → Tangalooma, permissive: 20.32 NM with a ~2.0 km audit land run (known bad, pinned as is)', () => {
            const r = run(TANGALOOMA, false);
            expect(r.refused).toBe(false);
            if (r.refused) return;
            within(r.distanceNM, 20.321, 0.02);
            within(r.auditMaxRunM, 1_993, 0.05);
            // Re-pinned 5 → 6 (final review 2026-09-29, on purpose): the lead
            // brush no longer stamps relax-zone land beside a lead 5 m preferred,
            // so that stretch of the crossing near the Newport origin is drawn red
            // now — one more caution leg (measured 5 without the fix, 6 with it;
            // 20.345 → 20.322 NM, audit land run 1998 → 1991 m).
            expect(r.caution).toBeLessThanOrEqual(6);
        });
    },
);

// GOLDEN — the production shape: the newport-shane cells (with their chart
// NAVLNE leads) PLUS the OSM overlay, strict, 60 m obstruction buffer.
//
// Phase 1 review (high, 2026-09-29): with the overlay present the grid treats
// the Newport entrance channel as water (the OSM canal carve and OSM-vouched
// water), but the lead clip read S-57 water only. It cut the entrance lead
// (NAVLNE 406/3035, ORIENT 183) into two pieces with a ~590 m gap exactly in
// the channel (-27.1961 to -27.2015, LNDARE with no S-57 DEPARE), and the
// strict router REFUSED both departures (hard-land-crossing ~1.0 km);
// permissive ran out the channel, U-turned into the canal estate and crossed
// ~1.04 km of charted LNDARE. HEAD cfca0e77 routed both cleanly (24.58 NM /
// 23.95 NM, 0 m of unvouched land under the new audit), as did the same tree
// with no chart leads. The goldens (OSM only) and the characterisation above
// (chart only) never saw it. The grid now clips a lead against its OWN land
// verdict, so a stretch the grid already treats as water keeps its lead.
//
// Measured after the fix (scratch prodleads probe; HEAD in brackets):
//   newport-shane          24.54 NM, caution 6, audit 0 m  [24.58 NM, 4, 0 m]
//   Newport -> Rivergate   23.93 NM, caution 9, audit 0 m  [23.95 NM, 4, 0 m]
// The extra caution segments are the land-conflict cells HEAD's reopen used
// to paint as 5 m water, now honest CAUTION.
describe('GOLDEN: chart leads + OSM overlay (the production shape), strict', { timeout: ROUTE_TEST_TIMEOUT_MS }, () => {
    it.each([
        ['newport-shane', { ...fx.request, obstructionBufferM: 60 }, 24.54, 6],
        ['Newport -> Rivergate', osmRivergate.request, 23.93, 9],
    ] as const)('%s routes (%s NM), with no unvouched charted land', (_name, req, nm, maxCaution) => {
        const r = run(req, true, osmRivergate.osm);
        expect(r.refused, JSON.stringify(r)).toBe(false);
        if (r.refused) return;
        expect(r.auditMaxRunM).toBe(0);
        within(r.distanceNM, nm, 0.02);
        expect(r.caution).toBeLessThanOrEqual(maxCaution);
    });
});
