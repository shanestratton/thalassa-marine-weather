/**
 * A solo lateral's inferred keep-out never closes charted deep water, and a
 * pin in a dredged river is never "on charted land" (2026-10-01).
 *
 * Found on the real Brisbane cells through the APP path (tryInshoreRoute,
 * which runs mark inference; the golden fixture harness does not): the
 * shipping channel's marks reach orientHazardsTowardLand unpaired, and three
 * solo starboard marks beside the dredged river mouth grew half-discs of
 * 549–647 m toward the nearest land — across the channel. The mouth closed:
 * with a 2.5 m tide top the route refused ("the only way through crosses the
 * West Banks"), and with no tide known it went over the drying bank and land.
 * Separately, the Rivergate pin — in a 9.1 m dredged area under a coarser
 * chart's coastline paint — read "on charted land" whenever the route could
 * not reach it, and the inland trim cut 2,660 m of river off the route.
 *
 * Everything here is SYNTHETIC (the repo is public): a river running west from
 * a mouth, a dredged channel down its middle and out into a bay, a spit on the
 * channel's south side, a drying bank on its north side, three solo starboard
 * marks on the bank's edge beside the channel, and an overview chart whose
 * coastline paint covers the upper river. Serene Summer: 2.4 m draft, 0.5 m
 * under-keel clearance (2.9 m), 18 m air draft. The local-only real-chart
 * check that used to sit beside it was retired in 127 (no decrypted cells on
 * a Mac's disk); real-chart checks move to the Pi's in-memory parity harness.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Feature, FeatureCollection, Polygon } from 'geojson';

const h = vi.hoisted(() => ({
    cells: [] as { id: string; bbox: [number, number, number, number] }[],
    blobs: new Map<string, unknown>(),
    lastLayers: null as unknown,
    lastResult: null as unknown,
    osm: null as unknown,
}));

vi.mock('../../services/enc/EncCellMetadata', async (original) => ({
    ...(await original<Record<string, unknown>>()),
    cellsForBBox: (b: [number, number, number, number]) =>
        h.cells.filter((c) => !(c.bbox[2] < b[0] || c.bbox[0] > b[2] || c.bbox[3] < b[1] || c.bbox[1] > b[3])),
    listCells: () => h.cells,
}));
vi.mock('../../services/enc/EncCellStore', async (original) => ({
    ...(await original<Record<string, unknown>>()),
    loadCellGeoJSON: async (id: string) => h.blobs.get(id) ?? null,
}));
vi.mock('../../services/OsmRouteOverlayService', async (original) => ({
    ...(await original<Record<string, unknown>>()),
    getOsmRouteOverlay: async () => h.osm,
}));
vi.mock('../../services/ntmRouting', () => ({
    activeNtmZonesFor: async () => ({ features: [], tracklines: [] }),
}));
vi.mock('../../services/mapboxWater', () => ({
    fetchMapboxWater: async () => ({ type: 'FeatureCollection', features: [] }),
}));
vi.mock('../../services/satelliteWater', () => ({
    fetchSatelliteWater: async () => ({ type: 'FeatureCollection', features: [] }),
}));
vi.mock('../../services/lowBridges', async (original) => ({
    ...(await original<Record<string, unknown>>()),
    loadLowBridges: async () => [],
}));
vi.mock('../../services/TideHeightService', async (original) => ({
    ...(await original<Record<string, unknown>>()),
    fetchTideCurve: async () => null,
}));
vi.mock('../../services/inshoreRouterEngine', async (original) => {
    const mod = await original<typeof import('../../services/inshoreRouterEngine')>();
    return {
        ...mod,
        routeInshore: (layers: unknown, req: unknown) => {
            h.lastLayers = layers;
            const r = mod.routeInshore(layers as never, req as never);
            h.lastResult = r;
            return r;
        },
    };
});

import { tryInshoreRoute } from '../../services/InshoreRouter';
import { chartAreaIndexFor, chartedDepthRangeAt } from '../../services/routing/leadLandClip';
import { hardLandAtPoint } from '../../services/engine/safetyAudit';
import { haversineM } from '../../services/engine/geometry';
import { noTideClearsRuns, tideCeilingLookup } from '../../services/engine/tideCeiling';
import type { RouteResult, TideCeiling } from '../../services/engine/types';

// ── The synthetic scene, in metres east (x) / north (y) of the river mouth ──
// Open ocean far from any regional marker file, so only the chart's own marks
// enter mark inference.
const LON0 = 160.0;
const LAT0 = -30.0;
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((LAT0 * Math.PI) / 180);
const ll = (x: number, y: number): [number, number] => [LON0 + x / M_PER_DEG_LON, LAT0 + y / M_PER_DEG_LAT];

/** A rectangle, its edges vertexed every 25 m — the disc orientation reads the
 *  nearest LAND VERTEX, as a real coastline's dense ring offers it. */
