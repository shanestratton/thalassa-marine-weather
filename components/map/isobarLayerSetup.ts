/**
 * Isobar Mapbox Layer Setup — extracted from useWeatherLayers.
 *
 * Creates all the Mapbox sources + layers for the synoptic chart:
 * isobar contours, pressure center labels, wind barbs,
 * circulation arrows, and (intentionally hidden) movement tracks.
 */
import mapboxgl from 'mapbox-gl';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('IsobarLayers');

/**
 * IDs of all isobar-related layers for hide/show toggling.
 */
export const ISOBAR_LAYER_IDS = [
    'isobar-shadow',
    'isobar-lines',
    'isobar-major-lines',
    'isobar-labels',
    'isobar-center-labels',
    'wind-barb-layer',
    'circulation-arrow-layer',
    'pressure-heatmap-layer',
    'coastal-vignette',
] as const;

/**
 * The parts of the pressure chart that only belong to the STANDALONE synoptic
 * view. When isobars ride on top of another layer (wind, rain…) these stay
 * hidden: the pressure heatmap would fight the wind ramp for the same pixels,
 * the barbs duplicate the particle field, and the vignette/land treatment is
 * a full-chart look, not an overlay's.
 */
export const SYNOPTIC_ONLY_LAYER_IDS = [
    'wind-barb-layer',
    'circulation-arrow-layer',
    'pressure-heatmap-layer',
    'coastal-vignette',
] as const;

/**
 * Movement estimates are not an operational forecast product, so retain the
 * data source for future opt-in use but never surface these layers with the
 * normal pressure chart.
 */
const MOVEMENT_TRACK_LAYER_IDS = ['movement-track-lines', 'movement-track-labels'] as const;

function hideMovementTrackLayers(map: mapboxgl.Map) {
    for (const id of MOVEMENT_TRACK_LAYER_IDS) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
    }
}

/**
 * Undo the synoptic chart's basemap treatment: restore land fills and label
 * opacity. Shared by full teardown (hideIsobarLayers) and by the overlay
 * presentation, which keeps the contours but must hand the basemap back.
 */
function restoreBasemapTreatment(
    map: mapboxgl.Map,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    savedLandColors: Map<string, any>,
) {
    // Restore land fill colors
    for (const [layerId, color] of savedLandColors) {
        try {
            if (map.getLayer(layerId)) map.setPaintProperty(layerId, 'fill-color', color);
        } catch (_) {
            /* skip */
        }
    }
    // Restore land label opacity — guarded because getStyle() throws
    // "Style is not done loading" when called before style load completes;
    // the effect will re-fire once it's ready.
    if (!map.isStyleLoaded()) return;
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
    hideMovementTrackLayers(map);
    restoreBasemapTreatment(map, savedLandColors);
}

/**
 * Show the isobar layers in one of two presentations:
 *
 *  - `overlay = false` (standalone synoptic chart): every layer including the
 *    pressure heatmap, wind barbs and circulation arrows; landmasses
 *    desaturated to charcoal and basemap labels ghosted so the field reads
 *    like a proper surface analysis.
 *  - `overlay = true` (isobars riding another layer, e.g. wind): ONLY the
 *    contour lines, inline labels and H/L centres. The basemap keeps its
 *    normal treatment — the host layer owns the look of the chart.
 */
