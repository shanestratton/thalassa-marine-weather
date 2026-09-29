/**
 * An OSM coastline over CHARTED WET water stays caution water (Pass 2b gets
 * Pass 2's doctrine) — inshore router Phase 1 review, 2026-09-29.
 *
 * The case the old chart-transit reopen served: an OSM natural=coastline line
 * (the usual river-mouth or creek closing line) crosses a charted channel
 * that is WET at chart datum but shallow for this keel (S-57 DEPARE
 * DRVAL1 1.0, draft 2.4), with no chart LNDARE there at all. Pass 2 keeps a
 * chart LNDARE over such a band as CAUTION (wetChartClaim → protected +
 * wetConflict); Pass 2b hard-blocked the same cells for an OSM coastline,
 * because shallow wet water is not protected until land collides. Before
 * Phase 1 the lead's brush reopened the crossing; Phase 1 removed that reopen
 * (right for drying bands and LNDARE), which severed the channel at the
 * closing line and refused the route. Now the coastline over the wet band is
 * the same honest CAUTION whether or not a lead is on it (a lead never
 * prefers or rescues a closing-line cell). A drying band (DRVAL1 ≤ 0) under
 * the coastline still blocks: a spit is still a spit. So does coastline-only
 * land over a WET band — a cay, a spit, a reclaimed pad: only a straight
 * stretch of an open coastline, from chart land to chart land, with charted
 * water on both sides, is read as a closing line.
 */
import type { Feature, FeatureCollection, LineString, Position } from 'geojson';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildNavGrid, navGridCache } from '../../services/engine/navGrid';
import { latLonToGrid } from '../../services/engine/geometry';
import type { InshoreLayers } from '../../services/engine/types';
import { routeInshore, type RouteRequest } from '../../services/inshoreRouterEngine';

const rect = (minLon: number, minLat: number, maxLon: number, maxLat: number, props: Record<string, unknown>) =>
    ({
        type: 'Feature',
        properties: props,
        geometry: {
            type: 'Polygon',
            coordinates: [
                [
                    [minLon, minLat],
                    [maxLon, minLat],
                    [maxLon, maxLat],
                    [minLon, maxLat],
                    [minLon, minLat],
                ],
            ],
        },
    }) as Feature;
const line = (coords: Position[], props: Record<string, unknown>): Feature<LineString> => ({
    type: 'Feature',
    properties: props,
    geometry: { type: 'LineString', coordinates: coords },
});
const fc = (...f: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features: f });
const isResult = (r: ReturnType<typeof routeInshore>): r is Extract<typeof r, { polyline: unknown }> => 'polyline' in r;

// A creek ~220 m wide, charted 1.0 m (wet, shallow for 2.4 + 0.2), between
// LNDARE banks, from a deep basin (west) to the deep bay (east). The OSM
// coastline runs north-south across the creek mouth at lon 152.512 — over
// the banks (land) and over the charted creek (no LNDARE there).
const CREEK_S = -27.901;
const CREEK_N = -27.899;
const MOUTH_LON = 152.512;
function creek(creekDrval1: number, withLead: boolean): InshoreLayers {
    return {
        DEPARE: fc(
            rect(152.5, -27.903, 152.504, -27.897, { acronym: 'DEPARE', DRVAL1: 10 }), // basin
            rect(152.504, CREEK_S, 152.517, CREEK_N, { acronym: 'DEPARE', DRVAL1: creekDrval1 }), // creek
            rect(152.517, -27.93, 152.545, -27.88, { acronym: 'DEPARE', DRVAL1: 10 }), // bay
        ),
        LNDARE: fc(
            rect(152.498, CREEK_N, 152.517, -27.88, { acronym: 'LNDARE' }), // north bank
            rect(152.498, -27.93, 152.517, CREEK_S, { acronym: 'LNDARE' }), // south bank
            rect(152.498, -27.903, 152.5, -27.897, { acronym: 'LNDARE' }), // basin head
        ),
        COASTLINE: fc(
            line(
                [
                    [MOUTH_LON, -27.93],
                    [MOUTH_LON, -27.88],
                ],
                { natural: 'coastline' },
            ),
        ),
        NAVLINE: withLead
            ? fc(
                  line(
                      [
                          [152.5025, -27.9],
                          [152.53, -27.9],
                      ],
                      { acronym: 'NAVLNE', CATNAV: 3 },
                  ),
              )
            : fc(),
    } as InshoreLayers;
}

