/**
 * EncCoverageLayer — Mapbox vector overlay showing the bounding
 * boxes of every imported S-57 ENC cell.
 *
 * Visual purpose: when a user has imported ENC cells, the map gets
 * a subtle outline (and very faint fill) over each cell's coverage
 * area. Inside those areas the routing engine uses surveyed vector
 * data; outside, it falls back to GEBCO bathymetry. The overlay
 * tells the user which is which at a glance.
 *
 * Why bbox rectangles, not the actual coastline polygons:
 *   - Cells are typically a few hundred km on a side. Their bbox
 *     is a fine approximation for "we have data here."
 *   - Painting every DEPARE polygon would be 1k+ features per cell
 *     and overlap the existing chart-tile rendering. That's a v3
 *     job (full vector chart display); this is just the coverage
 *     hint.
 *
 * Colouring by CATZOC range (when available):
 *   - A1/A2 (1..2)   — emerald (high confidence)
 *   - B    (3)        — sky blue (good)
 *   - C/D/U (4..6)    — amber (low — verify visually)
 *   - no data         — gray
 *
 * Click handler: not implemented in v1. The cell metadata is
 * already shown in the EncCellManager UI; opening a popup here
 * would duplicate that.
 */

import mapboxgl from 'mapbox-gl';
import type { Feature, FeatureCollection } from 'geojson';

import { createLogger } from '../../utils/createLogger';
import { getCoverage } from '../../services/enc/EncHazardService';
import type { EncCatzoc, EncCell } from '../../services/enc/types';

const log = createLogger('EncCoverageLayer');

export const ENC_COVERAGE_SOURCE_ID = 'enc-coverage-source';
export const ENC_COVERAGE_FILL_ID = 'enc-coverage-fill';
export const ENC_COVERAGE_OUTLINE_ID = 'enc-coverage-outline';

/**
 * Map a CATZOC range to a confidence bucket used for colouring.
 */
function catzocBucket(range: [EncCatzoc, EncCatzoc] | null | undefined): 'high' | 'good' | 'low' | 'unknown' {
    if (!range) return 'unknown';
    const worst = range[1];
    if (worst <= 2) return 'high';
    if (worst === 3) return 'good';
    return 'low';
}

/**
 * Convert the imported-cell list into a FeatureCollection of bbox
 * rectangles tagged with CATZOC bucket + provenance attributes.
 */
function buildCoverageGeoJSON(cells: EncCell[]): FeatureCollection {
    const features: Feature[] = cells.map((cell) => {
        const [minLon, minLat, maxLon, maxLat] = cell.bbox;
        return {
            type: 'Feature',
            properties: {
                cellId: cell.id,
                sourceHO: cell.sourceHO,
                edition: cell.edition,
                hazardCount: cell.hazardCount,
                catzocBucket: catzocBucket(cell.catzocRange),
                catzocBest: cell.catzocRange?.[0] ?? null,
                catzocWorst: cell.catzocRange?.[1] ?? null,
            },
            geometry: {
                type: 'Polygon',
                // GeoJSON polygons need to be closed (first === last point).
                coordinates: [
                    [
                        [minLon, minLat],
                        [maxLon, minLat],
                        [maxLon, maxLat],
                        [minLon, maxLat],
                        [minLon, minLat],
                    ],
                ],
            },
        };
    });
    return { type: 'FeatureCollection', features };
}

/**
 * Find a sensible insertion anchor so the coverage overlay sits
 * above water/bathymetry but below text labels and route lines.
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

export interface EncCoverageMountOptions {
    /** Layer alpha 0–1 for the fill — keep low so basemap stays readable. */
    fillOpacity?: number;
    /** Outline alpha 0–1 — sharper. */
    outlineOpacity?: number;
}

/**
 * Mount or re-mount the coverage overlay. Idempotent — safe to
 * call repeatedly (rebuilds the source data so cells imported
 * since last mount appear).
 */
export function mountEncCoverageLayer(map: mapboxgl.Map, opts: EncCoverageMountOptions = {}): void {
    const fillOpacity = opts.fillOpacity ?? 0.06;
    const outlineOpacity = opts.outlineOpacity ?? 0.7;

    const cells = getCoverage();
    const data = buildCoverageGeoJSON(cells);

    const existing = map.getSource(ENC_COVERAGE_SOURCE_ID);
    if (existing && 'setData' in existing) {
        // Source exists — just update the data so newly imported
        // cells show up without tearing down the layer.
        (existing as mapboxgl.GeoJSONSource).setData(data);
        log.info(`updated coverage source: ${cells.length} cells`);
        return;
    }

    map.addSource(ENC_COVERAGE_SOURCE_ID, {
        type: 'geojson',
        data,
        generateId: true,
    });

    const before = findInsertionAnchor(map);

    if (!map.getLayer(ENC_COVERAGE_FILL_ID)) {
        map.addLayer(
            {
                id: ENC_COVERAGE_FILL_ID,
                type: 'fill',
                source: ENC_COVERAGE_SOURCE_ID,
                // Hide once the user is zoomed in enough that the
                // vector chart layer takes over (zoom 7+). The
                // dashed bbox is just an "overview" cue at low
                // zoom; at high zoom the actual chart is present.
                maxzoom: 7,
                paint: {
                    'fill-color': [
                        'match',
                        ['get', 'catzocBucket'],
                        'high',
                        '#10b981', // emerald-500
                        'good',
                        '#0ea5e9', // sky-500
                        'low',
                        '#f59e0b', // amber-500
                        /* unknown / default */ '#6b7280', // gray-500
                    ],
                    'fill-opacity': fillOpacity,
                },
            },
            before,
        );
    }

    if (!map.getLayer(ENC_COVERAGE_OUTLINE_ID)) {
        map.addLayer(
            {
                id: ENC_COVERAGE_OUTLINE_ID,
                type: 'line',
                source: ENC_COVERAGE_SOURCE_ID,
                maxzoom: 7,
                paint: {
                    'line-color': [
                        'match',
                        ['get', 'catzocBucket'],
                        'high',
                        '#059669', // emerald-600
                        'good',
                        '#0284c7', // sky-600
                        'low',
                        '#d97706', // amber-600
                        '#374151', // gray-700
                    ],
                    'line-opacity': outlineOpacity,
                    'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.6, 8, 1.0, 12, 1.6, 16, 2.4],
                    'line-dasharray': [3, 2],
                },
            },
            before,
        );
    }

    log.info(`mounted ENC coverage overlay: ${cells.length} cells`);
}

/**
 * Tear down the coverage overlay. Safe to call when nothing is
 * mounted.
 */
export function unmountEncCoverageLayer(map: mapboxgl.Map): void {
    for (const id of [ENC_COVERAGE_OUTLINE_ID, ENC_COVERAGE_FILL_ID]) {
        if (map.getLayer(id)) {
            try {
                map.removeLayer(id);
            } catch {
                /* best effort */
            }
        }
    }
    if (map.getSource(ENC_COVERAGE_SOURCE_ID)) {
        try {
            map.removeSource(ENC_COVERAGE_SOURCE_ID);
        } catch {
            /* best effort */
        }
    }
    log.info('unmounted ENC coverage overlay');
}
