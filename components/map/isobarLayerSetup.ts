/**
 * Isobar Mapbox Layer Setup — extracted from useWeatherLayers.
 *
 * Creates all the Mapbox sources + layers for the synoptic chart:
 * isobar contours, pressure center labels, wind barbs,
 * circulation arrows, and (intentionally hidden) movement tracks.
 */
import mapboxgl from 'mapbox-gl';
import { createLogger } from '../../utils/createLogger';
import { isBasePlaceLabelLayer, setOpacityKeepingOwnshipFade } from './ownshipLabelFade';

const log = createLogger('IsobarLayers');

// ── Base town names under the standalone chart: ghosted by ink, not opacity ──
//
// The synoptic chart ghosts basemap labels to 30%. For the base style's town
// and suburb layers it must not do that through text-opacity: useVesselTracker
// arms their opacity with the own-ship fade (a feature-state switch), and in
// mapbox-gl 3.19 any paint change to or from a data-driven value re-parses the
// whole `composite` source and drops its tile cache (StyleLayer.setPaintProperty
// returns requiresRelayout, Style._updateLayer reloads the source). Writing
// fade(0.3) and back to fade(1) cost two full base reloads per pressure or
// weather toggle. So their opacity is only ever written through the own-ship
// helper, at 1 (a no-op once it is there), and the ghost goes into their text
// and halo colours instead: constant to constant, a repaint and nothing else.
// The colours they had are kept here and written back exactly when the chart
// hands the basemap back.
//
// A layer whose colours are not plain constants, or whose text-field can
// override text-color per section (then even a constant colour write relayouts,
// SymbolStyleLayer.hasPaintOverride), is left drawn at full strength rather
// than cost a reload. dark-v11's settlement layers are neither, once useMapInit
// has inked them '#ffffff' on 'rgba(0, 0, 0, 0.9)'.

/** How strongly the standalone chart ghosts basemap labels. */
const LABEL_GHOST_OPACITY = 0.3;

interface PlaceLabelInk {
    color: string | undefined;
    halo: string | undefined;
}

/** Per map: the base town-name layers ghosted by ink, and the colours to put back. */
const savedPlaceLabelInk = new WeakMap<object, Map<string, PlaceLabelInk>>();

const clampUnit = (v: number) => Math.min(1, Math.max(0, v));

function hslToRgb(hue: number, s: number, l: number): [number, number, number] {
    const h = (((hue % 360) + 360) % 360) / 360;
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const channel = (t: number) => {
        const x = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
        if (x < 1 / 6) return p + (q - p) * 6 * x;
        if (x < 1 / 2) return q;
        if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
        return p;
    };
    return [channel(h + 1 / 3) * 255, channel(h) * 255, channel(h - 1 / 3) * 255];
}

/** A plain CSS colour as [r, g, b, a] (0-255, alpha 0-1); null for anything else. */
function parsePlainColor(value: string): [number, number, number, number] | null {
    const s = value.trim().toLowerCase();
    if (s === 'transparent') return [0, 0, 0, 0];
    if (s === 'white') return [255, 255, 255, 1];
    if (s === 'black') return [0, 0, 0, 1];
    const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
    if (hex) {
        const h = hex[1].length <= 4 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
        const byte = (i: number) => parseInt(h.slice(i, i + 2), 16);
        return [byte(0), byte(2), byte(4), h.length === 8 ? byte(6) / 255 : 1];
    }
    const fn = /^(rgba?|hsla?)\(([^()]*)\)$/.exec(s);
    if (!fn) return null;
    const parts = fn[2].split(/[\s,/]+/).filter(Boolean);
    if (parts.length !== 3 && parts.length !== 4) return null;
    const num = (part: string, percentOf: number) => {
        const v = Number(part.endsWith('%') ? part.slice(0, -1) : part);
        return part.endsWith('%') ? (v / 100) * percentOf : v;
    };
    const alpha = parts.length === 4 ? clampUnit(num(parts[3], 1)) : 1;
    let rgb: number[];
    if (fn[1].startsWith('rgb')) {
        rgb = parts.slice(0, 3).map((part) => Math.min(255, Math.max(0, num(part, 255))));
    } else {
        if (!parts[1].endsWith('%') || !parts[2].endsWith('%')) return null;
        rgb = hslToRgb(Number(parts[0].replace(/deg$/, '')), clampUnit(num(parts[1], 1)), clampUnit(num(parts[2], 1)));
    }
    if (![...rgb, alpha].every(Number.isFinite)) return null;
    return [rgb[0], rgb[1], rgb[2], alpha];
}