function rect(x0: number, y0: number, x1: number, y1: number): Polygon {
    const ring: [number, number][] = [];
    const edge = (ax: number, ay: number, bx: number, by: number): void => {
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 25));
        for (let i = 0; i < n; i++) ring.push(ll(ax + ((bx - ax) * i) / n, ay + ((by - ay) * i) / n));
    };
    edge(x0, y0, x1, y0);
    edge(x1, y0, x1, y1);
    edge(x1, y1, x0, y1);
    edge(x0, y1, x0, y0);
    ring.push(ring[0]);
    return { type: 'Polygon', coordinates: [ring] };
}
const area = (acronym: string, g: Polygon, props: Record<string, unknown> = {}): Feature => ({
    type: 'Feature',
    properties: { acronym, ...props },
    geometry: g,
});
const mark = (x: number, y: number, catlam: 1 | 2, name: string): Feature => ({
    type: 'Feature',
    properties: { acronym: 'BOYLAT', CATLAM: catlam, OBJNAM: name },
    geometry: { type: 'Point', coordinates: ll(x, y) },
});
const fc = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });

const PIN = { x: -3000, y: 0 }; // in the dredged river, under the overview's coastline paint
const BAY = { x: 4000, y: 0 }; // in the dredged channel out in the bay

function scene(opts: { soloMarks: boolean; causeway?: boolean }): void {
    h.osm = null;
    const harbourLand = [rect(-5000, 250, -300, 2000), rect(-5000, -2000, 700, -160)]; // north bank, south spit
    if (opts.causeway) harbourLand.push(rect(-1500, -2000, -1400, 2000)); // a solid fill across the river
    const harbour = {
        cellId: 'OC-99-SYN012',
        sourceHO: 'AU',
        edition: 1,
        issued: '2026-10-01',
        nativeScale: 12_000,
        bbox: [...ll(-5000, -2000), ...ll(5000, 2000)] as [number, number, number, number],
        layers: {
            LNDARE: fc(harbourLand.map((g) => area('LNDARE', g))),
            DRGARE: fc([area('DRGARE', rect(-5000, -100, 5000, 100), { DRVAL1: 9.1 })]),
            DEPARE: fc([
                // River margins either side of the dredged channel: 2–5 m, never dry.
                area('DEPARE', rect(-5000, 100, -300, 250), { DRVAL1: 2, DRVAL2: 5 }),
                area('DEPARE', rect(-5000, -160, 700, -100), { DRVAL1: 2, DRVAL2: 5 }),
                // The drying bank north of the channel, from the mouth out into the bay.
                area('DEPARE', rect(-300, 100, 2500, 2000), { DRVAL1: -2, DRVAL2: 0 }),
                // Deep bay beyond the bank and the spit.
                area('DEPARE', rect(2500, 100, 5000, 2000), { DRVAL1: 10, DRVAL2: 20 }),
                area('DEPARE', rect(700, -2000, 5000, -100), { DRVAL1: 10, DRVAL2: 20 }),
            ]),
            // Three solo starboard marks on the bank's edge beside the channel.
            BOYLAT: fc(
                opts.soloMarks ? [mark(150, 130, 2, 'S19'), mark(300, 130, 2, 'S21'), mark(450, 130, 2, 'S23')] : [],
            ),
        },
    };
    const overview = {
        cellId: 'OC-99-SYN150',
        sourceHO: 'AU',
        edition: 1,
        issued: '2026-10-01',
        nativeScale: 1_500_000,
        bbox: [...ll(-30000, -30000), ...ll(30000, 30000)] as [number, number, number, number],
        layers: {
            // The coarse coastline paint: everything west of x = -1000, the upper river included.
            LNDARE: fc([area('LNDARE', rect(-30000, -30000, -1000, 30000))]),
            DEPARE: fc([area('DEPARE', rect(-1000, -30000, 30000, 30000), { DRVAL1: 10, DRVAL2: 20 })]),
        },
    };
    h.cells = [];
    h.blobs.clear();
    for (const blob of [overview, harbour]) {
        h.cells.push({
            id: blob.cellId,
            sourceHO: blob.sourceHO,
            edition: blob.edition,
            issued: blob.issued,
            importedAt: '2026-10-01T00:00:00.000Z',
            bbox: blob.bbox,
            geojsonPath: `enc/${blob.cellId}.json`,
            hazardCount: 1,
            usage: 'navigation',
        } as never);
        h.blobs.set(blob.cellId, blob);
    }
}

