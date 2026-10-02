/**
 * LOCAL-ONLY real-chart check for owner decision 12 (Shane, 2026-10-02,
 * "Trust the detailed chart"): wherever a chart of usage band 3 or finer
 * charts a depth area that never dries, an overview or general cell's
 * (bands 1–2) land paint is ignored — no decision-1 'charts disagree', the
 * detailed chart's depth decides.
 *
 * Two places from Shane's 2026-10-02 field tests, through the APP path
 * (tryInshoreRoute), and the Auto review's own leg checker
 * (reviewAutoroutingProposal — what drew "Danger reported · review required"):
 *   • Cid Harbour (route 3, leg 6→7): the 1:3,500,000 overview AU130120 paints
 *     the harbour as land; the 1:90,000 AU421148 charts it 10–15 m. The leg
 *     was red and Save was blocked.
 *   • The Coral Sea Marina (Airlie Beach) exit towards Daydream Island: ~3.3 km
 *     of red from the same overview land paint.
 * And what must stay: Newport → Rivergate on the Brisbane cells — decision 1's
 * red between two DETAILED charts. Measured on the Pi's cells (fix-up,
 * 2026-10-03, read-only copies deleted after): the only 'charts disagree'
 * left on that route is 322 m in the Newport canal — AU428153's (1:90,000)
 * land over AU5SCR01's (1:22,000) 0 m band (HEAD: 8,575 m, 7,643 m of it the
 * overview and general cells' land). Where AU428153's coastline lies over
 * AU5BNE01's river on the Rivergate reach, the route rides the OSM overlay's
 * river water, which decision 1 never applied to, before or after: that red
 * is a chart-geometry fact, not a route's.
 *
 * THE REPO IS PUBLIC: no chart data lives here. Point the variables at a
 * scratch folder:
 *   THALASSA_REAL_CELLS_DIR — the Pi's enc-charts index.json and one
 *     `<cellId>.json` blob per cell the routes touch (the Pi's own file,
 *     sha256-checked against the index);
 *   THALASSA_REAL_OSM_FILE — the Pi's OSM overlay cache file covering the
 *     routes (osm-cache/v6_*.json: { data: <overlay> });
 *   THALASSA_REAL_REPORT (optional) — a scratch file the report is written to;
 *   THALASSA_REAL_BNE_DIR (optional) — the same for every Pi cell the
 *     Newport → Rivergate envelope touches (its OSM water comes from the
 *     golden corridor fixture, as tests/repro/newportRivergateRealCells does).
 * Without the first two the suite skips.
 *
 *   THALASSA_REAL_CELLS_DIR=… THALASSA_REAL_OSM_FILE=… TZ=UTC \
 *     NODE_OPTIONS=--max-old-space-size=4096 \
 *     npx vitest run tests/repro/detailedChartOverviewLandRealCells.local.test.ts --maxWorkers=1
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DIR = process.env.THALASSA_REAL_CELLS_DIR ?? '';
const OSM_FILE = process.env.THALASSA_REAL_OSM_FILE ?? '';
const HAVE_DATA = DIR !== '' && existsSync(join(DIR, 'index.json')) && existsSync(OSM_FILE);
const BNE_DIR = process.env.THALASSA_REAL_BNE_DIR ?? '';
const HAVE_BNE = BNE_DIR !== '' && existsSync(join(BNE_DIR, 'index.json'));

const h = vi.hoisted(() => ({
    cells: [] as { bbox: [number, number, number, number] }[],
    blobs: new Map<string, unknown>(),
    osm: null as unknown,
    /** The last collectShallowRuns input: the route's own grid and layers. */
    shallow: null as unknown,
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
    routeAreaTideCeilings: async () => ({ ceilings: [] }),
}));
vi.mock('../../stores/settingsStore', () => ({
    useSettingsStore: { getState: () => ({ settings: { autorouteTrialEnabled: true } }) },
}));
vi.mock('../../services/engine/shallowRuns', async (original) => {
    const mod = await original<typeof import('../../services/engine/shallowRuns')>();
    return {
        ...mod,
        collectShallowRuns: (input: Parameters<typeof mod.collectShallowRuns>[0]) => {
            h.shallow = input;
            return mod.collectShallowRuns(input);
        },
    };
});

