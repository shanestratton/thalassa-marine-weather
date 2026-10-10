/**
 * The desk map's Light base (127-DESKMAP), drawn for real by Mapbox GL and
 * offline: the spec (browser-tests/desk-map-light.spec.ts) answers every tile
 * from made-up coastlines (e2e/helpers/syntheticChartTiles.ts). The map is
 * built through the app's own pieces: useMapInit's load pass
 * (recolourBaseStyle), addReliefBase, seaBaseLayers and setReliefPalette, the
 * OpenSeaMap raster with its credit, useOpenSeaMapRasterHide's desk gate, the
 * desk menu (MapBaseSelector) and the strip (DeskMapStrip). The base pass is
 * MapHub's, trimmed to what a desk shows.
 *
 *   ?place=solent|whitsundays|chesapeake&z=11   where it opens
 *   ?cell=1     a fictional NOAA-shaped chart off a made-up Chesapeake shore,
 *               mounted by the real chart layer, with the tracer's marks up
 *   ?night=1    the night palette
 *
 * Fictional data only; the repo is public.
 */
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import '../../index.css';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import { recolourBaseStyle } from '../../components/map/useMapInit';
import { addReliefBase, seaBaseLayers, setReliefPalette } from '../../components/map/reliefBase';
import { DESK_MAP_BASE_OPTIONS, MapBaseSelector, type MapBaseKind } from '../../components/map/MapBaseSelector';
import { DeskMapStrip } from '../../components/map/DeskMapStrip';
import { deskSlot0Line } from '../../components/map/deskMap';
import { useOpenSeaMapRasterHide } from '../../components/map/mapHub/useOpenSeaMapRasterHide';
import { OPENSEAMAP_ATTRIBUTION } from '../../components/map/seamarkCredit';
import {
    ENC_VEC_LAYERS,
    SATELLITE_HIDE_LAYERS,
    SATELLITE_KEY,
    mountEncVectorLayer,
    setEncPlottingMode,
    setEncVectorVisibility,
    syncDepareBaseTreatment,
} from '../../components/map/EncVectorLayer';
import { accumulateCellLayers, createClipGeometryMemos } from '../../services/enc/mergeFold';
import type { EncMergedVectorData } from '../../services/enc/EncHazardService';
import type { EncCell, EncConversionResult } from '../../services/enc/types';
import { clearAllCellMetadata, putCell } from '../../services/enc/EncCellMetadata';

const params = new URLSearchParams(location.search);
const PLACES: Record<string, [number, number]> = {
    solent: [-1.4, 50.76],
    whitsundays: [148.86, -20.24],
    chesapeake: [-76.4, 38.975],
};
const start = PLACES[params.get('place') ?? 'solent'] ?? PLACES.solent;
const withCell = params.get('cell') === '1';

// ── A fictional NOAA-shaped chart (US5 = a US harbour-scale id) ──────────
const CELL_BOX: [number, number, number, number] = [-76.45, 38.95, -76.35, 39.0];
const square = (w: number, s: number, e: number, n: number): Geometry => ({
    type: 'Polygon',
    coordinates: [
        [
            [w, s],
            [e, s],
            [e, n],
            [w, n],
            [w, s],
        ],
    ],
});
const feat = (geometry: Geometry, properties: Record<string, unknown> = {}): Feature => ({
    type: 'Feature',
    geometry,
    properties,
});
const fc = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
const CELL: EncCell = {
    id: 'US5FX10M',
    sourceHO: 'US',
    edition: 1,
    issued: '2026-01-01',
    importedAt: '2026-10-10T00:00:00Z',
    bbox: CELL_BOX,
    geojsonPath: 'enc/US5FX10M.json',
    hazardCount: 0,
    usage: 'navigation',
} as EncCell;
const BLOB: EncConversionResult = {
    cellId: CELL.id,
    sourceHO: 'US',
    nativeScale: 20_000,
    edition: 1,
    issued: '2026-01-01',
    bbox: CELL_BOX,
    layers: {
        // Deep water west, shoaling to a made-up shore in the cell's east.
        DEPARE: fc([
            feat(square(-76.45, 38.95, -76.4, 39.0), { DRVAL1: 50, DRVAL2: 100 }),
            feat(square(-76.4, 38.95, -76.38, 39.0), { DRVAL1: 5, DRVAL2: 10 }),
            feat(square(-76.38, 38.95, -76.37, 39.0), { DRVAL1: 2, DRVAL2: 5 }),
        ]),
        LNDARE: fc([feat(square(-76.37, 38.95, -76.35, 39.0))]),
        COALNE: fc([
            feat({
                type: 'LineString',
                coordinates: [
                    [-76.37, 38.95],
                    [-76.37, 39.0],
                ],
            }),
        ]),
        DEPCNT: fc([
            feat(
                {
                    type: 'LineString',
                    coordinates: [
                        [-76.38, 38.95],
                        [-76.38, 39.0],
                    ],
                },
                { VALDCO: 5 },
            ),
        ]),
        BOYLAT: fc([feat({ type: 'Point', coordinates: [-76.39, 38.975] }, { CATLAM: 2, COLOUR: '4', BOYSHP: 2 })]),
    },
} as unknown as EncConversionResult;

