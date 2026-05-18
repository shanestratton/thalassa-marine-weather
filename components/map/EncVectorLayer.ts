/**
 * EncVectorLayer — actual S-57 vector chart features rendered on
 * the Mapbox map.
 *
 * Phase 8 — the user's imported ENC cells stop being just bbox
 * outlines and become real chart features. Depth-graduated water
 * fills, white coastline strokes, hazard symbols.
 *
 * Symbology approach: simplified IHO INT1. Not chart-grade
 * (proper INT1 has hundreds of symbol classes); enough that a
 * cruising sailor can recognise their chart.
 *
 *   LNDARE  → tan fill (#d6c590), no stroke
 *   DEPARE  → graduated blue fills by DRVAL1:
 *               <2 m   pale (sandy)
 *               2–5    light blue
 *               5–10   medium blue
 *               10–20  blue
 *               >20    deep navy
 *   COALNE  → white line, 1 px
 *   OBSTRN  → magenta circle (5 px) with cross
 *   WRECKS  → magenta circle (5 px) with cross + bold ring
 *   UWTROC  → magenta circle (4 px) with star centre
 *
 * Performance: a typical user (1-10 cells) loads ~1-50 MB of
 * GeoJSON total. Mapbox-GL tessellates GeoJSON into vector tiles
 * in a Web Worker; one-time CPU cost is a few seconds, runtime
 * draw is fast. We mount once per cell-list-change.
 *
 * Phase 9+ scope (not done here):
 *   - Viewport-filtered loading (only push features in view)
 *   - Click-to-popup (cell ID, depth, description)
 *   - Light/Dark/Day theme variants
 */

import mapboxgl from 'mapbox-gl';
import type { FeatureCollection } from 'geojson';

import { createLogger } from '../../utils/createLogger';
import type { EncMergedVectorData } from '../../services/enc/EncHazardService';
import { CATZOC_LABELS, isLowConfidenceCatzoc, type EncCatzoc } from '../../services/enc/types';

const log = createLogger('EncVectorLayer');

// ── Source IDs ─────────────────────────────────────────────────────

export const ENC_VEC_SRC = {
    LNDARE: 'enc-vec-lndare',
    DEPARE: 'enc-vec-depare',
    COALNE: 'enc-vec-coalne',
    POINTS: 'enc-vec-points', // OBSTRN + WRECKS + UWTROC merged
    NAVAIDS: 'enc-vec-navaids', // LIGHTS + BOYLAT + BOYCAR merged
} as const;

export const ENC_VEC_LAYERS = {
    LNDARE: 'enc-vec-lndare-fill',
    DEPARE: 'enc-vec-depare-fill',
    COALNE: 'enc-vec-coalne-line',
    OBSTRN: 'enc-vec-obstrn-circle',
    WRECKS: 'enc-vec-wrecks-circle',
    UWTROC: 'enc-vec-uwtroc-circle',
    BOYLAT: 'enc-vec-boylat-circle',
    BOYCAR: 'enc-vec-boycar-circle',
    BCNLAT: 'enc-vec-bcnlat-circle',
    BCNCAR: 'enc-vec-bcncar-circle',
    LIGHTS: 'enc-vec-lights-symbol',
} as const;

// All layer IDs, ordered bottom-to-top for correct stacking.
const ALL_LAYER_IDS = [
    ENC_VEC_LAYERS.DEPARE, // bottom (water fills)
    ENC_VEC_LAYERS.LNDARE,
    ENC_VEC_LAYERS.COALNE,
    ENC_VEC_LAYERS.BOYLAT,
    ENC_VEC_LAYERS.BCNLAT,
    ENC_VEC_LAYERS.BOYCAR,
    ENC_VEC_LAYERS.BCNCAR,
    ENC_VEC_LAYERS.OBSTRN,
    ENC_VEC_LAYERS.WRECKS,
    ENC_VEC_LAYERS.UWTROC,
    ENC_VEC_LAYERS.LIGHTS, // top (lights paint on everything)
];

const ALL_SOURCE_IDS = Object.values(ENC_VEC_SRC);

// ── Helpers ────────────────────────────────────────────────────────

function emptyFC(): FeatureCollection {
    return { type: 'FeatureCollection', features: [] };
}

/**
 * Find a sensible insertion anchor — vector chart should sit
 * above water/bathymetry but below labels and the route line.
 * We use the same anchor strategy as MpaLayer / EncCoverageLayer.
 */
function findInsertionAnchor(map: mapboxgl.Map): string | undefined {
    const style = map.getStyle();
    const layers = style?.layers ?? [];
    const candidates = ['settlement-major-label', 'place-city', 'country-label', 'admin-0-boundary'];
    for (const id of candidates) {
        if (layers.some((l) => l.id === id)) return id;
    }
    const firstSymbol = layers.find((l) => l.type === 'symbol');
    return firstSymbol?.id;
}

/**
 * Tag the merged points data with a 'kind' property so the three
 * point layers can filter their own features out of one shared
 * source — saves an extra source per point type, which speeds up
 * Mapbox's worker-side tile generation.
 */
function buildMergedPoints(data: EncMergedVectorData): FeatureCollection {
    const features = [
        ...data.OBSTRN.features.map((f) => ({
            ...f,
            properties: { ...(f.properties ?? {}), _kind: 'OBSTRN' },
        })),
        ...data.WRECKS.features.map((f) => ({
            ...f,
            properties: { ...(f.properties ?? {}), _kind: 'WRECKS' },
        })),
        ...data.UWTROC.features.map((f) => ({
            ...f,
            properties: { ...(f.properties ?? {}), _kind: 'UWTROC' },
        })),
    ];
    return { type: 'FeatureCollection', features };
}

