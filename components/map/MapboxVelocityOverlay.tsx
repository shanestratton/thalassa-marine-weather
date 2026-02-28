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

import React, { useEffect, useRef, useState, useCallback } from 'react';
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

interface MapboxVelocityOverlayProps {
    mapboxMap: mapboxgl.Map | null;
    visible: boolean;
}

// Beaufort-inspired marine color scale (Light → Severe)
const WIND_COLORS = [
    '#3498db', // 0-10 kts: Calm/Light (Blue)
    '#2ecc71', // 10-15 kts: Moderate (Green)
    '#f1c40f', // 15-20 kts: Fresh (Yellow)
    '#e67e22', // 20-25 kts: Strong (Orange)
    '#e74c3c', // 25-35 kts: Near Gale/Gale (Red)
    '#8e44ad', // 35+ kts: Severe (Purple)
];

// ── Helper: Create velocity layer ─────────────────────────────

function createVelocityLayer(data: any[]): L.Layer {
    return (L as any).velocityLayer({
        displayValues: false,  // No mouse readout (overlay has pointer-events: none)
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

/** Beaufort color stops: [maxKts, r, g, b] */
const BEAUFORT_STOPS: [number, number, number, number][] = [
    [5, 52, 152, 219],     // calm — blue
    [10, 46, 204, 113],    // light — green
    [15, 241, 196, 15],    // moderate — yellow
    [20, 230, 126, 34],    // fresh — orange
    [25, 231, 76, 60],     // strong — red
    [30, 192, 57, 43],     // gale — dark red
    [40, 142, 68, 173],    // storm — purple
    [999, 100, 30, 120],   // violent — deep purple
];

function ktsToColor(kts: number): [number, number, number] {
    for (const [max, r, g, b] of BEAUFORT_STOPS) {
        if (kts <= max) return [r, g, b];
    }
    return [100, 30, 120];
}

function injectHeatMap(map: mapboxgl.Map, windData: any[]): void {
    const uRecord = windData.find((d: any) => d.header?.parameterNumberName?.includes('U-component') || d.header?.parameterNumber === 2);
    const vRecord = windData.find((d: any) => d.header?.parameterNumberName?.includes('V-component') || d.header?.parameterNumber === 3);
    if (!uRecord || !vRecord) { return; }

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
            imgData.data[px + 3] = 140;
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
        slice.width = w; slice.height = ny;
        slice.getContext('2d')!.drawImage(canvas, startX, 0, w, ny, 0, 0, w, ny);
        const sm = document.createElement('canvas');
        sm.width = w * 2; sm.height = ny * 2;
        const sc = sm.getContext('2d')!;
        sc.imageSmoothingEnabled = true;
        sc.imageSmoothingQuality = 'high';
        if (flipY) { sc.translate(0, sm.height); sc.scale(1, -1); }
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
            type: 'image', url: sliceToDataUrl(0, leftW),
            coordinates: [[west, north], [180, north], [180, south], [west, south]],
        });
        map.addLayer({
            id: HEATMAP_LAYER, type: 'raster', source: HEATMAP_SOURCE,
            paint: { 'raster-opacity': 0.30, 'raster-fade-duration': 300 }
        });

        // Right: -180° → (east - 360)
        const rSrc = HEATMAP_SOURCE + '_r';
        const rLyr = HEATMAP_LAYER + '_r';
        map.addSource(rSrc, {
            type: 'image', url: sliceToDataUrl(splitCol, rightW),
            coordinates: [[-180, north], [east - 360, north], [east - 360, south], [-180, south]],
        });
        map.addLayer({
            id: rLyr, type: 'raster', source: rSrc,
            paint: { 'raster-opacity': 0.30, 'raster-fade-duration': 300 }
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
                type: 'image', url: sliceToDataUrl(westColStart, westSliceW),
                coordinates: [[westLonMin, north], [westLonMax, north], [westLonMax, south], [westLonMin, south]],
            });
            map.addLayer({
                id: HEATMAP_LAYER, type: 'raster', source: HEATMAP_SOURCE,
                paint: { 'raster-opacity': 0.30, 'raster-fade-duration': 300 }
            });
        }

        // Eastern Hemisphere
        if (eastSliceW > 0) {
            const eastLonMin = 0;
            const eastLonMax = 180;

            const rSrc = HEATMAP_SOURCE + '_r';
            const rLyr = HEATMAP_LAYER + '_r';
            map.addSource(rSrc, {
                type: 'image', url: sliceToDataUrl(eastColStart, eastSliceW),
                coordinates: [[eastLonMin, north], [eastLonMax, north], [eastLonMax, south], [eastLonMin, south]],
            });
            map.addLayer({
                id: rLyr, type: 'raster', source: rSrc,
                paint: { 'raster-opacity': 0.30, 'raster-fade-duration': 300 }
            });
        }


    } else {
        // Standard single image — fits within 180° span
        const url = sliceToDataUrl(0, nx);
        map.addSource(HEATMAP_SOURCE, {
            type: 'image', url,
            coordinates: [[west, north], [east, north], [east, south], [west, south]],
        });
        map.addLayer({
            id: HEATMAP_LAYER, type: 'raster', source: HEATMAP_SOURCE,
            paint: { 'raster-opacity': 0.30, 'raster-fade-duration': 300 }
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
    } catch (_) { /* ok */ }
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
    data: any[];
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
        west = bounds.getWest() - lonSpan * 0.3;
        east = bounds.getEast() + lonSpan * 0.3;
    } else {
        // Regional view — 30% padding
        const latPad = latSpan * 0.3;
        const lonPad = lonSpan * 0.3;
        north = Math.min(bounds.getNorth() + latPad, 90);
        south = Math.max(bounds.getSouth() - latPad, -90);
        west = bounds.getWest() - lonPad;
        east = bounds.getEast() + lonPad;
    }

    const body = JSON.stringify({ north, south, east, west });
    const cacheKey = `${SUPABASE_URL}${EDGE_FN_PATH}?n=${north.toFixed(0)}&s=${south.toFixed(0)}&w=${west.toFixed(0)}&e=${east.toFixed(0)}`;

    try {
        const res = await fetch(`${SUPABASE_URL}${EDGE_FN_PATH}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`,
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
}) => {
    const overlayRef = useRef<HTMLDivElement | null>(null);
    const leafletMapRef = useRef<L.Map | null>(null);
    const velocityLayerRef = useRef<L.Layer | null>(null);
    const syncRef = useRef<(() => void) | null>(null);
    const resizeRef = useRef<(() => void) | null>(null);
    const [windData, setWindData] = useState<any[] | null>(null);
    const [dataInfo, setDataInfo] = useState<{ refTime: string | null; source: 'live' | 'cached' | 'static' | null }>({ refTime: null, source: null });

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
                    const h = result.data?.[0]?.header;
                    setDataInfo({ refTime, source: result.source });
                }
            } catch (err) {
                console.error('[VelocityOverlay] All data sources failed:', err);
            } finally {
                fetchingRef.current = false;
            }
        };

        // Debounced re-fetch on EVERY move — seamless exploration
        const onMoveEnd = () => {
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

    // ── Heat map layer (synchronous, decoupled from async Leaflet setup) ──
    useEffect(() => {
        if (!mapboxMap || !visible || !windData) {
            return;
        }
        try {
            injectHeatMap(mapboxMap, windData);
            // Verify layers were created
            const hasMain = !!mapboxMap.getLayer(HEATMAP_LAYER);
            const hasRight = !!mapboxMap.getLayer(HEATMAP_LAYER + '_r');
        } catch (err) {
            console.error('[HeatMap] Injection failed:', err);
        }
        return () => { removeHeatMap(mapboxMap); };
    }, [mapboxMap, visible, windData]);

    // ── Hide particles at low zoom (heatmap stays visible at all zooms) ──
    useEffect(() => {
        if (!mapboxMap || !visible) return;
        const MIN_PARTICLE_ZOOM = 4;

        const onZoom = () => {
            const z = mapboxMap.getZoom();
            const showParticles = z >= MIN_PARTICLE_ZOOM;

            // Toggle Leaflet particle overlay div (hide at low zoom — too chaotic)
            if (overlayRef.current) {
                overlayRef.current.style.display = showParticles ? '' : 'none';
            }

            // Heatmap always visible — ensure it's injected
            if (windData && !mapboxMap.getSource(HEATMAP_SOURCE)) {
                try { injectHeatMap(mapboxMap, windData); } catch (_) { /* ok */ }
            }
        };

        mapboxMap.on('zoom', onZoom);
        onZoom(); // Apply immediately
        return () => { mapboxMap.off('zoom', onZoom); };
    }, [mapboxMap, visible, windData]);

    // ── Create/destroy particle overlay ──────────────────────────
    useEffect(() => {
        if (!mapboxMap || !visible || !windData) return;

        let cancelled = false;

        const setup = async () => {
            // Ensure Leaflet is on window BEFORE the plugin loads
            (window as any).L = L;
            await import('leaflet-velocity-ts');

            if (cancelled) return;

            const container = mapboxMap.getContainer();

            // Create overlay div on top of Mapbox
            const div = document.createElement('div');
            div.style.cssText = 'position:absolute;inset:0;z-index:400;pointer-events:none;';
            container.appendChild(div);
            overlayRef.current = div;

            // Create headless Leaflet map (transparent, no tiles, no controls)
            const center = mapboxMap.getCenter();
            const zoom = mapboxMap.getZoom();
            const lMap = L.map(div, {
                center: [center.lat, center.lng],
                zoom: zoom + 1,             // Mapbox 512px tiles vs Leaflet 256px = +1 offset
                zoomControl: false,
                attributionControl: false,
                dragging: false,
                touchZoom: false,
                doubleClickZoom: false,
                scrollWheelZoom: false,
                boxZoom: false,
                keyboard: false,
                zoomAnimation: false,
                zoomSnap: 0,                // Allow fractional zoom to match Mapbox
                worldCopyJump: true,        // Prevent painting across repeating worlds
                maxBounds: [[-90, -180], [90, 180]],
            });
            leafletMapRef.current = lMap;

            // Make Leaflet fully transparent — no white background over Mapbox
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

            // ── Sync Leaflet viewport to Mapbox (frame-perfect) ─────
            const syncViewport = () => {
                if (!leafletMapRef.current || !mapboxMap) return;
                try {
                    const c = mapboxMap.getCenter();
                    const z = mapboxMap.getZoom() + 1;
                    leafletMapRef.current.setView([c.lat, c.lng], z, { animate: false });
                } catch (_) { /* velocity canvas not ready yet */ }
            };

            const onResize = () => {
                leafletMapRef.current?.invalidateSize();
                syncViewport();
            };

            mapboxMap.on('render', syncViewport);
            mapboxMap.on('resize', onResize);
            syncRef.current = syncViewport;
            resizeRef.current = onResize;

            // Initial sync
            lMap.invalidateSize();
            syncViewport();
        };

        setup().catch(err => console.error('[VelocityOverlay] Setup failed:', err));

        // ── Cleanup ──────────────────────────────────────────────
        return () => {
            cancelled = true;

            try {
                if (syncRef.current) mapboxMap.off('render', syncRef.current);
                if (resizeRef.current) mapboxMap.off('resize', resizeRef.current);
            } catch (_) { /* ok */ }
            syncRef.current = null;
            resizeRef.current = null;

            // Remove heat map from Mapbox
            // Heat map has its own useEffect lifecycle — don't touch it here

            // Remove velocity layer
            try {
                if (velocityLayerRef.current && leafletMapRef.current?.hasLayer(velocityLayerRef.current)) {
                    leafletMapRef.current.removeLayer(velocityLayerRef.current);
                }
            } catch (_) { /* ok */ }
            velocityLayerRef.current = null;

            // Destroy Leaflet map (also detaches its container div)
            try {
                if (leafletMapRef.current) {
                    leafletMapRef.current.remove();
                }
            } catch (_) { /* ok */ }
            leafletMapRef.current = null;

            // Remove overlay div (may already be gone after lMap.remove())
            try {
                if (overlayRef.current?.parentNode) {
                    overlayRef.current.parentNode.removeChild(overlayRef.current);
                }
            } catch (_) { /* ok */ }
            overlayRef.current = null;
        };
    }, [mapboxMap, visible, windData]);

    // ── Data freshness badge ─────────────────────────────────────
    if (!visible || !dataInfo.refTime) return null;

    const isOffline = dataInfo.source === 'cached' || dataInfo.source === 'static';
    const ageStr = formatRelativeTime(dataInfo.refTime);

    const isSmallContainer = mapboxMap?.getContainer()?.clientHeight ? mapboxMap.getContainer().clientHeight < 300 : false;

    return (
        <div
            className={`absolute ${isSmallContainer ? 'top-2 left-2' : 'top-14 left-4'} z-[600] flex items-center gap-2 px-3 py-1.5 rounded-xl backdrop-blur-xl border shadow-lg text-[11px] font-bold`}
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
