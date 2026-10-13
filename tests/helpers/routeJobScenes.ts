/**
 * Scenes and goldens for the route job's parity tests (127-ROUTE-W).
 *
 * Every scene is synthetic or NOAA (public domain): the synthetic archipelago
 * (tests/fixtures/syntheticArchipelago.ts), a buoyed channel invented in the
 * open North Atlantic, and NOAA US5GA22M (Savannah River). The NOAA cell is
 * not in the repository (it lives in the main checkout's gitignored
 * public/enc-samples): set THALASSA_ENC_SAMPLES to that folder, or the NOAA
 * cases skip and say why.
 *
 * The test files mock the router's IO seams to read `scene` below (cells,
 * OSM water, tides, ETOPO), so a route runs the real prep, engine, shadows
 * and result exactly as the app does, with nothing fetched.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Feature, FeatureCollection } from 'geojson';
import { syntheticArchipelago, type LonLat } from '../fixtures/syntheticArchipelago';

/** The fixed clock every parity run uses (pinTailTideWindows reads Date.now()). */
export const FIXED_NOW = Date.UTC(2026, 9, 11, 0, 0, 0);
/** Serene Summer: 2.4 m draft, 18 m air draft. */
export const DRAFT_M = 2.4;
export const AIR_DRAFT_M = 18;

export interface SceneState {
    cells: unknown[];
    blobs: Map<string, unknown>;
    osm: Record<string, FeatureCollection> | null;
    /** Synthetic tide at every place (a 12.42 h sine), or none. */
    tide: { meanM: number; ampM: number } | null;
    /** What ETOPO answers: water everywhere, or nothing (the check cannot finish). */
    relief: 'water' | 'none';
}

export const scene: SceneState = { cells: [], blobs: new Map(), osm: null, tide: null, relief: 'water' };

/** A synthetic tide curve (TideHeightService.TideCurve) for the mocked fetch. */
export function syntheticTideCurve(meanM: number, ampM: number, startMs: number, endMs: number) {
    const period = 12.42 * 3_600_000;
    return {
        heights: [],
        provenance: 'EXTREMES_INTERP' as const,
        heightAt: (t: number) =>
            t < startMs || t > endMs ? null : meanM + ampM * Math.sin((2 * Math.PI * (t - startMs)) / period),
        rangeMs: [startMs, endMs] as [number, number],
        maxHeightM: meanM + ampM,
        stationName: 'Synthetic tide',
    };
}

export function installArchipelago(): Record<'5nm' | '12nm' | '20nm', { from: LonLat; to: LonLat }> {
    const a = syntheticArchipelago();
    scene.cells = a.cells.map((c) => c.meta);
    scene.blobs = new Map(a.cells.map((c) => [c.meta.id, c.blob]));
    scene.osm = a.osm;
    scene.tide = { meanM: 1.3, ampM: 1.1 };
    return a.routes;
}

/** The open North Atlantic near 30.0W 40.0N (invented, no real place). */
const ATL = { lon: -30.0, lat: 40.0 };
const mPerLon = 111_320 * Math.cos((ATL.lat * Math.PI) / 180);
const atl = (x: number, y: number): LonLat => [
    +(ATL.lon + x / mPerLon).toFixed(7),
    +(ATL.lat + y / 111_320).toFixed(7),
];

/**
 * A numbered buoyed channel along the direct line in uniformly deep water, as
 * in tests/seawayShadow.test.ts: the Seaway graph threads every gate and the
 * route ships as the PROMOTED graph route. Returns the route's ends.
 */
