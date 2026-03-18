/**
 * MapboxVelocityOverlay — Bridges leaflet-velocity-ts onto a Mapbox GL map.
 *
 * Data pipeline:
 *   1. Grabs map center → builds Supabase edge function URL
 *   2. Fetches live GFS wind data (GRIB2 → JSON via edge function)
 *   3. Caches response in browser Cache API ('thalassa-wind-cache')
 *   4. Falls back to cached data when offline
 *   5. Renders animated wind particles via leaflet-velocity-ts
 *
 * Cleanup: removes velocity layer, destroys Leaflet map, removes overlay div.
 *
 * Usage:
 *   <MapboxVelocityOverlay mapboxMap={mapboxInstance} visible={activeLayer === 'velocity'} />
 */

import React, { useEffect, useRef, useState } from 'react';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('MapboxVelocityOverlay');
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// NOTE: leaflet-velocity-ts is dynamically imported inside useEffect
// because it expects window.L to exist at import time.
// Type declaration is in src/leaflet-velocity-ts.d.ts

// ── Config ────────────────────────────────────────────────────

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_KEY as string;
const WIND_CACHE_NAME = 'thalassa-wind-cache';
const EDGE_FN_PATH = '/functions/v1/fetch-wind-velocity';

/** GRIB2 record: one U- or V-component of wind data */
interface GribHeader {
    nx: number;
    ny: number;
    dx: number;
    dy: number;
    lo1: number;
    lo2?: number;
    la1: number;
    la2?: number;
    parameterCategory?: number;
    parameterNumber?: number;
    parameterNumberName?: string;
    refTime?: string;
}

interface GribRecord {
    header: GribHeader;
    data: number[];
}

/** WindGrid from WindStore — multi-hour wind field */
interface WindGrid {
    u: Float32Array[];
    v: Float32Array[];
    width: number;
    height: number;
    lats: number[];
    lons: number[];
    north: number;
    south: number;
    east: number;
    west: number;
    totalHours: number;
}

interface MapboxVelocityOverlayProps {
    mapboxMap: mapboxgl.Map | null;
    visible: boolean;
    windHour?: number;
    windGrid?: WindGrid;
    hideBadge?: boolean;
}

// Speed-based wind particle scale — steel blue → amber → coral
const WIND_COLORS = [
    '#8ca5c7', // 0-10 kts: Calm (steel blue)
    '#a8b08c', // 10-15 kts: Moderate (muted sage)
    '#d9bf80', // 15-20 kts: Fresh (warm amber)
    '#d9a060', // 20-25 kts: Strong (deep amber)
    '#cc6650', // 25-35 kts: Near Gale (burnt orange)
    '#e05a50', // 35+ kts: Severe (coral red)
];

// ── Helper: Create velocity layer ─────────────────────────────

function createVelocityLayer(data: GribRecord[]): L.Layer {
     
    return (L as unknown as Record<string, (...args: unknown[]) => L.Layer>).velocityLayer({
        displayValues: false, // No mouse readout (overlay has pointer-events: none)
        data,
        maxVelocity: 40,
        velocityScale: 0.015,
        particleAge: 60,
        particleMultiplier: 1 / 150,
        frameRate: 15,
        lineWidth: 3.5,
        colorScale: WIND_COLORS,
    });
}

// ── Helper: Wind speed heat map (Mapbox image source) ─────────

const HEATMAP_SOURCE = 'wind-heatmap-src';
const HEATMAP_LAYER = 'wind-heatmap-layer';

/** Monochrome color stops: [maxKts, r, g, b] */
const BEAUFORT_STOPS: [number, number, number, number][] = [
    [5, 15, 18, 23], // calm — near-black
    [10, 30, 33, 40], // light — dark slate
    [15, 50, 53, 60], // moderate — mid slate
    [20, 75, 78, 84], // fresh — grey
    [25, 107, 107, 110], // strong — light grey
    [30, 140, 102, 76], // gale — muted amber
    [40, 166, 76, 71], // storm — muted coral
    [999, 178, 64, 76], // violent — warm red
];

