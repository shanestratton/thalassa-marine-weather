/**
 * MapboxVelocityOverlay — Bridges leaflet-velocity-ts onto a Mapbox GL map.
 *
 * Data pipeline:
 *   1. Receives the selected model's reactive WindStore grid
 *   2. Converts its current (possibly fractional) forecast frame to U/V records
 *   3. Renders a static wind-speed heatmap below labels
 *   4. Optionally renders animated particles via leaflet-velocity-ts
 *
 * Cleanup: removes the heatmap plus the optional velocity layer/Leaflet overlay.
 *
 * Usage:
 *   <MapboxVelocityOverlay mapboxMap={mapboxInstance} visible />
 */

import React, { useEffect, useRef, useState } from 'react';
import type { WindGrid } from '../../services/weather/windGridEncoding';
import { createLogger } from '../../utils/createLogger';
import { WIND_COLORS, WIND_MAX_MS, windColorForKt } from './windRamp';
import { buildWindHeatmapSegments } from './windHeatmapSegments';
import { windGridFrameToVelocityData, type VelocityGribRecord } from './windVelocityFrame';

const log = createLogger('MapboxVelocityOverlay');
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// NOTE: leaflet-velocity-ts is dynamically imported inside useEffect
// because it expects window.L to exist at import time.
// Type declaration is in src/leaflet-velocity-ts.d.ts

interface MapboxVelocityOverlayProps {
    mapboxMap: mapboxgl.Map | null;
    visible: boolean;
    /** Static wind speed stays on; this controls only the animated overlay. */
    particlesEnabled?: boolean;
    windHour?: number;
    windGrid?: WindGrid;
}

// Speed-graded wind particle scale — blue → cyan → green → orange → red →
// pink → magenta → violet. Band table + bucket maths live in ./windRamp so the
// legend shares one definition instead of a hand-mirrored copy.

/**
 * Particle stroke width, in px. THE DIAL — change this one number if the wind
 * field wants more or less presence.
 *
 * Keep it thin, and know why. This canvas is a DOM overlay at z-index 400
 * spanning the whole map (see the container style below), so it draws over
 * LAND as well as water — and it sits above the Mapbox canvas that renders
 * place names. The library also composites additively ('lighter'), so trails
 * accumulate toward white where they cross.
 *
 * The option key is `particlelineWidth` — lowercase 'l' in "line":
 *   leaflet-velocity.js → `this.particleLineWidth = t.particlelineWidth || 1`
 * The code passed `lineWidth: 3.5` for months, which matched nothing, so it
 * silently rendered at the library default of 1. Correcting the key to the
 * literal 3.5 tripled the stroke and swamped every land label (Shane
 * 2026-07-21: "i have lost all of my names from the land area").
 *
 * So 1 is not a fallback here, it is the CHOSEN value: it is what the chart
 * looked like in the screenshot Shane asked to have restored, and it lets the
 * place names read through. The vivid speed ramp is what makes the wind stand
 * out now; the stroke does not have to.
 */
const PARTICLE_LINE_WIDTH = 1;
// Direction is essential even in the broad synoptic view, so Wind begins at
// z3 rather than falling back to a speed-only heatmap. The startup guard below
// protects the third-party renderer from the old delayed-start zoom race.
const MIN_PARTICLE_ZOOM = 3;

/**
 * The z3 synoptic look Shane signed off on. The library multiplies this by
 * pow(viewRadianArea, 0.4), and that area shrinks 4× per zoom level — so a
 * fixed base made particles crawl at ~0.4% of their z3 speed by z12, which
 * read as "the wind died" whenever you zoomed in.
 */
const BASE_VELOCITY_SCALE = 0.015;
const VELOCITY_SCALE_REF_ZOOM = 3;

/**
 * Cancel the library's pow(area, 0.4) zoom collapse so apparent particle
 * speed stays at the z3 look everywhere: area ∝ 4^−z, so pow(area, 0.4)
 * loses 2^0.8 per level — hand back exactly that. Clamped so a deep ENC
 * zoom can't wind the multiplier into the stratosphere.
 */
function zoomCompensatedVelocityScale(mapboxZoom: number): number {
    const z = Math.min(12, Math.max(VELOCITY_SCALE_REF_ZOOM, mapboxZoom));
    return BASE_VELOCITY_SCALE * Math.pow(2, 0.8 * (z - VELOCITY_SCALE_REF_ZOOM));
}

// ── Helper: Create velocity layer ─────────────────────────────

