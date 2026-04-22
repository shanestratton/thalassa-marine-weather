/**
 * MpaLayer — Australian Marine Protected Areas (CAPAD) overlay.
 *
 * Vanilla Mapbox GeoJSON source backed by a single CAPAD-derived
 * GeoJSON file served from our Vercel edge proxy.
 *
 * Why GeoJSON over PMTiles: Mapbox-GL v3 removed `addProtocol`, so the
 * normal MapLibre PMTiles bridge no longer works without writing a
 * Mapbox CustomSource adapter. CAPAD's full marine slice simplifies
 * to ~2 MB gzipped which is acceptable as a one-shot fetch when the
 * user first toggles MPA on. Future upgrade path: implement a
 * CustomSource that fetches MVT tiles from an edge-side PMTiles reader.
 *
 * Restriction colouring (matches pipeline classification):
 *   no_take  → red       — sanctuary / marine national park / IUCN Ia–II
 *   partial  → amber     — habitat protection / conservation / IUCN III–IV
 *   general  → blue      — multiple-use / IPA Sea Country / default
 *
 * Each polygon is fillable (low opacity so weather layers below stay
 * readable) and outlined (full opacity for a sharp boundary line).
 * Click handlers live in useMpaLayer — this module is responsible
 * only for source/style lifecycle.
 */

import mapboxgl from 'mapbox-gl';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('MpaLayer');

export const MPA_SOURCE_ID = 'mpa-aus-source';
export const MPA_FILL_ID = 'mpa-aus-fill';
export const MPA_OUTLINE_ID = 'mpa-aus-outline';

const GEOJSON_URL = '/api/mpa/mpa.geojson';

/**
 * Find the right "before" layer to insert MPA fills under so they
 * sit above land/water/bathymetry but below labels and roads. Falls
 * back to top-of-stack if no good anchor exists.
 */
function findInsertionAnchor(map: mapboxgl.Map): string | undefined {
    const style = map.getStyle();
    const layers = style?.layers ?? [];
    // Mapbox standard styles use these label/symbol layer ids — insert
    // before the first one we find so MPA polygons don't paint over
    // place names.
    const candidates = ['settlement-major-label', 'place-city', 'country-label', 'admin-0-boundary'];
    for (const id of candidates) {
        if (layers.some((l) => l.id === id)) return id;
    }
    // Otherwise insert before the first symbol layer (text/icon).
    const firstSymbol = layers.find((l) => l.type === 'symbol');
    return firstSymbol?.id;
}

export interface MpaMountOptions {
    /** Layer alpha 0–1 (paint on top of weather layers — keep low). */
    fillOpacity?: number;
    /** Outline alpha 0–1 (sharp boundary — keep high). */
    outlineOpacity?: number;
}

export function mountMpaLayer(map: mapboxgl.Map, opts: MpaMountOptions = {}): void {
    const fillOpacity = opts.fillOpacity ?? 0.28;
    const outlineOpacity = opts.outlineOpacity ?? 0.85;

    if (!map.getSource(MPA_SOURCE_ID)) {
        map.addSource(MPA_SOURCE_ID, {
            type: 'geojson',
            data: GEOJSON_URL,
            // Pre-build feature index so click queries are fast.
            generateId: true,
            attribution: '© Commonwealth of Australia (DCCEEW), CC BY 4.0',
        });
        log.info('Added GeoJSON source');
    }

    const before = findInsertionAnchor(map);

    if (!map.getLayer(MPA_FILL_ID)) {
        map.addLayer(
            {
                id: MPA_FILL_ID,
                type: 'fill',
                source: MPA_SOURCE_ID,
                paint: {
                    // Match restriction bucket → fill colour.
                    'fill-color': [
                        'match',
                        ['get', 'restriction'],
                        'no_take',
                        '#dc2626', // red-600
                        'partial',
                        '#f59e0b', // amber-500
                        'general',
                        '#3b82f6', // blue-500
                        /* default */ '#6b7280', // gray-500
                    ],
                    'fill-opacity': fillOpacity,
                },
            },
            before,
        );
        log.info(`Added fill layer (before=${before ?? 'top'})`);
    }

    if (!map.getLayer(MPA_OUTLINE_ID)) {
        map.addLayer(
            {
                id: MPA_OUTLINE_ID,
                type: 'line',
                source: MPA_SOURCE_ID,
                paint: {
                    'line-color': [
                        'match',
                        ['get', 'restriction'],
                        'no_take',
                        '#b91c1c', // red-700
                        'partial',
                        '#d97706', // amber-600
                        'general',
                        '#1d4ed8', // blue-700
                        /* default */ '#374151', // gray-700
                    ],
                    'line-opacity': outlineOpacity,
                    // Slightly thicker line at higher zooms so the
                    // boundary stays readable when the user zooms in.
                    'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.5, 8, 1.0, 12, 1.6, 16, 2.4],
                },
            },
            before,
        );
        log.info(`Added outline layer (before=${before ?? 'top'})`);
    }
}

export function unmountMpaLayer(map: mapboxgl.Map): void {
    for (const id of [MPA_OUTLINE_ID, MPA_FILL_ID]) {
        if (map.getLayer(id)) {
            try {
                map.removeLayer(id);
            } catch {
                /* best effort */
            }
        }
    }
    if (map.getSource(MPA_SOURCE_ID)) {
        try {
            map.removeSource(MPA_SOURCE_ID);
        } catch {
            /* best effort */
        }
    }
    log.info('Unmounted MPA layers + source');
}

export function setMpaOpacity(map: mapboxgl.Map, fillOpacity: number, outlineOpacity: number): void {
    if (map.getLayer(MPA_FILL_ID)) {
        map.setPaintProperty(MPA_FILL_ID, 'fill-opacity', fillOpacity);
    }
    if (map.getLayer(MPA_OUTLINE_ID)) {
        map.setPaintProperty(MPA_OUTLINE_ID, 'line-opacity', outlineOpacity);
    }
}