const NEED_M = 2.9;
const ceilingsAt = (highestM: number): TideCeiling[] => {
    const out: TideCeiling[] = [];
    for (let lat = -30.5; lat <= -29.5; lat += 0.25)
        for (let lon = 159.5; lon <= 160.5; lon += 0.25) out.push({ lat, lon, highestM, days: 14 });
    return out;
};

async function route(tide: number | null) {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in this test'));
    const [fromLon, fromLat] = ll(BAY.x, BAY.y);
    const [toLon, toLat] = ll(PIN.x, PIN.y);
    const res = await tryInshoreRoute({ lat: fromLat, lon: fromLon }, { lat: toLat, lon: toLon }, 2.4, 18, 'safest', {
        tideCeilings: tide === null ? [] : ceilingsAt(tide),
    });
    return { res, engine: h.lastResult as RouteResult | { error: string; code?: string } | null, toLat, toLon };
}

/** Metres of the route on charted land and over charted drying ground. */
function offWaterM(r: RouteResult): { landM: number; dryingM: number } {
    const layers = h.lastLayers as never;
    const bands = chartAreaIndexFor(layers).depth;
    const land = hardLandAtPoint(layers);
    let landM = 0;
    let dryingM = 0;
    const c = r.polyline;
    for (let i = 0; i + 1 < c.length; i++) {
        const segM = haversineM(c[i][1], c[i][0], c[i + 1][1], c[i + 1][0]);
        const steps = Math.max(1, Math.ceil(segM / 10));
        for (let k = 0; k < steps; k++) {
            const t = (k + 0.5) / steps;
            const lon = c[i][0] + (c[i + 1][0] - c[i][0]) * t;
            const lat = c[i][1] + (c[i + 1][1] - c[i][1]) * t;
            if (land(lon, lat)) landM += segM / steps;
            else {
                const range = chartedDepthRangeAt(bands, lon, lat);
                if (range && range.shallowestM !== null && range.shallowestM < 0) dryingM += segM / steps;
            }
        }
    }
    return { landM, dryingM };
}

/** The keep-out discs mark inference built from the solo marks. */
function soloDiscs(): { radiusM: number; yields: unknown }[] {
    const layers = h.lastLayers as { OBSTRN?: FeatureCollection };
    return (layers.OBSTRN?.features ?? [])
        .map((f) => f.properties as Record<string, unknown>)
        .filter(
            (p) =>
                p?._class === 'iala-oriented-hazard' &&
                (p._origin as { _class?: string } | undefined)?._class === 'lateral-marker-as-hazard',
        )
        .map((p) => ({ radiusM: p._radiusM as number, yields: p._yieldsToChartedDeep }));
}

// ── The reef-edge mark (review fix-up, 2026-10-01) ────────────────────────
// A solo starboard mark 600 m off a straight shore (y = 0, land to the
// south), at (0, 600). Its inferred keep-out exists for the strip between
// the mark and the shore that the chart may not show — the Scarborough
// pattern. Pins along the coast inside the mark's line: the short way runs
// inside the mark, the seamanlike way passes seaward of it.
const REEF_MARK = { x: 0, y: 600 };