const BBOX: [number, number, number, number] = [152.495, -27.935, 152.55, -27.875];
const DRAFT = 2.4;
const SAFETY = 0.2;
const req: RouteRequest = {
    fromLat: -27.9,
    fromLon: 152.502, // in the basin
    toLat: -27.9,
    toLon: 152.53, // out in the bay
    draftM: DRAFT,
    safetyM: SAFETY,
    resolutionM: 50,
};

beforeEach(() => navGridCache.clear());

/** The mouth cells the coastline crosses, over the creek and over a bank. */
function mouth(layers: InshoreLayers) {
    const grid = buildNavGrid(layers, BBOX, 50, DRAFT, SAFETY, 60);
    const at = (lat: number) => {
        const { x, y } = latLonToGrid(grid, lat, MOUTH_LON);
        const i = y * grid.width + x;
        return {
            landBlocked: grid.landBlocked?.[i] ?? 0,
            blocked: Number.isNaN(grid.cells[i]),
            wetConflict: grid.wetConflict?.[i] ?? 0,
        };
    };
    return { creek: at(-27.9), bank: at(-27.895) };
}

describe('Pass 2b: an OSM coastline over a charted wet band stays caution water', () => {
    it.each([true, false])('the creek mouth is open water under the coastline (lead on it: %s)', (withLead) => {
        const { creek: c, bank } = mouth(creek(1.0, withLead));
        expect(c).toMatchObject({ landBlocked: 0, blocked: false, wetConflict: 1 });
        // The coastline over the bank is still land.
        expect(bank).toMatchObject({ landBlocked: 1, blocked: true });
    });

    it.each([true, false])('the route runs out through the creek (lead on it: %s)', (withLead) => {
        const r = routeInshore(creek(1.0, withLead), req);
        expect(isResult(r)).toBe(true);
        if (!isResult(r)) return;
        // Through the charted creek, not by relaxing land: before the fix the
        // basin was islanded behind the coastline, and only the far-snap
        // relax zone (land → caution for ~1.4 km round the origin) let the
        // route out.
        const debug = (r as unknown as { debug?: { relaxZones?: unknown[] } }).debug;
        expect(debug?.relaxZones ?? []).toEqual([]);
        // Out through the mouth, not around: every sampled point near the
        // mouth lies in the creek's latitude band.
        const poly = r.polyline as Position[];
        for (let i = 0; i + 1 < poly.length; i++) {
            for (let s = 0; s <= 40; s++) {
                const t = s / 40;
                const lon = poly[i][0] + (poly[i + 1][0] - poly[i][0]) * t;
                const lat = poly[i][1] + (poly[i + 1][1] - poly[i][1]) * t;
                if (lon > MOUTH_LON - 0.001 && lon < MOUTH_LON + 0.001) {
                    expect(lat).toBeGreaterThan(CREEK_S - 0.0005);
                    expect(lat).toBeLessThan(CREEK_N + 0.0005);
                }
            }
        }
        expect(r.distanceNM).toBeLessThan(1.6);
    });

    it.each([0, -0.5])('a drying band (DRVAL1 %s) under the coastline still blocks', (drval1) => {
        expect(mouth(creek(drval1, true)).creek).toMatchObject({ landBlocked: 1, blocked: true, wetConflict: 0 });
    });
});