/**
 * Same approach for navaids — one source, layer-level filters by
 * `_kind`. Saves the worker tile-build cost of three separate
 * sources holding the same Point geometries.
 */
function buildMergedNavaids(data: EncMergedVectorData): FeatureCollection {
    const features = [
        ...data.LIGHTS.features.map((f) => ({
            ...f,
            properties: { ...(f.properties ?? {}), _kind: 'LIGHTS' },
        })),
        ...data.BOYLAT.features.map((f) => ({
            ...f,
            properties: { ...(f.properties ?? {}), _kind: 'BOYLAT' },
        })),
        ...data.BOYCAR.features.map((f) => ({
            ...f,
            properties: { ...(f.properties ?? {}), _kind: 'BOYCAR' },
        })),
        ...data.BCNLAT.features.map((f) => ({
            ...f,
            properties: { ...(f.properties ?? {}), _kind: 'BCNLAT' },
        })),
        ...data.BCNCAR.features.map((f) => ({
            ...f,
            properties: { ...(f.properties ?? {}), _kind: 'BCNCAR' },
        })),
    ];
    return { type: 'FeatureCollection', features };
}

// ── Mount ──────────────────────────────────────────────────────────

export interface EncVectorMountOptions {
    /** Minimum zoom level at which to render. Default 7 — below
     *  this, the dashed coverage overlay is sufficient and the
     *  vector data would be too dense to read anyway. */
    minZoom?: number;
    /** Overall opacity multiplier. Default 0.85 (matches an
     *  IHO-style chart on a dark basemap). */
    opacity?: number;
}

/**
 * Idempotent mount. Adds (or updates) all four sources + six
 * layers. Safe to call repeatedly — re-using existing sources
 * avoids the layer-rebuild cost on cell-list changes; we just
 * setData on the source.
 */
