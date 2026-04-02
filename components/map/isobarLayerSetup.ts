/**
 * Isobar Mapbox Layer Setup — extracted from useWeatherLayers.
 *
 * Creates all the Mapbox sources + layers for the synoptic chart:
 * isobar contours, pressure center labels, wind barbs,
 * circulation arrows, and movement tracks.
 */
import mapboxgl from 'mapbox-gl';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('IsobarLayers');

/**
 * IDs of all isobar-related layers for hide/show toggling.
 */
export const ISOBAR_LAYER_IDS = [
    'isobar-lines',
    'isobar-labels',
    'isobar-center-labels',
    'movement-track-lines',
    'movement-track-labels',
    'pressure-heatmap-layer',
    'coastal-vignette',
] as const;

/**
 * Hide all isobar layers and restore land fill colors.
 */
export function hideIsobarLayers(
    map: mapboxgl.Map,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    savedLandColors: Map<string, any>,
) {
    for (const id of ISOBAR_LAYER_IDS) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
    }
    // Restore land fill colors
    for (const [layerId, color] of savedLandColors) {
        try {
            if (map.getLayer(layerId)) map.setPaintProperty(layerId, 'fill-color', color);
        } catch (_) {
            /* skip */
        }
    }
    // Restore land label opacity
    const style = map.getStyle();
    if (style?.layers) {
        for (const layer of style.layers) {
            if (layer.type === 'symbol' && !layer.id.match(/isobar|wind|barb|movement|circulation/i)) {
                try {
                    map.setPaintProperty(layer.id, 'text-opacity', 1.0);
                } catch (_) {
                    /* skip */
                }
            }
        }
    }
}

/**
 * Show all isobar layers and desaturate landmasses.
 */
export function showIsobarLayers(
    map: mapboxgl.Map,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    savedLandColors: Map<string, any>,
) {
    for (const id of ISOBAR_LAYER_IDS) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'visible');
    }
    // Desaturate landmasses to charcoal + ghost labels to 30%
    const style = map.getStyle();
    if (style?.layers) {
        for (const layer of style.layers) {
            if (
                layer.type === 'fill' &&
                layer.id.match(/land|building|park|landuse|landcover|background/i) &&
                !layer.id.match(/water|ocean|sea/i)
            ) {
                try {
                    if (!savedLandColors.has(layer.id)) {
                        const current = map.getPaintProperty(layer.id, 'fill-color');
                        if (current) savedLandColors.set(layer.id, current);
                    }
                    map.setPaintProperty(layer.id, 'fill-color', 'rgba(20, 20, 20, 0.35)');
                } catch (_) {
                    /* skip */
                }
            }
            if (layer.type === 'symbol' && !layer.id.match(/isobar|wind|barb|movement|circulation/i)) {
                try {
                    map.setPaintProperty(layer.id, 'text-opacity', 0.3);
                } catch (_) {
                    /* skip */
                }
            }
        }
    }
}

/**
 * Create a wind barb icon on a canvas and add it to the map.
 */
function createWindBarbIcon(map: mapboxgl.Map) {
    const barbCanvas = document.createElement('canvas');
    barbCanvas.width = 48;
    barbCanvas.height = 48;
    const ctx = barbCanvas.getContext('2d');
    if (ctx) {
        ctx.clearRect(0, 0, 48, 48);
        ctx.strokeStyle = '#e2e8f0';
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        const cx = 24,
            bottom = 40,
            top = 8;
        ctx.beginPath();
        ctx.moveTo(cx, bottom);
        ctx.lineTo(cx, top);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx, top + 2);
        ctx.lineTo(cx + 12, top - 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx, top + 8);
        ctx.lineTo(cx + 10, top + 4);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx, top + 14);
        ctx.lineTo(cx + 6, top + 12);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx, bottom, 3, 0, Math.PI * 2);
        ctx.fillStyle = '#e2e8f0';
        ctx.fill();
    }
    const barbImage = new Image(48, 48);
    barbImage.onload = () => {
        if (!map.hasImage('wind-barb-icon')) map.addImage('wind-barb-icon', barbImage, { sdf: false });
    };
    barbImage.src = barbCanvas.toDataURL();
}

/**
 * Create a circulation arrow icon on a canvas and add it to the map.
 */
function createCirculationArrowIcon(map: mapboxgl.Map) {
    const arrowCanvas = document.createElement('canvas');
    arrowCanvas.width = 32;
    arrowCanvas.height = 32;
    const actx = arrowCanvas.getContext('2d');
    if (actx) {
        actx.clearRect(0, 0, 32, 32);
        actx.strokeStyle = '#ffffff';
        actx.lineWidth = 3;
        actx.lineCap = 'round';
        actx.lineJoin = 'round';
        actx.beginPath();
        actx.moveTo(8, 22);
        actx.lineTo(16, 10);
        actx.lineTo(24, 22);
        actx.stroke();
        actx.beginPath();
        actx.moveTo(16, 10);
        actx.lineTo(16, 28);
        actx.stroke();
    }
    const arrowImg = new Image(32, 32);
    arrowImg.onload = () => {
        if (!map.hasImage('circulation-arrow')) map.addImage('circulation-arrow', arrowImg, { sdf: true });
    };
    arrowImg.src = arrowCanvas.toDataURL();
}

/**
 * Initialize all isobar-related Mapbox sources and layers.
 * Call this once when the pressure layer is first activated.
 */