function reefScene(strip: 'charted-deep' | 'osm-water-only' | 'charted-deep-no-reef'): void {
    const sea = (x0: number, y0: number, x1: number, y1: number): Feature =>
        area('DEPARE', rect(x0, y0, x1, y1), { DRVAL1: 10, DRVAL2: 20 });
    const depare: Feature[] =
        strip === 'charted-deep-no-reef'
            ? [sea(-6000, 0, 6000, 4000)]
            : strip === 'charted-deep'
              ? [
                    sea(-6000, 0, 6000, 4000),
                    // A drying reef lobe from the shore to 150 m inside the mark;
                    // between it and the mark the chart says 10 m.
                    area('DEPARE', rect(-400, 0, 400, 450), { DRVAL1: -1, DRVAL2: 0 }),
                ]
              : [
                    // No chart depth at all round the mark's shore side: only the
                    // OSM water below vouches for it (a fringing reef the chart
                    // does not draw would sit here).
                    sea(-6000, 0, -1000, 4000),
                    sea(1000, 0, 6000, 4000),
                    sea(-1000, 600, 1000, 4000),
                ];
    const cell = {
        cellId: 'OC-99-SYN014',
        sourceHO: 'AU',
        edition: 1,
        issued: '2026-10-01',
        nativeScale: 12_000,
        bbox: [...ll(-6000, -3000), ...ll(6000, 4000)] as [number, number, number, number],
        layers: {
            LNDARE: fc([area('LNDARE', rect(-6000, -3000, 6000, 0))]),
            DEPARE: fc(depare),
            BOYLAT: fc([mark(REEF_MARK.x, REEF_MARK.y, 2, 'R1')]),
        },
    };
    h.osm =
        strip === 'osm-water-only'
            ? {
                  // OSM tags only — no S-57 acronym, so it is water, never depth.
                  water: fc([
                      {
                          type: 'Feature',
                          properties: { natural: 'water', water: 'lagoon' },
                          geometry: rect(-1000, 0, 1000, 600),
                      },
                  ]),
                  reef: fc([]),
                  coastline: fc([]),
                  marina: fc([]),
                  breakwater: fc([]),
                  aeroway: fc([]),
                  canalLines: fc([]),
                  navLines: fc([]),
                  berths: fc([]),
              }
            : null;
    h.cells = [
        {
            id: cell.cellId,
            sourceHO: cell.sourceHO,
            edition: cell.edition,
            issued: cell.issued,
            importedAt: '2026-10-01T00:00:00.000Z',
            bbox: cell.bbox,
            geojsonPath: `enc/${cell.cellId}.json`,
            hazardCount: 5_000,
            usage: 'navigation',
        } as never,
    ];
    h.blobs.clear();
    h.blobs.set(cell.cellId, cell);
}

/** Where the route crosses the mark's meridian (x = 0), metres north of the
 *  shore, running east or west along y = `fromY`. */
async function reefPassY(fromY: number, heading: 'east' | 'west'): Promise<{ y: number; engine: RouteResult }> {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in this test'));
    const dir = heading === 'east' ? 1 : -1;
    const [fromLon, fromLat] = ll(-2500 * dir, fromY);
    const [toLon, toLat] = ll(2500 * dir, fromY);
    const res = await tryInshoreRoute({ lat: fromLat, lon: fromLon }, { lat: toLat, lon: toLon }, 2.4, 18, 'safest', {
        tideCeilings: [],
    });
    expect(res && 'error' in res ? res.error : null).toBeNull();
    const engine = h.lastResult as RouteResult;
    const [markLon] = ll(REEF_MARK.x, 0);
    const c = engine.polyline;
    for (let i = 0; i + 1 < c.length; i++) {
        const [lonA, latA] = c[i];
        const [lonB, latB] = c[i + 1];
        if ((lonA - markLon) * (lonB - markLon) <= 0 && lonA !== lonB) {
            const t = (markLon - lonA) / (lonB - lonA);
            return { y: (latA + (latB - latA) * t - LAT0) * M_PER_DEG_LAT, engine };
        }
    }
    throw new Error('the route never crossed the mark’s meridian');
}

describe('a reef-edge mark keeps its strip (review fix-up, 2026-10-01)', { timeout: 120_000 }, () => {
    // Both ways along the coast: eastbound the engine's own lateral clamp
    // (tierPipeline) happens to put the route seaward of this green mark by
    // its travel tangent; westbound the tangent says the other side, and
    // only the keep-out holds the line off the reef.
    for (const heading of ['east', 'west'] as const) {
        // The safety lens's scene: the water between the mark and its reef is
        // charted 10 m. With the first cut (one cable, any charted-deep water
        // yields) the westbound route ran straight past, 80 m inside the
        // mark and 70 m off the drying reef — as with no mark at all. Natural
        // deep water on the inferred side stays closed now: only a dredged
        // channel or fairway yields.
        it(`charted 10 m between the mark and a drying reef, ${heading}bound: the route passes seaward of the mark`, async () => {
            reefScene('charted-deep');
            const { y } = await reefPassY(520, heading);
            expect(y, 'metres north of the shore where the route passes the mark').toBeGreaterThan(REEF_MARK.y);
        });

        // Beyond a cable the chart speaks where it charts water that never
        // dries: charted 10 m right to the shore and no reef, a route 300 m
        // inside the mark runs straight past. (The full-reach disc closing
        // charted water measured worse on the real cells: it pushed the bay →
        // Lytton route onto a drying clip and refused it at a 2.5 m top.)
        it(`charted 10 m to the shore, ${heading}bound: 300 m inside the mark the chart speaks`, async () => {
            reefScene('charted-deep-no-reef');
            const { y } = await reefPassY(300, heading);
            expect(Math.abs(y - 300), 'metres the route bent off its line at the mark').toBeLessThan(30);
        });

        // The integrity lens's scene: the strip is vouched water with no chart
        // depth (OSM water), where a fringing reef the cell does not draw would
        // lie. The one-cable cap left 415 m of it open inside the mark.
        it(`the strip vouched only by OSM water, ${heading}bound: the route still passes seaward of the mark`, async () => {
            reefScene('osm-water-only');
            const { y } = await reefPassY(300, heading);
            expect(y, 'metres north of the shore where the route passes the mark').toBeGreaterThan(REEF_MARK.y);
        });
    }
});