export function mountEncVectorLayer(
    map: mapboxgl.Map,
    data: EncMergedVectorData,
    opts: EncVectorMountOptions = {},
): void {
    const minZoom = opts.minZoom ?? 7;
    const opacity = opts.opacity ?? 0.85;

    const ensureSource = (id: string, fc: FeatureCollection) => {
        const existing = map.getSource(id);
        if (existing && 'setData' in existing) {
            (existing as mapboxgl.GeoJSONSource).setData(fc);
            return;
        }
        map.addSource(id, {
            type: 'geojson',
            data: fc,
            generateId: true,
        });
    };

    ensureSource(ENC_VEC_SRC.LNDARE, data.LNDARE);
    ensureSource(ENC_VEC_SRC.DEPARE, data.DEPARE);
    ensureSource(ENC_VEC_SRC.COALNE, data.COALNE);
    ensureSource(ENC_VEC_SRC.POINTS, buildMergedPoints(data));
    ensureSource(ENC_VEC_SRC.NAVAIDS, buildMergedNavaids(data));

    const before = findInsertionAnchor(map);

    // ── DEPARE (depth-graduated fills) ────────────────────────────
    if (!map.getLayer(ENC_VEC_LAYERS.DEPARE)) {
        map.addLayer(
            {
                id: ENC_VEC_LAYERS.DEPARE,
                type: 'fill',
                source: ENC_VEC_SRC.DEPARE,
                minzoom: minZoom,
                paint: {
                    // DRVAL1 = minimum depth in S-57 metres (positive = depth).
                    // Coerce to number for missing values; null sorts as "very
                    // deep" so empty polygons don't get sand-coloured.
                    'fill-color': [
                        'step',
                        ['coalesce', ['to-number', ['get', 'DRVAL1']], 999],
                        '#f1d49b', // <2 m sandy
                        2,
                        '#bcdcef', // 2–5 light blue
                        5,
                        '#7cbbe0', // 5–10
                        10,
                        '#3a8dbf', // 10–20
                        20,
                        '#19577f', // 20–50
                        50,
                        '#0b2f4d', // >50 deep navy
                    ],
                    'fill-opacity': opacity,
                    'fill-antialias': true,
                },
            },
            before,
        );
    }

    // ── LNDARE (tan land) ─────────────────────────────────────────
    // Tan fill with a dark olive 1-px stroke. The stroke draws around every
    // emitted polygon — and since each AREA feature emits as a MultiPolygon
    // of individual triangles, the stroke traces every triangle's three
    // edges. Interior edges are shared between two triangles so they render
    // twice at the same color (no visual cost); the outer hull (which is
    // the only edge with degree-1 in the triangulation graph) renders just
    // once. Net effect: a darker tan margin along the actual coastline.
    // The COALNE black line on top provides the authoritative outline.
    if (!map.getLayer(ENC_VEC_LAYERS.LNDARE)) {
        map.addLayer(
            {
                id: ENC_VEC_LAYERS.LNDARE,
                type: 'fill',
                source: ENC_VEC_SRC.LNDARE,
                minzoom: minZoom,
                paint: {
                    'fill-color': '#d6c590',
                    'fill-opacity': opacity,
                    'fill-antialias': true,
                    'fill-outline-color': '#5c4a1a',
                },
            },
            before,
        );
    }

    // ── COALNE (black coastline) ──────────────────────────────────
    // Drawn from chart zoom upward — at low zoom the LNDARE triangulation
    // bleeds into water (GLU TRIANGLE_FAN slivers across river concavities)
    // so the fill alone doesn't read as a proper land/water boundary.
    // COALNE is the chart-author's intended coastline as a line feature —
    // immune to the triangulation issue and gives a clean black outline at
    // all zooms.
    //
    // Earlier choice was white @ z11+ on the assumption LNDARE fill plus
    // an OSM coastline would suffice at coastal zoom. With ENC charts as
    // the primary surface that's no longer true (2026-05-19 — user
    // feedback: "still very hard to see land from water").
    if (!map.getLayer(ENC_VEC_LAYERS.COALNE)) {
        map.addLayer(
            {
                id: ENC_VEC_LAYERS.COALNE,
                type: 'line',
                source: ENC_VEC_SRC.COALNE,
                minzoom: minZoom,
                layout: {
                    'line-cap': 'round',
                    'line-join': 'round',
                },
                paint: {
                    'line-color': '#0a0a0a',
                    'line-width': ['interpolate', ['linear'], ['zoom'], 7, 0.6, 10, 1.0, 13, 1.4, 15, 1.8],
                    'line-opacity': ['interpolate', ['linear'], ['zoom'], 7, 0.6, 10, 0.8, 13, 0.95, 15, opacity],
                },
            },
            before,
        );
    }

    // ── Hazard points (filtered by `_kind` from one merged source) ─
    // OBSTRN, WRECKS, UWTROC are all magenta point hazards in IHO
    // styling. We use circle-stroke + circle-color to differentiate.
    const POINT_BASE_COLOR = '#d837a9'; // magenta

    // SCAMIN-aware visibility filter — features pre-tagged with `_minZoom`
    // (derived from S-57 SCAMIN at extraction time) become visible only at
    // or above their chart-prescribed display zoom. Features without
    // `_minZoom` (or zero) are always-visible. Composes with the layer's
    // existing `_kind` filter so we don't lose the multi-class routing.
    //
    // Mapbox's published `FilterSpecification` is a huge discriminated union
    // that doesn't admit dynamic composition cleanly; cast at the seam.
    const scaminAware = (kindFilter: unknown): mapboxgl.FilterSpecification =>
        [
            'all',
            kindFilter,
            ['any', ['!', ['has', '_minZoom']], ['>=', ['zoom'], ['get', '_minZoom']]],
        ] as unknown as mapboxgl.FilterSpecification;
    if (!map.getLayer(ENC_VEC_LAYERS.OBSTRN)) {
        map.addLayer(
            {
                id: ENC_VEC_LAYERS.OBSTRN,
                type: 'circle',
                source: ENC_VEC_SRC.POINTS,
                minzoom: minZoom,
                filter: scaminAware(['==', ['get', '_kind'], 'OBSTRN']),
                paint: {
                    'circle-color': POINT_BASE_COLOR,
                    'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 2, 11, 4, 15, 6],
                    'circle-stroke-color': '#ffffff',
                    'circle-stroke-width': 1.2,
                    'circle-opacity': opacity,
                    'circle-stroke-opacity': opacity,
                },
            },
            before,
        );
    }
    if (!map.getLayer(ENC_VEC_LAYERS.WRECKS)) {
        map.addLayer(
            {
                id: ENC_VEC_LAYERS.WRECKS,
                type: 'circle',
                source: ENC_VEC_SRC.POINTS,
                minzoom: minZoom,
                filter: scaminAware(['==', ['get', '_kind'], 'WRECKS']),
                paint: {
                    'circle-color': POINT_BASE_COLOR,
                    'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 3, 11, 5, 15, 7],
                    'circle-stroke-color': '#ffd1ec',
                    'circle-stroke-width': 2,
                    'circle-opacity': opacity,
                    'circle-stroke-opacity': opacity,
                },
            },
            before,
        );
    }
    if (!map.getLayer(ENC_VEC_LAYERS.UWTROC)) {
        map.addLayer(
            {
                id: ENC_VEC_LAYERS.UWTROC,
                type: 'circle',
                source: ENC_VEC_SRC.POINTS,
                minzoom: minZoom,
                filter: scaminAware(['==', ['get', '_kind'], 'UWTROC']),
                paint: {
                    'circle-color': '#ffffff',
                    'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 1.5, 11, 3, 15, 5],
                    'circle-stroke-color': POINT_BASE_COLOR,
                    'circle-stroke-width': 1.5,
                    'circle-opacity': opacity,
                    'circle-stroke-opacity': opacity,
                },
            },
            before,
        );
    }

    // ── BOYLAT / BCNLAT (lateral marks) ───────────────────────────
    // Color is pre-computed at merge time (lateralMarkColour() in
    // services/enc/types.ts) so we don't need region detection in
    // a paint expression — just read `_displayColor`. Region-A vs
    // region-B logic lives once in TypeScript, not duplicated as a
    // chunky `case` here.
    //
    // BOYLAT = floating buoy (thinner stroke).
    // BCNLAT = rigid beacon — same colour family but bolder stroke
    //          to suggest "structure, not float".
    if (!map.getLayer(ENC_VEC_LAYERS.BOYLAT)) {
        map.addLayer(
            {
                id: ENC_VEC_LAYERS.BOYLAT,
                type: 'circle',
                source: ENC_VEC_SRC.NAVAIDS,
                minzoom: minZoom,
                filter: scaminAware(['==', ['get', '_kind'], 'BOYLAT']),
                paint: {
                    'circle-color': ['coalesce', ['get', '_displayColor'], '#facc15'],
                    'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 2.5, 11, 4.5, 15, 7],
                    'circle-stroke-color': '#000000',
                    'circle-stroke-width': 1,
                    'circle-opacity': opacity,
                    'circle-stroke-opacity': opacity,
                },
            },
            before,
        );
    }

    if (!map.getLayer(ENC_VEC_LAYERS.BCNLAT)) {
        map.addLayer(
            {
                id: ENC_VEC_LAYERS.BCNLAT,
                type: 'circle',
                source: ENC_VEC_SRC.NAVAIDS,
                minzoom: minZoom,
                filter: scaminAware(['==', ['get', '_kind'], 'BCNLAT']),
                paint: {
                    'circle-color': ['coalesce', ['get', '_displayColor'], '#facc15'],
                    'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 2.5, 11, 4.5, 15, 7],
                    'circle-stroke-color': '#000000',
                    // Thicker stroke distinguishes a rigid beacon
                    // from a floating buoy at-a-glance.
                    'circle-stroke-width': 2.2,
                    'circle-opacity': opacity,
                    'circle-stroke-opacity': opacity,
                },
            },
            before,
        );
    }

    // ── BOYCAR / BCNCAR (cardinal marks) ──────────────────────────
    // Yellow with black ring. Same buoy-vs-beacon stroke distinction
    // as the lateral marks. Top-mark cones (proper IHO INT1) need
    // SVG icons — out of scope for v1.
    if (!map.getLayer(ENC_VEC_LAYERS.BOYCAR)) {
        map.addLayer(
            {
                id: ENC_VEC_LAYERS.BOYCAR,
                type: 'circle',
                source: ENC_VEC_SRC.NAVAIDS,
                minzoom: minZoom,
                filter: scaminAware(['==', ['get', '_kind'], 'BOYCAR']),
                paint: {
                    'circle-color': '#facc15',
                    'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 2.5, 11, 4.5, 15, 7],
                    'circle-stroke-color': '#000000',
                    'circle-stroke-width': 1.6,
                    'circle-opacity': opacity,
                    'circle-stroke-opacity': opacity,
                },
            },
            before,
        );
    }

    if (!map.getLayer(ENC_VEC_LAYERS.BCNCAR)) {
        map.addLayer(
            {
                id: ENC_VEC_LAYERS.BCNCAR,
                type: 'circle',
                source: ENC_VEC_SRC.NAVAIDS,
                minzoom: minZoom,
                filter: scaminAware(['==', ['get', '_kind'], 'BCNCAR']),
                paint: {
                    'circle-color': '#facc15',
                    'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 2.5, 11, 4.5, 15, 7],
                    'circle-stroke-color': '#000000',
                    'circle-stroke-width': 2.4,
                    'circle-opacity': opacity,
                    'circle-stroke-opacity': opacity,
                },
            },
            before,
        );
    }

    // ── LIGHTS (lighthouses + lit aids) ───────────────────────────
    // Symbol layer with a star char so it stays sharp at any zoom.
    // Color cues from the LIGHTS.COLOUR attribute:
    //   1=white  3=red  4=green  6=yellow  -- the ones you commonly
    //   see on a chart. Default to bright yellow for unknown.
    if (!map.getLayer(ENC_VEC_LAYERS.LIGHTS)) {
        map.addLayer(
            {
                id: ENC_VEC_LAYERS.LIGHTS,
                type: 'symbol',
                source: ENC_VEC_SRC.NAVAIDS,
                minzoom: minZoom,
                filter: scaminAware(['==', ['get', '_kind'], 'LIGHTS']),
                layout: {
                    'text-field': '★',
                    'text-size': ['interpolate', ['linear'], ['zoom'], 7, 11, 11, 16, 15, 22],
                    'text-allow-overlap': true,
                    'text-anchor': 'center',
                },
                paint: {
                    // S-57 COLOUR is a comma-separated string of codes.
                    // We use a regex-style match on the first character
                    // (most lights are mono-coloured); fall back to
                    // bright yellow for the typical "FlW" lighthouse.
                    'text-color': [
                        'match',
                        ['coalesce', ['get', 'COLOUR'], ['get', 'colour'], '6'],
                        '3',
                        '#ef4444', // red
                        '4',
                        '#22c55e', // green
                        '1',
                        '#ffffff', // white
                        /* default */ '#fde047', // yellow
                    ],
                    'text-halo-color': 'rgba(0, 0, 0, 0.85)',
                    'text-halo-width': 1.5,
                    'text-opacity': opacity,
                },
            },
            before,
        );
    }

    log.info(
        `mounted vector layers: ${data.cellCount} cells, ` +
            `${data.LIGHTS.features.length} lights, ` +
            `lat marks=${data.BOYLAT.features.length + data.BCNLAT.features.length} ` +
            `(${data.BOYLAT.features.length} buoys, ${data.BCNLAT.features.length} beacons), ` +
            `card marks=${data.BOYCAR.features.length + data.BCNCAR.features.length} ` +
            `(${data.BOYCAR.features.length} buoys, ${data.BCNCAR.features.length} beacons), ` +
            `polygons: ${data.DEPARE.features.length} depare, ${data.LNDARE.features.length} lndare, ` +
            `${data.COALNE.features.length} coalne, ` +
            `${data.OBSTRN.features.length + data.WRECKS.features.length + data.UWTROC.features.length} hazard pts`,
    );
}

