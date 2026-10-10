/**
 * LOCAL-ONLY real-chart check: Coral Sea Marina (Airlie Beach) → Daydream
 * Island through the APP path — tryInshoreRoute, then Auto's provider
 * (calculateThalassaProposal) with the real satellite land check
 * (services/routing/landBackstop) answered from NOAA ETOPO.
 *
 * Why (Shane's phone, 2026-10-02 06:16, at a marina in the Whitsundays):
 * Auto refused "Satellite relief shows land on this route" on a route the
 * installed charts cover end to end (AU5WSY01 1:12,000 Airlie harbour,
 * AU421148 1:90,000, two overview cells). ETOPO's ~1.8 km pixels read the
 * marina's own shore as land.
 *
 * THE REPO IS PUBLIC: no chart data lives here. Point the variables at a
 * scratch folder:
 *   THALASSA_REAL_CELLS_DIR — the Pi's enc-charts index.json and one
 *     `<cellId>.json` blob per cell the route envelope touches (the Pi's own
 *     file, sha256-checked against the index);
 *   THALASSA_REAL_OSM_FILE — the Pi's OSM overlay cache file covering the
 *     route (osm-cache/v6_*.json: { data: <overlay> });
 *   THALASSA_ETOPO_GRID — an ERDDAP etopo180 griddap JSON over the route
 *     (the source the gebco-depth edge function reads, nearest pixel), e.g.
 *     https://coastwatch.pfeg.noaa.gov/erddap/griddap/etopo180.json?altitude[(-20.40):1:(-20.15)][(148.62):1:(148.92)]
 * Without them the suite skips. The straight-line island check (review
 * fix-up, 2026-10-02) wants the grid over 20.45–20.10° S, 148.55–149.00° E.
 *
 *   THALASSA_REAL_CELLS_DIR=… THALASSA_REAL_OSM_FILE=… THALASSA_ETOPO_GRID=… \
 *     NODE_OPTIONS=--max-old-space-size=4096 \
 *     npx vitest run tests/repro/airlieDaydreamRealCells.local.test.ts --maxWorkers=1
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson';

const DIR = process.env.THALASSA_REAL_CELLS_DIR ?? '';
const OSM_FILE = process.env.THALASSA_REAL_OSM_FILE ?? '';
const ETOPO_GRID = process.env.THALASSA_ETOPO_GRID ?? '';
const HAVE_DATA = DIR !== '' && existsSync(join(DIR, 'index.json')) && existsSync(OSM_FILE) && existsSync(ETOPO_GRID);

const h = vi.hoisted(() => ({
    cells: [] as { bbox: [number, number, number, number] }[],
    blobs: new Map<string, unknown>(),
    osm: null as unknown,
    ceilings: [] as { lat: number; lon: number; highestM: number; days: number }[],
    lastLayers: null as unknown,
    etopo: null as null | { lats: number[]; lons: number[]; alt: Map<string, number> },
    /** When set, Auto's engine call answers this instead (the island lines). */
    engineOverride: null as unknown,
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
    packsForCorridor: async () => [],
}));
vi.mock('../../services/localNotices', () => ({
    loadLocalNotices: async () => [],
    localNoticesNearPolyline: () => [],
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
vi.mock('../../services/routing/tideCeilings', async (original) => ({
    ...(await original<Record<string, unknown>>()),
    routeAreaTideCeilings: async () => ({ ceilings: h.ceilings }),
}));
vi.mock('../../stores/settingsStore', () => ({
    useSettingsStore: { getState: () => ({ settings: { autorouteTrialEnabled: true } }) },
}));
// NOAA ETOPO, nearest pixel — exactly what the gebco-depth edge function
// asks ERDDAP for, read from a saved grid instead of the network.
vi.mock('../../services/GebcoDepthService', async (original) => {
    const mod = await original<typeof import('../../services/GebcoDepthService')>();
    const nearest = (values: number[], v: number) =>
        values.reduce((best, x) => (Math.abs(x - v) < Math.abs(best - v) ? x : best), values[0]);
    const lookup = (lat: number, lon: number): number | null => {
        const g = h.etopo;
        if (!g) return null;
        return g.alt.get(`${nearest(g.lats, lat)},${nearest(g.lons, lon)}`) ?? null;
    };
    return {
        ...mod,
        GebcoDepthService: {
            queryRouteDepths: async (points: { lat: number; lon: number }[]) =>
                points.map((p) => ({ lat: p.lat, lon: p.lon, depth_m: lookup(p.lat, p.lon) })),
            // The satellite land check's own call since 2026-10-02 (one grid
            // request per route; the same nearest pixel).
            queryRouteRelief: async (points: { lat: number; lon: number }[]) => {
                const depths = points.map((p) => ({ lat: p.lat, lon: p.lon, depth_m: lookup(p.lat, p.lon) }));
                const missing = depths.filter((d) => d.depth_m === null).length;
                return {
                    depths,
                    failure: missing > 0 ? { kind: 'partial' as const, missing, total: points.length } : null,
                    requests: 1,
                };
            },
        },
    };
});
vi.mock('../../services/InshoreRouter', async (original) => {
    const mod = await original<typeof import('../../services/InshoreRouter')>();
    return {
        ...mod,
        tryInshoreRoute: (...args: Parameters<typeof mod.tryInshoreRoute>) =>
            h.engineOverride ? Promise.resolve(h.engineOverride as never) : mod.tryInshoreRoute(...args),
    };
});
vi.mock('../../services/inshoreRouterEngine', async (original) => {
    const mod = await original<typeof import('../../services/inshoreRouterEngine')>();
    return {
        ...mod,
        routeInshore: (layers: unknown, req: unknown) => {
            h.lastLayers = layers;
            return mod.routeInshore(layers as never, req as never);
        },
    };
});

import { tryInshoreRoute, type InshoreRouteResult } from '../../services/InshoreRouter';
import { calculateThalassaProposal } from '../../services/autoroutingThalassa';
import { setAuthIdentityScope } from '../../services/authIdentityScope';
import type { AutoroutingTrialRoute } from '../../types/autorouting';
import { inshoreRouteCrossesLand, samplePolyline } from '../../services/routing/landBackstop';
import { inshoreRoutePieces, inshoreSegmentStates, routeTideDepths } from '../../components/map/inshoreRouteState';
import { parseAndCacheCellText } from '../../services/enc/EncCellStore';
import { validateLocalEncPack } from '../../services/enc/localEncPackImport';
import { isAuthoritativeOsmWater } from '../../services/engine/chartWaterEvidence';
import {
    auditUnvouchedHardLand,
    backstopChartWaterProbe,
    hardLandAwayFromPinEdges,
} from '../../services/engine/safetyAudit';
import { geometryBbox, haversineM, pointInGeometry } from '../../services/engine/geometry';
import { chartedLandFinding } from '../../services/routing/landBackstopWords';
import { readS57 } from '../../services/enc/types';
import { usageBandOfRank } from '../../services/enc/scaleShadow';

// Shane's pins (2026-10-02 06:16): Coral Sea Marina → Daydream Island.
const FROM = { lat: -20.27043, lon: 148.72405 };
const TO = { lat: -20.25657, lon: 148.8192 };
const DRAFT_M = 2.4; // Serene Summer
const AIR_DRAFT_M = 18.29;
const PROFILE = {
    length: { status: 'measured' as const, valueM: 14 },
    beam: { status: 'measured' as const, valueM: 4.9 },
    airDraft: { status: 'measured' as const, valueM: AIR_DRAFT_M },
    draftStatus: 'measured' as const,
};

interface IndexRow {
    cellId: string;
    sourceHO: string;
    sourceCellId?: string;
    edition: number;
    updateNumber?: number;
    issued: string;
    installedAt: string;
    bbox: [number, number, number, number];
    featureCount: number;
    sizeBytes: number;
    contentSha256?: string;
}

function loadRealCells(envelope: [number, number, number, number]): string[] {
    const index = JSON.parse(readFileSync(join(DIR, 'index.json'), 'utf8')) as { cells: IndexRow[] };
    const [w, s, e, n] = envelope;
    const wanted = index.cells.filter(
        (c) =>
            !(c.bbox[2] < w || c.bbox[0] > e || c.bbox[3] < s || c.bbox[1] > n) &&
            existsSync(join(DIR, `${c.cellId}.json`)),
    );
    for (const c of wanted) {
        const text = readFileSync(join(DIR, `${c.cellId}.json`), 'utf8');
        if (c.contentSha256 && createHash('sha256').update(text).digest('hex') !== c.contentSha256)
            throw new Error(`${c.cellId}: blob does not match the Pi index sha256`);
        const cell = validateLocalEncPack(JSON.parse(text)).cells[0];
        const blob = parseAndCacheCellText(c.cellId, JSON.stringify(cell));
        if (!blob) throw new Error(`${c.cellId} did not parse`);
        h.blobs.set(c.cellId, blob);
        h.cells.push({
            id: c.cellId,
            sourceHO: c.sourceHO,
            sourceCellId: c.sourceCellId,
            edition: c.edition,
            updateNumber: c.updateNumber,
            issued: c.issued,
            importedAt: c.installedAt,
            bbox: c.bbox,
            geojsonPath: `enc/${c.cellId}.json`,
            hazardCount: c.featureCount,
            usage: 'navigation',
            sizeBytes: c.sizeBytes,
        } as never);
    }
    return wanted.map((c) => `${c.cellId}(${c.sourceCellId ?? '?'})`);
}

/** What the engine's merged layers say at one point, for the report. */
function chartWordsAt(layers: Record<string, FeatureCollection>, lon: number, lat: number): string {
    const hits = (fc: FeatureCollection | undefined, pick: (f: Feature) => string | null): string[] => {
        const out: string[] = [];
        for (const f of fc?.features ?? []) {
            const g = f.geometry;
            if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) continue;
            if (!pointInGeometry(lon, lat, g as Polygon | MultiPolygon)) continue;
            const s = pick(f);
            if (s) out.push(s);
        }
        return out;
    };
    const props = (f: Feature) => (f.properties ?? {}) as Record<string, unknown>;
    const rank = (f: Feature) => (typeof props(f)._scaleRank === 'number' ? String(props(f)._scaleRank) : 'unranked');
    const land = hits(layers.LNDARE, (f) => (props(f).acronym || props(f).OBJL ? `LNDARE r${rank(f)}` : null));
    const bands = hits(layers.DEPARE, (f) =>
        props(f).acronym || props(f).OBJL ? `DEPARE r${rank(f)} ${String(readS57(props(f), 'DRVAL1'))}m` : null,
    );
    const dredged = hits(layers.DRGARE, (f) => `DRGARE r${rank(f)} ${String(readS57(props(f), 'DRVAL1'))}m`);
    const osm = hits(layers.DEPARE, (f) =>
        !(props(f).acronym || props(f).OBJL) && isAuthoritativeOsmWater(props(f))
            ? `OSM ${String(props(f).leisure ?? props(f).water ?? props(f).natural ?? '?')}`
            : null,
    );
    return [...land, ...bands, ...dredged, ...osm].join(' + ') || 'nothing';
}

beforeEach(() => {
    h.engineOverride = null;
    setAuthIdentityScope('real-cells-user');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in this test'));
});
afterEach(() => {
    vi.restoreAllMocks();
    setAuthIdentityScope(null);
});

describe.skipIf(!HAVE_DATA)('Coral Sea Marina → Daydream Island on the real cells (local only)', () => {
    for (const tide of [null, 3.0] as const) {
        it(
            `Auto shows the route, and the satellite land check agrees with the charts — highest tide ${tide === null ? 'unknown' : `${tide} m (assumed)`}`,
            { timeout: 600_000 },
            async () => {
                h.cells = [];
                h.blobs.clear();
                const loaded = loadRealCells([
                    Math.min(FROM.lon, TO.lon),
                    Math.min(FROM.lat, TO.lat),
                    Math.max(FROM.lon, TO.lon),
                    Math.max(FROM.lat, TO.lat),
                ]);
                h.osm = (JSON.parse(readFileSync(OSM_FILE, 'utf8')) as { data: unknown }).data;
                const rows = (
                    JSON.parse(readFileSync(ETOPO_GRID, 'utf8')) as { table: { rows: [number, number, number][] } }
                ).table.rows;
                h.etopo = {
                    lats: [...new Set(rows.map((r) => r[0]))],
                    lons: [...new Set(rows.map((r) => r[1]))],
                    alt: new Map(rows.map((r) => [`${r[0]},${r[1]}`, r[2]])),
                };
                // The Pi's tide cache is not in the repro: "unknown", or an
                // assumed highest tide over the route's 0.25° tide grid.
                h.ceilings = [];
                if (tide !== null)
                    for (let lat = -20.5; lat <= -20.0; lat += 0.25)
                        for (let lon = 148.5; lon <= 149.0; lon += 0.25)
                            h.ceilings.push({ lat, lon, highestM: tide, days: 14 });

                const res = await tryInshoreRoute(FROM, TO, DRAFT_M, AIR_DRAFT_M, 'safest', {
                    tideCeilings: h.ceilings,
                });
                expect(
                    res && 'polyline' in res,
                    `engine: ${JSON.stringify(res && 'error' in res ? res.error : res)}`,
                ).toBe(true);
                const ok = res as InshoreRouteResult;
                const layers = h.lastLayers as Record<string, FeatureCollection>;
                const samples = samplePolyline(ok.polyline);
                // The route carries its own chart evidence: a verdict at every sample (127-ROUTE-W).
                expect(ok.chartVerdicts, 'the route carries its own chart evidence').toHaveLength(samples.length);
                const depths = await (
                    await import('../../services/GebcoDepthService')
                ).GebcoDepthService.queryRouteDepths(samples.map(([lon, lat]) => ({ lat, lon })));
                const lines = samples.map(([lon, lat], i) => {
                    const d = depths[i].depth_m;
                    const land = d !== null && d >= 0;
                    return (
                        `  #${i} ${lat.toFixed(5)},${lon.toFixed(5)} ETOPO ${d}${land ? ` LAND → charts: ${ok.chartVerdicts![i]}` : ''}` +
                        ` | ${chartWordsAt(layers, lon, lat)}`
                    );
                });
                const states = inshoreSegmentStates(ok);
                const colours = new Map<string, number>();
                (states ?? []).forEach((st, i) => {
                    const [a, b] = [ok.polyline[i], ok.polyline[i + 1]];
                    colours.set(String(st), (colours.get(String(st)) ?? 0) + haversineM(a[1], a[0], b[1], b[0]));
                });
                // As drawn: with the tide this run assumed (none known: the
                // line stays red until a tide is loaded), survey dots included.
                const pieces = states
                    ? inshoreRoutePieces(
                          ok.polyline,
                          states,
                          ok.surveyRuns ?? [],
                          ok.chartedShallowSpans ?? [],
                          tide === null
                              ? undefined
                              : { depthM: routeTideDepths(ok), needM: ok.tideNeedM ?? DRAFT_M + 0.5, highestM: tide },
                      )
                    : [];
                const drawn = new Map<string, number>();
                for (const piece of pieces) {
                    let m = 0;
                    for (let i = 1; i < piece.coordinates.length; i++)
                        m += haversineM(
                            piece.coordinates[i - 1][1],
                            piece.coordinates[i - 1][0],
                            piece.coordinates[i][1],
                            piece.coordinates[i][0],
                        );
                    drawn.set(piece.state, (drawn.get(piece.state) ?? 0) + m);
                }
                const without = await inshoreRouteCrossesLand(ok.polyline);
                const backstop = await inshoreRouteCrossesLand(ok.polyline, { chartVerdicts: ok.chartVerdicts });
                console.log(
                    `AIRLIE→DAYDREAM tide=${tide ?? 'unknown'} cells=${loaded.join(',')} ${ok.distanceNM.toFixed(2)} NM, ${ok.polyline.length} pts, ` +
                        `hardLand ${JSON.stringify(ok.hardLand)} pinOffWater ${JSON.stringify(ok.pinOffWater)} tideCheck ${String(ok.tideCheck)}\n` +
                        `  colours ${[...colours].map(([k, m]) => `${k} ${Math.round(m)} m`).join(', ')}\n` +
                        `  drawn ${[...drawn].map(([k, m]) => `${k} ${Math.round(m)} m`).join(', ')} | tideDepthM ${JSON.stringify(ok.tideDepthM)} need ${ok.tideNeedM}\n` +
                        `  path ${ok.polyline.map(([lon, lat]) => `${lat.toFixed(4)},${lon.toFixed(4)}`).join(' ')}\n` +
                        `  backstop WITHOUT charts ${JSON.stringify(without)}\n` +
                        `  backstop WITH charts ${JSON.stringify(backstop)}\n${lines.join('\n')}`,
                );
                // Before the fix: two ETOPO runs (the marina and its dredged
                // channel, 5 samples; the deep water off the headland, 9).
                expect(without.crossesLand, 'ETOPO alone still reads land here').toBe(true);
                expect(backstop).toMatchObject({ status: 'verified', crossesLand: false, runs: [] });
                expect(backstop.ignoredRuns).toBeGreaterThanOrEqual(1);

                let auto: AutoroutingTrialRoute | { refused: string };
                try {
                    auto = await calculateThalassaProposal({
                        departure: FROM,
                        destination: TO,
                        draftM: DRAFT_M,
                        speedKts: 6,
                        vesselProfile: structuredClone(PROFILE),
                    });
                } catch (e) {
                    auto = { refused: e instanceof Error ? e.message : String(e) };
                }
                console.log(
                    `AUTO tide=${tide ?? 'unknown'}: ${JSON.stringify(
                        'coordinates' in auto
                            ? {
                                  points: auto.coordinates.length,
                                  distanceNM: auto.engine?.distanceNM,
                                  backstop: auto.engine?.backstop,
                                  stateMask: auto.engine?.stateMask,
                                  warnings: auto.warnings,
                              }
                            : auto,
                    )}`,
                );
                expect(auto, 'Auto refused').toMatchObject({ provider: 'Thalassa', engine: { backstop: 'verified' } });
            },
        );
    }
});

// Review fix-up (2026-10-02): straight lines across the small Whitsunday
// islands the detailed charts paint must be refused by all three callers —
// Auto (calculateThalassaProposal, run for real with the line as the
// engine's answer) and the passage planner and the voyage form, which run
// the same two checks (landBackstop.test pins that in their source): the
// engine's own charted-land audit (hardLand, 25 m, a pin's edge left out)
// first, then the satellite check with the route's own charts. Before the
// fix-up the satellite check passed 4 of the reviewer's 14 east–west lines
// (Daydream Island itself among them) and the planner and the voyage form
// never looked at hardLand. The islands are the reviewer's: every detailed
// (usage band 4+) LNDARE ring 0.25–8 km across inside the ETOPO grid, crossed
// east–west 0.02° beyond each side; plus two north–south lines.
describe.skipIf(!HAVE_DATA)('straight lines across the charted Whitsunday islands (local only)', () => {
    it('every line is refused by Auto, the passage planner and the voyage form', { timeout: 900_000 }, async () => {
        h.cells = [];
        h.blobs.clear();
        loadRealCells([148.55, -20.45, 149.0, -20.1]);
        h.osm = (JSON.parse(readFileSync(OSM_FILE, 'utf8')) as { data: unknown }).data;
        const rows = (JSON.parse(readFileSync(ETOPO_GRID, 'utf8')) as { table: { rows: [number, number, number][] } })
            .table.rows;
        h.etopo = {
            lats: [...new Set(rows.map((r) => r[0]))],
            lons: [...new Set(rows.map((r) => r[1]))],
            alt: new Map(rows.map((r) => [`${r[0]},${r[1]}`, r[2]])),
        };
        h.ceilings = [];
        // The merged layers over the islands: a route that spans them.
        const res = await tryInshoreRoute(FROM, { lat: -20.3487, lon: 148.949 }, DRAFT_M, AIR_DRAFT_M, 'safest', {
            tideCeilings: [],
        });
        const layers = h.lastLayers as Record<string, FeatureCollection>;
        expect(layers, `engine: ${JSON.stringify(res && 'error' in res ? res.error : 'ok')}`).toBeTruthy();

        // The reviewer's islands, wherever the grid reaches 0.02° past them.
        const [gw, ge] = [Math.min(...h.etopo.lons), Math.max(...h.etopo.lons)];
        const [gs, gn] = [Math.min(...h.etopo.lats), Math.max(...h.etopo.lats)];
        const lines: { name: string; line: [number, number][] }[] = [];
        let candidates = 0;
        for (const f of layers.LNDARE?.features ?? []) {
            const rank = (f.properties as Record<string, unknown> | null)?._scaleRank;
            if (typeof rank !== 'number' || usageBandOfRank(rank) < 4) continue;
            const g = f.geometry;
            const rings = g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : [];
            for (const coordinates of rings) {
                const island: Polygon = { type: 'Polygon', coordinates };
                const [w, s, e, n] = geometryBbox(island);
                const kmW = (e - w) * 104.4;
                const kmH = (n - s) * 111.3;
                if (kmW <= 0.25 || kmW >= 8 || kmH <= 0.25 || kmH >= 8) continue;
                if (w - 0.02 < gw || e + 0.02 > ge || s < gs + 0.02 || n > gn - 0.02) continue;
                candidates++;
                const midLon = (w + e) / 2;
                const midLat = (s + n) / 2;
                const offsets = Array.from({ length: 25 }, (_, i) => (i - 12) * 0.0005).sort(
                    (a, b) => Math.abs(a) - Math.abs(b),
                );
                const lat = offsets.map((d) => midLat + d).find((la) => pointInGeometry(midLon, la, island));
                if (lat === undefined) continue;
                lines.push({
                    name: `island ${kmW.toFixed(1)}×${kmH.toFixed(1)} km @${lat.toFixed(4)},${midLon.toFixed(4)} E–W`,
                    line: [
                        [w - 0.02, lat],
                        [e + 0.02, lat],
                    ],
                });
            }
        }
        lines.push(
            {
                name: 'Daydream N–S 1.09 km',
                line: [
                    [148.8142, -20.2508],
                    [148.8142, -20.2606],
                ],
            },
            {
                name: 'Hamilton N–S 148.9490',
                line: [
                    [148.949, -20.325],
                    [148.949, -20.375],
                ],
            },
        );

        const GebcoDepth = (await import('../../services/GebcoDepthService')).GebcoDepthService;
        /** As the engine wrapper builds it (InshoreRouter routeChartWater). */
        const probeFor = (L: Record<string, FeatureCollection>, line: [number, number][]) => {
            const lons = line.map((p) => p[0]);
            const lats = line.map((p) => p[1]);
            return backstopChartWaterProbe(L as never, [
                Math.min(...lons) - 1e-6,
                Math.min(...lats) - 1e-6,
                Math.max(...lons) + 1e-6,
                Math.max(...lats) + 1e-6,
            ]);
        };
        /** The engine's charted-land audit, as the engine reports it. */
        const hardLandFor = (L: Record<string, FeatureCollection>, line: [number, number][]) => {
            const audit = auditUnvouchedHardLand(L as never, line);
            const away = hardLandAwayFromPinEdges(audit, { origin: false, destination: false });
            return {
                totalM: Math.round(audit.totalM),
                awayM: Math.round(away.metres),
                ...(away.at ? { awayAt: away.at } : {}),
            };
        };

        const report: string[] = [];
        let satelliteAlone = 0;
        let oldBackstop = 0;
        for (const { name, line } of lines) {
            const chartWater = probeFor(layers, line);
            const hardLand = hardLandFor(layers, line);
            const backstop = await inshoreRouteCrossesLand(line, { chartWater });
            const old = await inshoreRouteCrossesLand(line);
            if (backstop.crossesLand) satelliteAlone++;
            if (old.crossesLand) oldBackstop++;
            // The passage planner and the voyage form: charted land first,
            // then the satellite check (usePassagePlanner / useVoyageForm).
            const plannerRefuses =
                chartedLandFinding(hardLand) !== null || backstop.status !== 'verified' || backstop.crossesLand;
            // Auto, for real, with this line as the engine's answer.
            h.engineOverride = {
                polyline: line,
                cautionMask: [false],
                canalMask: [false],
                channelMask: [false],
                offshoreMask: [false],
                chartedShallowMask: [false],
                landPaintConflictMask: [false],
                tideDepthM: [null],
                tideNeedM: DRAFT_M + 0.5,
                shallowRuns: [],
                chartedShallowSpans: [],
                surveyRuns: [],
                distanceNM: haversineM(line[0][1], line[0][0], line[1][1], line[1][0]) / 1852,
                cellsUsed: h.cells.map((c) => (c as unknown as { id: string }).id),
                elapsedMs: 1,
                hardLand,
                chartWater,
            };
            let auto: string;
            try {
                await calculateThalassaProposal({
                    departure: { lat: line[0][1], lon: line[0][0] },
                    destination: { lat: line[1][1], lon: line[1][0] },
                    draftM: DRAFT_M,
                    speedKts: 6,
                    vesselProfile: structuredClone(PROFILE),
                });
                auto = 'SHOWN';
            } catch (e) {
                auto = e instanceof Error ? e.message : String(e);
            }
            h.engineOverride = null;
            const samples = samplePolyline(line);
            const depths = await GebcoDepth.queryRouteDepths(samples.map(([lon, lat]) => ({ lat, lon })));
            report.push(
                `${name}: hardLand away ${hardLand.awayM} m; satellite ${backstop.status} crossesLand=${backstop.crossesLand} ` +
                    `runs ${JSON.stringify(backstop.runs.map((r) => [r.startIdx, r.samples, r.charts]))} (old backstop ${old.crossesLand}); ` +
                    `planner/voyage form ${plannerRefuses ? 'REFUSE' : 'PASS'}; Auto: ${auto}\n    ` +
                    samples
                        .map(
                            ([lon, lat], i) =>
                                `${i}:${depths[i].depth_m}${(depths[i].depth_m ?? -1) >= 0 ? `/${chartWater(lon, lat)}` : ''}`,
                        )
                        .join(' '),
            );
            expect(plannerRefuses, `${name}: the passage planner and the voyage form passed it`).toBe(true);
            expect(auto, `${name}: Auto showed it`).toMatch(/crosses charted land|Satellite relief shows land/);
        }

        // What-if, report only: the islands' detailed land paint never merged
        // (only the overview cells paint them).
        const stripped = {
            ...layers,
            LNDARE: {
                ...layers.LNDARE,
                features: (layers.LNDARE?.features ?? []).filter((f) => {
                    const r = (f.properties as Record<string, unknown> | null)?._scaleRank;
                    return typeof r === 'number' && usageBandOfRank(r) < 3;
                }),
            },
        };
        let strippedPass = 0;
        for (const { name, line } of lines) {
            const hardLand = hardLandFor(stripped, line);
            const backstop = await inshoreRouteCrossesLand(line, { chartWater: probeFor(stripped, line) });
            const refused = chartedLandFinding(hardLand) !== null || backstop.crossesLand;
            if (!refused) strippedPass++;
            report.push(
                `NO DETAILED LNDARE ${name}: hardLand away ${hardLand.awayM} m; ` +
                    `satellite crossesLand=${backstop.crossesLand} runs ${JSON.stringify(backstop.runs.map((r) => [r.startIdx, r.samples, r.charts]))}` +
                    `${refused ? '' : ' — PASSES BOTH'}`,
            );
        }
        console.log(
            `ISLAND LINES: ${candidates} island candidates, ${lines.length} lines; refused by all three callers: ${lines.length}; ` +
                `satellite check alone (with charts) refuses ${satelliteAlone}, the old ETOPO-only backstop ${oldBackstop}; ` +
                `with no detailed land paint, ${strippedPass} pass both checks\n${report.join('\n')}`,
        );
        // The reviewer's 14 east–west lines, and the two north–south ones.
        expect(lines.length).toBeGreaterThanOrEqual(16);
    });
});