export function installAtlanticChannel(): { from: LonLat; to: LonLat } {
    const E = 6000;
    const ring = (x0: number, y0: number, x1: number, y1: number): LonLat[] => {
        const pts: LonLat[] = [];
        const edge = (ax: number, ay: number, bx: number, by: number) => {
            const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 200));
            for (let i = 0; i < n; i++) pts.push(atl(ax + ((bx - ax) * i) / n, ay + ((by - ay) * i) / n));
        };
        edge(x0, y0, x1, y0);
        edge(x1, y0, x1, y1);
        edge(x1, y1, x0, y1);
        edge(x0, y1, x0, y0);
        pts.push(pts[0]);
        return pts;
    };
    const feature = (acronym: string, geometry: Feature['geometry'], props: Record<string, unknown>): Feature => ({
        type: 'Feature',
        properties: { acronym, ...props },
        geometry,
    });
    const marks: Feature[] = [];
    for (let k = 0; k < 8; k++) {
        const x = -1750 + k * 500;
        marks.push(
            feature(
                'BOYLAT',
                { type: 'Point', coordinates: atl(x, 100) },
                { CATLAM: 1, OBJNAM: `ZZ Channel ${2 * k + 1}` },
            ),
            feature(
                'BOYLAT',
                { type: 'Point', coordinates: atl(x, -100) },
                { CATLAM: 2, OBJNAM: `ZZ Channel ${2 * k + 2}` },
            ),
        );
    }
    const fc = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
    const bbox = [...atl(-E, -E), ...atl(E, E)] as [number, number, number, number];
    const blob = {
        cellId: 'ZZ5ATL01',
        sourceHO: 'ZZ',
        edition: 1,
        issued: '2026-10-01',
        nativeScale: 12_000,
        bbox,
        layers: {
            DEPARE: fc([
                feature('DEPARE', { type: 'Polygon', coordinates: [ring(-E, -E, E, E)] }, { DRVAL1: 12, DRVAL2: 20 }),
            ]),
            BOYLAT: fc(marks),
            M_QUAL: fc([feature('M_QUAL', { type: 'Polygon', coordinates: [ring(-E, -E, E, E)] }, { CATZOC: 2 })]),
        },
    };
    scene.cells = [
        {
            id: blob.cellId,
            sourceHO: 'ZZ',
            edition: 1,
            issued: '2026-10-01',
            importedAt: '2026-10-01T00:00:00.000Z',
            bbox,
            geojsonPath: `enc/${blob.cellId}.json`,
            hazardCount: 5_000,
            usage: 'navigation',
        },
    ];
    scene.blobs = new Map([[blob.cellId, blob]]);
    scene.osm = null;
    scene.tide = null;
    return { from: atl(-2600, 0), to: atl(2600, 0) };
}

/** Where the NOAA cell is, or why the NOAA cases skip. */
export function noaaCellPath(): { path: string } | { skip: string } {
    const dir = process.env.THALASSA_ENC_SAMPLES;
    if (!dir) return { skip: 'THALASSA_ENC_SAMPLES is not set (the NOAA cell is gitignored; CI has none)' };
    const path = join(dir, 'US5GA22M.geojson');
    return existsSync(path) ? { path } : { skip: `${path} is missing` };
}

/** NOAA US5GA22M, Savannah River, with OSM river water made from its own wet depth areas. */
export function installNoaa(path: string): { blob: { layers: Record<string, FeatureCollection> } } {
    const blob = JSON.parse(readFileSync(path, 'utf8')) as {
        cellId: string;
        bbox: [number, number, number, number];
        layers: Record<string, FeatureCollection>;
    };
    blob.cellId = 'US5GA22M';
    const features = Object.values(blob.layers).reduce((n, c) => n + c.features.length, 0);
    scene.cells = [
        {
            id: 'US5GA22M',
            sourceHO: 'US',
            edition: 61,
            issued: '2023-10-20',
            importedAt: '2026-10-01T00:00:00.000Z',
            bbox: blob.bbox,
            geojsonPath: 'enc/US5GA22M.geojson',
            hazardCount: features * 20,
            usage: 'navigation',
        },
    ];
    scene.blobs = new Map([['US5GA22M', blob]]);
    const water = blob.layers.DEPARE.features
        .filter((f) => ((f.properties as { DRVAL1?: number } | null)?.DRVAL1 ?? -1) >= 0)
        .map(
            (f): Feature => ({
                type: 'Feature',
                properties: { natural: 'water', water: 'river', waterway: 'river' },
                geometry: f.geometry,
            }),
        );
    const fc = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
    scene.osm = {
        water: fc(water),
        reef: fc([]),
        coastline: fc([]),
        marina: fc([]),
        breakwater: fc([]),
        aeroway: fc([]),
        canalLines: fc([]),
        navLines: fc([]),
        berths: fc([]),
    };
    scene.tide = null;
    return { blob };
}

/** Fig Island Jetty Lighted Buoy 54 → Port Wentworth, 7.3 NM up the Savannah River. */
export const NOAA_ROUTE: { from: LonLat; to: LonLat } = { from: [-81.041899, 32.082668], to: [-81.153463, 32.157929] };

// ── Goldens ─────────────────────────────────────────────────────────

