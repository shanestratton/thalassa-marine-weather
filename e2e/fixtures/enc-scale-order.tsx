/**
 * Scale-ordered chart drawing, rendered (item f, 2026-10-03). Two SYNTHETIC
 * cells — nowhere real; the repo is public — folded by the real merge
 * (accumulateCellLayers) and mounted by the real chart layer
 * (mountEncVectorLayer) on a real Mapbox canvas:
 *   • OVERVIEW, 1:3,500,000: a coarse land blob over a "harbour", and coarse
 *     water over an "island" it leaves out;
 *   • DETAILED, 1:90,000: the harbour charted 10–15 m, and the island.
 * Shane's Cid Harbour: the overview's land must draw UNDER the detailed
 * chart's water, and the detailed island OVER the overview's water.
 * window.__encScale.top(lon, lat) names the topmost area fill Mapbox drew
 * there (its layer and cell) — it needs no rendering, so it holds on CI —
 * and probe(lon, lat) reads the rendered pixel, which Mapbox only paints for
 * an authenticated map: the dev server's own VITE_MAPBOX_ACCESS_TOKEN (the
 * same config the app's map uses) when it has one; without it the canvas
 * stays blank and the spec checks the stack alone.
 */
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import { accumulateCellLayers, createClipGeometryMemos } from '../../services/enc/mergeFold';
import type { EncMergedVectorData } from '../../services/enc/EncHazardService';
import type { EncCell, EncConversionResult } from '../../services/enc/types';
import { mountEncVectorLayer } from '../../components/map/EncVectorLayer';

const square = (minLon: number, minLat: number, maxLon: number, maxLat: number): Geometry => ({
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
});
const ring = (minLon: number, minLat: number, maxLon: number, maxLat: number): Geometry => ({
    type: 'LineString',
    coordinates: (square(minLon, minLat, maxLon, maxLat) as GeoJSON.Polygon).coordinates[0],
});
const fc = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
const feat = (geometry: Geometry, properties: Record<string, unknown> = {}): Feature => ({
    type: 'Feature',
    geometry,
    properties,
});

const cell = (id: string, bbox: [number, number, number, number]): EncCell =>
    ({
        id,
        sourceHO: 'AU',
        edition: 1,
        issued: '2026-01-01',
        importedAt: '2026-10-03T00:00:00Z',
        bbox,
        geojsonPath: `enc/${id}.json`,
        usage: 'navigation',
    }) as EncCell;

const OVERVIEW = cell('OVERVIEW', [9, 9, 13, 13]);
// A 1°×1° cell, as a real 1:90,000 chart is: the bbox-sized "harbour-grade"
// repaint this replaces never reached a cell that size (Cid Harbour's).
const DETAILED = cell('DETAILED', [10.5, 10.5, 11.5, 11.5]);

const blobs = new Map<string, EncConversionResult>([
    [
        'OVERVIEW',
        {
            cellId: 'OVERVIEW',
            sourceHO: 'AU',
            nativeScale: 3_500_000,
            edition: 1,
            issued: '2026-01-01',
            bbox: OVERVIEW.bbox,
            layers: {
                DEPARE: fc([feat(square(10.8, 10.9, 11.2, 11.1), { DRVAL1: 20, DRVAL2: 50 })]),
                LNDARE: fc([feat(square(10.9, 10.95, 11.06, 11.08))]),
                COALNE: fc([feat(ring(10.9, 10.95, 11.06, 11.08))]),
            },
        },
    ],
    [
        'DETAILED',
        {
            cellId: 'DETAILED',
            sourceHO: 'AU',
            nativeScale: 90_000,
            edition: 1,
            issued: '2026-01-01',
            bbox: DETAILED.bbox,
            layers: {
                DEPARE: fc([
                    feat(square(10.95, 10.98, 11.03, 11.05), { DRVAL1: 10, DRVAL2: 15 }),
                    feat(square(11.07, 10.97, 11.14, 11.05), { DRVAL1: 5, DRVAL2: 10 }),
                ]),
                LNDARE: fc([feat(square(11.1, 11.0, 11.12, 11.02))]),
                COALNE: fc([feat(ring(11.1, 11.0, 11.12, 11.02))]),
            },
        },
    ],
]);

function emptyMerged(): EncMergedVectorData {
    const keys = [
        'DEPARE',
        'LNDARE',
        'COALNE',
        'OBSTRN',
        'WRECKS',
        'UWTROC',
        'DEPCNT',
        'DEPCNT_DERIVED',
        'LIGHTS',
        'LIGHTSEC',
        'BOYLAT',
        'BOYCAR',
        'BCNLAT',
        'BCNCAR',
        'BOYSPP',
        'BCNSPP',
        'BOYSAW',
        'BCNSAW',
        'BOYISD',
        'BCNISD',
        'RECTRC',
        'SOUNDG',
        'SEAARE_LABELS',
        'CAUTION_AREAS',
        'FAIRWY',
        'DEPARE_GLAZE',
    ];
    const out: Record<string, unknown> = { cellCount: 0 };
    for (const k of keys) out[k] = fc([]);
    return out as unknown as EncMergedVectorData;
}