/**
 * Replace just the underlying source data without rebuilding
 * layers. Faster than a full mount cycle when cells are imported
 * or removed mid-session.
 */
export function refreshEncVectorData(map: mapboxgl.Map, data: EncMergedVectorData): void {
    const setData = (id: string, fc: FeatureCollection) => {
        const src = map.getSource(id);
        if (src && 'setData' in src) (src as mapboxgl.GeoJSONSource).setData(fc);
    };
    setData(ENC_VEC_SRC.LNDARE, data.LNDARE);
    setData(ENC_VEC_SRC.DEPARE, data.DEPARE);
    setData(ENC_VEC_SRC.COALNE, data.COALNE);
    setData(ENC_VEC_SRC.POINTS, buildMergedPoints(data));
    setData(ENC_VEC_SRC.NAVAIDS, buildMergedNavaids(data));
    log.info(`refreshed vector data: ${data.cellCount} cells`);
}

/**
 * Tear down all sources + layers. Idempotent.
 */
export function unmountEncVectorLayer(map: mapboxgl.Map): void {
    for (const id of ALL_LAYER_IDS) {
        if (map.getLayer(id)) {
            try {
                map.removeLayer(id);
            } catch {
                /* best effort */
            }
        }
    }
    for (const id of ALL_SOURCE_IDS) {
        if (map.getSource(id)) {
            try {
                map.removeSource(id);
            } catch {
                /* best effort */
            }
        }
    }
    log.info('unmounted ENC vector layers');
}

