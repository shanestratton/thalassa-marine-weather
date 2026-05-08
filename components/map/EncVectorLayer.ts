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

const log = createLogger('EncVectorLayer');

// ── Source IDs ─────────────────────────────────────────────────────

export const ENC_VEC_SRC = {
    LNDARE: 'enc-vec-lndare',
    DEPARE: 'enc-vec-depare',
    COALNE: 'enc-vec-coalne',
    POINTS: 'enc-vec-points', // OBSTRN + WRECKS + UWTROC merged
} as const;

export const ENC_VEC_LAYERS = {
    LNDARE: 'enc-vec-lndare-fill',
    DEPARE: 'enc-vec-depare-fill',
    COALNE: 'enc-vec-coalne-line',
    OBSTRN: 'enc-vec-obstrn-circle',
    WRECKS: 'enc-vec-wrecks-circle',
    UWTROC: 'enc-vec-uwtroc-circle',
} as const;

// All layer IDs, ordered bottom-to-top for correct stacking.
const ALL_LAYER_IDS = [
    ENC_VEC_LAYERS.DEPARE, // bottom
    ENC_VEC_LAYERS.LNDARE,
    ENC_VEC_LAYERS.COALNE,
    ENC_VEC_LAYERS.OBSTRN,
    ENC_VEC_LAYERS.WRECKS,
    ENC_VEC_LAYERS.UWTROC,
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
                    'fill-outline-color': '#a8956a',
                },
            },
            before,
        );
    }

    // ── COALNE (white coastline) ──────────────────────────────────
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
                    'line-color': '#ffffff',
                    'line-width': ['interpolate', ['linear'], ['zoom'], 7, 0.6, 11, 1.0, 15, 1.6],
                    'line-opacity': Math.min(1, opacity + 0.1),
                },
            },
            before,
        );
    }

    // ── Hazard points (filtered by `_kind` from one merged source) ─
    // OBSTRN, WRECKS, UWTROC are all magenta point hazards in IHO
    // styling. We use circle-stroke + circle-color to differentiate.
    const POINT_BASE_COLOR = '#d837a9'; // magenta
    if (!map.getLayer(ENC_VEC_LAYERS.OBSTRN)) {
        map.addLayer(
            {
                id: ENC_VEC_LAYERS.OBSTRN,
                type: 'circle',
                source: ENC_VEC_SRC.POINTS,
                minzoom: minZoom,
                filter: ['==', ['get', '_kind'], 'OBSTRN'],
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
                filter: ['==', ['get', '_kind'], 'WRECKS'],
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
                filter: ['==', ['get', '_kind'], 'UWTROC'],
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

    log.info(
        `mounted vector layers: ${data.cellCount} cells, ` +
            `${data.DEPARE.features.length} depare, ${data.LNDARE.features.length} lndare, ` +
            `${data.COALNE.features.length} coalne, ` +
            `${data.OBSTRN.features.length + data.WRECKS.features.length + data.UWTROC.features.length} points`,
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