import { tryInshoreRoute, type InshoreRouteResult } from '../../services/InshoreRouter';
import { setAuthIdentityScope } from '../../services/authIdentityScope';
import { parseAndCacheCellText } from '../../services/enc/EncCellStore';
import { validateLocalEncPack } from '../../services/enc/localEncPackImport';
import { inshoreSegmentStates } from '../../components/map/inshoreRouteState';
import { reviewAutoroutingProposal, type TrialRouteReview } from '../../services/autoroutingReview';
import {
    forEachCellOnSegment,
    haversineM,
    pointInGeometry,
    segmentGeometryDistanceM,
} from '../../services/engine/geometry';
import { usageBandOfRank } from '../../services/enc/scaleShadow';
import { loadFixture } from '../helpers/corridorFixture';
import { CAUTION_WHY, type InshoreLayers, type NavGrid } from '../../services/engine/types';
import type { MultiPolygon, Polygon } from 'geojson';

const DRAFT_M = 2.4; // Serene Summer
const AIR_DRAFT_M = 18.29;

// Cid Harbour, between Cid Island and Whitsunday Island: in from the open
// water north of the harbour to an anchorage in it, and from there out of its
// south-west arm. At (148.935, -20.255) AU130120 (1:3.5M) paints land,
// AU230140 (1:1.5M) charts 0–30 m and AU421148 (1:90k) charts 10–15 m (read
// from the Pi's cells, 2026-10-02); the whole harbour is under the overview's
// land paint, and AU421148 charts it 5–15 m+.
const CID_N = { lat: -20.235, lon: 148.925 };
const CID_ANCHORAGE = { lat: -20.262, lon: 148.93 };
const CID_SW_ARM = { lat: -20.277, lon: 148.918 };
const CID_WEST = { lat: -20.279, lon: 148.9 };
// Shane's pins (2026-10-02 06:16): Coral Sea Marina → Daydream Island.
const AIRLIE = { lat: -20.27043, lon: 148.72405 };
const DAYDREAM = { lat: -20.25657, lon: 148.8192 };

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