// Final review 2026-09-29 (medium): the Pass 2b exemption had no guard. A cay
// that exists only as an OSM coastline ring (the overview cell leaves it out,
// or it is newer than the chart) under a coarse overview band charted 2-5 m
// (DRVAL1 2, wet at chart datum) became CAUTION, protected and wetConflict all
// round its ring: routable, priced at 1.5x under tideDirect, and rescued to
// 5 m preferred by any lead across it. A closed coastline ring is an island,
// never a closing line, so its cells stay land at any scale. The exemption is
// kept for an open coastline whose two sides are both charted water.
describe('Pass 2b: a coastline-only cay under a coarse wet band stays land', () => {
    // A 2 km band charted DRVAL1 2 (shallow for 2.4 + 0.2, wet at LAT) from an
    // overview cell, between deep water west and east. The cay, ~200 m across,
    // sits in the middle of the band on the direct line, drawn only by OSM.
    const B2: [number, number, number, number] = [152.6, -27.95, 152.66, -27.91];
    const CAY_LAT = -27.93;
    const CAY: [number, number, number, number] = [152.629, -27.931, 152.631, -27.929];
    const overview = { acronym: 'DEPARE', _scaleRank: -250 };
    const osmCoast = { natural: 'coastline', _source: 'osm' };
    const ring = (b: [number, number, number, number]): Position[] => [
        [b[0], b[1]],
        [b[2], b[1]],
        [b[2], b[3]],
        [b[0], b[3]],
        [b[0], b[1]],
    ];
    function cay(opts: { lead: boolean; splitRing?: boolean }): InshoreLayers {
        const r = ring(CAY);
        // Overpass returns a large island as several ways that meet end to end.
        const coast = opts.splitRing
            ? [line(r.slice(0, 3), osmCoast), line(r.slice(2), osmCoast)]
            : [line(r, osmCoast)];
        return {
            DEPARE: fc(
                rect(152.6, -27.95, 152.62, -27.91, { ...overview, DRVAL1: 10 }),
                rect(152.62, -27.95, 152.64, -27.91, { ...overview, DRVAL1: 2 }),
                rect(152.64, -27.95, 152.66, -27.91, { ...overview, DRVAL1: 10 }),
            ),
            COASTLINE: fc(...coast),
            NAVLINE: opts.lead
                ? fc(
                      line(
                          [
                              [152.605, CAY_LAT],
                              [152.655, CAY_LAT],
                          ],
                          { 'seamark:type': 'navigation_line', _source: 'osm', _osmId: 42 },
                      ),
                  )
                : fc(),
        } as InshoreLayers;
    }
    const cayReq: RouteRequest = {
        fromLat: CAY_LAT,
        fromLon: 152.607,
        toLat: CAY_LAT,
        toLon: 152.653,
        draftM: DRAFT,
        safetyM: SAFETY,
        resolutionM: 50,
        routeProfile: 'tideDirect',
    };

    it.each([
        { lead: false, splitRing: false },
        { lead: true, splitRing: false },
        { lead: true, splitRing: true },
    ])('the cay ring is land on the grid (%o)', (opts) => {
        const grid = buildNavGrid(cay(opts), B2, 50, DRAFT, SAFETY, 60, false, [], 'tideDirect');
        const at = (lat: number, lon: number) => {
            const { x, y } = latLonToGrid(grid, lat, lon);
            const i = y * grid.width + x;
            return {
                landBlocked: grid.landBlocked?.[i] ?? 0,
                blocked: Number.isNaN(grid.cells[i]),
                wetConflict: grid.wetConflict?.[i] ?? 0,
                assist: grid.tideAssist?.[i] ?? 0,
            };
        };
        // West and east edges of the ring, on the direct line (and the lead).
        for (const lon of [CAY[0], CAY[2]]) {
            expect(at(CAY_LAT, lon)).toMatchObject({ landBlocked: 1, blocked: true, wetConflict: 0, assist: 0 });
        }
        // North and south edges too.
        for (const lat of [CAY[1], CAY[3]]) {
            expect(at(lat, 152.63)).toMatchObject({ landBlocked: 1, blocked: true, wetConflict: 0 });
        }
    });

    it.each([false, true])('the route goes round the cay, never across it (OSM lead on it: %s)', (lead) => {
        const r = routeInshore(cay({ lead }), cayReq);
        expect(isResult(r)).toBe(true);
        if (!isResult(r)) return;
        const poly = r.polyline as Position[];
        for (let i = 0; i + 1 < poly.length; i++) {
            for (let s = 0; s <= 80; s++) {
                const t = s / 80;
                const lon = poly[i][0] + (poly[i + 1][0] - poly[i][0]) * t;
                const lat = poly[i][1] + (poly[i + 1][1] - poly[i][1]) * t;
                const onCay = lon > CAY[0] && lon < CAY[2] && lat > CAY[1] && lat < CAY[3];
                expect(onCay, `route point ${lat.toFixed(5)},${lon.toFixed(5)} is on the cay`).toBe(false);
            }
        }
    });

    it('a breakwater over the wet band is a structure, never a closing line', () => {
        const layers = creek(1.0, false);
        layers.COASTLINE = fc(
            line(
                [
                    [MOUTH_LON, -27.93],
                    [MOUTH_LON, -27.88],
                ],
                { man_made: 'breakwater', _source: 'osm' },
            ),
        );
        expect(mouth(layers).creek).toMatchObject({ landBlocked: 1, blocked: true, wetConflict: 0 });
    });

    it('a coastline along the shore of the wet band, with land on one side, is still the shore', () => {
        // The creek's coastline drawn along its north bank instead of across
        // its mouth: over the charted band, but with the bank (LNDARE, no
        // band) on its north side. Not a closing line: it stays land.
        const layers = creek(1.0, false);
        const bankLat = CREEK_N - 0.0002;
        layers.COASTLINE = fc(
            line(
                [
                    [152.505, bankLat],
                    [152.516, bankLat],
                ],
                osmCoast,
            ),
        );
        const grid = buildNavGrid(layers, BBOX, 50, DRAFT, SAFETY, 60);
        const { x, y } = latLonToGrid(grid, bankLat, 152.51);
        const i = y * grid.width + x;
        expect(grid.wetConflict?.[i] ?? 0).toBe(0);
        expect(grid.landBlocked?.[i]).toBe(1);
    });

    it('a creek-mouth conflict cell is never priced as a tide crossing', () => {
        const grid = buildNavGrid(creek(1.0, false), BBOX, 50, DRAFT, SAFETY, 60, false, [], 'tideDirect');
        const { x, y } = latLonToGrid(grid, -27.9, MOUTH_LON);
        const i = y * grid.width + x;
        expect(grid.wetConflict?.[i]).toBe(1);
        expect(grid.tideAssist?.[i]).toBe(0);
        // The rest of the creek is still a tide crossing.
        const inCreek = latLonToGrid(grid, -27.9, 152.508);
        expect(grid.tideAssist?.[inCreek.y * grid.width + inCreek.x]).toBe(1);
    });
});

