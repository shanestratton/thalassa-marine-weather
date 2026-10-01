/**
 * LOCAL-ONLY real-chart check: Newport → Rivergate through the APP path
 * (tryInshoreRoute — mark inference, scale shadow, NAVLNE leads, curated
 * bridges, the lot), on the skipper's own chart cells.
 *
 * Why (2026-10-01): on the real cells the river mouth was closed by
 * mark-inference half-discs of 322–647 m round three solo starboard marks
 * beside the dredged channel. With a 2.5 m tide top the router then refused
 * ("the only way through crosses the West Banks"), and with no tide data it
 * reached Rivergate over ~936 m of drying bank and ~861 m of land. The golden
 * fixture harness never runs mark inference, so it could not see this; the
 * synthetic regression is tests/engine/soloMarkDiscYieldsToDeepWater.test.ts.
 *
 * THE REPO IS PUBLIC: no chart data lives here. Point THALASSA_REAL_CELLS_DIR
 * at a scratch folder holding the Pi's enc-charts index.json and one
 * `<cellId>.json` blob (the Pi's own file, sha256-checked against the index)
 * for every cell the route envelope touches. Without it the suite skips.
 *
 *   THALASSA_REAL_CELLS_DIR=/path/to/scratch NODE_OPTIONS=--max-old-space-size=4096 \
 *     npx vitest run tests/repro/newportRivergateRealCells.local.test.ts --maxWorkers=1
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import type { FeatureCollection } from 'geojson';

const DIR = process.env.THALASSA_REAL_CELLS_DIR ?? '';
const HAVE_CELLS = DIR !== '' && existsSync(join(DIR, 'index.json'));

const h = vi.hoisted(() => ({
    cells: [] as { bbox: [number, number, number, number] }[],
    blobs: new Map<string, unknown>(),
    osm: null as unknown,
    lastLayers: null as unknown,
    lastResult: null as unknown,
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
vi.mock('../../services/lowBridges', async (original) => {
    const fs = await import('node:fs');
    const data = JSON.parse(fs.readFileSync('public/notices/bridges-au.json', 'utf8')) as {
        bridges?: { span?: unknown[]; clearanceM?: number }[];
    };
    const bridges = (data.bridges ?? [])
        .filter((b) => Array.isArray(b.span) && b.span.length >= 2)
        .map((b) => ({ ...b, clearanceM: Number.isFinite(b.clearanceM) ? b.clearanceM : null }));
    return { ...(await original<Record<string, unknown>>()), loadLowBridges: async () => bridges };
});
vi.mock('../../services/TideHeightService', async (original) => ({
    ...(await original<Record<string, unknown>>()),
    fetchTideCurve: async () => null, // tides come only from the handed-in ceilings
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

import { tryInshoreRoute, type InshoreRouteResult } from '../../services/InshoreRouter';
import { dangerWithoutChartedDepth, inshoreSegmentStates } from '../../components/map/inshoreRouteState';
import { parseAndCacheCellText } from '../../services/enc/EncCellStore';
import { validateLocalEncPack } from '../../services/enc/localEncPackImport';
import { loadFixture } from '../helpers/corridorFixture';
import { chartAreaIndexFor, chartedDepthRangeAt } from '../../services/routing/leadLandClip';
import { hardLandAtPoint } from '../../services/engine/safetyAudit';
import { haversineM } from '../../services/engine/geometry';
import { noTideClearsRuns, tideCeilingLookup } from '../../services/engine/tideCeiling';
import type { RouteResult, TideCeiling } from '../../services/engine/types';

const SEQLD_SUFFIX = '/regions/australia_se_qld/nav_markers.geojson';
const DRAFT_M = 2.4; // Serene Summer
const NEED_M = 2.9; // draft + the owner's 0.5 m under-keel clearance
const AIR_DRAFT_M = 18;

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
    const wanted = index.cells.filter((c) => !(c.bbox[2] < w || c.bbox[0] > e || c.bbox[3] < s || c.bbox[1] > n));
    for (const c of wanted) {
        const path = join(DIR, `${c.cellId}.json`);
        if (!existsSync(path)) throw new Error(`copy ${c.cellId} from the Pi into ${DIR} (the route touches it)`);
        const text = readFileSync(path, 'utf8');
        if (c.contentSha256 && createHash('sha256').update(text).digest('hex') !== c.contentSha256)
            throw new Error(`${c.cellId}: blob does not match the Pi index sha256`);
        // As the phone pulls it: {cells:[one]} through validateLocalEncPack.
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
    return wanted.map((c) => c.cellId);
}

/** Metres of the route on land, drying ground and (with a tide) water no tide clears. */
function audit(r: RouteResult, layers: Record<string, FeatureCollection>, ceilings: TideCeiling[]) {
    const bands = chartAreaIndexFor(layers as never).depth;
    const land = hardLandAtPoint(layers as never);
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
    const noTide = noTideClearsRuns(layers as never, c, tideCeilingLookup(ceilings), NEED_M);
    const lengthM = c.slice(1).reduce((m, p, i) => m + haversineM(c[i][1], c[i][0], p[1], p[0]), 0);
    return { landM, dryingM, noTideM: noTide.reduce((m, x) => m + x.lengthM, 0), lengthM };
}