/**
 * Toggle layer visibility without mutating sources. Useful for the
 * UI toggle (when added) — keeps the tile cache warm so re-show
 * is instant.
 */
export function setEncVectorVisibility(map: mapboxgl.Map, visible: boolean): void {
    const value = visible ? 'visible' : 'none';
    for (const id of ALL_LAYER_IDS) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', value);
    }
}

/**
 * The ENC layers we drop when a route is on the map. Polygon fills
 * (DEPARE, LNDARE) and lines (COALNE) clutter the route polyline; the
 * lateral/cardinal markers + lights + obstruction symbols help the user
 * verify the route is sensible so we keep those visible. Hazard points
 * (WRECKS/UWTROC/OBSTRN as circles) also stay — they're the things the
 * router already routed around but the user wants to see.
 */
const ROUTE_FOCUS_HIDE_LAYERS = [ENC_VEC_LAYERS.DEPARE, ENC_VEC_LAYERS.LNDARE, ENC_VEC_LAYERS.COALNE] as const;

/**
 * "Clean chart" mode — hide the busy depth-band fills so the chart reads
 * as just land + coastline + navigational markers + hazards. COALNE is
 * KEPT visible in clean mode (2026-05-19 user feedback: needs the
 * coastline to distinguish land from water at coastal zooms because the
 * LNDARE triangulation bleeds across river concavities).
 *
 * Independent of route-focus: route-focus hides LNDARE+COALNE too because
 * the route polyline is the focal point; clean-chart keeps both so the
 * sailor can sense-check waypoints against the coastline.
 */
const CHART_DETAIL_HIDE_LAYERS = [ENC_VEC_LAYERS.DEPARE] as const;

/**
 * Route-focus mode: hide the busy bulk-fill and coastline layers so the route
 * polyline is the dominant visual, but keep markers / lights / hazards so the
 * sailor can sense-check the route against channel marks.
 *
 * Composes with the master FAB toggle (`setEncVectorVisibility`) by reading
 * the BCNLAT layer's current visibility as a master-state probe — BCNLAT is
 * one of the marker layers we never hide, so its visibility equals the master
 * state. If master is off, we leave every layer hidden. If master is on, we
 * flip the bulk-fill subset and leave the markers alone.
 *
 * Idempotent — calling repeatedly with the same args costs almost nothing.
 */
export function setEncRouteFocusMode(map: mapboxgl.Map, focused: boolean): void {
    // Probe master toggle state via BCNLAT (always 'visible' when ENC is on,
    // 'none' when ENC is off). If the layer doesn't exist yet, the user has
    // no cells imported and there's nothing to focus.
    const probe = map.getLayer(ENC_VEC_LAYERS.BCNLAT);
    if (!probe) return;
    const masterVisible = map.getLayoutProperty(ENC_VEC_LAYERS.BCNLAT, 'visibility') !== 'none';
    if (!masterVisible) return; // every ENC layer already hidden — leave it

    const value = focused ? 'none' : 'visible';
    for (const id of ROUTE_FOCUS_HIDE_LAYERS) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', value);
    }
}

/**
 * Chart-detail toggle: false = clean (land + markers + hazards only), true =
 * full (also depth-fills + coastline). Mirrors `setEncRouteFocusMode` shape
 * so MapHub can call them independently and the more-specific layer wins.
 *
 * Order rule: clean-chart can be on alongside route-focus; whichever sets
 * 'none' last sticks. Since both target overlapping layers (DEPARE/COALNE),
 * effectively "clean OR focused → hide" is what the user sees — which is
 * the intended composition.
 */
export function setEncChartDetail(map: mapboxgl.Map, detailed: boolean): void {
    const probe = map.getLayer(ENC_VEC_LAYERS.BCNLAT);
    if (!probe) return;
    const masterVisible = map.getLayoutProperty(ENC_VEC_LAYERS.BCNLAT, 'visibility') !== 'none';
    if (!masterVisible) return;

    const value = detailed ? 'visible' : 'none';
    for (const id of CHART_DETAIL_HIDE_LAYERS) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', value);
    }
}