// Final review, second pass (2026-09-29, medium): the closed-ring guard was
// not enough. OSM coastline-only land on an OPEN chain — a spit or mole off
// the mainland, a pad reclaimed after the chart was drawn — under a wet
// overview band passed the both-sides test: on a sub-cell spit both sides of
// the one coastline column are band, and on a wide pad the band under the
// pad itself read as "wet". Every cell became CAUTION + protected +
// wetConflict with landBlocked 0, and an OSM lead across it then stamped
// those cells 5 m preferred: tideDirect crossed the spit and the pad with 0
// caution legs, under unchartedPolicy 'strict' too. HEAD kept both as land.
// The review measured it with OSM-like vertices ~10 m apart; with 2-vertex
// segments the old direction chord swallowed whole km-long neighbours and
// left these shapes land by accident, so these fixtures are dense.
describe('Pass 2b: open-chain coastline-only land under a coarse wet band stays land (dense OSM vertices)', () => {
    const B2: [number, number, number, number] = [152.6, -27.95, 152.66, -27.91];
    const overview = { acronym: 'DEPARE', _scaleRank: -250 };
    const osmCoast = { natural: 'coastline', _source: 'osm' };
    const SHORE = -27.915;
    /** OSM draws coastline with vertices metres apart; ~10 m here. */
    const dense = (coords: Position[], stepDeg = 0.0001): Position[] => {
        const out: Position[] = [coords[0]];
        for (let i = 0; i + 1 < coords.length; i++) {
            const [x0, y0] = coords[i];
            const [x1, y1] = coords[i + 1];
            const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / stepDeg));
            for (let k = 1; k <= n; k++) {
                out.push(k === n ? coords[i + 1] : [x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n]);
            }
        }
        return out;
    };
    const osmLead = (lat: number) =>
        fc(
            line(
                [
                    [152.605, lat],
                    [152.655, lat],
                ],
                { 'seamark:type': 'navigation_line', _source: 'osm', _osmId: 42 },
            ),
        );
    /**
     * Mainland LNDARE along the north edge; an overview band charted DRVAL1 2
     * (wet at LAT, shallow for 2.4 + 0.2) between deep bands west and east.
     * `anchored`: the band stops 110 m short of the shore, so the mainland
     * coastline lies on chart land (the land-anchored shape) rather than over
     * the band's generalised edge (the review's shape).
     */
    function bay(coast: Position[], o: { lead: boolean; anchored: boolean; sparse?: boolean }, leadLat: number) {
        const bandTop = o.anchored ? SHORE - 0.001 : SHORE;
        return {
            DEPARE: fc(
                rect(152.6, -27.95, 152.62, bandTop, { ...overview, DRVAL1: 10 }),
                rect(152.62, -27.95, 152.64, bandTop, { ...overview, DRVAL1: 2 }),
                rect(152.64, -27.95, 152.66, bandTop, { ...overview, DRVAL1: 10 }),
            ),
            LNDARE: fc(rect(152.6, bandTop, 152.66, -27.91, { acronym: 'LNDARE' })),
            COASTLINE: fc(line(o.sparse ? coast : dense(coast), osmCoast)),
            NAVLINE: o.lead ? osmLead(leadLat) : fc(),
        } as InshoreLayers;
    }
    function gridAt(layers: InshoreLayers, lat: number, lon: number) {
        const grid = buildNavGrid(layers, B2, 50, DRAFT, SAFETY, 60, false, [], 'tideDirect');
        const { x, y } = latLonToGrid(grid, lat, lon);
        const i = y * grid.width + x;
        return {
            landBlocked: grid.landBlocked?.[i] ?? 0,
            blocked: Number.isNaN(grid.cells[i]),
            wetConflict: grid.wetConflict?.[i] ?? 0,
            preferred: grid.preferred?.[i] ?? 0,
        };
    }
    /** The first sampled route point inside `inside`, or null. */
    function entersLand(layers: InshoreLayers, r: RouteRequest, inside: (lat: number, lon: number) => boolean) {
        const res = routeInshore(layers, r);
        expect(isResult(res)).toBe(true);
        if (!isResult(res)) return 'refused';
        const poly = res.polyline as Position[];
        for (let i = 0; i + 1 < poly.length; i++) {
            for (let s = 0; s <= 200; s++) {
                const t = s / 200;
                const lon = poly[i][0] + (poly[i + 1][0] - poly[i][0]) * t;
                const lat = poly[i][1] + (poly[i + 1][1] - poly[i][1]) * t;
                if (inside(lat, lon)) return `${lat.toFixed(5)},${lon.toFixed(5)}`;
            }
        }
        return null;
    }
    // The review's shape (the mainland coastline over the band's edge), the
    // land-anchored shape, no lead, and the same land drawn with sparse
    // 2-vertex sides: the verdict must not depend on vertex spacing.
    const cases = [
        { lead: true, anchored: false },
        { lead: true, anchored: true },
        { lead: false, anchored: false },
        { lead: true, anchored: true, sparse: true },
    ];

    // A ~30 m-wide spit hanging 2.8 km south off the mainland shore: the
    // coastline runs along the shore, down the spit's west side, round its
    // tip and back up its east side. One open chain, no LNDARE for the spit.
    const W = 152.629;
    const E = 152.6293;
    const TIP = -27.94;
    const SPIT_LAT = -27.93;
    const spit: Position[] = [
        [152.6, SHORE],
        [W, SHORE],
        [W, TIP],
        [E, TIP],
        [E, SHORE],
        [152.66, SHORE],
    ];
    it.each(cases)('a 30 m spit is land on the grid, and a lead across it never reopens it (%o)', (o) => {
        const layers = bay(spit, o, SPIT_LAT);
        for (const [lat, lon] of [
            [SPIT_LAT, W],
            [SPIT_LAT, E],
            [-27.925, W],
            [-27.935, E],
        ]) {
            expect(gridAt(layers, lat, lon), `spit cell ${lat},${lon}`).toMatchObject({
                landBlocked: 1,
                blocked: true,
                wetConflict: 0,
                preferred: 0,
            });
        }
    });
    it.each(cases)('the route goes round the spit tip, under either policy (%o)', (o) => {
        const layers = bay(spit, o, SPIT_LAT);
        const onSpit = (lat: number, lon: number) => lon >= W - 0.0002 && lon <= E + 0.0002 && lat > TIP && lat < SHORE;
        for (const policy of [undefined, 'strict' as const]) {
            const r: RouteRequest = {
                fromLat: SPIT_LAT,
                fromLon: 152.607,
                toLat: SPIT_LAT,
                toLon: 152.653,
                draftM: DRAFT,
                safetyM: SAFETY,
                resolutionM: 50,
                routeProfile: 'tideDirect',
                ...(policy ? { unchartedPolicy: policy } : {}),
            };
            expect(entersLand(layers, r, onSpit), `policy ${policy ?? 'default'}`).toBeNull();
        }
    });

    // A 600 m x 1.1 km pad reclaimed after the chart was drawn: the chart
    // still shows the band where the pad now stands; OSM draws its three faces.
    const PAD: [number, number, number, number] = [152.627, -27.925, 152.633, SHORE];
    const PAD_LAT = -27.92;
    const pad: Position[] = [
        [152.6, SHORE],
        [PAD[0], SHORE],
        [PAD[0], PAD[1]],
        [PAD[2], PAD[1]],
        [PAD[2], SHORE],
        [152.66, SHORE],
    ];
    it.each(cases)('a reclaimed pad is land on the grid, and a lead across it never reopens it (%o)', (o) => {
        const layers = bay(pad, o, PAD_LAT);
        for (const [lat, lon] of [
            [PAD_LAT, PAD[0]],
            [PAD_LAT, PAD[2]],
            [PAD[1], 152.63],
        ]) {
            expect(gridAt(layers, lat, lon), `pad face ${lat},${lon}`).toMatchObject({
                landBlocked: 1,
                blocked: true,
                wetConflict: 0,
                preferred: 0,
            });
        }
    });
    it.each(cases)('the route goes round the pad, under either policy (%o)', (o) => {
        const layers = bay(pad, o, PAD_LAT);
        const onPad = (lat: number, lon: number) => lon > PAD[0] && lon < PAD[2] && lat > PAD[1] && lat < SHORE;
        for (const policy of [undefined, 'strict' as const]) {
            const r: RouteRequest = {
                fromLat: PAD_LAT,
                fromLon: 152.607,
                toLat: PAD_LAT,
                toLon: 152.653,
                draftM: DRAFT,
                safetyM: SAFETY,
                resolutionM: 50,
                routeProfile: 'tideDirect',
                ...(policy ? { unchartedPolicy: policy } : {}),
            };
            expect(entersLand(layers, r, onPad), `policy ${policy ?? 'default'}`).toBeNull();
        }
    });

    // Each side of a ~50 m causeway, drawn as its own straight way from the
    // mainland's chart land to an islet's, looks like a closing line on its
    // own: anchored, straight, band beyond. What gives it away is the other
    // side one cell over. The both-sides test may step over its own line's
    // staircase, never over another stretch of coastline.
    it('a narrow causeway drawn as two coastline ways between chart land stays land', () => {
        const top = SHORE - 0.001;
        const SOUTH = -27.94;
        const CW = 152.62925;
        const CE = 152.62975; // ~49 m east: the next column at 50 m
        const layers = {
            DEPARE: fc(
                rect(152.6, -27.95, 152.62, top, { ...overview, DRVAL1: 10 }),
                rect(152.62, SOUTH, 152.64, top, { ...overview, DRVAL1: 2 }),
                rect(152.64, -27.95, 152.66, top, { ...overview, DRVAL1: 10 }),
            ),
            LNDARE: fc(
                rect(152.6, top, 152.66, -27.91, { acronym: 'LNDARE' }),
                rect(152.62, -27.95, 152.64, SOUTH, { acronym: 'LNDARE' }), // the islet
            ),
            COASTLINE: fc(
                line(
                    dense([
                        [CW, SHORE],
                        [CW, SOUTH - 0.0005],
                    ]),
                    osmCoast,
                ),
                line(
                    dense([
                        [CE, SOUTH - 0.0005],
                        [CE, SHORE],
                    ]),
                    osmCoast,
                ),
            ),
            NAVLINE: osmLead(SPIT_LAT),
        } as InshoreLayers;
        for (const lon of [CW, CE]) {
            expect(gridAt(layers, SPIT_LAT, lon), `causeway side ${lon}`).toMatchObject({
                landBlocked: 1,
                blocked: true,
                wetConflict: 0,
                preferred: 0,
            });
        }
    });
});