export function showIsobarLayers(
    map: mapboxgl.Map,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    savedLandColors: Map<string, any>,
    overlay = false,
) {
    const synopticOnly = new Set<string>(SYNOPTIC_ONLY_LAYER_IDS);
    for (const id of ISOBAR_LAYER_IDS) {
        if (!map.getLayer(id)) continue;
        const visible = overlay && synopticOnly.has(id) ? 'none' : 'visible';
        map.setLayoutProperty(id, 'visibility', visible);
    }
    // These remain hidden even while the rest of the pressure chart is shown.
    hideMovementTrackLayers(map);

    if (overlay) {
        // A previous standalone activation may have left the charcoal land —
        // hand the basemap back before the host layer paints over it.
        restoreBasemapTreatment(map, savedLandColors);
        return;
    }

    // Desaturate landmasses to charcoal + ghost labels to 30% — guarded
    // because getStyle() throws before style load completes.
    if (!map.isStyleLoaded()) return;
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
        actx.lineWidth = 2;
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
 * H/L centre badges: a soft radial glow in the centre's hue around a dark
 * glass disc with a thin ring. Drawn at 2× and registered with pixelRatio 2
 * so the disc renders 48pt on screen and stays crisp on retina.
 *
 * Windy marks its centres with bare letters that vanish over a busy field;
 * the disc guarantees contrast over every background this app has — white ENC
 * water, near-black satellite, and the full wind ramp in between.
 */
function createPressureCenterBadge(map: mapboxgl.Map, name: string, r: number, g: number, b: number) {
    if (map.hasImage(name)) return;
    const size = 96;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const c = size / 2;

    // Outer glow — fades to nothing at the badge edge.
    const glow = ctx.createRadialGradient(c, c, 10, c, c, c);
    glow.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.34)`);
    glow.addColorStop(0.55, `rgba(${r}, ${g}, ${b}, 0.12)`);
    glow.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, size, size);

    // Glass disc.
    ctx.beginPath();
    ctx.arc(c, c, 34, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(8, 16, 30, 0.62)';
    ctx.fill();

    // Ring.
    ctx.beginPath();
    ctx.arc(c, c, 34, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.85)`;
    ctx.lineWidth = 2.5;
    ctx.stroke();

    const data = ctx.getImageData(0, 0, size, size);
    map.addImage(name, { width: size, height: size, data: new Uint8Array(data.data.buffer) }, { pixelRatio: 2 });
}

function createPressureCenterBadges(map: mapboxgl.Map) {
    // Hues match the H/L letter colours below (coral high, ice-blue low).
    createPressureCenterBadge(map, 'pressure-badge-h', 240, 150, 128);
    createPressureCenterBadge(map, 'pressure-badge-l', 138, 200, 240);
}

/**
 * Initialize all isobar-related Mapbox sources and layers.
 * Call this once when the pressure layer is first activated.
 */
