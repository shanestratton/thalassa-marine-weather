/**
 * MpaLayer — Australian Marine Protected Areas (CAPAD) overlay.
 *
 * Vanilla Mapbox GeoJSON source backed by a verified CAPAD-derived
 * GeoJSON object. The network URL is never handed to Mapbox: the client
 * first validates the schema-v2 manifest, bounded bytes, checksum,
 * feature schema, geometries and coordinate bounds.
 *
 * Why GeoJSON over PMTiles: Mapbox-GL v3 removed `addProtocol`, so the
 * normal MapLibre PMTiles bridge no longer works without writing a
 * Mapbox CustomSource adapter. CAPAD's full marine slice simplifies
 * to ~2 MB gzipped which is acceptable as a one-shot fetch when the
 * user first toggles MPA on. Future upgrade path: implement a
 * CustomSource that fetches MVT tiles from an edge-side PMTiles reader.
 *
 * Indicative protection-class colouring (matches pipeline classification):
 *   high          → red   — inferred high-protection metadata class
 *   conditional   → amber — inferred conditional-protection metadata class
 *   multiple_use  → blue  — inferred multiple-use metadata class
 *
 * Each polygon is fillable (low opacity so weather layers below stay
 * readable) and outlined (full opacity for a sharp boundary line).
 * Click handlers live in useMpaLayer — this module is responsible
 * only for source/style lifecycle.
 */

import mapboxgl from 'mapbox-gl';
import { createLogger } from '../../utils/createLogger';
import {
    fetchVerifiedMpaGeoJson,
    getVerifiedMpaDatasetStatus,
    type VerifiedMpaCollection,
} from '../../services/weather/api/mpaDataset';

const log = createLogger('MpaLayer');

export const MPA_SOURCE_ID = 'mpa-aus-source';
export const MPA_FILL_ID = 'mpa-aus-fill';
export const MPA_OUTLINE_ID = 'mpa-aus-outline';

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

export function buildMpaAttribution(sourceDate: string | undefined): string {
    const validatedDate = /^\d{4}-\d{2}-\d{2}/.exec(sourceDate ?? '')?.[0] ?? 'date unavailable';
    return (
        '<a href="https://www.dcceew.gov.au/environment/land/nrs/science/capad" target="_blank" rel="noopener noreferrer">' +
        `CAPAD data © Commonwealth of Australia (DCCEEW)</a> source ${validatedDate}, simplified and display-classified by Thalassa · ` +
        '<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">CC BY 4.0</a>'
    );
}

interface MpaArtifactState {
    source: boolean;
    fill: boolean;
    outline: boolean;
}

function readMpaArtifactState(map: mapboxgl.Map): MpaArtifactState {
    return {
        source: Boolean(map.getSource(MPA_SOURCE_ID)),
        fill: Boolean(map.getLayer(MPA_FILL_ID)),
        outline: Boolean(map.getLayer(MPA_OUTLINE_ID)),
    };
}

/** A replacement may mount only after all three owned artifacts are absent. */
export function isMpaLayerUnmounted(map: mapboxgl.Map): boolean {
    try {
        const state = readMpaArtifactState(map);
        return !state.source && !state.fill && !state.outline;
    } catch (error) {
        log.warn('Could not prove that the MPA presentation is unmounted', error);
        return false;
    }
}

/** Complete presentation invariant used before the hook claims a mount. */
export function isMpaLayerMounted(map: mapboxgl.Map): boolean {
    try {
        const state = readMpaArtifactState(map);
        return state.source && state.fill && state.outline;
    } catch (error) {
        log.warn('Could not prove that the MPA presentation is mounted', error);
        return false;
    }
}

export type MpaLayerDeactivation = 'absent' | 'hidden' | 'failed';

function isMpaArtifactSafelyHidden(map: mapboxgl.Map, layerId: string): boolean {
    const layer = map.getLayer(layerId);
    return !layer || map.getLayoutProperty(layerId, 'visibility') === 'none';
}

/**
 * Prefer complete removal. If Mapbox cannot remove during a style transition,
 * fail closed only after every surviving paint layer is proven visibility=none.
 * Hidden artifacts remain owned and are not eligible for replacement mounting.
 */
export function deactivateMpaLayerAndProveSafe(map: mapboxgl.Map): MpaLayerDeactivation {
    if (unmountMpaLayer(map)) return 'absent';
    try {
        for (const id of [MPA_FILL_ID, MPA_OUTLINE_ID]) {
            if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
        }
        if (isMpaLayerUnmounted(map)) return 'absent';
        if (isMpaArtifactSafelyHidden(map, MPA_FILL_ID) && isMpaArtifactSafelyHidden(map, MPA_OUTLINE_ID)) {
            return 'hidden';
        }
    } catch (error) {
        log.warn('Could not prove the MPA presentation hidden after teardown failure', error);
    }
    return 'failed';
}