/** `value` (or the spec default when unset) with its alpha scaled; null when it is not a plain colour. */
function ghostInk(value: unknown, specDefault: string): string | null {
    if (value !== undefined && typeof value !== 'string') return null;
    const rgba = parsePlainColor(value ?? specDefault);
    if (!rgba) return null;
    const [r, g, b, a] = rgba;
    const alpha = Math.round(a * LABEL_GHOST_OPACITY * 1000) / 1000;
    return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${alpha})`;
}

/**
 * Ghost one base town-name layer by its ink (see above). Idempotent: the
 * colours are saved once and the ghost is always computed from them, so every
 * later pass writes the same constants, which mapbox drops as unchanged.
 */
function ghostPlaceLabelInk(map: mapboxgl.Map, layerId: string): void {
    let saved = savedPlaceLabelInk.get(map);
    const ink: PlaceLabelInk = saved?.get(layerId) ?? {
        color: map.getPaintProperty(layerId, 'text-color') as string | undefined,
        halo: map.getPaintProperty(layerId, 'text-halo-color') as string | undefined,
    };
    const field =
        typeof map.getLayoutProperty === 'function' ? map.getLayoutProperty(layerId, 'text-field') : undefined;
    const color = JSON.stringify(field ?? null).includes('"text-color"') ? null : ghostInk(ink.color, '#000000');
    const halo = ghostInk(ink.halo, 'rgba(0, 0, 0, 0)');
    if (color === null || halo === null) return; // left drawn: never a relayout
    if (!saved) savedPlaceLabelInk.set(map, (saved = new Map()));
    saved.set(layerId, ink);
    map.setPaintProperty(layerId, 'text-color', color);
    map.setPaintProperty(layerId, 'text-halo-color', halo);
}

/** Put back the colours ghostPlaceLabelInk saved. Needs no style walk, so it never waits for tiles. */
function restorePlaceLabelInk(map: mapboxgl.Map): void {
    const saved = savedPlaceLabelInk.get(map);
    if (!saved) return;
    for (const [layerId, ink] of saved) {
        try {
            if (map.getLayer(layerId)) {
                map.setPaintProperty(layerId, 'text-color', ink.color as string);
                map.setPaintProperty(layerId, 'text-halo-color', ink.halo as string);
            }
            saved.delete(layerId);
        } catch (_) {
            /* style mid-swap: the next pass puts it back */
        }
    }
}

// ── Everything else the standalone chart changes: recorded, put back exactly ──
//
// The chart turns land fills charcoal and ghosts every other label layer to
// 30% by its text-opacity. Each value it replaces is recorded, unset included
// (land fills in the caller's savedLandColors, label opacity per map below),
// and handing the basemap back writes exactly those and nothing else. It never
// flattens the app's own opacities to 1 (ENC labels and soundings 0.85, the
// ENC layer at 0.75, buoyage arrows 0.58, caution mounts 0.9, the base style's
// state and continent labels), and it writes nothing at all on the weather
// passes where no ghost is recorded. A layer that no longer shows the ghost
// (removed, re-added or rewritten by its owner since) is left as it is. A
// value that reads feature data is never ghosted: a write to or from it
// re-parses its whole source (StyleLayer.setPaintProperty).
//
// Neither side waits for map.isStyleLoaded(). In mapbox-gl 3.19 that is false
// for a frame after any visibility write or addLayer (Style._updateLayer
// queues a source reload) and while any tile is loading, which is exactly when
// the pressure toggle runs its visibility writes; nothing re-runs the weather
// effect while pressure stays on, so the ghost never landed, and after
// pressure off the labels stayed at 30%. The ghost needs only the style JSON
// (getStyle throws until that is in), and the restore needs no style walk.
//
// For the same reason, a label layer mounted after the toggle pass (the ENC
// stack on the first zoom into chart cover, AIS or waypoint names) would draw
// at full strength over the charcoal chart. So while the standalone chart is
// up, a coalesced styledata watch ghosts each layer that was not in the style
// on the previous walk, once (see "Layers that mount while the chart is up").

/** The charcoal the standalone chart paints land fills. */
const LAND_GHOST_FILL = 'rgba(20, 20, 20, 0.35)';

/** Per map: the text-opacity each ghosted label layer had (undefined when unset). */
const savedLabelOpacity = new WeakMap<object, Map<string, unknown>>();

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const FEATURE_DATA_OPERATOR =
    /"(?:get|has|properties|feature-state|id|geometry-type|accumulated|line-progress|heatmap-density)"/;

/** A paint value that reads feature data: a write to or from it re-parses the layer's source. */
function readsFeatureData(value: unknown): boolean {
    if (value === null || typeof value !== 'object') return false;
    if (!Array.isArray(value)) return 'property' in value; // legacy function: {property} is data, {stops} is zoom
    return FEATURE_DATA_OPERATOR.test(JSON.stringify(value));
}

/**
 * Write the ghost `value` to one paint property, recording what it replaces.
 * Idempotent: a layer still showing the ghost keeps its record and is not
 * written again. A layer that shows anything else (the first pass, or its
 * owner re-added or rewrote it since) is recorded afresh.
 */
function ghostPaint(
    map: mapboxgl.Map,
    saved: Map<string, unknown>,
    layerId: string,
    property: 'fill-color' | 'text-opacity',
    value: string | number,
): void {
    const current = map.getPaintProperty(layerId, property);
    if (saved.has(layerId) && sameValue(current, value)) return;
    if (readsFeatureData(current)) {
        saved.delete(layerId); // left drawn: never a re-parse
        return;
    }
    saved.set(layerId, current);
    map.setPaintProperty(layerId, property, value);
}

/**
 * Put back what ghostPaint recorded, where the ghost is still what is drawn,
 * and forget it. Needs no style walk, so it never waits for tiles.
 */
function restorePaint(
    map: mapboxgl.Map,
    saved: Map<string, unknown>,
    property: 'fill-color' | 'text-opacity',
    ghost: string | number,
): void {
    for (const [layerId, original] of saved) {
        try {
            if (map.getLayer(layerId) && sameValue(map.getPaintProperty(layerId, property), ghost)) {
                // undefined goes back to the spec default (mapbox's null path).
                map.setPaintProperty(layerId, property, original as string);
            }
            saved.delete(layerId);
        } catch (_) {
            /* style mid-swap: the record stays and the next pass puts it back */
        }
    }
}

const isGhostedLandFill = (layer: { id: string; type?: string }) =>
    layer.type === 'fill' &&
    /land|building|park|landuse|landcover|background/i.test(layer.id) &&
    !/water|ocean|sea/i.test(layer.id);

const isGhostedLabel = (layer: { id: string; type?: string }) =>
    layer.type === 'symbol' && !/isobar|wind|barb|movement|circulation/i.test(layer.id);

// ── Coastal vignette: switched by its opacity, never its visibility ──
//
// useWeatherLayers adds it once, on the first standalone chart, as a line
// layer on the base `composite` source at line-opacity 0.6. Every visibility
// write on it would re-parse every loaded base tile (Style._updateLayer
// reloads the layer's source), so it stays added and only its constant
// line-opacity changes: a repaint.
//
// At 0 mapbox skips drawing it (drawLine returns early), but the trade has a
// cost, on record here: the worker still builds its line bucket and uploads
// it for every base tile parsed from then on (WorkerTile.parse skips a layer
// for its zoom range or visibility 'none', never for its opacity). So after
// the first standalone chart, every new base tile carries the water outlines
// as a 6 px line bucket for the rest of the session, pressure on or off, in
// exchange for no re-parse of every loaded base tile on each pressure toggle.
// If that bucket ever shows on a device, the fix belongs to the caller
// (useWeatherLayers): remove the layer when the chart goes (Style.removeLayer
// queues no source reload in 3.19, so only the re-add on each solo chart
// re-parses the base), or draw the glow from a source of its own.

/** The coastal glow's layer id (added by useWeatherLayers). */
const COASTAL_VIGNETTE_LAYER_ID = 'coastal-vignette';

/** The glow's line-opacity on the standalone chart; 0 anywhere else. */
const COASTAL_VIGNETTE_OPACITY = 0.6;

function setCoastalVignette(map: mapboxgl.Map, on: boolean): void {
    if (!map.getLayer(COASTAL_VIGNETTE_LAYER_ID)) return;
    const opacity = on ? COASTAL_VIGNETTE_OPACITY : 0;
    try {
        if (sameValue(map.getPaintProperty(COASTAL_VIGNETTE_LAYER_ID, 'line-opacity'), opacity)) return;
        map.setPaintProperty(COASTAL_VIGNETTE_LAYER_ID, 'line-opacity', opacity);
    } catch (_) {
        /* style mid-swap: the next pass sets it */
    }
}

/**
 * IDs of all isobar-related layers for hide/show toggling. The coastal
 * vignette is not one of them: it is switched by opacity (see above).
 */
export const ISOBAR_LAYER_IDS = [
    'isobar-shadow',
    'isobar-lines',
    'isobar-detail-lines',
    'isobar-detail-labels',
    'isobar-major-lines',
    'isobar-labels',
    'isobar-center-labels',
    'wind-barb-layer',
    'circulation-arrow-layer',
    'pressure-heatmap-layer',
] as const;

/**
 * The parts of the pressure chart that only belong to the STANDALONE synoptic
 * view. When isobars ride on top of another layer (wind, rain…) these stay
 * hidden: the pressure heatmap would fight the wind ramp for the same pixels,
 * the barbs duplicate the particle field, and the vignette/land treatment is
 * a full-chart look, not an overlay's. (The vignette itself goes to opacity 0
 * rather than hidden: setCoastalVignette.)
 */
export const SYNOPTIC_ONLY_LAYER_IDS = [
    'wind-barb-layer',
    'circulation-arrow-layer',
    'pressure-heatmap-layer',
] as const;

/**
 * Movement estimates are not an operational forecast product, so retain the
 * data source for future opt-in use but never surface these layers with the
 * normal pressure chart.
 */
const MOVEMENT_TRACK_LAYER_IDS = ['movement-track-lines', 'movement-track-labels'] as const;

/**
 * Set a layer's visibility only when that changes it. Style drops an unchanged
 * value, but Map.setLayoutProperty still flags the style dirty and repaints,
 * and every weather pass with pressure off used to make a dozen of those.
 * Unset reads as 'visible', as mapbox has it.
 */
function setVisibility(map: mapboxgl.Map, id: string, value: 'visible' | 'none'): void {
    if (!map.getLayer(id)) return;
    const current =
        typeof map.getLayoutProperty === 'function' ? (map.getLayoutProperty(id, 'visibility') ?? 'visible') : null;
    if (current === value) return;
    map.setLayoutProperty(id, 'visibility', value);
}

function hideMovementTrackLayers(map: mapboxgl.Map) {
    for (const id of MOVEMENT_TRACK_LAYER_IDS) setVisibility(map, id, 'none');
}

/**
 * Undo the synoptic chart's basemap treatment: put back the land fills, town
 * name ink and label opacities the ghost recorded, and only those. Shared by
 * full teardown (hideIsobarLayers, every weather pass with pressure off) and
 * by the overlay presentation, which keeps the contours but must hand the
 * basemap back. It walks the records, not the style, so it never waits for
 * the style to settle.
 */
function restoreBasemapTreatment(
    map: mapboxgl.Map,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    savedLandColors: Map<string, any>,
) {
    restorePaint(map, savedLandColors, 'fill-color', LAND_GHOST_FILL);
    restorePlaceLabelInk(map);
    const labels = savedLabelOpacity.get(map);
    if (labels) restorePaint(map, labels, 'text-opacity', LABEL_GHOST_OPACITY);
}

type StyleLayerIdentity = { id: string; type?: string; source?: unknown };

/** The style's layers; undefined until the style JSON is in (getStyle throws before that). */
function styleLayers(map: mapboxgl.Map): StyleLayerIdentity[] | undefined {
    try {
        return map.getStyle()?.layers;
    } catch (_) {
        return undefined;
    }
}

/**
 * The standalone chart's treatment for one layer: charcoal for a land fill,
 * the ghost for a label. Anything else is left alone.
 */
function ghostLayer(
    map: mapboxgl.Map,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    savedLandColors: Map<string, any>,
    layer: StyleLayerIdentity,
): void {
    try {
        if (isGhostedLandFill(layer)) {
            ghostPaint(map, savedLandColors, layer.id, 'fill-color', LAND_GHOST_FILL);
        } else if (isGhostedLabel(layer)) {
            if (isBasePlaceLabelLayer(layer)) {
                // Town names: opacity stays at 1 and keeps the own-ship
                // fade (written only through the helper, and not at all
                // on a layer it has not armed); the ghost goes into ink.
                setOpacityKeepingOwnshipFade(map, layer, 'text-opacity', 1);
                ghostPlaceLabelInk(map, layer.id);
            } else {
                let labels = savedLabelOpacity.get(map);
                if (!labels) savedLabelOpacity.set(map, (labels = new Map()));
                ghostPaint(map, labels, layer.id, 'text-opacity', LABEL_GHOST_OPACITY);
            }
        }
    } catch (_) {
        /* style mid-swap: the next pass ghosts it */
    }
}

/**
 * Charcoal land and ghosted labels: the standalone chart's basemap. Needs the
 * style JSON only, never a settled style (see "recorded, put back exactly").
 * Returns the ids it walked, or null when the style JSON is not in yet.
 */
function ghostBasemapTreatment(
    map: mapboxgl.Map,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    savedLandColors: Map<string, any>,
): Set<string> | null {
    const layers = styleLayers(map);
    if (!layers) return null;
    for (const layer of layers) ghostLayer(map, savedLandColors, layer);
    return new Set(layers.map((layer) => layer.id));
}

// ── Layers that mount while the chart is up ──
//
// While the standalone chart is up, the first styledata of a burst (a layer
// add comes with one) schedules one walk 120 ms later and the rest of the
// burst rides on it, as MapHub's own styledata apply does: a quiet map is
// never walked. The walk ghosts only the layers that were not in the
// style on the previous walk, once each. A layer seen before is never written
// again from here, even when its owner has rewritten it since: two writers
// that each answer the other's styledata are the ~8 Hz loop this map has been
// through before. The next toggle pass re-ghosts such a layer, and a layer
// that goes and mounts again counts as new once a walk has seen it gone. The
// restore needs nothing from this: whatever the walk ghosted is recorded like
// the rest. Taken down on pressure off and when the chart becomes an overlay.

/** How long a styledata burst must settle before the late-layer walk. */
const LATE_LAYER_SETTLE_MS = 120;

interface LateLayerWatch {
    onStyleData: () => void;
    timer: ReturnType<typeof setTimeout> | null;
    /** The ids in the style at the last walk. */
    seen: Set<string>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    savedLandColors: Map<string, any>;
}

/** Per map: the watch the standalone chart keeps while it is up. */
const lateLayerWatch = new WeakMap<object, LateLayerWatch>();

function watchLateLayers(
    map: mapboxgl.Map,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    savedLandColors: Map<string, any>,
    seen: Set<string>,
): void {
    if (typeof map.on !== 'function' || typeof map.off !== 'function') return;
    const current = lateLayerWatch.get(map);
    if (current) {
        current.seen = seen;
        current.savedLandColors = savedLandColors;
        return;
    }
    const watch: LateLayerWatch = {
        timer: null,
        seen,
        savedLandColors,
        onStyleData: () => {
            if (watch.timer !== null) return;
            watch.timer = setTimeout(() => {
                watch.timer = null;
                if (lateLayerWatch.get(map) !== watch) return;
                const layers = styleLayers(map);
                if (!layers) return;
                for (const layer of layers) {
                    if (!watch.seen.has(layer.id)) ghostLayer(map, watch.savedLandColors, layer);
                }
                watch.seen = new Set(layers.map((layer) => layer.id));
            }, LATE_LAYER_SETTLE_MS);
        },
    };
    lateLayerWatch.set(map, watch);
    map.on('styledata', watch.onStyleData);
}

function unwatchLateLayers(map: mapboxgl.Map): void {
    const watch = lateLayerWatch.get(map);
    if (!watch) return;
    lateLayerWatch.delete(map);
    if (watch.timer !== null) clearTimeout(watch.timer);
    map.off('styledata', watch.onStyleData);
}

/**
 * Hide all isobar layers and hand the basemap back.
 */
export function hideIsobarLayers(
    map: mapboxgl.Map,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    savedLandColors: Map<string, any>,
) {
    unwatchLateLayers(map);
    for (const id of ISOBAR_LAYER_IDS) setVisibility(map, id, 'none');
    hideMovementTrackLayers(map);
    setCoastalVignette(map, false);
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
        setVisibility(map, id, overlay && synopticOnly.has(id) ? 'none' : 'visible');
    }
    // These remain hidden even while the rest of the pressure chart is shown.
    hideMovementTrackLayers(map);
    setCoastalVignette(map, !overlay);

    if (overlay) {
        // A previous standalone activation may have left the charcoal land —
        // hand the basemap back before the host layer paints over it.
        unwatchLateLayers(map);
        restoreBasemapTreatment(map, savedLandColors);
        return;
    }

    // Desaturate landmasses to charcoal + ghost labels to 30%. The visibility
    // writes above leave map.isStyleLoaded() false until the next frame; the
    // ghost does not wait for it. Layers that mount after this pass are
    // ghosted by the watch (an empty `seen` when the style JSON is not in yet:
    // its first walk then ghosts everything).
    const walked = ghostBasemapTreatment(map, savedLandColors);
    watchLateLayers(map, savedLandColors, walked ?? new Set());
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
        filter: ['!=', ['get', 'isDetail'], true],
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
        filter: ['all', ['==', ['get', 'isMajor'], false], ['!=', ['get', 'isDetail'], true]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
            // THE 4 hPa LINES ARE THE CHART (2026-08-21). This is a 4 hPa
            // analysis — the synoptic standard, and what BOM's own MSLP
            // charts draw — so these are ordinary isobars, not detail that
            // "yields". At 0.68 colour alpha over 0.9 opacity they rendered
            // at ~0.61 against the majors' ~0.94, half the width, and the
            // whole chart read as an 8 hPa one with decoration between the
            // lines. Near-equal weight now; the 8 hPa rhythm survives as a
            // modest width step, which is all a reading aid needs to be.
            'line-color': 'rgba(238, 246, 253, 0.9)',
            'line-width': ['interpolate', ['linear'], ['zoom'], 2, 1.2, 5, 1.55, 8, 2.0],
            'line-opacity': 0.95,
        },
    });

    // Intermediate rings are intersections of the same actual pressure
    // field, not invented circles around H/L. Keep the broad 4 hPa overview.
    map.addLayer({
        id: 'isobar-detail-lines',
        type: 'line',
        source: 'isobar-contours',
        minzoom: 3,
        filter: ['==', ['get', 'isDetail'], true],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
            'line-color': '#e9f3fc',
            'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.8, 5, 1.15, 8, 1.5],
            'line-opacity': 0.78,
        },
    });

    map.addLayer({
        id: 'isobar-major-lines',
        type: 'line',
        source: 'isobar-contours',
        filter: ['==', ['get', 'isMajor'], true],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
            // Major contours keep the 8 hPa rhythm readable — a touch wider
            // and brighter than their neighbours, not a different class of
            // line.
            'line-color': 'rgba(252, 254, 255, 0.98)',
            'line-width': ['interpolate', ['linear'], ['zoom'], 2, 1.7, 5, 2.15, 8, 2.7],
            'line-opacity': 0.98,
        },
    });

    map.addLayer({
        id: 'isobar-labels',
        type: 'symbol',
        source: 'isobar-contours',
        // EVERY isobar carries its value, not every second one. The contour
        // interval is already the synoptic standard 4 hPa, but labelling only
        // the multiples of 8 made the chart READ as an 8 hPa chart — the
        // intervening lines looked like unexplained decoration. BOM's own
        // MSLP analysis labels essentially every 4 hPa line (verified against
        // the live IDY00030 chart, 2026-08-21). Mapbox's symbol collision
        // still thins them out where they crowd.
        filter: ['all', ['has', 'label'], ['!=', ['get', 'isDetail'], true]],
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

    map.addLayer({
        id: 'isobar-detail-labels',
        type: 'symbol',
        source: 'isobar-contours',
        minzoom: 3,
        filter: ['==', ['get', 'isDetail'], true],
        layout: {
            'symbol-placement': 'line',
            'text-field': ['get', 'label'],
            'text-size': 11,
            'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
            'symbol-spacing': 360,
            'text-max-angle': 30,
            'text-keep-upright': true,
            'text-allow-overlap': false,
        },
        paint: { 'text-color': '#e9f3fc', 'text-halo-color': 'rgba(6,14,28,0.9)', 'text-halo-width': 1.8 },
    });

    createPressureCenterBadges(map);
    map.addLayer({
        id: 'isobar-center-labels',
        type: 'symbol',
        source: 'isobar-centers',
        layout: {
            'icon-image': ['match', ['get', 'type'], 'H', 'pressure-badge-h', 'pressure-badge-l'],
            'icon-allow-overlap': true,
            // Two-scale stack inside the badge: the letter carries the paint
            // colour below; the central pressure sits under it. The NUMBER is
            // what a skipper actually reads off a chart ("L 998" tells you
            // how deep), so it is nearly as large as the letter — BOM prints
            // it equal-or-larger, NOAA underlines it. It was 0.62 scale in a
            // dim grey, which is smaller than any reference chart uses.
            'text-field': [
                'format',
                ['get', 'type'],
                { 'font-scale': 1.25 },
                '\n',
                {},
                ['to-string', ['get', 'pressure']],
                { 'font-scale': 0.85, 'text-color': '#f2f7fc' },
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
            // BLUE H / RED L — the NOAA convention, and the one every chart a
            // skipper is likely to compare against uses. The old pairing was
            // the exact inverse (coral H, ice-blue L), which reads as "warm
            // high / cold low" and is precisely backwards from the charts on
            // the internet (2026-08-21).
            'text-color': ['match', ['get', 'type'], 'H', '#5eb8ff', 'L', '#ff6b6b', '#dce6ef'],
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
    // An unverified line: bright red and white dashes on a dark edge
    // (2026-10-03, inshoreRouteState unverifiedRouteDashLayers), bottom to top.
    'route-unverified-casing',
    'route-unverified-gap',
    'route-unverified',
    'route-core',
    // Decision 9's survey stretches: amber dots on a dark casing (owner
    // decision 10, 2026-09-30; dots since the round-4 review;
    // inshoreRouteState surveyDashLayers).
    'route-survey-casing',
    'route-survey-dash',
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