function ktsToColor(kts: number): [number, number, number] {
    for (const [max, r, g, b] of BEAUFORT_STOPS) {
        if (kts <= max) return [r, g, b];
    }
    return [178, 64, 76];
}

function _injectHeatMap(map: mapboxgl.Map, windData: GribRecord[]): void {
    const uRecord = windData.find(
        (d: GribRecord) => d.header?.parameterNumberName?.includes('U-component') || d.header?.parameterNumber === 2,
    );
    const vRecord = windData.find(
        (d: GribRecord) => d.header?.parameterNumberName?.includes('V-component') || d.header?.parameterNumber === 3,
    );
    if (!uRecord || !vRecord) {
        return;
    }

    const header = uRecord.header;
    const nx = header.nx;
    const ny = header.ny;
    const lo1 = header.lo1;
    const la1 = header.la1;
    const la2 = header.la2 ?? la1 - (ny - 1) * header.dy;

    // Paint wind speed pixels
    const canvas = document.createElement('canvas');
    canvas.width = nx;
    canvas.height = ny;
    const ctx = canvas.getContext('2d')!;
    const imgData = ctx.createImageData(nx, ny);
    for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
            const i = y * nx + x;
            const u = uRecord.data[i] ?? 0;
            const v = vRecord.data[i] ?? 0;
            const speedKts = Math.sqrt(u * u + v * v) * 1.94384;
            const [r, g, b] = ktsToColor(speedKts);
            const px = i * 4;
            imgData.data[px] = r;
            imgData.data[px + 1] = g;
            imgData.data[px + 2] = b;
            imgData.data[px + 3] = 40;
        }
    }
    ctx.putImageData(imgData, 0, 0);

    // Mapbox Mercator can't handle ±90° latitude (infinity at poles)
    const MERCATOR_LAT_LIMIT = 85.0;
    const north = Math.min(Math.max(la1, la2), MERCATOR_LAT_LIMIT);
    const south = Math.max(Math.min(la1, la2), -MERCATOR_LAT_LIMIT);
    const west = lo1;
    const east = lo1 + (nx - 1) * header.dx;
    const flipY = la1 < la2;

    // Compute actual longitude span (handles wrapping: west=48°, east=-121° → span=191°)
    let lonSpan = east - west;
    if (lonSpan < 0) lonSpan += 360; // Handle wrapped/negative east values

    // Helper: slice a column range from the canvas, upscale, return dataURL
    const sliceToDataUrl = (startX: number, w: number) => {
        const slice = document.createElement('canvas');
        slice.width = w;
        slice.height = ny;
        slice.getContext('2d')!.drawImage(canvas, startX, 0, w, ny, 0, 0, w, ny);
        const sm = document.createElement('canvas');
        sm.width = w * 2;
        sm.height = ny * 2;
        const sc = sm.getContext('2d')!;
        sc.imageSmoothingEnabled = true;
        sc.imageSmoothingQuality = 'high';
        if (flipY) {
            sc.translate(0, sm.height);
            sc.scale(1, -1);
        }
        sc.drawImage(slice, 0, 0, sm.width, sm.height);
        return sm.toDataURL('image/png');
    };

    // Clean up any previous heat map layers
    removeHeatMap(map);

    const crossesDateLine = east > 180 && lonSpan <= 180;

    if (crossesDateLine) {
        // Split at 180° into two image sources
        const splitCol = Math.ceil((180 - west) / header.dx);
        const leftW = splitCol;
        const rightW = nx - splitCol;

        // Left: west → 180°
        map.addSource(HEATMAP_SOURCE, {
            type: 'image',
            url: sliceToDataUrl(0, leftW),
            coordinates: [
                [west, north],
                [180, north],
                [180, south],
                [west, south],
            ],
        });
        map.addLayer({
            id: HEATMAP_LAYER,
            type: 'raster',
            source: HEATMAP_SOURCE,
            paint: { 'raster-opacity': 0.12, 'raster-fade-duration': 300 },
        });

        // Right: -180° → (east - 360)
        const rSrc = HEATMAP_SOURCE + '_r';
        const rLyr = HEATMAP_LAYER + '_r';
        map.addSource(rSrc, {
            type: 'image',
            url: sliceToDataUrl(splitCol, rightW),
            coordinates: [
                [-180, north],
                [east - 360, north],
                [east - 360, south],
                [-180, south],
            ],
        });
        map.addLayer({
            id: rLyr,
            type: 'raster',
            source: rSrc,
            paint: { 'raster-opacity': 0.12, 'raster-fade-duration': 300 },
        });
    } else if (lonSpan > 180) {
        // ── Global GFS data: lon 0°→359.5° ──
        // Must split into two ≤180° image sources for Mapbox.
        // GFS columns 0..359   → Eastern Hemisphere  (0°→180°)
        // GFS columns 360..719 → Western Hemisphere  (-180°→0°)
        const dx = header.dx;

        // Eastern hemisphere: 0° → 180°
        const eastColStart = 0;
        const eastColEnd = Math.round(180 / dx); // col 360
        const eastSliceW = eastColEnd - eastColStart;

        // Western hemisphere: columns 360..719 represent 180°→359.5° which is -180°→-0.5°
        const westColStart = eastColEnd;
        const westColEnd = nx;
        const westSliceW = westColEnd - westColStart;

        // Western Hemisphere first (behind in layer order)
        if (westSliceW > 0) {
            const westLonMin = -180;
            const westLonMax = west + (westColEnd - 1) * dx - 360; // ≈ -0.5°

            map.addSource(HEATMAP_SOURCE, {
                type: 'image',
                url: sliceToDataUrl(westColStart, westSliceW),
                coordinates: [
                    [westLonMin, north],
                    [westLonMax, north],
                    [westLonMax, south],
                    [westLonMin, south],
                ],
            });
            map.addLayer({
                id: HEATMAP_LAYER,
                type: 'raster',
                source: HEATMAP_SOURCE,
                paint: { 'raster-opacity': 0.12, 'raster-fade-duration': 300 },
            });
        }

        // Eastern Hemisphere
        if (eastSliceW > 0) {
            const eastLonMin = 0;
            const eastLonMax = 180;

            const rSrc = HEATMAP_SOURCE + '_r';
            const rLyr = HEATMAP_LAYER + '_r';
            map.addSource(rSrc, {
                type: 'image',
                url: sliceToDataUrl(eastColStart, eastSliceW),
                coordinates: [
                    [eastLonMin, north],
                    [eastLonMax, north],
                    [eastLonMax, south],
                    [eastLonMin, south],
                ],
            });
            map.addLayer({
                id: rLyr,
                type: 'raster',
                source: rSrc,
                paint: { 'raster-opacity': 0.12, 'raster-fade-duration': 300 },
            });
        }
    } else {
        // Standard single image — fits within 180° span
        const url = sliceToDataUrl(0, nx);
        map.addSource(HEATMAP_SOURCE, {
            type: 'image',
            url,
            coordinates: [
                [west, north],
                [east, north],
                [east, south],
                [west, south],
            ],
        });
        map.addLayer({
            id: HEATMAP_LAYER,
            type: 'raster',
            source: HEATMAP_SOURCE,
            paint: { 'raster-opacity': 0.12, 'raster-fade-duration': 300 },
        });
    }
}