function loadRealCells(dir: string): string[] {
    const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as { cells: IndexRow[] };
    const wanted = index.cells.filter((c) => existsSync(join(dir, `${c.cellId}.json`)));
    for (const c of wanted) {
        const text = readFileSync(join(dir, `${c.cellId}.json`), 'utf8');
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

const whyWords = (why: number): string =>
    Object.entries(CAUTION_WHY)
        .filter(([, bit]) => (why & bit) !== 0)
        .map(([k]) => k)
        .join('|') || '0';

interface Measured {
    nm: number;
    pts: number;
    redM: number;
    disagreeM: number;
    /** Metres of the 'charts disagree' segments by the usage band of the
     * finest land paint over them (decision 12 leaves only bands 3+). */
    disagreeLandBands: Record<string, number>;
    why: [string, number][];
    dangerLegs: string[];
    line: string;
}

async function review(coords: [number, number][]): Promise<TrialRouteReview> {
    return reviewAutoroutingProposal(
        { coordinates: coords, vesselProfile: { draftStatus: 'measured' } } as never,
        DRAFT_M,
        new AbortController().signal,
        () => undefined,
        { draftAssumed: false },
    );
}

function gradesOf(r: TrialRouteReview): string {
    return r.legs.map((leg) => leg?.verdict.grade ?? '-').join(',');
}

function dangerOf(r: TrialRouteReview): string[] {
    return r.legs.flatMap((leg, i) =>
        leg?.verdict.grade === 'danger'
            ? [`leg ${i}: ${leg.verdict.issues.map((x) => `${x.severity} ${x.message}`).join(' / ')}`]
            : [],
    );
}

async function measure(
    name: string,
    from: { lat: number; lon: number },
    to: { lat: number; lon: number },
): Promise<Measured> {
    const res = await tryInshoreRoute(from, to, DRAFT_M, AIR_DRAFT_M, 'safest', { tideCeilings: [] });
    expect(res && 'polyline' in res, `${name}: ${JSON.stringify(res && 'error' in res ? res.error : res)}`).toBe(true);
    const ok = res as InshoreRouteResult;
    const states = inshoreSegmentStates(ok) ?? [];
    const why = ok.cautionWhy ?? [];
    let redM = 0;
    let disagreeM = 0;
    const tally = new Map<string, number>();
    for (let i = 0; i < ok.polyline.length - 1; i++) {
        const [a, b] = [ok.polyline[i], ok.polyline[i + 1]];
        const m = haversineM(a[1], a[0], b[1], b[0]);
        if (states[i] === 'danger') redM += m;
        if ((why[i] ?? 0) & CAUTION_WHY.DISAGREE || ok.landPaintConflictMask?.[i]) disagreeM += m;
        if (why[i]) tally.set(whyWords(why[i]), (tally.get(whyWords(why[i])) ?? 0) + m);
    }
    const input0 = h.shallow as { layers: InshoreLayers; polyline: [number, number][] } | null;
    const disagreeLandBands: Record<string, number> = {};
    if (input0 && input0.polyline.length === ok.polyline.length) {
        const land = (input0.layers.LNDARE?.features ?? []).filter(
            (f) => f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon',
        );
        for (let i = 0; i < ok.polyline.length - 1; i++) {
            if (!((why[i] ?? 0) & CAUTION_WHY.DISAGREE || ok.landPaintConflictMask?.[i])) continue;
            const [a, b] = [ok.polyline[i], ok.polyline[i + 1]];
            const m = haversineM(a[1], a[0], b[1], b[0]);
            const n = Math.max(1, Math.ceil(m / 25));
            for (let k = 0; k < n; k++) {
                const t = (k + 0.5) / n;
                const lon = a[0] + (b[0] - a[0]) * t;
                const lat = a[1] + (b[1] - a[1]) * t;
                let key = 'none';
                let best = -1;
                for (const f of land) {
                    if (!pointInGeometry(lon, lat, f.geometry as Polygon | MultiPolygon)) continue;
                    const r = (f.properties as { _scaleRank?: unknown } | null)?._scaleRank;
                    if (typeof r !== 'number') {
                        key = 'unranked';
                        best = Infinity;
                    } else if (usageBandOfRank(r) > best) {
                        best = usageBandOfRank(r);
                        key = `band${best}`;
                    }
                }
                disagreeLandBands[key] = (disagreeLandBands[key] ?? 0) + m / n;
            }
        }
    }
    // A red segment in a hazard's keep-out: how near the line comes to the
    // charted obstruction areas, and whether the route's own grid blocked any
    // cell it crosses (the grid classes a cell by its centre).
    const input = h.shallow as { grid: NavGrid; layers: InshoreLayers; polyline: [number, number][] } | null;
    const hazardNotes: string[] = [];
    if (input && input.polyline.length === ok.polyline.length) {
        for (let i = 0; i < ok.polyline.length - 1; i++) {
            if (!((why[i] ?? 0) & CAUTION_WHY.HAZARD)) continue;
            const [a, b] = [ok.polyline[i], ok.polyline[i + 1]];
            const kx = 111_320 * Math.cos((a[1] * Math.PI) / 180);
            let nearest = Infinity;
            for (const f of input.layers.OBSTRN?.features ?? []) {
                const g = f.geometry;
                if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) continue;
                const p = f.properties as { acronym?: unknown } | null;
                if (p?.acronym !== 'OBSTRN') continue;
                nearest = Math.min(nearest, segmentGeometryDistanceM(a, b, g as Polygon | MultiPolygon, kx, 111_320));
            }
            let blocked = 0;
            forEachCellOnSegment(input.grid, a, b, (idx) => {
                if (input.grid.obstnBlocked?.[idx] === 1) blocked++;
            });
            hazardNotes.push(
                `seg ${i}: nearest charted obstruction area ${nearest.toFixed(1)} m, grid hazard cells crossed ${blocked}`,
            );
        }
    }
    const rv = await review(ok.polyline as [number, number][]);
    const dangerLegs = dangerOf(rv);
    const line =
        `${name}: ${ok.distanceNM.toFixed(2)} NM ${ok.polyline.length} pts red ${redM.toFixed(0)} m ` +
        `disagree ${disagreeM.toFixed(0)} m (finest land paint: ${JSON.stringify(Object.fromEntries(Object.entries(disagreeLandBands).map(([k, v]) => [k, Math.round(v)])))}) ` +
        `why ${JSON.stringify([...tally].map(([k, v]) => [k, Math.round(v)]))} ` +
        `review ${rv.phase} [${gradesOf(rv)}] danger ${dangerLegs.length}/${rv.legs.length}${dangerLegs.length ? `\n    ${dangerLegs.slice(0, 6).join('\n    ')}` : ''}` +
        `\n  segments: ${ok.polyline
            .slice(1)
            .map((b, i) => {
                const a = ok.polyline[i];
                return `${i}:${haversineM(a[1], a[0], b[1], b[0]).toFixed(0)}m ${states[i]}${why[i] ? ` ${whyWords(why[i])}` : ''}`;
            })
            .join(', ')}` +
        `\n  shallow runs: ${(ok.shallowRuns ?? [])
            .map(
                (r) =>
                    `${r.startSeg}-${r.endSeg} ${r.lengthM} m min ${r.minDepthM ?? '-'}${r.nearHazard ? ' nearHazard' : ''}${r.chartsDisagree ? ' disagree' : ''}${r.endpointTail ? ` tail:${r.endpointTail}` : ''}`,
            )
            .join('; ')}` +
        (hazardNotes.length ? `\n  hazard: ${hazardNotes.join('; ')}` : '') +
        `\n  polyline: ${ok.polyline.map(([lon, lat]) => `${lat.toFixed(5)},${lon.toFixed(5)}`).join(' ')}`;
    return {
        nm: ok.distanceNM,
        pts: ok.polyline.length,
        redM,
        disagreeM,
        disagreeLandBands,
        why: [...tally],
        dangerLegs,
        line,
    };
}

beforeEach(() => {
    setAuthIdentityScope('real-cells-user');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in this test'));
});
afterEach(() => {
    vi.restoreAllMocks();
    setAuthIdentityScope(null);
});

describe.skipIf(!HAVE_DATA)('decision 12 on the real Whitsunday cells (local only)', () => {
    it(
        'Cid Harbour and the Airlie marina exit read the detailed chart, not the overview land',
        {
            timeout: 900_000,
        },
        async () => {
            h.cells = [];
            h.blobs.clear();
            const loaded = loadRealCells(DIR);
            h.osm = (JSON.parse(readFileSync(OSM_FILE, 'utf8')) as { data: unknown }).data;
            const report = (s: string): void => {
                if (process.env.THALASSA_REAL_REPORT) appendFileSync(process.env.THALASSA_REAL_REPORT, `${s}\n`);
                else console.log(s);
            };
            if (process.env.THALASSA_REAL_REPORT) writeFileSync(process.env.THALASSA_REAL_REPORT, '');
            report(`cells ${loaded.join(',')}`);

            // The phone's own kind of leg: one straight line through the harbour,
            // graded by Auto's review (what said "Danger reported").
            const straight = await review(
                [CID_N, CID_ANCHORAGE, CID_SW_ARM, CID_WEST].map((p) => [p.lon, p.lat] as [number, number]),
            );
            const straightDanger = dangerOf(straight);
            report(
                `CID straight legs: review ${straight.phase} [${gradesOf(straight)}] danger ${straightDanger.length}/${straight.legs.length}` +
                    (straightDanger.length ? `\n    ${straightDanger.join('\n    ')}` : '') +
                    `\n    ${straight.legs.map((l, i) => `leg ${i}: ${l?.verdict.issues.map((x) => `${x.severity} ${x.message}`).join(' / ') || 'no issue'} least ${l?.verdict.minDepthM ?? '-'}`).join('\n    ')}`,
            );

            const cid = await measure('CID in (N → anchorage)', CID_N, CID_ANCHORAGE);
            report(cid.line);
            const cidOut = await measure('CID out (anchorage → SW arm → west)', CID_ANCHORAGE, CID_WEST);
            report(cidOut.line);
            const airlie = await measure('AIRLIE marina→Daydream', AIRLIE, DAYDREAM);
            report(airlie.line);

            // Decision 12: the overview's land paint over the 1:90k chart's
            // 10–15 m is not the charts disagreeing, and the review finds no danger.
            expect(straightDanger).toEqual([]);
            expect(cid.disagreeM).toBe(0);
            expect(cid.dangerLegs).toEqual([]);
            expect(cidOut.disagreeM).toBe(0);
            expect(cidOut.dangerLegs).toEqual([]);
            expect(airlie.disagreeM).toBe(0);
        },
    );
});

describe.skipIf(!HAVE_BNE)('decision 1 stays between two detailed charts: the Brisbane River (local only)', () => {
    it(
        'Newport → Rivergate: what stays "charts disagree" is a detailed chart’s land only (the Newport canal)',
        { timeout: 900_000 },
        async () => {
            h.cells = [];
            h.blobs.clear();
            const loaded = loadRealCells(BNE_DIR);
            const fx = loadFixture('newport-rivergate.corridor.json.gz');
            h.osm = { berths: { type: 'FeatureCollection', features: [] }, ...fx.osm };
            const r = await measure(
                'BNE Newport→Rivergate',
                { lat: fx.request.fromLat, lon: fx.request.fromLon },
                { lat: fx.request.toLat, lon: fx.request.toLon },
            );
            const line = `cells ${loaded.join(',')}\n${r.line}`;
            if (process.env.THALASSA_REAL_REPORT) appendFileSync(process.env.THALASSA_REAL_REPORT, `${line}\n`);
            else console.log(line);
            // The detailed charts' disagreement keeps its red; nothing of it is an
            // overview or general cell's land paint any more.
            expect(r.disagreeM).toBeGreaterThan(0);
            for (const band of Object.keys(r.disagreeLandBands))
                expect(['band3', 'band4', 'band5', 'band6']).toContain(band);
        },
    );
});
