import { useCallback, type MutableRefObject } from 'react';
import type mapboxgl from 'mapbox-gl';
import type { AtmosView } from '../../services/weather/api/atmosSession';
import { atmosPressureSymbols } from '../../services/weather/atmosPressure';
import { useOwnedGeoJsonOverlay, type OwnedGeoJsonOverlayOptions } from './useOwnedGeoJsonOverlay';

const LAYERS: OwnedGeoJsonOverlayOptions['layers'] = [
    {
        suffix: 'lines',
        specification: {
            type: 'line',
            filter: ['==', '$type', 'LineString'],
            paint: {
                'line-color': '#bae6fd',
                'line-width': ['case', ['get', 'isMajor'], 1.8, 0.8],
                'line-opacity': 0.8,
            },
        },
    },
    {
        suffix: 'labels',
        specification: {
            type: 'symbol',
            filter: ['all', ['==', '$type', 'LineString'], ['==', 'isDetail', false]],
            layout: { 'symbol-placement': 'line', 'text-field': ['get', 'label'], 'text-size': 11 },
            paint: { 'text-color': '#e0f2fe', 'text-halo-color': '#020617', 'text-halo-width': 1.5 },
        },
    },
    {
        suffix: 'centers',
        specification: {
            type: 'symbol',
            filter: ['==', '$type', 'Point'],
            layout: { 'text-field': ['get', 'label'], 'text-size': 17 },
            paint: { 'text-color': '#e0f2fe', 'text-halo-color': '#020617', 'text-halo-width': 2 },
        },
    },
];

/** Selected pressure only; ownership, ordering and retirement use the shared bounded vector owner. */
export function usePressureSymbolOverlay(
    mapRef: MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    enabled: boolean,
    view: AtmosView | null,
    credit: string,
) {
    const sourceCurrent = useCallback(() => !!view?.isCurrent(), [view]);
    const createData = useCallback((): GeoJSON.FeatureCollection => {
        if (!view) throw new Error('Pressure view absent');
        const symbols = atmosPressureSymbols(view);
        return { type: 'FeatureCollection', features: [...symbols.contours.features, ...symbols.centers.features] };
    }, [view]);
    return useOwnedGeoJsonOverlay(mapRef, mapReady, {
        namespace: 'atmos-pressure-symbols',
        label: 'Pressure contours',
        credit,
        enabled,
        owner: view,
        revision: view ? `${view.generation}:${view.runMs}:${view.validMs}` : '',
        sourceCurrent,
        createData,
        layers: LAYERS,
        maxFeatures: 6032,
        maxVertices: 120028,
    });
}