export function initIsobarLayers(map: mapboxgl.Map) {
    if (map.getSource('isobar-contours')) return; // Already initialized

    // Contour lines
    map.addSource('isobar-contours', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
    });
    map.addSource('isobar-centers', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
    });

    map.addLayer({
        id: 'isobar-lines',
        type: 'line',
        source: 'isobar-contours',
        paint: {
            'line-color': 'rgba(255, 255, 255, 0.55)',
            'line-width': 1.2,
            'line-opacity': 0.9,
        },
    });

    map.addLayer({
        id: 'isobar-labels',
        type: 'symbol',
        source: 'isobar-contours',
        layout: {
            'symbol-placement': 'line',
            'text-field': ['get', 'label'],
            'text-size': 11,
            'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'],
            'symbol-spacing': 500,
            'text-keep-upright': true,
        },
        paint: {
            'text-color': '#e2e8f0',
            'text-halo-color': 'rgba(15, 23, 42, 0.7)',
            'text-halo-width': 1.5,
        },
    });

    map.addLayer({
        id: 'isobar-center-labels',
        type: 'symbol',
        source: 'isobar-centers',
        layout: {
            'text-field': ['get', 'label'],
            'text-size': 18,
            'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'],
            'text-allow-overlap': true,
            'text-letter-spacing': 0.05,
        },
        paint: {
            'text-color': ['match', ['get', 'type'], 'H', '#ff5252', 'L', '#4da6ff', '#e2e8f0'],
            'text-halo-color': 'rgba(10, 15, 30, 0.85)',
            'text-halo-width': 2.5,
        },
    });

    // Wind barbs
    map.addSource('wind-barbs', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    createWindBarbIcon(map);
    map.addLayer({
        id: 'wind-barb-layer',
        type: 'symbol',
        source: 'wind-barbs',
        layout: {
            'icon-image': 'wind-barb-icon',
            'icon-size': 0.7,
            'icon-rotate': ['get', 'rotation'],
            'icon-rotation-alignment': 'map',
            'icon-allow-overlap': true,
            'text-field': ['concat', ['get', 'label'], ' kt'],
            'text-size': 9,
            'text-offset': [0, 2.5],
            'text-anchor': 'top',
            'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
            'text-allow-overlap': false,
        },
        paint: {
            'icon-opacity': 0.8,
            'text-color': '#94a3b8',
            'text-halo-color': '#0f172a',
            'text-halo-width': 1,
        },
    });

    // Circulation arrows
    map.addSource('circulation-arrows', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
    });
    createCirculationArrowIcon(map);
    map.addLayer({
        id: 'circulation-arrow-layer',
        type: 'symbol',
        source: 'circulation-arrows',
        layout: {
            'icon-image': 'circulation-arrow',
            'icon-size': 0.6,
            'icon-rotate': ['get', 'rotation'],
            'icon-rotation-alignment': 'map',
            'icon-allow-overlap': true,
        },
        paint: { 'icon-color': ['get', 'color'], 'icon-opacity': 0.7 },
    });

    // Movement tracks
    map.addSource('movement-tracks', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
    });
    map.addLayer({
        id: 'movement-track-lines',
        type: 'line',
        source: 'movement-tracks',
        paint: {
            'line-color': ['get', 'color'],
            'line-width': 3,
            'line-opacity': 0.85,
            'line-dasharray': [3, 2],
        },
    });
    map.addLayer({
        id: 'movement-track-labels',
        type: 'symbol',
        source: 'movement-tracks',
        layout: {
            'symbol-placement': 'line',
            'text-field': ['get', 'label'],
            'text-size': 11,
            'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'],
            'symbol-spacing': 500,
            'text-anchor': 'center',
            'text-keep-upright': true,
        },
        paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0f172a', 'text-halo-width': 1.5 },
    });

    log.info('Initialized isobar layer stack');
}

/**
 * RainViewer dBZ → color ramp for Rainbow.ai forecast tiles.
 * Matches RainViewer scheme 4 exactly.
 */
export const RAINVIEWER_COLOR_RAMP: mapboxgl.Expression = [
    'interpolate',
    ['linear'],
    ['raster-value'],
    0.047,
    'rgba(0,0,0,0)',
    0.052,
    'rgba(0,72,120,0.8)',
    0.078,
    'rgba(0,120,180,0.8)',
    0.11,
    'rgba(0,150,210,0.8)',
    0.137,
    'rgba(56,190,230,0.85)',
    0.165,
    'rgba(130,220,235,0.85)',
    0.196,
    'rgba(250,235,0,0.9)',
    0.22,
    'rgba(250,210,0,0.9)',
    0.247,
    'rgba(250,180,0,0.9)',
    0.275,
    'rgba(250,120,0,0.95)',
    0.302,
    'rgba(200,0,0,0.95)',
    0.325,
    'rgba(143,0,0,1)',
];

/**
 * Navigation layer IDs that should always render above weather layers.
 */
export const NAV_LAYER_IDS = [
    'isochrone-fan-layer',
    'isochrone-time-labels',
    'comfort-zone-layer',
    'route-glow',
    'route-line-layer',
    'route-harbour-dash',
    'route-core',
    'waypoint-circles',
    'waypoint-labels',
] as const;

/**
 * Promote navigation layers above all weather layers.
 */
export function promoteNavLayers(map: mapboxgl.Map) {
    for (const id of NAV_LAYER_IDS) {
        try {
            if (map.getLayer(id)) map.moveLayer(id);
        } catch (_) {
            /* layer not present — skip */
        }
    }
}