function createVelocityLayer(data: VelocityGribRecord[], velocityScale: number): L.Layer {
    const layer = (L as unknown as Record<string, (...args: unknown[]) => L.Layer>).velocityLayer({
        displayValues: false, // No mouse readout (overlay has pointer-events: none)
        data,
        maxVelocity: WIND_MAX_MS,
        velocityScale,
        particleAge: 60,
        particleMultiplier: 1 / 150,
        frameRate: 15,
        particlelineWidth: PARTICLE_LINE_WIDTH,
        colorScale: WIND_COLORS,
    });
    // Keep the third-party delayed-start guard attached to every creation
    // path, including a replacement after an unsupported data update.
    guardVelocityLayerStartup(layer);
    return layer;
}

type MutableVelocityLayer = L.Layer & {
    _windy?: { setData: (data: VelocityGribRecord[]) => void; velocityScale?: number };
    setData?: (data: VelocityGribRecord[]) => void;
};

/**
 * `leaflet-velocity-ts` creates its Windy instance before it creates the
 * animation bucket used by `Windy.stop()`. A Mapbox zoom can arrive in that
 * small window (particularly when Wind opens at z3), causing the plugin to
 * call `this.animationBucket.clear()` while the bucket is still undefined.
 *
 * The plugin does not expose a lifecycle hook for this, so guard its private
 * startup seam at the one place we create a velocity layer. Once `start()`
 * has run, the original stop implementation remains completely unchanged.
 */
type VelocityWindyInternals = {
    animationBucket?: { clear?: () => void };
    stop?: () => void;
    __thalassaSafeStop?: boolean;
};

type VelocityLayerInternals = MutableVelocityLayer & {
    _windy?: VelocityWindyInternals;
    onDrawLayer?: (...args: unknown[]) => unknown;
    __thalassaStartupGuarded?: boolean;
};

export function guardVelocityLayerStartup(layer: L.Layer): void {
    const internalLayer = layer as VelocityLayerInternals;
    if (internalLayer.__thalassaStartupGuarded || typeof internalLayer.onDrawLayer !== 'function') return;

    internalLayer.__thalassaStartupGuarded = true;
    const originalOnDrawLayer = internalLayer.onDrawLayer;

    internalLayer.onDrawLayer = (...args: unknown[]) => {
        const result = originalOnDrawLayer.call(internalLayer, ...args);
        const windy = internalLayer._windy;
        if (!windy || windy.__thalassaSafeStop || typeof windy.stop !== 'function') return result;

        const originalStop = windy.stop;
        windy.__thalassaSafeStop = true;
        windy.stop = () => {
            // Before the plugin's delayed `start()` call there is no running
            // animation to stop. Returning here avoids its unsafe clear().
            if (!windy.animationBucket) return;
            originalStop.call(windy);
        };

        return result;
    };
}

function removeVelocityLayer(map: L.Map, layer: L.Layer | null): void {
    if (layer && map.hasLayer(layer)) map.removeLayer(layer);
}

function applyVelocityData(
    map: L.Map,
    layer: L.Layer | null,
    data: VelocityGribRecord[],
    velocityScale: number,
): L.Layer {
    if (!layer) {
        const created = createVelocityLayer(data, velocityScale);
        created.addTo(map);
        return created;
    }

    const mutableLayer = layer as MutableVelocityLayer;
    if (mutableLayer._windy) {
        mutableLayer._windy.velocityScale = velocityScale;
        mutableLayer._windy.setData(data);
        return layer;
    }
    if (mutableLayer.setData) {
        mutableLayer.setData(data);
        return layer;
    }

    removeVelocityLayer(map, layer);
    const replacement = createVelocityLayer(data, velocityScale);
    replacement.addTo(map);
    return replacement;
}

// ── Helper: Wind speed heat map (Mapbox image source) ─────────

const HEATMAP_SOURCE = 'wind-heatmap-src';
const HEATMAP_LAYER = 'wind-heatmap-layer';
const HEATMAP_PIXEL_ALPHA = 148;
const HEATMAP_RASTER_OPACITY = 0.72;

type ImageSourceUpdate = {
    updateImage?: (options: { url: string; coordinates: unknown }) => void;
};

type StyleLayer = {
    id: string;
    type?: string;
    layout?: { visibility?: string };
};

const HEATMAP_LAYER_IDS = new Set([`${HEATMAP_LAYER}`, `${HEATMAP_LAYER}_r`]);
// MapTiler Ocean is a translucent weather/bathymetry tint in the normal
// Hybrid chart, not a true base. Treating it as an opaque base anchor would
// lift wind above ENC/navigation layers, so only use the actual opaque image
// bases here.
const IMAGERY_BASE_LAYER_IDS = ['hybrid-base-layer', 'satellite-base-layer'];

