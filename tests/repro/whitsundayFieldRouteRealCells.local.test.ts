/**
 * LOCAL-ONLY real-chart check: Shane's second field route of 2026-10-02
 * (Whitsundays, 18.3 NM from near Armit Island to the Molles), through the APP
 * path (tryInshoreRoute), measuring how close each caution segment the
 * engine calls "the grid's alone" (CAUTION_WHY GRID_ONLY) comes to the
 * shallow bands round it.
 *
 * Why (round-2 review, 2026-10-03): GRID_ONLY asked only that the line not
 * ENTER a shallow band, so a line metres off a steep-to drying reef was drawn
 * green and saved. The fix gives it a measured clearance (engine/shallowRuns
 * nearShallowBand); this measures the field route's real clearances, so the
 * North Molle corner's red — the reason GRID_ONLY exists — is judged on the
 * real chart, not a synthetic one.
 *
 * THE REPO IS PUBLIC: no chart data lives here. Point the variables at a
 * scratch folder:
 *   THALASSA_REAL_CELLS_DIR — the Pi's enc-charts index.json and one
 *     `<cellId>.json` blob per cell the route envelope touches (the Pi's own
 *     file, sha256-checked against the index);
 *   THALASSA_REAL_OSM_FILE — the Pi's OSM overlay cache file covering the
 *     route (osm-cache/v6_*.json: { data: <overlay> });
 *   THALASSA_REAL_REPORT (optional) — a scratch file the report is written to.
 * Without the first two the suite skips.
 *
 *   THALASSA_REAL_CELLS_DIR=… THALASSA_REAL_OSM_FILE=… \
 *     NODE_OPTIONS=--max-old-space-size=4096 \
 *     npx vitest run tests/repro/whitsundayFieldRouteRealCells.local.test.ts --maxWorkers=1
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DIR = process.env.THALASSA_REAL_CELLS_DIR ?? '';
const OSM_FILE = process.env.THALASSA_REAL_OSM_FILE ?? '';
const HAVE_DATA = DIR !== '' && existsSync(join(DIR, 'index.json')) && existsSync(OSM_FILE);

const h = vi.hoisted(() => ({
    cells: [] as { bbox: [number, number, number, number] }[],
    blobs: new Map<string, unknown>(),
    osm: null as unknown,
    /** Every collectShallowRuns call of the last route: its input and output. */
    shallow: [] as { input: unknown; output: unknown }[],
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
            const output = mod.collectShallowRuns(input);
            h.shallow.push({ input, output });
            return output;
        },
    };
});

import { tryInshoreRoute, type InshoreRouteResult } from '../../services/InshoreRouter';
import { setAuthIdentityScope } from '../../services/authIdentityScope';
import { parseAndCacheCellText } from '../../services/enc/EncCellStore';
import { validateLocalEncPack } from '../../services/enc/localEncPackImport';
import { inshoreSegmentStates } from '../../components/map/inshoreRouteState';
import {
    collectShallowRuns,
    nearShallowBand,
    SHALLOW_BAND_CLEARANCE_M,
    SHALLOW_CLIFF_CLEARANCE_M,
} from '../../services/engine/shallowRuns';
import {
    chartAreaIndexFor,
    chartedDepthOwnersAt,
    segmentAreaDistanceM,
    type IndexedDepthArea,
} from '../../services/routing/leadLandClip';
import { forEachCellOnSegment, haversineM } from '../../services/engine/geometry';
import { hazardBufferSegments } from '../../services/engine/safetyAudit';
import { gridCautionSegMask } from '../../services/seaway/seawayRouter';
import { CAUTION_WHY, type InshoreLayers, type NavGrid } from '../../services/engine/types';

// Shane's second auto route, 2026-10-02 06:21 (Whitsundays): departure and
// destination as the phone recorded them.
const FROM = { lat: -(20 + 3.281 / 60), lon: 148 + 37.075 / 60 };
const TO = { lat: -(20 + 14.25 / 60), lon: 148 + 51.342 / 60 };
// Its legs 2→3→4→5→6, the North Molle corner the phone drew red while each
// leg's review said "no issue found" (waypoints as the phone listed them).
const DM = (deg: number, min: number): number => Math.sign(deg) * (Math.abs(deg) + min / 60);
const CORNER: [number, number][] = [
    [DM(148, 47.926), DM(-20, 13.468)],
    [DM(148, 48.327), DM(-20, 13.468)],
    [DM(148, 49.504), DM(-20, 14.573)],
    [DM(148, 49.619), DM(-20, 14.573)],
    [DM(148, 49.677), DM(-20, 14.627)],
];
const DRAFT_M = 2.4; // Serene Summer
const AIR_DRAFT_M = 18.29;

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

const whyWords = (why: number): string =>
    Object.entries(CAUTION_WHY)
        .filter(([, bit]) => (why & bit) !== 0)
        .map(([k]) => k)
        .join('|') || '0';