/** Object keys sorted, undefined dropped: the same value always gives the same text. */
export function canonicalJson(value: unknown): string {
    return JSON.stringify(value, (_key, v: unknown) => {
        if (ArrayBuffer.isView(v)) return Array.from(v as unknown as ArrayLike<number>);
        if (v && typeof v === 'object' && !Array.isArray(v))
            return Object.fromEntries(
                Object.keys(v as Record<string, unknown>)
                    .sort()
                    .map((k) => [k, (v as Record<string, unknown>)[k]]),
            );
        return v;
    });
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

const GOLDEN_DIR = resolve(__dirname, '../fixtures/routeJob');
export const WRITE_GOLDENS = process.env.ROUTEJOB_GOLDEN_WRITE === '1';

/**
 * Compare `value` with its golden (canonical-JSON sha256 plus a readable
 * summary), or write the golden when ROUTEJOB_GOLDEN_WRITE=1. Returns what to
 * expect equal: [actual, golden].
 */
export function golden(name: string, value: unknown, summary: Record<string, unknown>): [unknown, unknown] {
    const file = join(GOLDEN_DIR, `${name}.json`);
    const text = canonicalJson(value);
    const actual = { sha256: sha256(text), summary };
    if (WRITE_GOLDENS) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`);
        return [actual, actual];
    }
    return [actual, JSON.parse(readFileSync(file, 'utf8'))];
}

/** A route's readable summary: points, NM, ends, mask lengths; or a refusal's code and words. */
export function routeSummary(res: unknown): Record<string, unknown> {
    if (res === null || res === undefined) return { result: 'null' };
    const r = res as Record<string, unknown> & { polyline?: [number, number][] };
    if (!Array.isArray(r.polyline)) return { refusal: { code: r.code ?? null, error: r.error ?? null } };
    const masks: Record<string, number> = {};
    for (const [k, v] of Object.entries(r)) if (/Mask$/.test(k) && Array.isArray(v)) masks[k] = v.length;
    return {
        points: r.polyline.length,
        nm: Number((r.distanceNM as number).toFixed(4)),
        first: r.polyline[0],
        last: r.polyline[r.polyline.length - 1],
        masks,
        promoted: !!(r.debug as { seaway?: unknown } | undefined)?.seaway,
        chartVerdicts: Array.isArray(r.chartVerdicts) ? (r.chartVerdicts as unknown[]).length : null,
    };
}

/**
 * A solid land wall north–south through the open North Atlantic scene, edge
 * to edge of the chart: no way round by water, so the engine refuses.
 */
export function installAtlanticWall(): { from: LonLat; to: LonLat } {
    const ends = installAtlanticChannel();
    const blob = scene.blobs.get('ZZ5ATL01') as { layers: Record<string, FeatureCollection> };
    const E = 6000;
    const wall: LonLat[] = [atl(-1000, -E), atl(1000, -E), atl(1000, E), atl(-1000, E), atl(-1000, -E)];
    blob.layers.LNDARE = {
        type: 'FeatureCollection',
        features: [
            { type: 'Feature', properties: { acronym: 'LNDARE' }, geometry: { type: 'Polygon', coordinates: [wall] } },
        ],
    };
    blob.layers.BOYLAT = { type: 'FeatureCollection', features: [] };
    return ends;
}

/**
 * A small, fast route job (1.5 NM of open 15 m water in the North Atlantic
 * scene's box), shaped as tryInshoreRoute posts it. For the host and clone
 * tests; `extra` lets a test change any field.
 */
export function tinyRouteJob(extra: Record<string, unknown> = {}) {
    const E = 3000;
    const ring: LonLat[] = [atl(-E, -E), atl(E, -E), atl(E, E), atl(-E, E), atl(-E, -E)];
    const from = atl(-1400, 0);
    const to = atl(1400, 0);
    return {
        layers: {
            DEPARE: {
                type: 'FeatureCollection' as const,
                features: [
                    {
                        type: 'Feature' as const,
                        properties: { acronym: 'DEPARE', DRVAL1: 15, DRVAL2: 20 },
                        geometry: { type: 'Polygon' as const, coordinates: [ring] },
                    },
                ],
            },
        },
        routeOpts: {
            fromLat: from[1],
            fromLon: from[0],
            toLat: to[1],
            toLon: to[0],
            draftM: DRAFT_M,
            safetyM: 0.5,
            obstructionBufferM: 60,
            unchartedPolicy: 'strict' as const,
            routeProfile: 'safest' as const,
            surveyUncheckedCells: [],
        },
        origin: { lat: from[1], lon: from[0] },
        destination: { lat: to[1], lon: to[0] },
        airDraftM: AIR_DRAFT_M,
        cellsUsed: ['ZZ5TINY1'],
        structuresUnknownCells: [],
        structuresUnknownBboxes: [],
        regionalPairs: [],
        leadGraph: null,
        tideCeilings: [],
        ...extra,
    };
}