// ── Click-to-popup ─────────────────────────────────────────────────

/**
 * Escape HTML special chars so feature properties (e.g. `OBJNAM`
 * containing apostrophes) can't break the popup HTML.
 */
function esc(s: unknown): string {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function fmtDepth(v: unknown, suffix = ' m'): string {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return '—';
    return `${n.toFixed(1)}${suffix}`;
}

function fmtRange(min: unknown, max: unknown): string | null {
    const a = typeof min === 'number' ? min : Number(min);
    const b = typeof max === 'number' ? max : Number(max);
    if (!Number.isFinite(a) && !Number.isFinite(b)) return null;
    if (Number.isFinite(a) && Number.isFinite(b)) return `${a.toFixed(1)}–${b.toFixed(1)} m`;
    if (Number.isFinite(a)) return `${a.toFixed(1)} m+`;
    return `≤${b.toFixed(1)} m`;
}

/**
 * S-57 attribute lookups for the popup. Wreck and obstruction
 * categories are coded ints in the source — we map the most-common
 * ones; unknown codes fall back to the raw value.
 */
const CATWRK_LABELS: Record<string, string> = {
    '1': 'Non-dangerous wreck',
    '2': 'Dangerous wreck',
    '3': 'Distributed remains',
    '4': 'Wreck showing mast/funnel',
    '5': 'Wreck showing hull',
};

const CATOBS_LABELS: Record<string, string> = {
    '1': 'Snag/Stump',
    '2': 'Wellhead',
    '3': 'Diffuser',
    '4': 'Crib',
    '5': 'Fish haven',
    '6': 'Foul area',
    '7': 'Foul ground',
    '8': 'Ice boom',
    '9': 'Ground tackle',
    '10': 'Boom',
};

const WATLEV_LABELS: Record<string, string> = {
    '1': 'Partly submerged at high water',
    '2': 'Always dry',
    '3': 'Always submerged',
    '4': 'Covers and uncovers',
    '5': 'Awash',
    '6': 'Subject to inundation/flooding',
    '7': 'Floating',
};

/**
 * Build the popup HTML for a feature. The layer ID determines
 * which fields we surface — DEPARE shows depth range, WRECKS
 * shows category + depth, etc.
 *
 * Style: dark glassmorphic to match the rest of the app's chart
 * UI. Mapbox's default popup CSS gives us a white background; we
 * override per-class in the class names.
 */
function buildFeaturePopupHtml(layerId: string, props: Record<string, unknown>): string {
    const cellId = props._cellId as string | undefined;
    const sourceHO = props._sourceHO as string | undefined;
    const provenance = cellId
        ? `<div class="enc-popup-cell">${esc(cellId)}${sourceHO ? ` · ${esc(sourceHO)}` : ''}</div>`
        : '';

    let title = 'Feature';
    let body = '';
    let accent = '#0ea5e9'; // sky-500 default

    if (layerId === ENC_VEC_LAYERS.DEPARE) {
        title = 'Depth area';
        accent = '#3a8dbf';
        const range = fmtRange(props.DRVAL1 ?? props.drval1, props.DRVAL2 ?? props.drval2);
        if (range) body += `<div class="enc-popup-row"><span>Depth</span><b>${range}</b></div>`;
    } else if (layerId === ENC_VEC_LAYERS.LNDARE) {
        title = 'Land';
        accent = '#a8956a';
        body += `<div class="enc-popup-row"><span>Type</span><b>Charted land area</b></div>`;
    } else if (layerId === ENC_VEC_LAYERS.COALNE) {
        title = 'Coastline';
        accent = '#ffffff';
        body += `<div class="enc-popup-row"><span>Type</span><b>Charted coastline</b></div>`;
    } else if (layerId === ENC_VEC_LAYERS.OBSTRN) {
        title = 'Obstruction';
        accent = '#d837a9';
        const name = props.OBJNAM ?? props.objnam;
        if (typeof name === 'string' && name)
            body += `<div class="enc-popup-row"><span>Name</span><b>${esc(name)}</b></div>`;
        const cat = String(props.CATOBS ?? props.catobs ?? '');
        if (cat && CATOBS_LABELS[cat]) {
            body += `<div class="enc-popup-row"><span>Category</span><b>${esc(CATOBS_LABELS[cat])}</b></div>`;
        }
        const depth = props.VALSOU ?? props.valsou;
        if (depth != null) body += `<div class="enc-popup-row"><span>Depth</span><b>${esc(fmtDepth(depth))}</b></div>`;
        const watlev = String(props.WATLEV ?? props.watlev ?? '');
        if (watlev && WATLEV_LABELS[watlev]) {
            body += `<div class="enc-popup-row"><span>Water level</span><b>${esc(WATLEV_LABELS[watlev])}</b></div>`;
        }
    } else if (layerId === ENC_VEC_LAYERS.WRECKS) {
        title = 'Wreck';
        accent = '#d837a9';
        const name = props.OBJNAM ?? props.objnam;
        if (typeof name === 'string' && name)
            body += `<div class="enc-popup-row"><span>Name</span><b>${esc(name)}</b></div>`;
        const cat = String(props.CATWRK ?? props.catwrk ?? '');
        if (cat && CATWRK_LABELS[cat]) {
            body += `<div class="enc-popup-row"><span>Category</span><b>${esc(CATWRK_LABELS[cat])}</b></div>`;
        }
        const depth = props.VALSOU ?? props.valsou;
        if (depth != null) body += `<div class="enc-popup-row"><span>Depth</span><b>${esc(fmtDepth(depth))}</b></div>`;
    } else if (layerId === ENC_VEC_LAYERS.UWTROC) {
        title = 'Underwater rock';
        accent = '#d837a9';
        const depth = props.VALSOU ?? props.valsou;
        if (depth != null) body += `<div class="enc-popup-row"><span>Depth</span><b>${esc(fmtDepth(depth))}</b></div>`;
        const watlev = String(props.WATLEV ?? props.watlev ?? '');
        if (watlev && WATLEV_LABELS[watlev]) {
            body += `<div class="enc-popup-row"><span>Water level</span><b>${esc(WATLEV_LABELS[watlev])}</b></div>`;
        }
    } else if (layerId === ENC_VEC_LAYERS.LIGHTS) {
        title = 'Light';
        accent = '#fde047';
        const name = props.OBJNAM ?? props.objnam;
        if (typeof name === 'string' && name)
            body += `<div class="enc-popup-row"><span>Name</span><b>${esc(name)}</b></div>`;
        // S-57 light "character" stitched together — closest the
        // popup gets to a full nautical light description like
        // "FL.W.5s.18m." Without symbol expansion we just show the
        // raw fields the user can cross-reference on a chart.
        const litchr = props.LITCHR ?? props.litchr;
        const sigper = props.SIGPER ?? props.sigper;
        const valnmr = props.VALNMR ?? props.valnmr;
        const height = props.HEIGHT ?? props.height;
        const colour = props.COLOUR ?? props.colour;
        if (litchr) body += `<div class="enc-popup-row"><span>Character</span><b>${esc(String(litchr))}</b></div>`;
        if (sigper) body += `<div class="enc-popup-row"><span>Period</span><b>${esc(sigper)} s</b></div>`;
        if (height) body += `<div class="enc-popup-row"><span>Height</span><b>${esc(fmtDepth(height))}</b></div>`;
        if (valnmr) body += `<div class="enc-popup-row"><span>Range</span><b>${esc(valnmr)} NM</b></div>`;
        if (colour) body += `<div class="enc-popup-row"><span>Colour code</span><b>${esc(String(colour))}</b></div>`;
    } else if (layerId === ENC_VEC_LAYERS.BOYLAT || layerId === ENC_VEC_LAYERS.BCNLAT) {
        const isBeacon = layerId === ENC_VEC_LAYERS.BCNLAT;
        title = isBeacon ? 'Lateral beacon' : 'Lateral buoy';
        accent = '#facc15';
        const CATLAM_LABELS: Record<string, string> = {
            '1': 'Port-hand mark',
            '2': 'Starboard-hand mark',
            '3': 'Preferred channel — port',
            '4': 'Preferred channel — starboard',
            '5': 'Channel marker',
            '6': 'Bifurcation',
            '7': 'Junction',
            '8': 'Wreck mark',
        };
        const cat = String(props.CATLAM ?? props.catlam ?? '');
        if (cat && CATLAM_LABELS[cat]) {
            body += `<div class="enc-popup-row"><span>Mark</span><b>${esc(CATLAM_LABELS[cat])}</b></div>`;
        }
        const region = props._ialaRegion;
        if (region === 'A' || region === 'B') {
            body += `<div class="enc-popup-row"><span>Region</span><b>IALA-${esc(region)}</b></div>`;
        }
        const name = props.OBJNAM ?? props.objnam;
        if (typeof name === 'string' && name)
            body += `<div class="enc-popup-row"><span>Name</span><b>${esc(name)}</b></div>`;
    } else if (layerId === ENC_VEC_LAYERS.BOYCAR || layerId === ENC_VEC_LAYERS.BCNCAR) {
        const isBeacon = layerId === ENC_VEC_LAYERS.BCNCAR;
        title = isBeacon ? 'Cardinal beacon' : 'Cardinal buoy';
        accent = '#facc15';
        const CATCAM_LABELS: Record<string, string> = {
            '1': 'North',
            '2': 'East',
            '3': 'South',
            '4': 'West',
        };
        const cat = String(props.CATCAM ?? props.catcam ?? '');
        if (cat && CATCAM_LABELS[cat]) {
            body += `<div class="enc-popup-row"><span>Quadrant</span><b>${esc(CATCAM_LABELS[cat])}</b></div>`;
        }
        const name = props.OBJNAM ?? props.objnam;
        if (typeof name === 'string' && name)
            body += `<div class="enc-popup-row"><span>Name</span><b>${esc(name)}</b></div>`;
    }

    if (!body) body = `<div class="enc-popup-row"><span>Feature</span><b>${esc(title)}</b></div>`;

    return `
        <div class="enc-popup">
            <button class="enc-popup-close" aria-label="Close">×</button>
            <div class="enc-popup-title" style="color:${accent}">${esc(title)}</div>
            <div class="enc-popup-body">${body}</div>
            ${provenance}
        </div>
        <style>
            .enc-popup {
                position: relative;
                font-family: system-ui, -apple-system, sans-serif;
                color: rgb(229, 231, 235);
                background: rgba(15, 23, 42, 0.92);
                backdrop-filter: blur(12px);
                -webkit-backdrop-filter: blur(12px);
                border: 1px solid rgba(255, 255, 255, 0.12);
                border-radius: 10px;
                padding: 10px 12px;
                font-size: 12px;
                line-height: 1.5;
                min-width: 180px;
                max-width: 280px;
            }
            .enc-popup-close {
                position: absolute;
                top: 4px;
                right: 6px;
                background: rgba(15, 23, 42, 0.85);
                border: 1px solid rgba(255, 255, 255, 0.1);
                color: rgb(209, 213, 219);
                border-radius: 999px;
                width: 22px;
                height: 22px;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                font-size: 16px;
                line-height: 1;
                font-weight: bold;
                padding: 0;
            }
            .enc-popup-close:hover {
                background: rgba(220, 38, 38, 0.85);
                color: white;
            }
            .enc-popup-title {
                font-size: 13px;
                font-weight: 700;
                margin-bottom: 6px;
                padding-right: 22px;
            }
            .enc-popup-body { display: flex; flex-direction: column; gap: 2px; }
            .enc-popup-row { display: flex; justify-content: space-between; gap: 12px; }
            .enc-popup-row span { color: rgba(229, 231, 235, 0.55); }
            .enc-popup-row b { font-weight: 600; color: rgb(229, 231, 235); }
            .enc-popup-cell {
                margin-top: 6px;
                padding-top: 6px;
                border-top: 1px solid rgba(255, 255, 255, 0.08);
                font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
                font-size: 10px;
                color: rgba(229, 231, 235, 0.55);
            }
            .mapboxgl-popup-content { background: transparent !important; padding: 0 !important; box-shadow: none !important; }
            .mapboxgl-popup-tip { display: none !important; }
        </style>
    `;
}

/**
 * Track click handlers per map for clean teardown. We can't use a
 * closure inside detachClickHandlers without a reference, so we
 * stash them on the map object itself via a WeakMap.
 */
interface AttachedHandlers {
    click: (e: mapboxgl.MapMouseEvent) => void;
    enter: () => void;
    leave: () => void;
    popup: mapboxgl.Popup | null;
}
const attachedHandlers = new WeakMap<mapboxgl.Map, AttachedHandlers>();

/**
 * Wire up click handlers on every ENC vector layer so tapping a
 * feature shows a popup describing it. Idempotent — if handlers
 * are already attached, this is a no-op.
 */
export function attachEncFeatureClickHandlers(map: mapboxgl.Map): void {
    if (attachedHandlers.has(map)) return;

    const onClick = (e: mapboxgl.MapMouseEvent) => {
        // queryRenderedFeatures across all our layers; topmost wins.
        // Order matters: we list points first (small, easy to miss
        // if covered by a polygon hit) then polygons last.
        const features = map.queryRenderedFeatures(e.point, { layers: ALL_LAYER_IDS });
        if (!features.length) return;

        // Prefer point features over big polygons when both are
        // hit — clicking near a buoy that sits on top of a depth
        // area should pop the buoy info, not the depth.
        const POINT_LAYER_IDS = new Set<string>([
            ENC_VEC_LAYERS.OBSTRN,
            ENC_VEC_LAYERS.WRECKS,
            ENC_VEC_LAYERS.UWTROC,
            ENC_VEC_LAYERS.LIGHTS,
            ENC_VEC_LAYERS.BOYLAT,
            ENC_VEC_LAYERS.BOYCAR,
            ENC_VEC_LAYERS.BCNLAT,
            ENC_VEC_LAYERS.BCNCAR,
        ]);
        const point = features.find((f) => POINT_LAYER_IDS.has(f.layer?.id ?? ''));
        const feat = point ?? features[0];
        const layerId = feat.layer?.id ?? '';
        const props = (feat.properties ?? {}) as Record<string, unknown>;

        const existing = attachedHandlers.get(map);
        if (existing?.popup) existing.popup.remove();

        const popup = new mapboxgl.Popup({
            closeButton: false,
            maxWidth: '280px',
            offset: 8,
            className: 'enc-popup-mapbox',
        })
            .setLngLat(e.lngLat)
            .setHTML(buildFeaturePopupHtml(layerId, props))
            .addTo(map);

        if (existing) existing.popup = popup;

        const closeBtn = popup.getElement()?.querySelector<HTMLButtonElement>('.enc-popup-close');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => popup.remove());
        }
    };

    const onEnter = () => {
        map.getCanvas().style.cursor = 'pointer';
    };
    const onLeave = () => {
        map.getCanvas().style.cursor = '';
    };

    for (const id of ALL_LAYER_IDS) {
        map.on('click', id, onClick);
        map.on('mouseenter', id, onEnter);
        map.on('mouseleave', id, onLeave);
    }

    attachedHandlers.set(map, { click: onClick, enter: onEnter, leave: onLeave, popup: null });
    log.info('attached ENC feature click handlers');
}

/**
 * Tear down click handlers + any open popup. Used when the
 * useEncVectorLayer hook unmounts.
 */
export function detachEncFeatureClickHandlers(map: mapboxgl.Map): void {
    const h = attachedHandlers.get(map);
    if (!h) return;
    for (const id of ALL_LAYER_IDS) {
        map.off('click', id, h.click);
        map.off('mouseenter', id, h.enter);
        map.off('mouseleave', id, h.leave);
    }
    if (h.popup) h.popup.remove();
    attachedHandlers.delete(map);
    log.info('detached ENC feature click handlers');
}