export function initIsobarLayers(map: mapboxgl.Map) {
    if (map.getSource('isobar-contours')) {
        // A hot-reloaded map can retain an older visible track layer.
        hideMovementTrackLayers(map);
        return;
    }

    // Contour lines
    map.addSource('isobar-contours', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
    });
    map.addSource('isobar-centers', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
    });

    // A dark blurred under-stroke beneath EVERY contour. This is what keeps
    // the bright lines legible when they ride the wind heatmap: over the
    // yellow/green mid-range of the wind ramp a bare white line washes out
    // (Windy's does exactly that), while a shadowed one stays crisp on every
    // background from white ENC water to near-black satellite.
    map.addLayer({
        id: 'isobar-shadow',
        type: 'line',
        source: 'isobar-contours',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
            'line-color': 'rgba(3, 9, 20, 0.42)',
            'line-blur': 2,
            'line-width': [
                'interpolate',
                ['linear'],
                ['zoom'],
                2,
                ['case', ['get', 'isMajor'], 2.6, 1.9],
                5,
                ['case', ['get', 'isMajor'], 3.6, 2.6],
                8,
                ['case', ['get', 'isMajor'], 4.6, 3.4],
            ],
        },
    });

    map.addLayer({
        id: 'isobar-lines',
        type: 'line',
        source: 'isobar-contours',
        filter: ['==', ['get', 'isMajor'], false],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
            // 4 hPa detail remains visible, but yields to the 8 hPa rhythm.
            'line-color': 'rgba(222, 236, 248, 0.68)',
            'line-width': ['interpolate', ['linear'], ['zoom'], 2, 0.8, 5, 1.05, 8, 1.4],
            'line-opacity': 0.9,
        },
    });

    map.addLayer({
        id: 'isobar-major-lines',
        type: 'line',
        source: 'isobar-contours',
        filter: ['==', ['get', 'isMajor'], true],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
            // Major contours are deliberately brighter rather than wider by
            // much, keeping the synoptic chart confident but not garish.
            'line-color': 'rgba(252, 254, 255, 0.96)',
            'line-width': ['interpolate', ['linear'], ['zoom'], 2, 1.5, 5, 1.9, 8, 2.4],
            'line-opacity': 0.98,
        },
    });

    map.addLayer({
        id: 'isobar-labels',
        type: 'symbol',
        source: 'isobar-contours',
        filter: ['==', ['get', 'isMajor'], true],
        layout: {
            'symbol-placement': 'line',
            'text-field': ['get', 'label'],
            'text-size': ['interpolate', ['linear'], ['zoom'], 2, 10.5, 6, 12.5],
            'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'],
            'text-letter-spacing': 0.04,
            'symbol-spacing': 440,
            // Reject placements on tight bends so the value always sits on a
            // calm stretch of the line instead of kinking around a trough.
            'text-max-angle': 30,
            'text-keep-upright': true,
        },
        paint: {
            'text-color': '#f2f7fc',
            'text-halo-color': 'rgba(6, 14, 28, 0.88)',
            'text-halo-width': 2.1,
        },
    });

    createPressureCenterBadges(map);
    map.addLayer({
        id: 'isobar-center-labels',
        type: 'symbol',
        source: 'isobar-centers',
        layout: {
            'icon-image': ['match', ['get', 'type'], 'H', 'pressure-badge-h', 'pressure-badge-l'],
            'icon-allow-overlap': true,
            // Two-scale stack inside the badge: the big letter carries the
            // paint colour below; the hPa value beneath it overrides to a
            // quiet neutral so the number informs without shouting.
            'text-field': [
                'format',
                ['get', 'type'],
                { 'font-scale': 1.25 },
                '\n',
                {},
                ['to-string', ['get', 'pressure']],
                { 'font-scale': 0.62, 'text-color': '#d9e5f2' },
            ],
            'text-size': 15,
            'text-line-height': 1.15,
            'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'],
            // Centres are deliberately capped at three highs and lows, so
            // they should win over a nearby ordinary contour label.
            'text-allow-overlap': true,
            'text-letter-spacing': 0.05,
            'text-padding': 4,
        },
        paint: {
            'text-color': ['match', ['get', 'type'], 'H', '#ffc0a9', 'L', '#a9dcff', '#dce6ef'],
            // The disc supplies the contrast now — keep only a whisper of halo
            // for the pixels that overhang it.
            'text-halo-color': 'rgba(6, 12, 26, 0.55)',
            'text-halo-width': 1.1,
            'text-opacity': 0.98,
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
            'icon-size': 0.42,
            'icon-rotate': ['get', 'rotation'],
            'icon-rotation-alignment': 'map',
            'icon-allow-overlap': false,
            'icon-padding': 2,
        },
        paint: { 'icon-color': '#d8e1ea', 'icon-opacity': 0.44 },
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
        layout: { visibility: 'none' },
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
            visibility: 'none',
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
 * RainViewer dBZ → colour ramp for Rainbow.ai forecast tiles.
 *
 * THE SHARED COLOUR LANGUAGE. Rainbow serves the forecast half as grayscale
 * dbz_u8 tiles, which this ramp paints; RainViewer bakes the observed half
 * server-side at RAINVIEWER_COLOR_SCHEME. Those two must describe the same
 * palette family — scheme 4, the Weather Channel ramp — or the chart shows
 * two colour maps for one physical quantity and the legend (which mirrors
 * THIS ramp) describes colours the radar never shows. That was the state
 * until 2026-08-21, when the observed tiles were baked at scheme 2.
 *
 * If you change this ramp, change RAINVIEWER_COLOR_SCHEME and the LegendDock
 * rain gradient with it. RainRadarPalette.test.ts fails if they drift.
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
 * Squall-specific dBZ → color ramp.
 *
 * The rain layer's RAINVIEWER ramp shows ALL precipitation from drizzle
 * upward. A squall view is the opposite — we want light/moderate rain
 * to vanish entirely so only the actual heavy convective cells (the
 * "where can I get hammered right now" cells) are visible.
 *
 * Threshold: pixel values below ~0.196 (corresponding to ~moderate rain
 * intensity in the dbz_u8 encoding) render fully transparent. Above
 * that we ramp aggressively through yellow → orange → red → magenta so
 * a serious cell pops off the chart even at small zoom.
 */
export const SQUALL_COLOR_RAMP: mapboxgl.Expression = [
    'interpolate',
    ['linear'],
    ['raster-value'],
    0.0, // pure no-data
    'rgba(0,0,0,0)',
    0.18, // anything below moderate-heavy = invisible
    'rgba(0,0,0,0)',
    0.196, // moderate-heavy threshold — squall begins here
    'rgba(255,235,59,0.55)', // soft yellow — possible squall
    0.235, // strong cell
    'rgba(255,150,0,0.8)', // orange
    0.275, // severe
    'rgba(229,28,35,0.9)', // red
    0.31, // extreme — hail-grade
    'rgba(170,0,180,0.95)', // magenta
    0.35,
    'rgba(120,0,160,1)', // deep magenta clamp
];

/**
 * Navigation layer IDs that should always render above weather layers.
 */
export const NAV_LAYER_IDS = [
    'isochrone-fan-layer',
    'isochrone-time-labels',
    'comfort-zone-layer',
    'comfort-zone-layer_r',
    'route-glow',
    'route-line-layer',
    'route-harbour-dash',
    'route-core',
    'waypoint-circles',
    'waypoint-labels',
    // ── The TRACER's own render (MapHub coordCaptureMode) ──
    // These were missing, and the omission was invisible because the ids look
    // like the passage planner's. They are not: `route-*` belongs to
    // usePassagePlanner, `trace-*` to the tracer, and the tracer adds every one
    // of them with NO beforeId — so they sit wherever the top of the style
    // happened to be at creation. Any weather raster added afterwards went
    // straight over the route line (the `sea` tiles run at raster-opacity 1.0,
    // which hides it completely), while the waypoint PINS stayed visible because
    // they are DOM markers on their own effect and live above the canvas
    // entirely. That asymmetry is the whole "waypoints but no line between them"
    // symptom (Shane 2026-07-22, again 2026-07-23).
    //
    // Order matters: moveLayer with no beforeId moves to the TOP, so the last id
    // listed ends up highest. Glow under core under arrows.
    'trace-ghost-line',
    'trace-dest-hint-line',
    'trace-line-glow',
    'trace-line-core',
    'trace-line-arrows',
    'trace-issues-icons',
    // ── Armed anchor watch (useAnchorSwingLayer) ── added with no beforeId
    // like the tracer layers, so they need the same promote treatment or a
    // weather raster/late ENC mount paints straight over the guard ring.
    // Listed LAST: an armed anchor ring outranks everything else on the water.
    'anchor-swing-fill',
    'anchor-swing-line',
    'anchor-swing-point',
] as const;

/**
 * The TRACER's own layers, bottom-first (moveLayer with no beforeId moves to
 * the top, so the last id listed ends up highest).
 */
export const TRACE_LAYER_IDS = [
    'trace-ghost-line',
    'trace-dest-hint-line',
    'trace-line-glow',
    'trace-line-core',
    'trace-line-arrows',
    'trace-issues-icons',
] as const;

/**
 * Lift the tracer's render to the top of the style.
 *
 * SEPARATE FROM promoteNavLayers ON PURPOSE. That one is only ever called from
 * the weather effect, which early-returns on `activeLayers.size === 0` BEFORE
 * reaching it — so the moment no weather layer is up (which is every moment on
 * the plan page) nothing maintains z-order at all, and the trace line sits
 * wherever it was appended, under any ENC/imagery layer added later. The tracer
 * has to own its own ordering rather than borrow it from a weather code path.
 *
 * Returns the ids left above `trace-line-core`, so the caller can tell the
 * difference between "promoted, still buried" and "never promoted".
 */
export function promoteTraceLayers(map: mapboxgl.Map): string[] {
    for (const id of TRACE_LAYER_IDS) {
        try {
            if (map.getLayer(id)) map.moveLayer(id);
        } catch (_) {
            /* layer not present — skip */
        }
    }
    try {
        const order = map.getStyle().layers.map((l) => l.id);
        const coreAt = order.indexOf('trace-line-core');
        if (coreAt < 0) return [];
        const trace = new Set<string>(TRACE_LAYER_IDS);
        return order.slice(coreAt + 1).filter((id) => !trace.has(id));
    } catch (_) {
        return [];
    }
}

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