function canRenderHeatMap(map: mapboxgl.Map | null): map is mapboxgl.Map {
    const candidate = map as unknown as {
        addLayer?: unknown;
        addSource?: unknown;
        getLayer?: unknown;
        getSource?: unknown;
        removeLayer?: unknown;
        removeSource?: unknown;
    } | null;
    return Boolean(
        candidate &&
        typeof candidate.addLayer === 'function' &&
        typeof candidate.addSource === 'function' &&
        typeof candidate.getLayer === 'function' &&
        typeof candidate.getSource === 'function' &&
        typeof candidate.removeLayer === 'function' &&
        typeof candidate.removeSource === 'function',
    );
}

/**
 * `MapHub` can still be mounting its base style when a cached wind grid arrives.
 * Adding an image source in that tiny window throws, and a style replacement
 * later removes every custom source. Leave the static field dormant until the
 * style is ready; the style-load listener below then paints the latest frame.
 */
function isHeatMapStyleReady(map: mapboxgl.Map): boolean {
    const candidate = map as unknown as { isStyleLoaded?: () => boolean };
    return typeof candidate.isStyleLoaded !== 'function' || candidate.isStyleLoaded();
}

function hexToRgb(hex: string): [number, number, number] {
    const normalized = hex.replace('#', '');
    const value = Number.parseInt(normalized, 16);
    return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function heatmapSourceId(suffix: '' | '_r'): string {
    return `${HEATMAP_SOURCE}${suffix}`;
}

function heatmapLayerId(suffix: '' | '_r'): string {
    return `${HEATMAP_LAYER}${suffix}`;
}

function removeHeatMapSegment(map: mapboxgl.Map, suffix: '' | '_r'): void {
    const layerId = heatmapLayerId(suffix);
    const sourceId = heatmapSourceId(suffix);
    if (map.getLayer(layerId)) map.removeLayer(layerId);
    if (map.getSource(sourceId)) map.removeSource(sourceId);
}

function styleLayers(map: mapboxgl.Map): StyleLayer[] {
    try {
        const styleMap = map as unknown as {
            getStyle?: () => { layers?: StyleLayer[] };
        };
        return styleMap.getStyle?.().layers ?? [];
    } catch {
        return [];
    }
}

function layerIsVisible(map: mapboxgl.Map, layer: StyleLayer): boolean {
    try {
        const layoutMap = map as unknown as {
            getLayoutProperty?: (layerId: string, property: string) => unknown;
        };
        const visibility = layoutMap.getLayoutProperty?.(layer.id, 'visibility') ?? layer.layout?.visibility;
        return visibility !== 'none';
    } catch {
        return layer.layout?.visibility !== 'none';
    }
}

/**
 * Keep the static wind field above whichever opaque base is actually visible,
 * but beneath ENC/navigation content. Hybrid is appended late by MapHub, so
 * using the first base-style label as the anchor put the broad-view heatmap
 * underneath it and made it look as though wind had failed to load.
 */
export function getWindHeatmapBeforeLayerId(map: mapboxgl.Map): string | undefined {
    const layers = styleLayers(map);
    const visibleBaseIndexes = layers
        .map((layer, index) => (IMAGERY_BASE_LAYER_IDS.includes(layer.id) && layerIsVisible(map, layer) ? index : -1))
        .filter((index) => index >= 0);
    const baseIndex = visibleBaseIndexes.length > 0 ? Math.max(...visibleBaseIndexes) : -1;

    if (baseIndex >= 0) {
        // The layer immediately after the visible base is the safe ceiling:
        // usually the first ENC layer, and otherwise the end of the style.
        // Skip our own layer IDs so a reassertion can never select itself as
        // its `beforeId` after the base healer has reordered imagery.
        return layers.slice(baseIndex + 1).find((layer) => !HEATMAP_LAYER_IDS.has(layer.id))?.id;
    }

    return layers.find((layer) => layer.type === 'symbol')?.id;
}

/** Reassert the one ordering invariant without writing when it already holds. */
export function ensureWindHeatmapLayerOrder(map: mapboxgl.Map): void {
    try {
        const layers = styleLayers(map);
        if (layers.length === 0) return;
        const beforeLayerId = getWindHeatmapBeforeLayerId(map);
        const beforeIndex = beforeLayerId ? layers.findIndex((layer) => layer.id === beforeLayerId) : layers.length;
        const visibleBaseIndexes = layers
            .map((layer, index) =>
                IMAGERY_BASE_LAYER_IDS.includes(layer.id) && layerIsVisible(map, layer) ? index : -1,
            )
            .filter((index) => index >= 0);
        const baseIndex = visibleBaseIndexes.length > 0 ? Math.max(...visibleBaseIndexes) : -1;
        const movableMap = map as unknown as { moveLayer?: (layerId: string, beforeId?: string) => void };
        if (!movableMap.moveLayer) return;

        for (const suffix of ['' as const, '_r' as const]) {
            const layerId = heatmapLayerId(suffix);
            const layerIndex = layers.findIndex((layer) => layer.id === layerId);
            if (layerIndex < 0) continue;
            const belowBase = baseIndex >= 0 && layerIndex <= baseIndex;
            const aboveCeiling = beforeIndex >= 0 && layerIndex >= beforeIndex;
            if (belowBase || aboveCeiling) movableMap.moveLayer(layerId, beforeLayerId);
        }
    } catch {
        // The base style can be in transit; the coalesced styledata pass will
        // retry after it settles.
    }
}

function upsertHeatMapImage(
    map: mapboxgl.Map,
    suffix: '' | '_r',
    url: string,
    coordinates: [[number, number], [number, number], [number, number], [number, number]],
    beforeLayerId: string | undefined,
): void {
    const sourceId = heatmapSourceId(suffix);
    const layerId = heatmapLayerId(suffix);
    const existingSource = map.getSource(sourceId) as ImageSourceUpdate | undefined;
    if (existingSource?.updateImage) {
        existingSource.updateImage({ url, coordinates });
    } else {
        map.addSource(sourceId, { type: 'image', url, coordinates });
    }

    if (!map.getLayer(layerId)) {
        map.addLayer(
            {
                id: layerId,
                type: 'raster',
                source: sourceId,
                paint: {
                    'raster-opacity': HEATMAP_RASTER_OPACITY,
                    'raster-fade-duration': 0,
                    'raster-resampling': 'linear',
                },
            },
            beforeLayerId,
        );
    }
}

function updateHeatMap(map: mapboxgl.Map, windData: VelocityGribRecord[]): void {
    const uRecord = windData.find(
        (d: VelocityGribRecord) =>
            d.header?.parameterNumberName?.includes('U-component') || d.header?.parameterNumber === 2,
    );
    const vRecord = windData.find(
        (d: VelocityGribRecord) =>
            d.header?.parameterNumberName?.includes('V-component') || d.header?.parameterNumber === 3,
    );
    if (!uRecord || !vRecord) {
        removeHeatMap(map);
        return;
    }

    const header = uRecord.header;
    const nx = Math.floor(header.nx);
    const ny = Math.floor(header.ny);
    if (nx < 2 || ny < 2 || uRecord.data.length < nx * ny || vRecord.data.length < nx * ny) {
        removeHeatMap(map);
        return;
    }
    const segments = buildWindHeatmapSegments({ columns: nx, west: header.lo1, east: header.lo2 });
    if (segments.length === 0) {
        removeHeatMap(map);
        return;
    }

    const la1 = header.la1;
    const la2 = header.la2 ?? la1 - (ny - 1) * header.dy;

    // Paint wind speed pixels
    const canvas = document.createElement('canvas');
    canvas.width = nx;
    canvas.height = ny;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const imgData = ctx.createImageData(nx, ny);
    for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
            const i = y * nx + x;
            const u = uRecord.data[i] ?? 0;
            const v = vRecord.data[i] ?? 0;
            const speedKts = Math.sqrt(u * u + v * v) * 1.94384;
            const [r, g, b] = hexToRgb(windColorForKt(speedKts));
            const px = i * 4;
            imgData.data[px] = r;
            imgData.data[px + 1] = g;
            imgData.data[px + 2] = b;
            imgData.data[px + 3] = HEATMAP_PIXEL_ALPHA;
        }
    }
    ctx.putImageData(imgData, 0, 0);

    // Mapbox Mercator can't handle ±90° latitude (infinity at poles)
    const MERCATOR_LAT_LIMIT = 85.0;
    const north = Math.min(Math.max(la1, la2), MERCATOR_LAT_LIMIT);
    const south = Math.max(Math.min(la1, la2), -MERCATOR_LAT_LIMIT);
    const flipY = la1 < la2;

    // Mapbox image sources do not wrap cleanly across a global field. The
    // segmenter keeps each image within a hemisphere and shares the seam pixel
    // between neighbours, so no one-column / one-degree gap shows through.
    const sliceToDataUrl = (startX: number, endX: number) => {
        const width = endX - startX + 1;
        const slice = document.createElement('canvas');
        slice.width = width;
        slice.height = ny;
        const sliceContext = slice.getContext('2d');
        if (!sliceContext) return null;
        sliceContext.drawImage(canvas, startX, 0, width, ny, 0, 0, width, ny);
        const sm = document.createElement('canvas');
        sm.width = width * 2;
        sm.height = ny * 2;
        const sc = sm.getContext('2d');
        if (!sc) return null;
        sc.imageSmoothingEnabled = true;
        sc.imageSmoothingQuality = 'high';
        if (flipY) {
            sc.translate(0, sm.height);
            sc.scale(1, -1);
        }
        sc.drawImage(slice, 0, 0, sm.width, sm.height);
        return sm.toDataURL('image/png');
    };

    const beforeLayerId = getWindHeatmapBeforeLayerId(map);
    const activeSuffixes = new Set<'' | '_r'>();
    for (const segment of segments) {
        const url = sliceToDataUrl(segment.startColumn, segment.endColumn);
        if (!url) continue;
        activeSuffixes.add(segment.sourceSuffix);
        upsertHeatMapImage(
            map,
            segment.sourceSuffix,
            url,
            [
                [segment.west, north],
                [segment.east, north],
                [segment.east, south],
                [segment.west, south],
            ],
            beforeLayerId,
        );
    }

    for (const suffix of ['' as const, '_r' as const]) {
        if (!activeSuffixes.has(suffix)) removeHeatMapSegment(map, suffix);
    }
    ensureWindHeatmapLayerOrder(map);
}