/** Every shallow band owning a shallow-band cell centre within `reachM` of a→b, with its exact distance. */
function bandsNear(
    grid: NavGrid,
    bands: readonly IndexedDepthArea[],
    floorM: number,
    a: [number, number],
    b: [number, number],
    reachM: number,
): string[] {
    const sd = grid.shallowDepthM!;
    const out = new Map<IndexedDepthArea, number>();
    const touched = new Set<number>();
    forEachCellOnSegment(grid, a, b, (idx) => touched.add(idx));
    const lat0 = Math.min(a[1], b[1]) - reachM / 111_320;
    const lat1 = Math.max(a[1], b[1]) + reachM / 111_320;
    const kx = 111_320 * Math.cos((a[1] * Math.PI) / 180);
    const lon0 = Math.min(a[0], b[0]) - reachM / kx;
    const lon1 = Math.max(a[0], b[0]) + reachM / kx;
    for (let y = Math.floor((lat0 - grid.minLat) / grid.dLat); y <= Math.floor((lat1 - grid.minLat) / grid.dLat); y++)
        for (
            let x = Math.floor((lon0 - grid.minLon) / grid.dLon);
            x <= Math.floor((lon1 - grid.minLon) / grid.dLon);
            x++
        ) {
            if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) continue;
            const idx = y * grid.width + x;
            if (!(grid.cells[idx] < 0) || Number.isNaN(sd[idx])) continue;
            const lon = grid.minLon + (x + 0.5) * grid.dLon;
            const lat = grid.minLat + (y + 0.5) * grid.dLat;
            for (const o of chartedDepthOwnersAt(bands, lon, lat))
                if (o.drval1 === null || o.drval1 < floorM) out.set(o, segmentAreaDistanceM(o, a, b, 500));
        }
    return [...out]
        .sort((p, q) => p[1] - q[1])
        .map(([o, d]) => `${o.drval1 ?? '∅'}..${o.drval2 ?? '∅'} r${o.rank ?? '?'} at ${d.toFixed(1)} m`);
}

beforeEach(() => {
    setAuthIdentityScope('real-cells-user');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in this test'));
});
afterEach(() => {
    vi.restoreAllMocks();
    setAuthIdentityScope(null);
});