describe.skipIf(!HAVE_CELLS)('Newport → Rivergate on the real cells (app path, local only)', () => {
    for (const tide of [2.5, null] as const) {
        it(
            `reaches the Rivergate pin by water — highest tide ${tide === null ? 'unknown' : `${tide} m`}`,
            { timeout: 600_000 },
            async () => {
                const fx = loadFixture('newport-rivergate.corridor.json.gz');
                const from = { lat: fx.request.fromLat, lon: fx.request.fromLon };
                const to = { lat: fx.request.toLat, lon: fx.request.toLon };
                h.cells = [];
                h.blobs.clear();
                const loaded = loadRealCells([
                    Math.min(from.lon, to.lon),
                    Math.min(from.lat, to.lat),
                    Math.max(from.lon, to.lon),
                    Math.max(from.lat, to.lat),
                ]);
                h.osm = { berths: { type: 'FeatureCollection', features: [] }, ...fx.osm };
                const markers = gunzipSync(readFileSync('tests/fixtures/se-qld-nav-markers.json.gz')).toString();
                vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
                    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
                    if (url.endsWith(SEQLD_SUFFIX))
                        return Promise.resolve(
                            new Response(markers, { status: 200, headers: { 'content-type': 'application/json' } }),
                        );
                    return Promise.reject(new Error(`no network here: ${url}`));
                });
                // The 2.5 m tide top Shane measured for Moreton Bay, everywhere on
                // the route's 0.25° tide grid; "unknown" is an empty list.
                const ceilings: TideCeiling[] = [];
                if (tide !== null)
                    for (let lat = -28.0; lat <= -26.5; lat += 0.25)
                        for (let lon = 152.75; lon <= 153.75; lon += 0.25)
                            ceilings.push({ lat, lon, highestM: tide, days: 14 });

                const res = await tryInshoreRoute(from, to, DRAFT_M, AIR_DRAFT_M, 'safest', {
                    tideCeilings: ceilings,
                });
                const engine = h.lastResult as (RouteResult & { debug?: Record<string, unknown> }) | { error: string };
                expect(res, 'the app router returned nothing').not.toBeNull();
                expect(engine && 'error' in engine ? engine.error : null).toBeNull();
                const r = engine as RouteResult & { debug?: Record<string, unknown> };
                const layers = h.lastLayers as Record<string, FeatureCollection>;
                const a = audit(
                    r,
                    layers,
                    tide === null ? [{ lat: -27.25, lon: 153.0, highestM: 2.5, days: 14 }] : ceilings,
                );
                const end = r.polyline[r.polyline.length - 1];
                const endToPinM = haversineM(end[1], end[0], to.lat, to.lon);
                // The path, a point every ~2 km, for the report.
                const path: string[] = [];
                let run = Infinity;
                for (let i = 0; i < r.polyline.length; i++) {
                    if (i > 0)
                        run += haversineM(
                            r.polyline[i - 1][1],
                            r.polyline[i - 1][0],
                            r.polyline[i][1],
                            r.polyline[i][0],
                        );
                    if (run >= 2000 || i === r.polyline.length - 1) {
                        path.push(`${r.polyline[i][1].toFixed(4)},${r.polyline[i][0].toFixed(4)}`);
                        run = 0;
                    }
                }
                console.log(
                    `REAL ${tide ?? 'none'}: cells=${loaded.join(',')} ${r.distanceNM.toFixed(2)} NM, ` +
                        `land ${Math.round(a.landM)} m, drying ${Math.round(a.dryingM)} m, no-tide ${Math.round(a.noTideM)} m, ` +
                        `end ${Math.round(endToPinM)} m from pin, inlandTrim=${String(r.debug?.destinationInlandTrimM ?? 'none')}` +
                        `\n  path ${path.join(' ')}`,
                );
                expect(r.debug?.destinationInlandTrimM, 'the pin in a 9.1 m dredged area read as land').toBeUndefined();
                expect(endToPinM, 'the route stops short of the pin').toBeLessThan(60);
                expect(Math.round(a.landM), 'metres on charted land').toBe(0);
                expect(Math.round(a.dryingM), 'metres over charted drying ground').toBe(0);
                expect(Math.round(a.noTideM), 'metres over water no 2.5 m tide clears').toBe(0);
                // What Auto refuses (services/autoroutingThalassa; 2026-10-01
                // review): land away from a pin's edge, and red with no charted
                // depth inside a relax zone when the tides were loaded. A real
                // route it would refuse is a regression.
                const shipped = res as InshoreRouteResult;
                const states = inshoreSegmentStates(shipped);
                const unchecked = dangerWithoutChartedDepth({ ...shipped, stateMask: states }) ?? [];
                const inZone = unchecked.filter((i) => {
                    const mid = {
                        lat: (shipped.polyline[i][1] + shipped.polyline[i + 1][1]) / 2,
                        lon: (shipped.polyline[i][0] + shipped.polyline[i + 1][0]) / 2,
                    };
                    return (shipped.relaxZones ?? []).some(
                        (z) => haversineM(z.lat, z.lon, mid.lat, mid.lon) <= z.radiusM,
                    );
                });
                console.log(
                    `AUTO ${tide ?? 'none'}: hardLand ${JSON.stringify(shipped.hardLand)} relaxZones ${shipped.relaxZones?.length ?? 0} ` +
                        `tideCeilingsLoaded ${String(shipped.tideCeilingsLoaded)} red-without-depth segs ${unchecked.length} (in zones ${inZone.length})`,
                );
                expect(shipped.hardLand?.awayM, 'metres of charted land away from a pin edge').toBe(0);
                if (shipped.tideCeilingsLoaded) expect(inZone, 'red with no depth inside a relax zone').toEqual([]);
            },
        );
    }
});