function removeHeatMap(map: mapboxgl.Map): void {
    try {
        removeHeatMapSegment(map, '');
        removeHeatMapSegment(map, '_r');
    } catch (_) {
        /* ok */
    }
}

// ── Component ─────────────────────────────────────────────────

export const MapboxVelocityOverlay: React.FC<MapboxVelocityOverlayProps> = ({
    mapboxMap,
    visible,
    particlesEnabled = true,
    windHour = 0,
    windGrid,
}) => {
    const overlayRef = useRef<HTMLDivElement | null>(null);
    const leafletMapRef = useRef<L.Map | null>(null);
    const velocityLayerRef = useRef<L.Layer | null>(null);
    const syncRef = useRef<(() => void) | null>(null);
    const moveRef = useRef<(() => void) | null>(null);
    const resizeRef = useRef<(() => void) | null>(null);
    const zoomEndRef = useRef<(() => void) | null>(null);
    const [particleZoomSupported, setParticleZoomSupported] = useState(() =>
        Boolean(mapboxMap && mapboxMap.getZoom() >= MIN_PARTICLE_ZOOM),
    );
    // Track latest values so the async setup can apply the correct hour
    const windHourRef = useRef(windHour);
    const windGridPropRef = useRef(windGrid);
    windHourRef.current = windHour;
    windGridPropRef.current = windGrid;

    // The OBS wind read is directional at every supported zoom. Wait for the
    // camera to settle before mounting/unmounting the second map so a z3
    // transition cannot fight Mapbox's zoom animation.
    useEffect(() => {
        if (!mapboxMap || !visible || !particlesEnabled) {
            setParticleZoomSupported(false);
            return;
        }

        const updateParticleZoomSupport = () => {
            setParticleZoomSupported(mapboxMap.getZoom() >= MIN_PARTICLE_ZOOM);
        };

        updateParticleZoomSupport();
        // Wait for the camera to settle before starting/stopping the second
        // map. That keeps an animation-layer transition out of Mapbox's zoom
        // animation.
        mapboxMap.on('zoomend', updateParticleZoomSupport);
        return () => {
            mapboxMap.off('zoomend', updateParticleZoomSupport);
        };
    }, [mapboxMap, visible, particlesEnabled]);

    const particlesActive = particlesEnabled && particleZoomSupported;

    // The selected WindStore grid is the sole particle source. This effect
    // covers grid/hour updates after Leaflet setup, including the first frame.
    // If a model switch clears the grid, remove the old model immediately
    // rather than leaving plausible-looking but incorrectly labelled wind.
    useEffect(() => {
        if (!particlesActive) return;
        const leafletMap = leafletMapRef.current;
        if (!leafletMap) return;

        const nextData = windGridFrameToVelocityData(windGrid, windHour);
        if (!nextData) {
            removeVelocityLayer(leafletMap, velocityLayerRef.current);
            velocityLayerRef.current = null;
            if (overlayRef.current) overlayRef.current.style.opacity = '0';
            return;
        }

        try {
            velocityLayerRef.current = applyVelocityData(
                leafletMap,
                velocityLayerRef.current,
                nextData,
                zoomCompensatedVelocityScale(mapboxMap?.getZoom() ?? VELOCITY_SCALE_REF_ZOOM),
            );
            if (overlayRef.current) overlayRef.current.style.opacity = '1';
            syncRef.current?.();
        } catch (err) {
            // Never leave the previous model painted after a renderer update
            // fails. A plausible old field with a newly-selected model label is
            // more dangerous than an honestly empty overlay.
            removeVelocityLayer(leafletMap, velocityLayerRef.current);
            velocityLayerRef.current = null;
            if (overlayRef.current) overlayRef.current.style.opacity = '0';
            log.error('[VelocityOverlay] Failed to apply selected wind grid:', err);
        }
    }, [windHour, windGrid, particlesActive, mapboxMap]);

    // The static heatmap is intentionally quantised to whole forecast frames.
    // Particles can interpolate smoothly, but turning every scrubber fraction
    // into a fresh PNG would churn the main thread and make this "calm" mode
    // less battery-friendly than the animation it replaces.
    const heatmapFrame = Math.round(windHour);
    useEffect(() => {
        if (!mapboxMap || !canRenderHeatMap(mapboxMap)) return;
        if (!visible) {
            removeHeatMap(mapboxMap);
            return;
        }

        const renderStaticField = () => {
            if (!isHeatMapStyleReady(mapboxMap)) return;

            const data = windGridFrameToVelocityData(windGrid, heatmapFrame);
            if (!data) {
                removeHeatMap(mapboxMap);
                return;
            }

            try {
                updateHeatMap(mapboxMap, data);
            } catch (err) {
                removeHeatMap(mapboxMap);
                log.error('[HeatMap] Failed to render wind field:', err);
            }
        };

        renderStaticField();
        // A Mapbox style replacement deletes all custom sources and layers.
        // The static field remains the speed underlay at z3, so restore it on
        // that one lifecycle edge rather than relying on a later grid update
        // (which may not happen until the user moves the map).
        mapboxMap.on('style.load', renderStaticField);
        return () => {
            mapboxMap.off('style.load', renderStaticField);
        };
    }, [mapboxMap, visible, windGrid, heatmapFrame]);

    // MapHub may subsequently heal Hybrid/Satellite beneath a late ENC mount.
    // That move can put opaque imagery over a previously-correct heatmap. A
    // coalesced order check catches that edge without turning every Mapbox
    // styledata burst into a write (and therefore another styledata burst).
    useEffect(() => {
        if (!mapboxMap || !canRenderHeatMap(mapboxMap) || !visible) return;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const reassertOrder = () => {
            if (timer) return;
            timer = setTimeout(() => {
                timer = null;
                ensureWindHeatmapLayerOrder(mapboxMap);
            }, 120);
        };
        mapboxMap.on('styledata', reassertOrder);
        // Covers a source that was added before the current imagery-healer
        // pass, without waiting for the next unrelated style event.
        reassertOrder();
        return () => {
            if (timer) clearTimeout(timer);
            mapboxMap.off('styledata', reassertOrder);
        };
    }, [mapboxMap, visible]);

    // Tear down only when the owning map changes or this overlay unmounts.
    // Updating a forecast frame uses ImageSource.updateImage() above, avoiding
    // the visible remove/re-add flash the old implementation would cause.
    useEffect(() => {
        if (!mapboxMap || !canRenderHeatMap(mapboxMap)) return;
        return () => removeHeatMap(mapboxMap);
    }, [mapboxMap]);

    // ── Create/destroy particle overlay ──────────────────────────
    useEffect(() => {
        if (!mapboxMap || !visible || !particlesActive) return;

        let cancelled = false;
        let snapTimer: ReturnType<typeof setTimeout> | null = null;

        const setup = async () => {
            // Ensure Leaflet is on window BEFORE the plugin loads

            window.L = L;
            await import('leaflet-velocity-ts');

            // leaflet-velocity-ts includes `zoomanim: undefined` in its
            // CanvasLayer event map whenever Leaflet animations are disabled.
            // Leaflet warns once on bind and again on unbind for every mount.
            // Filter only non-functions at the plugin boundary; all valid
            // resize/move/zoom callbacks remain untouched.
            const canvasLayerProto = (
                L as unknown as {
                    CanvasLayer?: {
                        prototype?: {
                            getEvents?: () => Record<string, unknown>;
                            __thalassaFiltersInvalidEvents?: boolean;
                        };
                    };
                }
            ).CanvasLayer?.prototype;
            if (canvasLayerProto?.getEvents && !canvasLayerProto.__thalassaFiltersInvalidEvents) {
                const originalGetEvents = canvasLayerProto.getEvents;
                canvasLayerProto.getEvents = function () {
                    return Object.fromEntries(
                        Object.entries(originalGetEvents.call(this)).filter(
                            ([, listener]) => typeof listener === 'function',
                        ),
                    );
                };
                canvasLayerProto.__thalassaFiltersInvalidEvents = true;
            }

            if (cancelled) return;

            const container = mapboxMap.getContainer();

            // Create overlay div on top of Mapbox
            const div = document.createElement('div');
            div.style.cssText =
                'position:absolute;inset:0;z-index:400;pointer-events:none;opacity:0;transition:opacity 0.4s ease;';
            container.appendChild(div);
            overlayRef.current = div;

            // Create headless Leaflet map (transparent, no tiles, no controls)
            const center = mapboxMap.getCenter();
            const zoom = mapboxMap.getZoom();
            const lMap = L.map(div, {
                center: [center.lat, center.lng],
                zoom: zoom + 1,
                zoomControl: false,
                attributionControl: false,
                dragging: false,
                touchZoom: false,
                doubleClickZoom: false,
                scrollWheelZoom: false,
                boxZoom: false,
                keyboard: false,
                zoomAnimation: false,
                zoomSnap: 0,
            });
            leafletMapRef.current = lMap;

            // Make Leaflet fully transparent
            div.style.background = 'transparent';
            const leafletContainer = div.querySelector('.leaflet-container') as HTMLElement;
            if (leafletContainer) leafletContainer.style.background = 'transparent';
            const tilePane = lMap.getPane('tilePane');
            if (tilePane) tilePane.style.display = 'none';
            const mapPane = lMap.getPane('mapPane');
            if (mapPane) mapPane.style.background = 'transparent';

            // The grid/hour effect may have run before the async Leaflet plugin
            // was ready. Read the refs here to cover that race, including hour 0.
            const initialData = windGridFrameToVelocityData(windGridPropRef.current, windHourRef.current);
            if (initialData) {
                velocityLayerRef.current = applyVelocityData(
                    lMap,
                    null,
                    initialData,
                    zoomCompensatedVelocityScale(mapboxMap.getZoom()),
                );
            }

            // ── Anchor-point geo-locking (performance optimised) ──
            // MOVE/ZOOM events (every frame during a gesture):
            //   → Lightweight: CSS translate+scale against the last synced view
            //     (no setView — a setView per zoom frame made the plugin kill
            //     and re-seed every particle dozens of times per pinch)
            // MOVEEND (end of gesture — Mapbox fires it after zooms too):
            //   → Full: setView() + measure + record the new baseline
            let _syncing = false;

            // The Leaflet view the canvas was last truly projected at, plus
            // the sub-pixel residual Leaflet rendered it off-centre by.
            let lastSync: { lat: number; lng: number; zoom: number; rx: number; ry: number } | null = null;

            // Full sync — expensive, only at gesture end
            const syncFull = () => {
                if (_syncing || !leafletMapRef.current || !mapboxMap || !overlayRef.current) return;
                _syncing = true;
                try {
                    const c = mapboxMap.getCenter();
                    const zRaw = mapboxMap.getZoom();
                    // The restart this setView triggers re-reads velocityScale,
                    // so hand it the zoom-compensated value first.
                    const windy = (velocityLayerRef.current as MutableVelocityLayer | null)?._windy;
                    if (windy) windy.velocityScale = zoomCompensatedVelocityScale(zRaw);
                    leafletMapRef.current.setView([c.lat, c.lng], zRaw + 1, { animate: false });

                    // Measure residual error and correct
                    const mapboxPx = mapboxMap.project([c.lng, c.lat]);
                    const leafletPx = leafletMapRef.current.latLngToContainerPoint([c.lat, c.lng]);
                    const dx = mapboxPx.x - leafletPx.x;
                    const dy = mapboxPx.y - leafletPx.y;
                    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
                        overlayRef.current.style.transform = `translate(${dx}px, ${dy}px)`;
                    } else {
                        overlayRef.current.style.transform = '';
                    }
                    lastSync = { lat: c.lat, lng: c.lng, zoom: zRaw, rx: -dx, ry: -dy };
                } catch (_) {
                    /* velocity canvas not ready yet */
                }
                _syncing = false;
            };

            // Lightweight camera tracking — cheap, runs on every move/zoom
            // frame. Scales+translates the whole canvas so the field stays
            // geo-locked through a pinch without touching Leaflet (one real
            // re-projection then happens at moveend).
            const trackCamera = () => {
                if (!leafletMapRef.current || !mapboxMap || !overlayRef.current || !lastSync) return;
                try {
                    const cam = mapboxMap.getCenter();
                    const camPx = mapboxMap.project([cam.lng, cam.lat]);
                    const anchorPx = mapboxMap.project([lastSync.lng, lastSync.lat]);
                    const s = Math.pow(2, mapboxMap.getZoom() - lastSync.zoom);
                    const tx = anchorPx.x - camPx.x - s * lastSync.rx;
                    const ty = anchorPx.y - camPx.y - s * lastSync.ry;
                    // transform-origin is the div centre, which is exactly
                    // where the camera centre projects (the div is inset:0).
                    overlayRef.current.style.transform =
                        Math.abs(s - 1) > 0.001
                            ? `translate(${tx}px, ${ty}px) scale(${s})`
                            : `translate(${tx}px, ${ty}px)`;
                } catch (_) {
                    /* ok */
                }
            };

            const onResize = () => {
                leafletMapRef.current?.invalidateSize();
                syncFull();
            };

            // Lightweight tracking on every gesture frame, full sync only at end
            mapboxMap.on('move', trackCamera);
            mapboxMap.on('moveend', syncFull);
            mapboxMap.on('zoom', trackCamera);
            mapboxMap.on('resize', onResize);

            // Single deferred re-sync after zoom/move ends (replaces heavy 200ms×10 interval)
            const onViewEnd = () => {
                if (snapTimer) clearTimeout(snapTimer);
                snapTimer = setTimeout(() => {
                    if (cancelled) return;
                    syncFull();
                    snapTimer = null;
                }, 300);
            };
            mapboxMap.on('zoomend', onViewEnd);
            mapboxMap.on('moveend', onViewEnd);

            syncRef.current = syncFull;
            moveRef.current = trackCamera;
            resizeRef.current = onResize;
            zoomEndRef.current = onViewEnd;

            // Initial sync
            lMap.invalidateSize();
            syncFull();

            // Delayed re-sync — container may not have final dimensions on first mount.
            // Fade in AFTER this final sync so particles don't visibly jump.
            setTimeout(() => {
                if (cancelled) return;
                lMap.invalidateSize();
                syncFull();
                // Fade in only when a selected-model grid has produced a layer.
                if (overlayRef.current && velocityLayerRef.current) overlayRef.current.style.opacity = '1';
            }, 600);
        };

        setup().catch((err) => log.error('[VelocityOverlay] Setup failed:', err));

        // ── Cleanup ──────────────────────────────────────────────
        return () => {
            cancelled = true;
            if (snapTimer) {
                clearTimeout(snapTimer);
                snapTimer = null;
            }

            try {
                if (moveRef.current) {
                    mapboxMap.off('move', moveRef.current);
                    mapboxMap.off('zoom', moveRef.current);
                }
                if (syncRef.current) mapboxMap.off('moveend', syncRef.current);
                if (resizeRef.current) mapboxMap.off('resize', resizeRef.current);
                if (zoomEndRef.current) {
                    mapboxMap.off('zoomend', zoomEndRef.current);
                    mapboxMap.off('moveend', zoomEndRef.current);
                }
            } catch (_) {
                /* ok */
            }
            syncRef.current = null;
            moveRef.current = null;
            resizeRef.current = null;
            zoomEndRef.current = null;

            // Remove heat map from Mapbox
            // Heat map has its own useEffect lifecycle — don't touch it here

            // Remove velocity layer
            try {
                if (velocityLayerRef.current && leafletMapRef.current?.hasLayer(velocityLayerRef.current)) {
                    leafletMapRef.current.removeLayer(velocityLayerRef.current);
                }
            } catch (_) {
                /* ok */
            }
            velocityLayerRef.current = null;

            // Destroy Leaflet map (also detaches its container div)
            try {
                if (leafletMapRef.current) {
                    leafletMapRef.current.remove();
                }
            } catch (_) {
                /* ok */
            }
            leafletMapRef.current = null;

            // Remove overlay div (may already be gone after lMap.remove())
            try {
                if (overlayRef.current?.parentNode) {
                    overlayRef.current.parentNode.removeChild(overlayRef.current);
                }
            } catch (_) {
                /* ok */
            }
            overlayRef.current = null;
        };
    }, [mapboxMap, visible, particlesActive]);

    return null;
};