export async function mountMpaLayer(
    map: mapboxgl.Map,
    opts: MpaMountOptions = {},
    alreadyVerifiedData?: VerifiedMpaCollection,
): Promise<boolean> {
    const fillOpacity = opts.fillOpacity ?? 0.28;
    const outlineOpacity = opts.outlineOpacity ?? 0.85;

    // This function owns a whole source+fill+outline generation. Reusing an
    // unexpected pre-existing source could silently label old geometry as a
    // freshly verified generation, so clean ownership is a hard precondition.
    if (!isMpaLayerUnmounted(map)) {
        log.warn('Refusing to mount MPA data over pre-existing owned artifacts');
        return false;
    }

    const verifiedData = alreadyVerifiedData ?? (await fetchVerifiedMpaGeoJson());
    if (!verifiedData) {
        log.warn('Verified MPA data unavailable; source remains off');
        return false;
    }

    // The optional fetch above yields to the event loop. Recheck the exact
    // ownership precondition in case a style reload installed an artifact.
    if (!isMpaLayerUnmounted(map)) {
        log.warn('Refusing to mount MPA data because ownership changed during verification');
        return false;
    }

    try {
        map.addSource(MPA_SOURCE_ID, {
            type: 'geojson',
            data: verifiedData,
            // Pre-build feature index so click queries are fast.
            generateId: true,
            attribution: buildMpaAttribution(getVerifiedMpaDatasetStatus()?.sourceDate),
        });
        log.info('Added GeoJSON source');

        const before = findInsertionAnchor(map);

        map.addLayer(
            {
                id: MPA_FILL_ID,
                type: 'fill',
                source: MPA_SOURCE_ID,
                paint: {
                    // Match the neutral indicative protection class.
                    'fill-color': [
                        'match',
                        ['get', 'protection_class'],
                        'high',
                        '#dc2626', // red-600
                        'conditional',
                        '#f59e0b', // amber-500
                        'multiple_use',
                        '#3b82f6', // blue-500
                        /* default */ '#6b7280', // gray-500
                    ],
                    'fill-opacity': fillOpacity,
                },
            },
            before,
        );
        log.info(`Added fill layer (before=${before ?? 'top'})`);

        map.addLayer(
            {
                id: MPA_OUTLINE_ID,
                type: 'line',
                source: MPA_SOURCE_ID,
                paint: {
                    'line-color': [
                        'match',
                        ['get', 'protection_class'],
                        'high',
                        '#b91c1c', // red-700
                        'conditional',
                        '#d97706', // amber-600
                        'multiple_use',
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
        log.info(`Added outline-solid layer (before=${before ?? 'top'})`);
    } catch (error) {
        log.warn('MPA mount failed; rolling back every owned artifact', error);
        deactivateMpaLayerAndProveSafe(map);
        return false;
    }

    if (!isMpaLayerMounted(map)) {
        log.warn('MPA mount postcondition failed; rolling back incomplete presentation');
        deactivateMpaLayerAndProveSafe(map);
        return false;
    }
    return true;
}

/**
 * Remove every owned artifact and prove the postcondition. A thrown removal
 * is failure even if a later query happens to report the artifact absent.
 */
export function unmountMpaLayer(map: mapboxgl.Map): boolean {
    let removalFailed = false;
    for (const id of [MPA_OUTLINE_ID, MPA_FILL_ID]) {
        try {
            if (map.getLayer(id)) map.removeLayer(id);
        } catch (error) {
            removalFailed = true;
            log.warn(`Failed to remove MPA layer ${id}`, error);
        }
    }
    try {
        if (map.getSource(MPA_SOURCE_ID)) map.removeSource(MPA_SOURCE_ID);
    } catch (error) {
        removalFailed = true;
        log.warn('Failed to remove MPA source', error);
    }

    const fullyRemoved = isMpaLayerUnmounted(map);
    if (removalFailed || !fullyRemoved) {
        log.warn('MPA teardown could not prove removal of source, fill and outline-solid');
        return false;
    }
    log.info('Unmounted MPA layers + source');
    return true;
}

export function setMpaOpacity(map: mapboxgl.Map, fillOpacity: number, outlineOpacity: number): void {
    if (map.getLayer(MPA_FILL_ID)) {
        map.setPaintProperty(MPA_FILL_ID, 'fill-opacity', fillOpacity);
    }
    if (map.getLayer(MPA_OUTLINE_ID)) {
        map.setPaintProperty(MPA_OUTLINE_ID, 'line-opacity', outlineOpacity);
    }
}