const MERGED_KEYS = [
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

async function cellMerged(): Promise<EncMergedVectorData> {
    const out: Record<string, unknown> = { cellCount: 0 };
    for (const k of MERGED_KEYS) out[k] = fc([]);
    const merged = out as unknown as EncMergedVectorData;
    const blobs = new Map([[CELL.id, BLOB]]);
    await accumulateCellLayers(CELL, BLOB, {
        merged,
        cellExtents: [{ id: CELL.id, bbox: CELL.bbox, authority: 'navigation' as const }],
        depareExtent: new Map([[CELL.id, CELL_BOX]]),
        ...createClipGeometryMemos(blobs, () => []),
        seaareByName: new Map(),
        glazeCoverageLib: new Map(),
        glazeUpgradeQueue: [],
        mergeGlazeKeys: [],
        buildGlaze: true,
        cullDeg: 0,
        yieldIfNeeded: async () => undefined,
    });
    return merged;
}

// The tracer's mark floor (useTracerChartFloors): what the grader checks is on screen.
const TRACER_MARKS = [ENC_VEC_LAYERS.BOYLAT, ENC_VEC_LAYERS.SOUNDG, ENC_VEC_LAYERS.LIGHTS];

// ── The page's style writes, for the styledata-loop rule ────────────────
const writes = { count: 0 };
const counted = ['setPaintProperty', 'setLayoutProperty', 'setFilter', 'moveLayer', 'setLayerZoomRange'] as const;

const token = String(import.meta.env.VITE_MAPBOX_ACCESS_TOKEN ?? '').trim();
if (token) mapboxgl.accessToken = token;

type Probe = [number, number];
const api = {
    ready: false,
    map: null as mapboxgl.Map | null,
    writes,
    setBase: (_: MapBaseKind) => undefined as void,
    setNight: (_: boolean) => undefined as void,
    setSeamarks: (_: boolean) => undefined as void,
    /** Move and wait for the map to settle: moveend, the gate's 120 ms pass, then idle. */
    async jump(lon: number, lat: number, zoom: number) {
        const map = api.map!;
        await new Promise<void>((resolve) => {
            map.once('moveend', () => resolve());
            map.jumpTo({ center: [lon, lat], zoom });
        });
        await new Promise((resolve) => setTimeout(resolve, 200));
        await api.idle();
    },
    idle: () =>
        new Promise<void>((resolve) => {
            const map = api.map!;
            map.once('idle', () => resolve());
            map.triggerRepaint();
        }),
    /** Drawn pixels at [lon, lat] points, read in one render frame. */
    probe(points: Probe[]): Promise<Array<number[] | null>> {
        const map = api.map!;
        const canvas = map.getCanvas();
        const scale = canvas.width / canvas.clientWidth;
        return new Promise((resolve) => {
            map.once('render', () => {
                const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext;
                const bound = gl.getParameter(gl.FRAMEBUFFER_BINDING);
                gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                const out = points.map(([lon, lat]) => {
                    const p = map.project([lon, lat]);
                    if (p.x < 0 || p.y < 0 || p.x >= canvas.clientWidth || p.y >= canvas.clientHeight) return null;
                    const pixel = new Uint8Array(4);
                    gl.readPixels(
                        Math.round(p.x * scale),
                        Math.round(canvas.height - p.y * scale),
                        1,
                        1,
                        gl.RGBA,
                        gl.UNSIGNED_BYTE,
                        pixel,
                    );
                    return [...pixel];
                });
                gl.bindFramebuffer(gl.FRAMEBUFFER, bound);
                resolve(out);
            });
            map.triggerRepaint();
        });
    },
    /** Pixels down a vertical run of canvas rows at x (client px), in one frame. */
    column(x: number, y0: number, y1: number): Promise<number[][]> {
        const map = api.map!;
        const canvas = map.getCanvas();
        const scale = canvas.width / canvas.clientWidth;
        return new Promise((resolve) => {
            map.once('render', () => {
                const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext;
                const bound = gl.getParameter(gl.FRAMEBUFFER_BINDING);
                gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                const out: number[][] = [];
                for (let y = y0; y <= y1; y += 1) {
                    const pixel = new Uint8Array(4);
                    gl.readPixels(
                        Math.round(x * scale),
                        Math.round(canvas.height - y * scale),
                        1,
                        1,
                        gl.RGBA,
                        gl.UNSIGNED_BYTE,
                        pixel,
                    );
                    out.push([...pixel]);
                }
                gl.bindFramebuffer(gl.FRAMEBUFFER, bound);
                resolve(out);
            });
            map.triggerRepaint();
        });
    },
    /** Client pixel of [lon, lat]. */
    at(lon: number, lat: number) {
        const p = api.map!.project([lon, lat]);
        return { x: p.x, y: p.y };
    },
    visibility(id: string) {
        const map = api.map!;
        if (!map.getLayer(id)) return null;
        return (map.getLayoutProperty(id, 'visibility') as string | undefined) ?? 'visible';
    },
    paint(id: string, prop: string) {
        return api.map!.getPaintProperty(id, prop as 'fill-opacity') as unknown;
    },
    cell: { box: CELL_BOX, id: CELL.id },
};
(window as unknown as { __deskMap: typeof api }).__deskMap = api;

function Desk() {
    const containerRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<mapboxgl.Map | null>(null);
    const [ready, setReady] = useState(false);
    const [base, setBase] = useState<MapBaseKind>('light');
    const [night, setNight] = useState(params.get('night') === '1');
    const [seamarks, setSeamarks] = useState(true);
    api.setBase = setBase;
    api.setNight = setNight;
    api.setSeamarks = setSeamarks;

    useEffect(() => {
        if (withCell) {
            clearAllCellMetadata();
            putCell(CELL);
        }
        const map = new mapboxgl.Map({
            container: containerRef.current!,
            style: 'mapbox://styles/mapbox/dark-v11',
            center: start,
            zoom: Number(params.get('z') ?? 11),
            attributionControl: false,
            fadeDuration: 0,
        });
        for (const name of counted) {
            const own = (map as unknown as Record<string, (...args: unknown[]) => unknown>)[name].bind(map);
            (map as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
                writes.count += 1;
                return own(...args);
            };
        }
        map.addControl(new mapboxgl.AttributionControl({ compact: true }), 'bottom-right');
        mapRef.current = map;
        api.map = map;
        map.on('load', async () => {
            recolourBaseStyle(map, false);
            map.addSource('satellite-base', {
                type: 'raster',
                tiles: [`https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}@2x.jpg90?access_token=${token}`],
                tileSize: 512,
                maxzoom: 22,
                attribution: '&copy; Mapbox &copy; Maxar',
            });
            addReliefBase(map);
            // As useMapInit adds it: born hidden, under the first symbol layer.
            map.addSource('openseamap-permanent', {
                type: 'raster',
                tiles: ['https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png'],
                tileSize: 256,
                maxzoom: 18,
                attribution: OPENSEAMAP_ATTRIBUTION,
            });
            map.addLayer({
                id: 'openseamap-permanent',
                type: 'raster',
                source: 'openseamap-permanent',
                minzoom: 6,
                maxzoom: 18,
                layout: { visibility: 'none' },
                paint: { 'raster-opacity': 0.85, 'raster-fade-duration': 0, 'raster-resampling': 'nearest' },
            });
            if (withCell) {
                try {
                    localStorage.setItem(SATELLITE_KEY, 'false');
                } catch {
                    /* the composer falls back to chart mode */
                }
                mountEncVectorLayer(map, await cellMerged(), { minZoom: 5 });
            }
            setReady(true);
        });
        return () => map.remove();
    }, []);

    // MapHub's base pass, trimmed: conditional visibility, the palette guard,
    // and the ENC treatment Light picks (chart) or the imagery bases keep (glaze).
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !ready) return;
        const imageryOn = base !== 'light';
        try {
            localStorage.setItem(SATELLITE_KEY, imageryOn ? 'true' : 'false');
        } catch {
            /* storage unavailable */
        }
        const setVis = (id: string, v: 'visible' | 'none') => {
            if (!map.getLayer(id) || (map.getLayoutProperty(id, 'visibility') ?? 'visible') === v) return false;
            map.setLayoutProperty(id, 'visibility', v);
            return true;
        };
        const apply = (force = false) => {
            let changed = force;
            for (const [id, on] of seaBaseLayers(base)) if (setVis(id, on ? 'visible' : 'none')) changed = true;
            if (setReliefPalette(map, night ? 'night' : base === 'light' ? 'light' : 'day')) changed = true;
            if (imageryOn && withCell) {
                for (const id of SATELLITE_HIDE_LAYERS) if (setVis(id, 'none')) changed = true;
                if (changed) syncDepareBaseTreatment(map);
            }
        };
        apply(true);
        if (withCell) {
            // The desk tracer (MapHub's encMaster): on Light the whole open
            // chart; on the imagery bases the plotting floors alone.
            setEncVectorVisibility(map, !imageryOn);
            setEncPlottingMode(map, true);
            for (const id of TRACER_MARKS) setVis(id, 'visible');
        }
        let pending: number | null = null;
        const schedule = () => {
            if (pending === null)
                pending = window.setTimeout(() => {
                    pending = null;
                    apply();
                }, 120);
        };
        map.on('styledata', schedule);
        api.ready = true;
        return () => {
            if (pending !== null) window.clearTimeout(pending);
            map.off('styledata', schedule);
        };
    }, [ready, base, night]);

    const view = useOpenSeaMapRasterHide(mapRef, ready, false, false, EMPTY, true, {
        surface: true,
        on: seamarks,
        chartMarks: withCell,
        encCellCount: withCell ? 1 : 0,
    });

    return (
        <main className="relative h-dvh w-full overflow-hidden bg-slate-950 text-white">
            {/* mapbox-gl's own CSS makes the map element position: relative, so
                the sizing box is a wrapper. */}
            <div className="absolute inset-0">
                <div ref={containerRef} data-testid="desk-map" className="thalassa-chart-map h-full w-full" />
            </div>
            <MapBaseSelector
                visible
                value={base}
                onChange={setBase}
                options={DESK_MAP_BASE_OPTIONS}
                encRow={false}
                toggles={[
                    {
                        id: 'seamarks',
                        label: 'Seamarks',
                        detail: 'OpenSeaMap community data, not verified',
                        on: seamarks,
                        onToggle: () => setSeamarks((on) => !on),
                    },
                ]}
                encCellCount={withCell ? 1 : 0}
                encVisible={false}
                onToggleEnc={() => undefined}
            />
            <DeskMapStrip
                slot0={deskSlot0Line({ licensed: false, boatName: null, chartInView: view.chartInView })}
                seamarks={seamarks ? (view.down ? 'down' : 'shown') : null}
                seabed={base === 'light' && view.low}
            />
        </main>
    );
}
const EMPTY = new Set<never>();

createRoot(document.getElementById('root')!).render(<Desk />);