describe('Pass 2b: a real closing line stays honest caution water', () => {
    it('a lead across the creek mouth never reopens the closing line: it stays 40x red, unpreferred', () => {
        const grid = buildNavGrid(creek(1.0, true), BBOX, 50, DRAFT, SAFETY, 60);
        const { x, y } = latLonToGrid(grid, -27.9, MOUTH_LON);
        const i = y * grid.width + x;
        expect({
            cell: grid.cells[i],
            wetConflict: grid.wetConflict?.[i],
            preferred: grid.preferred?.[i],
            landBlocked: grid.landBlocked?.[i],
        }).toEqual({ cell: -1, wetConflict: 1, preferred: 0, landBlocked: 0 });
        // The lead still marks the creek itself on either side of the mouth.
        const up = latLonToGrid(grid, -27.9, 152.508);
        expect(grid.preferred?.[up.y * grid.width + up.x]).toBe(1);
    });

    // The closing line drawn the way OSM draws it: the coastline comes in
    // along the creek's south bank, crosses the mouth and leaves along the
    // north bank, each bank stretch one long 2-vertex segment. The old
    // direction test took those whole km-long neighbours into its chord,
    // skewed the normal to north-south and read the mouth as land.
    it('a closing line joined to long, sparse bank segments is still a closing line', () => {
        const layers = creek(1.0, false);
        layers.COASTLINE = fc(
            line(
                [
                    [152.4985, -27.9025], // 1.3 km along the south bank (LNDARE)
                    [MOUTH_LON, -27.9015],
                    [MOUTH_LON, -27.8985], // across the mouth
                    [152.5165, -27.8975], // along the north bank (LNDARE)
                ],
                { natural: 'coastline', _source: 'osm' },
            ),
        );
        const grid = buildNavGrid(layers, BBOX, 50, DRAFT, SAFETY, 60);
        const { x, y } = latLonToGrid(grid, -27.9, MOUTH_LON);
        const i = y * grid.width + x;
        expect({ wetConflict: grid.wetConflict?.[i], landBlocked: grid.landBlocked?.[i] }).toEqual({
            wetConflict: 1,
            landBlocked: 0,
        });
        const r = routeInshore(layers, req);
        expect(isResult(r)).toBe(true);
        if (!isResult(r)) return;
        const debug = (r as unknown as { debug?: { relaxZones?: unknown[] } }).debug;
        expect(debug?.relaxZones ?? []).toEqual([]);
        expect(r.distanceNM).toBeLessThan(1.6);
    });
});