function removeHeatMap(map: mapboxgl.Map): void {
    try {
        if (map.getLayer(HEATMAP_LAYER)) map.removeLayer(HEATMAP_LAYER);
        if (map.getSource(HEATMAP_SOURCE)) map.removeSource(HEATMAP_SOURCE);
        const rLyr = HEATMAP_LAYER + '_r';
        const rSrc = HEATMAP_SOURCE + '_r';
        if (map.getLayer(rLyr)) map.removeLayer(rLyr);
        if (map.getSource(rSrc)) map.removeSource(rSrc);
    } catch (_) {
        /* ok */
    }
}

// ── Helper: Relative time formatter ──────────────────────────

function formatRelativeTime(isoString: string): string {
    const then = new Date(isoString).getTime();
    const now = Date.now();
    const diffMs = now - then;
    const mins = Math.floor(diffMs / 60_000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min${mins > 1 ? 's' : ''} ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs} hr${hrs > 1 ? 's' : ''} ago`;
    const days = Math.floor(hrs / 24);
    return `${days} day${days > 1 ? 's' : ''} ago`;
}

// ── Helper: Fetch with Cache API offline fallback ─────────────

interface WindFetchResult {
    data: GribRecord[];
    source: 'live' | 'cached' | 'static';
}

async function fetchWindData(map: mapboxgl.Map): Promise<WindFetchResult> {
    // Use actual viewport bounds with generous padding
    const bounds = map.getBounds()!;
    const latSpan = bounds.getNorth() - bounds.getSouth();
    const lonSpan = bounds.getEast() - bounds.getWest();

    let north: number, south: number, west: number, east: number;

    if (latSpan > 60) {
        // Zoomed out enough to see continents — request full global coverage
        north = 90;
        south = -90;
        west = -180;
        east = 180;
    } else {
        // Regional view — 30% padding
        const latPad = latSpan * 0.3;
        const lonPad = lonSpan * 0.3;
        north = Math.min(bounds.getNorth() + latPad, 90);
        south = Math.max(bounds.getSouth() - latPad, -90);
        west = bounds.getWest() - lonPad;
        east = bounds.getEast() + lonPad;

        // Dateline handling: if viewport crosses 180° meridian,
        // west > east (e.g. west=170, east=-170). Request full longitude.
        if (west > east) {
            west = -180;
            east = 180;
        }
    }

    const body = JSON.stringify({ north, south, east, west });
    const cacheKey = `${SUPABASE_URL}${EDGE_FN_PATH}?n=${north.toFixed(0)}&s=${south.toFixed(0)}&w=${west.toFixed(0)}&e=${east.toFixed(0)}`;

    try {
        const res = await fetch(`${SUPABASE_URL}${EDGE_FN_PATH}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                apikey: SUPABASE_KEY,
                Authorization: `Bearer ${SUPABASE_KEY}`,
            },
            body,
        });

        if (!res.ok) throw new Error(`Edge function HTTP ${res.status}`);

        const cache = await caches.open(WIND_CACHE_NAME);
        // Cache with a key based on the bounds
        await cache.put(cacheKey, res.clone());

        return { data: await res.json(), source: 'live' };
    } catch (err) {
        const cache = await caches.open(WIND_CACHE_NAME);
        const cached = await cache.match(cacheKey);

        if (cached) {
            return { data: await cached.json(), source: 'cached' };
        }

        const fallback = await fetch('/wind_test.json');
        if (fallback.ok) return { data: await fallback.json(), source: 'static' };

        throw new Error('No wind data available (online or cached)');
    }
}

