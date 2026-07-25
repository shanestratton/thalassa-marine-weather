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
 *   <MapboxVelocityOverlay mapboxMap={mapboxInstance} visible particlesEnabled={particlesOn} />
 */

import React, { useEffect, useRef } from 'react';
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

// ── Helper: Create velocity layer ─────────────────────────────

function createVelocityLayer(data: VelocityGribRecord[]): L.Layer {
    return (L as unknown as Record<string, (...args: unknown[]) => L.Layer>).velocityLayer({
        displayValues: false, // No mouse readout (overlay has pointer-events: none)
        data,
        maxVelocity: WIND_MAX_MS,
        velocityScale: 0.015,
        particleAge: 60,
        particleMultiplier: 1 / 150,
        frameRate: 15,
        particlelineWidth: PARTICLE_LINE_WIDTH,
        colorScale: WIND_COLORS,
    });
}

type MutableVelocityLayer = L.Layer & {
    _windy?: { setData: (data: VelocityGribRecord[]) => void };
    setData?: (data: VelocityGribRecord[]) => void;
};

function removeVelocityLayer(map: L.Map, layer: L.Layer | null): void {
    if (layer && map.hasLayer(layer)) map.removeLayer(layer);
}

function applyVelocityData(map: L.Map, layer: L.Layer | null, data: VelocityGribRecord[]): L.Layer {
    if (!layer) {
        const created = createVelocityLayer(data);
        created.addTo(map);
        return created;
    }

    const mutableLayer = layer as MutableVelocityLayer;
    if (mutableLayer._windy) {
        mutableLayer._windy.setData(data);
        return layer;
    }
    if (mutableLayer.setData) {
        mutableLayer.setData(data);
        return layer;
    }

    removeVelocityLayer(map, layer);
    const replacement = createVelocityLayer(data);
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

/** Keep wind below the navigation and label chrome, regardless of base style. */
function heatmapBeforeLayerId(map: mapboxgl.Map): string | undefined {
    try {
        const styleMap = map as unknown as {
            getStyle?: () => { layers?: Array<{ id: string; type?: string }> };
        };
        return styleMap.getStyle?.().layers?.find((layer) => layer.type === 'symbol')?.id;
    } catch {
        return undefined;
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

    const beforeLayerId = heatmapBeforeLayerId(map);
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
    // Track latest values so the async setup can apply the correct hour
    const windHourRef = useRef(windHour);
    const windGridPropRef = useRef(windGrid);
    windHourRef.current = windHour;
    windGridPropRef.current = windGrid;

    // The selected WindStore grid is the sole particle source. This effect
    // covers grid/hour updates after Leaflet setup, including the first frame.
    // If a model switch clears the grid, remove the old model immediately
    // rather than leaving plausible-looking but incorrectly labelled wind.
    useEffect(() => {
        if (!particlesEnabled) return;
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
            velocityLayerRef.current = applyVelocityData(leafletMap, velocityLayerRef.current, nextData);
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
    }, [windHour, windGrid, particlesEnabled]);

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
    }, [mapboxMap, visible, windGrid, heatmapFrame]);

    // Tear down only when the owning map changes or this overlay unmounts.
    // Updating a forecast frame uses ImageSource.updateImage() above, avoiding
    // the visible remove/re-add flash the old implementation would cause.
    useEffect(() => {
        if (!mapboxMap || !canRenderHeatMap(mapboxMap)) return;
        return () => removeHeatMap(mapboxMap);
    }, [mapboxMap]);

    // ── Zoom-based particle visibility ───────────────────────────
    useEffect(() => {
        if (!mapboxMap || !visible || !particlesEnabled) return;
        const MIN_PARTICLE_ZOOM = 1; // Match wind layer minZoom

        const onZoom = () => {
            const z = mapboxMap.getZoom();
            const showParticles = z >= MIN_PARTICLE_ZOOM;
            if (overlayRef.current) {
                overlayRef.current.style.display = showParticles ? '' : 'none';
            }
        };

        mapboxMap.on('zoom', onZoom);
        onZoom();
        return () => {
            mapboxMap.off('zoom', onZoom);
        };
    }, [mapboxMap, visible, particlesEnabled]);

    // ── Create/destroy particle overlay ──────────────────────────
    useEffect(() => {
        if (!mapboxMap || !visible || !particlesEnabled) return;

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
                velocityLayerRef.current = applyVelocityData(lMap, null, initialData);
            }

            // ── Anchor-point geo-locking (performance optimised) ──
            // MOVE events (every pixel during drag):
            //   → Lightweight: just measure pixel error + CSS translate (no setView)
            // MOVEEND / ZOOM events (end of gesture):
            //   → Full: setView() + measure + correct
            let _syncing = false;

            // Full sync — expensive, only on moveend/zoom
            const syncFull = () => {
                if (_syncing || !leafletMapRef.current || !mapboxMap || !overlayRef.current) return;
                _syncing = true;
                try {
                    const c = mapboxMap.getCenter();
                    const z = mapboxMap.getZoom() + 1;
                    leafletMapRef.current.setView([c.lat, c.lng], z, { animate: false });

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
                } catch (_) {
                    /* velocity canvas not ready yet */
                }
                _syncing = false;
            };

            // Lightweight correction — cheap, runs on every move pixel
            const correctOnly = () => {
                if (!leafletMapRef.current || !mapboxMap || !overlayRef.current) return;
                try {
                    const c = mapboxMap.getCenter();
                    const mapboxPx = mapboxMap.project([c.lng, c.lat]);
                    const leafletPx = leafletMapRef.current.latLngToContainerPoint([c.lat, c.lng]);
                    const dx = mapboxPx.x - leafletPx.x;
                    const dy = mapboxPx.y - leafletPx.y;
                    overlayRef.current.style.transform = `translate(${dx}px, ${dy}px)`;
                } catch (_) {
                    /* ok */
                }
            };

            const onResize = () => {
                leafletMapRef.current?.invalidateSize();
                syncFull();
            };

            // Lightweight correction on every drag pixel, full sync only at end
            mapboxMap.on('move', correctOnly);
            mapboxMap.on('moveend', syncFull);
            mapboxMap.on('zoom', syncFull);
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
            moveRef.current = correctOnly;
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
                if (moveRef.current) mapboxMap.off('move', moveRef.current);
                if (syncRef.current) {
                    mapboxMap.off('moveend', syncRef.current);
                    mapboxMap.off('zoom', syncRef.current);
                }
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
    }, [mapboxMap, visible, particlesEnabled]);

    return null;
};