describe('solo lateral keep-outs and the dredged river mouth', { timeout: 120_000 }, () => {
    for (const tide of [2.5, null] as const) {
        it(`reaches the river pin through the dredged mouth — highest tide ${tide ?? 'unknown'}`, async () => {
            scene({ soloMarks: true });
            const { engine, toLat, toLon } = await route(tide);
            const discs = soloDiscs();
            expect(discs, 'mark inference built no keep-outs from the solo marks').toHaveLength(3);
            expect(engine && 'error' in engine ? engine.error : null).toBeNull();
            const r = engine as RouteResult & { destinationInlandTrimM?: number };
            const end = r.polyline[r.polyline.length - 1];
            expect(haversineM(end[1], end[0], toLat, toLon), 'the route stops short of the pin').toBeLessThan(60);
            expect(r.destinationInlandTrimM).toBeUndefined();
            const off = offWaterM(r);
            expect(Math.round(off.landM), 'metres on charted land').toBe(0);
            expect(Math.round(off.dryingM), 'metres over the drying bank').toBe(0);
            // Nor over water a 2.5 m tide top cannot clear for 2.9 m (decision 11).
            const noTide = noTideClearsRuns(
                h.lastLayers as never,
                r.polyline,
                tideCeilingLookup(ceilingsAt(2.5)),
                NEED_M,
            );
            expect(noTide.reduce((m, x) => m + x.lengthM, 0)).toBe(0);
            // Through the mouth, not round it: every vertex between the bay
            // and the river sits in the dredged channel (|y| ≤ 100 m).
            const [, mouthLat0] = ll(0, -100);
            const [, mouthLat1] = ll(0, 100);
            const [mouthLonW] = ll(-200, 0);
            const [mouthLonE] = ll(800, 0);
            for (const [lon, lat] of r.polyline)
                if (lon > mouthLonW && lon < mouthLonE)
                    expect(lat >= mouthLat0 - 1e-5 && lat <= mouthLat1 + 1e-5, 'left the channel at the mouth').toBe(
                        true,
                    );
            for (const d of discs) {
                // Each disc still reaches across the dredged channel toward
                // the spit, as BC19's did (shore distance + 30 m; review
                // fix-up, 2026-10-01 — the first cut capped it at a cable):
                // the channel stays open because it is a charted DREDGED
                // AREA deep enough, and only that yields.
                expect(d.radiusM).toBeGreaterThan(185);
                expect(d.yields).toBe(true);
            }
        });
    }

    it('without the marks the same scene routes the same way (the discs were the only closure)', async () => {
        scene({ soloMarks: false });
        const { engine } = await route(2.5);
        expect(engine && 'error' in engine ? engine.error : null).toBeNull();
        const off = offWaterM(engine as RouteResult);
        expect(Math.round(off.landM)).toBe(0);
        expect(Math.round(off.dryingM)).toBe(0);
    });

    it('never calls a pin in a dredged river "on charted land" when the route cannot reach it', async () => {
        // A solid fill across the river between the mouth and the pin: the pin
        // is unreachable by water. Whatever the router does about that, the
        // pin is in 9.1 m of dredged water — decision 1 water under the
        // overview's coastline paint, not land.
        scene({ soloMarks: false, causeway: true });
        const { engine } = await route(null);
        if (engine && !('error' in engine)) {
            const r = engine as RouteResult & { destinationInlandTrimM?: number };
            expect(r.destinationInlandTrimM, 'the pin read as inland').toBeUndefined();
            expect(r.pinOffWater?.destination).toBeUndefined();
            // …and the route still never ENDS on charted land: a tail that
            // snapped onto the bank is cut back to the water.
            const end = r.polyline[r.polyline.length - 1];
            expect(hardLandAtPoint(h.lastLayers as never)(end[0], end[1]), 'the route ends on charted land').toBe(
                false,
            );
        }
    });
});