describe.skipIf(!HAVE_DATA)("Shane's second Whitsunday field route on the real cells (local only)", () => {
    it('measures what GRID_ONLY clears, and what keeps its red', { timeout: 600_000 }, async () => {
        h.cells = [];
        h.blobs.clear();
        h.shallow = [];
        const loaded = loadRealCells([
            Math.min(FROM.lon, TO.lon),
            Math.min(FROM.lat, TO.lat),
            Math.max(FROM.lon, TO.lon),
            Math.max(FROM.lat, TO.lat),
        ]);
        h.osm = (JSON.parse(readFileSync(OSM_FILE, 'utf8')) as { data: unknown }).data;
        const res = await tryInshoreRoute(FROM, TO, DRAFT_M, AIR_DRAFT_M, 'safest', { tideCeilings: [] });
        expect(res && 'polyline' in res, `engine: ${JSON.stringify(res && 'error' in res ? res.error : res)}`).toBe(
            true,
        );
        const ok = res as InshoreRouteResult;
        const last = h.shallow.at(-1)!;
        const input = last.input as Parameters<typeof collectShallowRuns>[0];
        const { grid, layers, polyline } = input;
        const floorM = input.draftM + input.safetyM;
        const bands = chartAreaIndexFor(layers as InshoreLayers).depth;
        const lines: string[] = [];
        const why = ok.cautionWhy ?? [];
        const states = inshoreSegmentStates(ok) ?? [];
        let gridOnlyM = 0;
        let nearM = 0;
        for (let i = 0; i < polyline.length - 1; i++) {
            const w = why[i] ?? 0;
            if (!(w & (CAUTION_WHY.GRID_ONLY | CAUTION_WHY.NEAR_SHALLOW))) continue;
            const [a, b] = [polyline[i], polyline[i + 1]];
            const m = haversineM(a[1], a[0], b[1], b[0]);
            if (w === CAUTION_WHY.GRID_ONLY) gridOnlyM += m;
            else nearM += m;
            const near = nearShallowBand({
                grid,
                depthBands: bands,
                floorM,
                cliffClearanceM: SHALLOW_CLIFF_CLEARANCE_M,
                a,
                b,
            });
            lines.push(
                `  seg ${i} ${m.toFixed(0)} m ${whyWords(w)} state=${states[i]} @${a[1].toFixed(5)},${a[0].toFixed(5)}→${b[1].toFixed(5)},${b[0].toFixed(5)}` +
                    ` near=${JSON.stringify(near)}\n    bands within 80 m: ${bandsNear(grid, bands, floorM, a, b, 80).join('; ') || 'none'}`,
            );
        }
        // The phone's own line round the corner, cut into ~20 m segments as
        // the engine's polyline is, read with the engine's own machinery.
        const corner: [number, number][] = [CORNER[0]];
        for (let k = 1; k < CORNER.length; k++) {
            const [a, b] = [CORNER[k - 1], CORNER[k]];
            const n = Math.max(1, Math.round(haversineM(a[1], a[0], b[1], b[0]) / 20));
            for (let j = 1; j <= n; j++) corner.push([a[0] + ((b[0] - a[0]) * j) / n, a[1] + ((b[1] - a[1]) * j) / n]);
        }
        const cornerCaution = gridCautionSegMask(
            grid,
            corner.map(([lon, lat]) => ({ lat, lon })),
        );
        // The app's own hazard buffer (InshoreRouter routeOpts: 60 m).
        const cornerHazard = hazardBufferSegments(corner, layers as InshoreLayers, 60, floorM);
        const cornerRuns = collectShallowRuns({
            ...input,
            polyline: corner,
            caution: cornerCaution.map((c, i) => c || cornerHazard[i]),
            hazardMask: cornerHazard,
            destinationTailStartSeg: -1,
            originTailEndSeg: -1,
        });
        const cornerLines: string[] = [];
        for (let i = 0; i < corner.length - 1; i++) {
            const w = cornerRuns.cautionWhy[i];
            if (!w) continue;
            const [a, b] = [corner[i], corner[i + 1]];
            const near = nearShallowBand({
                grid,
                depthBands: bands,
                floorM,
                cliffClearanceM: SHALLOW_CLIFF_CLEARANCE_M,
                a,
                b,
            });
            cornerLines.push(
                `  corner seg ${i} ${whyWords(w)} (${w}) @${a[1].toFixed(5)},${a[0].toFixed(5)} near=${JSON.stringify(near)} engine=${JSON.stringify(cornerRuns.cautionNearShallow[i])}` +
                    `\n    bands within 80 m: ${bandsNear(grid, bands, floorM, a, b, 80).join('; ') || 'none'}`,
            );
        }
        const tally = new Map<string, number>();
        for (const w of why) tally.set(whyWords(w), (tally.get(whyWords(w)) ?? 0) + 1);
        const report =
            `calls ${h.shallow.length} polyline ${polyline.length} ok ${ok.polyline.length} why ${why.length} ${JSON.stringify([...tally])}\n` +
            `FIELD2 cells=${loaded.join(',')} ${ok.distanceNM.toFixed(2)} NM ${ok.polyline.length} pts floor ${floorM} m soft ${SHALLOW_BAND_CLEARANCE_M} m\n` +
            `  GRID_ONLY ${gridOnlyM.toFixed(0)} m, NEAR_SHALLOW ${nearM.toFixed(0)} m\n${lines.join('\n')}\n` +
            `CORNER (legs 2→6, ${corner.length - 1} segs, caution ${cornerCaution.filter(Boolean).length}, hazard ${cornerHazard.filter(Boolean).length})\n${cornerLines.join('\n')}`;
        // THALASSA_REAL_REPORT: a scratch file for the report (the console
        // reporter can drop a passing test's output).
        if (process.env.THALASSA_REAL_REPORT) writeFileSync(process.env.THALASSA_REAL_REPORT, report);
        else console.log(report);
        expect(ok.polyline.length).toBeGreaterThan(1);
        // Round 2 item (a), any-angle string pulling (2026-10-03): the route
        // Auto ships here is the PROMOTED Seaway route (the engine's own is
        // one straight 17.33 NM line), and its connector legs were the A*
        // cell chain itself — 498 points, each 50 m east or 70.7 m
        // south-east: the display's legs 4→5 east then 5→6 south-east where
        // the straight line crosses 15–20 m water. Pulled taut where each
        // chord is at least as safe (engine/stringPull): 6 points, 18.22 →
        // 18.00 NM, every segment green, 0 m of land.
        expect(ok.polyline.length).toBeLessThanOrEqual(12);
        expect(ok.distanceNM).toBeLessThan(18.1);
        // Measured 2026-10-03 (AU421148): the corner's caution segments pass
        // 12.3 m+ from its 2–5 m band, 31.6 m+ from its 0–2 m band and 43 m+
        // from the reef drying 3.6 m — clear of 10 m and 30 m, so GRID_ONLY
        // keeps them green, as round 2 (b) made them.
        const cornerCaution2 = cornerCaution.map((c, i) => c || cornerHazard[i]);
        expect(cornerCaution2.filter(Boolean).length).toBeGreaterThan(0);
        cornerCaution2.forEach((c, i) => {
            if (c) expect(cornerRuns.cautionWhy[i], `corner seg ${i}`).toBe(CAUTION_WHY.GRID_ONLY);
        });
    });
});