function bboxOf(fcol: FeatureCollection | undefined): [number, number, number, number] | null {
    let b: [number, number, number, number] | null = null;
    for (const f of fcol?.features ?? []) {
        const coords = JSON.stringify((f.geometry as { coordinates?: unknown }).coordinates ?? []).match(
            /-?\d+(\.\d+)?/g,
        );
        if (!coords) continue;
        for (let i = 0; i + 1 < coords.length; i += 2) {
            const lon = Number(coords[i]);
            const lat = Number(coords[i + 1]);
            b = b
                ? [Math.min(b[0], lon), Math.min(b[1], lat), Math.max(b[2], lon), Math.max(b[3], lat)]
                : [lon, lat, lon, lat];
        }
    }
    return b;
}

async function buildMerged(): Promise<EncMergedVectorData> {
    const merged = emptyMerged();
    const cells = [OVERVIEW, DETAILED]; // coarse → fine, as the merge sorts them
    const depareExtent = new Map<string, [number, number, number, number]>();
    for (const c of cells) {
        const e = bboxOf(blobs.get(c.id)?.layers.DEPARE);
        if (e) depareExtent.set(c.id, e);
    }
    const memos = createClipGeometryMemos(blobs, () => []);
    for (const c of cells) {
        await accumulateCellLayers(c, blobs.get(c.id)!, {
            merged,
            cellExtents: cells.map((x) => ({ id: x.id, bbox: x.bbox, authority: 'navigation' as const })),
            depareExtent,
            ...memos,
            seaareByName: new Map(),
            glazeCoverageLib: new Map(),
            glazeUpgradeQueue: [],
            mergeGlazeKeys: [],
            buildGlaze: false,
            cullDeg: 0,
            yieldIfNeeded: async () => undefined,
        });
    }
    return merged;
}

const token = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_MAPBOX_ACCESS_TOKEN;
if (token) mapboxgl.accessToken = token;

const container = document.getElementById('map')!;
const map = new mapboxgl.Map({
    container,
    style: {
        version: 8,
        glyphs: `${location.origin}/e2e/fixtures/glyphs/{fontstack}/{range}.pbf`,
        sources: {},
        layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#08243b' } }],
    },
    center: [11.0, 11.0],
    zoom: 10,
    attributionControl: false,
    preserveDrawingBuffer: true,
    testMode: true,
} as mapboxgl.MapOptions);

const state = {
    ready: false,
    stack: [] as string[],
    top(lon: number, lat: number): { layer: string; cell: string } | null {
        const ids = (map.getStyle().layers ?? [])
            .map((l) => l.id)
            .filter((id) => /^enc-vec-(depare|lndare)(-t\d+)?-fill$/.test(id));
        const hit = map.queryRenderedFeatures(map.project([lon, lat]), { layers: ids })[0];
        return hit ? { layer: hit.layer?.id ?? '', cell: String(hit.properties?._cellId ?? '') } : null;
    },
    probe(lon: number, lat: number): [number, number, number, number] {
        const p = map.project([lon, lat]);
        const dpr = window.devicePixelRatio || 1;
        const src = map.getCanvas();
        const c = document.createElement('canvas');
        c.width = src.width;
        c.height = src.height;
        const ctx = c.getContext('2d')!;
        ctx.drawImage(src, 0, 0);
        const d = ctx.getImageData(Math.round(p.x * dpr), Math.round(p.y * dpr), 1, 1).data;
        return [d[0], d[1], d[2], d[3]];
    },
};
(window as unknown as { __encScale: typeof state }).__encScale = state;

map.on('load', async () => {
    const merged = await buildMerged();
    mountEncVectorLayer(map, merged, { minZoom: 5 });
    // The mount uploads its sources a frame at a time; wait for them, then
    // for the map to settle.
    const sourcesReady = () =>
        ['enc-vec-depare', 'enc-vec-lndare', 'enc-vec-coalne'].every((id) => {
            const data = (map.getSource(id) as unknown as { _data?: FeatureCollection } | undefined)?._data;
            return !!data && Array.isArray(data.features) && data.features.length > 0;
        });
    const settle = () => {
        if (!sourcesReady()) {
            setTimeout(settle, 100);
            return;
        }
        map.once('idle', () => {
            state.stack = (map.getStyle().layers ?? []).map((l) => l.id).filter((id) => id.startsWith('enc-vec-'));
            state.ready = true;
        });
        map.triggerRepaint();
    };
    settle();
});