// ── Component ─────────────────────────────────────────────────

export const MapboxVelocityOverlay: React.FC<MapboxVelocityOverlayProps> = ({
    mapboxMap,
    visible,
    windHour = 0,
    windGrid,
    hideBadge = false,
}) => {
    const overlayRef = useRef<HTMLDivElement | null>(null);
    const leafletMapRef = useRef<L.Map | null>(null);
    const velocityLayerRef = useRef<L.Layer | null>(null);
    const syncRef = useRef<(() => void) | null>(null);
    const moveRef = useRef<(() => void) | null>(null);
    const resizeRef = useRef<(() => void) | null>(null);
    const [windData, setWindData] = useState<GribRecord[] | null>(null);
    const [dataInfo, setDataInfo] = useState<{ refTime: string | null; source: 'live' | 'cached' | 'static' | null }>({
        refTime: null,
        source: null,
    });

    const lastFetchZoom = useRef<number | null>(null);
    const fetchingRef = useRef(false);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // ── Fetch wind data for current viewport ─────────────────────
    useEffect(() => {
        if (!visible || !mapboxMap) return;
        let cancelled = false;

        const doFetch = async () => {
            if (fetchingRef.current) return;
            fetchingRef.current = true;
            try {
                const result = await fetchWindData(mapboxMap);
                if (!cancelled) {
                    setWindData(result.data);
                    lastFetchZoom.current = mapboxMap.getZoom();
                    const refTime = result.data?.[0]?.header?.refTime ?? null;
                    const _h = result.data?.[0]?.header;
                    setDataInfo({ refTime, source: result.source });
                }
            } catch (err) {
                log.error('[VelocityOverlay] All data sources failed:', err);
            } finally {
                fetchingRef.current = false;
            }
        };

        // Only re-fetch when zoom changes significantly — panning within the
        // same zoom level doesn't need new data (fetchWindData uses generous padding).
        const onMoveEnd = () => {
            const currentZoom = mapboxMap.getZoom();
            const zoomDelta = Math.abs(currentZoom - (lastFetchZoom.current ?? currentZoom));
            if (zoomDelta < 1) return; // Skip re-fetch for minor zoom/pan
            if (debounceRef.current) clearTimeout(debounceRef.current);
            debounceRef.current = setTimeout(() => doFetch(), 600);
        };

        doFetch();
        mapboxMap.on('moveend', onMoveEnd);

        return () => {
            cancelled = true;
            if (debounceRef.current) clearTimeout(debounceRef.current);
            mapboxMap.off('moveend', onMoveEnd);
        };
    }, [visible, mapboxMap]);

    // ── Update velocity layer data when windHour changes (scrubber) ──
    useEffect(() => {
        if (!windGrid || !velocityLayerRef.current || !leafletMapRef.current) return;
        const hFloat = Math.min(windHour, windGrid.totalHours - 1);
        if (hFloat < 0) return;

        const h0 = Math.floor(hFloat);
        const h1 = Math.min(h0 + 1, windGrid.totalHours - 1);
        const lerp = hFloat - h0; // 0.0 to ~0.9

        // Get source data for both hours
        const u0 = windGrid.u[h0];
        const v0 = windGrid.v[h0];
        const u1 = windGrid.u[h1];
        const v1 = windGrid.v[h1];
        if (!u0 || !v0) return;

        const nx = windGrid.width;
        const ny = windGrid.height;

        // Interpolate U/V between hours and flip rows (south→north to north→south)
        const uFlipped = new Array(nx * ny);
        const vFlipped = new Array(nx * ny);
        for (let row = 0; row < ny; row++) {
            const srcRow = (ny - 1 - row) * nx;
            const dstRow = row * nx;
            for (let col = 0; col < nx; col++) {
                const si = srcRow + col;
                const di = dstRow + col;
                if (lerp < 0.01 || !u1 || !v1) {
                    // No interpolation needed — exact hour
                    uFlipped[di] = u0[si];
                    vFlipped[di] = v0[si];
                } else {
                    // Smooth blend between hours
                    uFlipped[di] = u0[si] * (1 - lerp) + u1[si] * lerp;
                    vFlipped[di] = v0[si] * (1 - lerp) + v1[si] * lerp;
                }
            }
        }

        const dx = windGrid.lons.length > 1 ? Math.abs(windGrid.lons[1] - windGrid.lons[0]) : 1;
        const dy = windGrid.lats.length > 1 ? Math.abs(windGrid.lats[1] - windGrid.lats[0]) : 1;

        const header = {
            nx,
            ny,
            dx,
            dy,
            lo1: windGrid.west,
            lo2: windGrid.east,
            la1: windGrid.north,
            la2: windGrid.south,
            parameterCategory: 2,
            parameterNumber: 2,
            parameterNumberName: 'U-component_of_wind',
        };

        const newData = [
            { header: { ...header, parameterNumber: 2, parameterNumberName: 'U-component_of_wind' }, data: uFlipped },
            { header: { ...header, parameterNumber: 3, parameterNumberName: 'V-component_of_wind' }, data: vFlipped },
        ];

        // Update wind data smoothly — bypass clearAndRestart to keep particles alive.
        // Particles naturally pick up new wind vectors on their next animation frame.
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const vl = velocityLayerRef.current as any;
            if (vl._windy) {
                // Directly update the internal Windy grid — particles keep their positions
                // and tails, but their movement direction shifts to match new wind data
                vl._windy.setData(newData);
                // Don't call clearAndRestart — that's what causes the "dots" reset
            } else if (typeof vl.setData === 'function') {
                vl.setData(newData);
            } else {
                // Fallback: recreate layer
                if (leafletMapRef.current.hasLayer(velocityLayerRef.current)) {
                    leafletMapRef.current.removeLayer(velocityLayerRef.current);
                }
                const layer = createVelocityLayer(newData);
                layer.addTo(leafletMapRef.current);
                velocityLayerRef.current = layer;
            }

            // Re-sync viewport to ensure wind stays geolocked
            if (syncRef.current) syncRef.current();
        } catch (err) {
            log.error('[VelocityOverlay] Failed to update forecast hour:', err);
        }
    }, [windHour, windGrid]);

    // ── Heat map layer DISABLED — clean dark map with particles only ──
    // useEffect(() => {
    //     if (!mapboxMap || !visible || !windData) return;
    //     try { injectHeatMap(mapboxMap, windData); } catch (err) { log.error('[HeatMap]', err); }
    //     return () => { removeHeatMap(mapboxMap); };
    // }, [mapboxMap, visible, windData]);

    // ── Zoom-based particle visibility (heatmap disabled) ──
    useEffect(() => {
        if (!mapboxMap || !visible) return;
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
    }, [mapboxMap, visible]);

    // ── Create/destroy particle overlay ──────────────────────────
    useEffect(() => {
        if (!mapboxMap || !visible || !windData) return;

        let cancelled = false;

        const setup = async () => {
            // Ensure Leaflet is on window BEFORE the plugin loads
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            window.L = L;
            await import('leaflet-velocity-ts');

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

            // Inject velocity layer via helper
            const vLayer = createVelocityLayer(windData);
            vLayer.addTo(lMap);
            velocityLayerRef.current = vLayer;

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
            syncRef.current = syncFull;
            moveRef.current = correctOnly;
            resizeRef.current = onResize;

            // Initial sync, then fade in
            lMap.invalidateSize();
            syncFull();
            // Fade in after velocity canvas has rendered its first frame
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    if (overlayRef.current) overlayRef.current.style.opacity = '1';
                });
            });
        };

        setup().catch((err) => log.error('[VelocityOverlay] Setup failed:', err));

        // ── Cleanup ──────────────────────────────────────────────
        return () => {
            cancelled = true;

            try {
                if (moveRef.current) mapboxMap.off('move', moveRef.current);
                if (syncRef.current) {
                    mapboxMap.off('moveend', syncRef.current);
                    mapboxMap.off('zoom', syncRef.current);
                }
                if (resizeRef.current) mapboxMap.off('resize', resizeRef.current);
            } catch (_) {
                /* ok */
            }
            syncRef.current = null;
            moveRef.current = null;
            resizeRef.current = null;

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
    }, [mapboxMap, visible, windData]);

    // ── Data freshness badge ─────────────────────────────────────
    if (!visible || !dataInfo.refTime || hideBadge) return null;

    const isOffline = dataInfo.source === 'cached' || dataInfo.source === 'static';
    const ageStr = formatRelativeTime(dataInfo.refTime);

    const isSmallContainer = mapboxMap?.getContainer()?.clientHeight
        ? mapboxMap.getContainer().clientHeight < 300
        : false;

    return (
        <div
            className={`absolute ${isSmallContainer ? 'top-2 left-2' : 'top-14 left-4'} z-[600] flex items-center gap-2 px-3 py-1.5 rounded-xl border shadow-lg text-[11px] font-bold`}
            style={{
                background: isOffline ? 'rgba(30, 30, 30, 0.85)' : 'rgba(15, 23, 42, 0.85)',
                borderColor: isOffline ? 'rgba(245, 158, 11, 0.4)' : 'rgba(255, 255, 255, 0.1)',
                color: isOffline ? '#fbbf24' : '#94a3b8',
            }}
        >
            {/* Status dot */}
            <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{
                    background: isOffline ? '#f59e0b' : '#22c55e',
                    boxShadow: isOffline ? '0 0 6px rgba(245, 158, 11, 0.6)' : '0 0 6px rgba(34, 197, 94, 0.6)',
                }}
            />
            {/* Label */}
            <span>
                {isOffline ? '📡 Offline · ' : ''}GFS {ageStr}
            </span>
        </div>
    );
};
