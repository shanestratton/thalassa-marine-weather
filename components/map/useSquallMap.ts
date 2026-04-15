/**
 * useSquallMap — Global IR Squall Detection Map
 *
 * Uses SSEC RealEarth globalir-avn Dvorak-enhanced IR composite to
 * highlight deep convection and squall threats.
 *
 *  Satellite coverage: Global composite (GOES + Himawari + Meteosat)
 *  Resolution: ~4km, hourly updates
 *  Tile source: SSEC RealEarth (pre-enhanced Dvorak BD colour curve)
 *  Zoom clamped ≤ 6 for best tile alignment.
 *
 *  Data source: SSEC via Supabase edge proxy
 *  Radar overlay: RainViewer (actual precipitation intensity)
 */

import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import { createLogger } from '../../utils/createLogger';
import type { ActiveCyclone } from '../../services/weather/CycloneTrackingService';

const log = createLogger('SquallMap');

// ── Layer/Source IDs ──
const SQUALL_SOURCE = 'squall-ir-source';
const SQUALL_LAYER = 'squall-ir-layer';
const RADAR_SOURCE = 'squall-radar-source';
const RADAR_LAYER = 'squall-radar-layer';
const SQUALL_HUD_ID = 'squall-map-hud';

// ── SSEC RealEarth globalir-avn via Supabase edge function proxy ──
// Uses SSEC Dvorak-enhanced IR composite (reliable, pre-coloured tiles).
// SSEC/nowCOAST was tested but returns 502 — NOAA service unreliable.
// Tiles clamped to zoom ≤ 6 where alignment is good.
const SUPABASE_URL = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) || '';

/** Build the edge function proxy tile URL with cache-bust */
function buildTileUrl(cacheBust: number): string {
    return `${SUPABASE_URL}/functions/v1/satellite-tile?sat=ssec-ir&x={x}&y={y}&z={z}&_cb=${cacheBust}`;
}

/**
 * BD Enhancement Curve — Mapbox GL raster-color expression.
 *
 * KEY FIX: raster-color-range is set to [150, 255] instead of [0, 255].
 * This stretches ONLY the cloud pixel brightness range (150-255) across
 * the full 0.0→1.0 interpolation scale, amplifying differences between
 * regular clouds and deep convection:
 *
 *   Pixel 150 → 0.0  (thin cloud, edge of visibility)
 *   Pixel 180 → 0.29 (regular trade-wind clouds)
 *   Pixel 200 → 0.48 (thick cloud mass)
 *   Pixel 220 → 0.67 (deep convection, cyclone wall)
 *   Pixel 240 → 0.86 (severe convection)
 *   Pixel 255 → 1.0  (extreme overshooting tops)
 */
const _BD_ENHANCEMENT_RAMP: mapboxgl.Expression = [
    'interpolate',
    ['linear'],
    ['raster-value'],
    // Thin/edge clouds → transparent (pixels 150-165)
    0.0,
    'rgba(0, 0, 0, 0)',
    0.14,
    'rgba(0, 0, 0, 0)',

    // Regular clouds → subtle gray overlay (pixels 165-185)
    0.18,
    'rgba(40, 42, 54, 0.12)',
    0.3,
    'rgba(55, 58, 68, 0.20)',

    // -30°C threshold — developing convection (pixels ~190-200)
    0.38,
    'rgba(0, 255, 255, 0.45)', // Cyan — thickening
    0.45,
    'rgba(0, 128, 255, 0.50)', // Blue

    // -40°C threshold — moderate (pixels ~200-215)
    0.52,
    'rgba(0, 220, 0, 0.55)', // Green — CB developing
    0.58,
    'rgba(255, 255, 0, 0.62)', // Yellow

    // -50°C threshold — active squall (pixels ~215-230)
    0.65,
    'rgba(255, 165, 0, 0.70)', // Orange — mature squall
    0.72,
    'rgba(255, 40, 0, 0.78)', // Red — heavy rain

    // -60°C threshold — severe (pixels ~230-240)
    0.78,
    'rgba(180, 0, 0, 0.82)', // Dark Red — violent cell
    0.84,
    'rgba(139, 0, 0, 0.85)', // Deeper red

    // -70°C threshold — extreme (pixels ~240-255)
    0.9,
    'rgba(128, 0, 128, 0.88)', // Purple — overshooting tops
    0.95,
    'rgba(200, 150, 255, 0.90)', // Light purple
    1.0,
    'rgba(255, 255, 255, 0.93)', // White — extreme
];

// ── Hook ──

export function useSquallMap(
    mapRef: React.MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    visible: boolean,
    userLat?: number,
    userLon?: number,
    allCyclones?: ActiveCyclone[],
    onSelectStorm?: (storm: ActiveCyclone) => void,
) {
    const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);
    const ageTimer = useRef<ReturnType<typeof setInterval> | null>(null);
    const latestTileTime = useRef<Date | null>(null);
    const isSetUp = useRef(false);
    const stormMarkersRef = useRef<mapboxgl.Marker[]>([]);
    /** Save previous maxZoom so we can restore when squall deactivates */
    const prevMaxZoomRef = useRef<number | null>(null);
    /** Zoom-snap listener ref (integer-only zoom for crisp tiles) */
    const zoomSnapRef = useRef<(() => void) | null>(null);

    // Squall map zoom — integer-only so satellite tiles render at native
    // resolution with no fractional upscaling artefacts.
    const SQUALL_MAX_ZOOM = 6;

    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;

        // ── Teardown when hidden ──
        if (!visible) {
            cleanupSquallLayers(map);
            isSetUp.current = false;
            latestTileTime.current = null;
            if (refreshTimer.current) {
                clearInterval(refreshTimer.current);
                refreshTimer.current = null;
            }
            if (ageTimer.current) {
                clearInterval(ageTimer.current);
                ageTimer.current = null;
            }
            // Remove integer-zoom snap listener
            if (zoomSnapRef.current) {
                map.off('zoomend', zoomSnapRef.current);
                zoomSnapRef.current = null;
            }
            // Clean up storm markers
            for (const m of stormMarkersRef.current) m.remove();
            stormMarkersRef.current = [];

            // Restore previous maxZoom
            if (prevMaxZoomRef.current !== null) {
                map.setMaxZoom(prevMaxZoomRef.current);
                prevMaxZoomRef.current = null;
            }
            return;
        }

        // ── Setup squall IR layer ──
        if (!isSetUp.current) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ausNzMin: number = (map as any).__ausNzMinZoom ?? 3;
            const minInt = Math.round(ausNzMin);
            prevMaxZoomRef.current = map.getMaxZoom();
            map.setMinZoom(minInt);
            map.setMaxZoom(SQUALL_MAX_ZOOM);

            // Always start at AU+NZ default zoom (integer) centred on user.
            // This matches the app's approved default view — full width of
            // Australia + NZ visible, user location centred if available.
            const targetZoom = minInt; // AU+NZ fit zoom, rounded to integer
            if (userLat && userLon && isFinite(userLat) && isFinite(userLon)) {
                map.flyTo({ center: [userLon, userLat], zoom: targetZoom, duration: 800 });
            } else {
                map.easeTo({ center: [145, -28], zoom: targetZoom, duration: 400 });
            }

            // Snap zoom to integers so tiles render at native resolution
            const onZoomEnd = () => {
                const z = map.getZoom();
                const snapped = Math.max(minInt, Math.min(Math.round(z), SQUALL_MAX_ZOOM));
                if (Math.abs(z - snapped) > 0.05) {
                    map.easeTo({ zoom: snapped, duration: 150 });
                }
            };
            map.on('zoomend', onZoomEnd);
            zoomSnapRef.current = onZoomEnd;

            addSquallLayer(map);
            addRadarLayer(map);
            addSquallHUD(map);
            fetchDataTimestamp(latestTileTime, map);
            isSetUp.current = true;
            log.info('🌩️ Squall map activated — integer-zoom tiles + radar');
        }

        // ── Live data age ticker (updates every 60s) ──
        if (!ageTimer.current) {
            ageTimer.current = setInterval(() => {
                updateDataAge(map, latestTileTime.current);
            }, 60 * 1000);
        }

        // ── Auto-refresh every 10 minutes (pick up new hourly composites) ──
        if (!refreshTimer.current) {
            refreshTimer.current = setInterval(
                () => {
                    refreshSquallSource(map);
                    refreshRadarLayer(map);
                    fetchDataTimestamp(latestTileTime, map);
                },
                10 * 60 * 1000,
            );
        }

        return () => {
            if (refreshTimer.current) {
                clearInterval(refreshTimer.current);
                refreshTimer.current = null;
            }
            if (ageTimer.current) {
                clearInterval(ageTimer.current);
                ageTimer.current = null;
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible, mapReady]);

    // ── Cyclone spinners on squall map ──
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady || !visible || !allCyclones?.length) {
            // Clear markers if no cyclones or not visible
            for (const m of stormMarkersRef.current) m.remove();
            stormMarkersRef.current = [];
            return;
        }

        // Rebuild markers
        for (const m of stormMarkersRef.current) m.remove();
        stormMarkersRef.current = [];

        for (const cyclone of allCyclones) {
            const el = createSquallSpinnerEl(cyclone);
            el.addEventListener('click', (e: MouseEvent) => {
                e.stopPropagation();
                // Hide immediately so it doesn't fly to [0,0] during layer switch
                el.style.display = 'none';
                onSelectStorm?.(cyclone);
            });

            const marker = new mapboxgl.Marker({ element: el })
                .setLngLat([cyclone.currentPosition.lon, cyclone.currentPosition.lat])
                .addTo(map);

            stormMarkersRef.current.push(marker);
        }

        log.info(`🌀 Added ${allCyclones.length} cyclone spinner(s) to squall map`);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible, mapReady, allCyclones?.length]);
}

// ── Compact cyclone spinner for squall map ──

/** Create a small clickable cyclone spinner marker for the squall map */
function createSquallSpinnerEl(cyclone: ActiveCyclone): HTMLElement {
    const el = document.createElement('div');
    el.style.cssText = `
        display: flex;
        flex-direction: column;
        align-items: center;
        cursor: pointer;
        pointer-events: auto;
        z-index: 500;
        filter: drop-shadow(0 2px 8px rgba(255,60,60,0.5));
    `;

    // Storm name label
    const name = cyclone.name || cyclone.sid || '?';
    const windKts = cyclone.currentPosition.windKts ?? cyclone.maxWindKts;
    const catColor = windKts >= 64 ? '#ff4444' : windKts >= 34 ? '#ffa500' : '#22c55e';

    const nameLabel = document.createElement('div');
    nameLabel.style.cssText = `
        font-size: 10px; font-weight: 800; color: #fff;
        text-shadow: 0 1px 4px rgba(0,0,0,0.9);
        background: rgba(0,0,0,0.55); padding: 2px 8px;
        border-radius: 6px; backdrop-filter: blur(4px);
        margin-bottom: 3px; white-space: nowrap;
        text-transform: uppercase; letter-spacing: 0.04em;
    `;
    nameLabel.textContent = name;
    el.appendChild(nameLabel);

    // Spinner container
    const spinnerContainer = document.createElement('div');
    spinnerContainer.style.cssText = `
        width: 32px; height: 32px;
        display: flex; align-items: center; justify-content: center;
    `;

    const svgStr = `<svg viewBox="0 0 100 100" width="30" height="30"
         style="animation: cyclone-eye-spin 4s linear infinite;">
        <circle cx="50" cy="50" r="8" fill="${catColor}" stroke="#000" stroke-width="2"/>
        <g fill="${catColor}" opacity="0.8" stroke="#000" stroke-width="1">
            <path d="M54 42 C58 28, 68 10, 82 8 C90 6, 96 14, 94 24 C92 32, 84 36, 74 34 C68 33, 62 36, 58 42 Z"/>
            <path d="M46 58 C42 72, 32 90, 18 92 C10 94, 4 86, 6 76 C8 68, 16 64, 26 66 C32 67, 38 64, 42 58 Z"/>
            <path d="M58 54 C72 58, 90 68, 92 82 C94 90, 86 96, 76 94 C68 92, 64 84, 66 74 C67 68, 64 62, 58 58 Z"/>
            <path d="M42 46 C28 42, 10 32, 8 18 C6 10, 14 4, 24 6 C32 8, 36 16, 34 26 C33 32, 36 38, 42 42 Z"/>
        </g>
    </svg>`;
    const parser = new DOMParser();
    const svgDoc = parser.parseFromString(svgStr, 'image/svg+xml');
    const svgNode = svgDoc.documentElement;
    if (svgNode && svgNode.nodeName === 'svg') {
        spinnerContainer.appendChild(document.importNode(svgNode, true));
    }
    el.appendChild(spinnerContainer);

    return el;
}

function addSquallLayer(map: mapboxgl.Map): void {
    // Remove stale if present
    try {
        if (map.getLayer(SQUALL_LAYER)) map.removeLayer(SQUALL_LAYER);
        if (map.getSource(SQUALL_SOURCE)) map.removeSource(SQUALL_SOURCE);
    } catch (_) {
        /* ignore */
    }

    const cacheBust = Math.floor(Date.now() / (10 * 60 * 1000)); // Changes every 10 min

    map.addSource(SQUALL_SOURCE, {
        type: 'raster',
        tiles: [buildTileUrl(cacheBust)],
        tileSize: 256,
        maxzoom: 6, // Clamped — tiles align best at low zoom for coarse IR data
    });

    // Insert below route/nav layers but above base
    const insertBefore = map.getLayer('route-line-layer') ? 'route-line-layer' : undefined;

    map.addLayer(
        {
            id: SQUALL_LAYER,
            type: 'raster',
            source: SQUALL_SOURCE,
            paint: {
                'raster-opacity': 0.85,
                'raster-fade-duration': 0,
                'raster-resampling': 'linear',
            },
        },
        insertBefore,
    );
}

/** Fetch latest RainViewer radar and overlay on top of IR */
async function addRadarLayer(map: mapboxgl.Map): Promise<void> {
    try {
        const data = await fetch('https://api.rainviewer.com/public/weather-maps.json').then((r) => r.json());
        const past: { path: string; time: number }[] = data?.radar?.past ?? [];
        if (past.length === 0) {
            log.warn('No RainViewer radar frames available');
            return;
        }
        // Use the latest past frame (most recent actual radar)
        const latest = past[past.length - 1];
        const tileUrl = `https://tilecache.rainviewer.com${latest.path}/256/{z}/{x}/{y}/4/1_1.png`;

        // Remove stale if present
        if (map.getLayer(RADAR_LAYER)) map.removeLayer(RADAR_LAYER);
        if (map.getSource(RADAR_SOURCE)) map.removeSource(RADAR_SOURCE);

        map.addSource(RADAR_SOURCE, {
            type: 'raster',
            tiles: [tileUrl],
            tileSize: 256,
            minzoom: 2,
            maxzoom: 6,
        });

        // Insert above IR but below nav layers
        const insertBefore = map.getLayer('route-line-layer') ? 'route-line-layer' : undefined;

        map.addLayer(
            {
                id: RADAR_LAYER,
                type: 'raster',
                source: RADAR_SOURCE,
                paint: {
                    'raster-opacity': 0.65,
                    'raster-fade-duration': 0,
                    'raster-resampling': 'linear',
                },
            },
            insertBefore,
        );

        const radarAge = Math.round((Date.now() / 1000 - latest.time) / 60);
        log.info(`🌧️ RainViewer radar overlay added (${radarAge} min old)`);
    } catch (err) {
        log.warn('Failed to add RainViewer radar layer:', err);
    }
}

/** Refresh the radar layer with the latest frame */
async function refreshRadarLayer(map: mapboxgl.Map): Promise<void> {
    try {
        // Remove old
        if (map.getLayer(RADAR_LAYER)) map.removeLayer(RADAR_LAYER);
        if (map.getSource(RADAR_SOURCE)) map.removeSource(RADAR_SOURCE);
        // Re-add with fresh data
        await addRadarLayer(map);
    } catch (err) {
        log.warn('Failed to refresh radar layer:', err);
    }
}

function refreshSquallSource(map: mapboxgl.Map): void {
    try {
        const src = map.getSource(SQUALL_SOURCE) as mapboxgl.RasterTileSource | undefined;
        if (!src) return;
        const cacheBust = Math.floor(Date.now() / (10 * 60 * 1000));
        // Update tile URL in-place — avoids flash from remove+re-add
        src.setTiles([buildTileUrl(cacheBust)]);
        log.info('🔄 Squall map refreshed (in-place tile swap)');
    } catch (err) {
        log.warn('Failed to refresh squall map:', err);
    }
}

function cleanupSquallLayers(map: mapboxgl.Map): void {
    try {
        // Radar layer
        if (map.getLayer(RADAR_LAYER)) map.removeLayer(RADAR_LAYER);
        if (map.getSource(RADAR_SOURCE)) map.removeSource(RADAR_SOURCE);
        // IR layer
        if (map.getLayer(SQUALL_LAYER)) map.removeLayer(SQUALL_LAYER);
        if (map.getSource(SQUALL_SOURCE)) map.removeSource(SQUALL_SOURCE);
        // HUD
        const hud = map.getContainer().querySelector(`#${SQUALL_HUD_ID}`);
        if (hud) hud.remove();
    } catch (err) {
        log.warn('Squall map cleanup error:', err);
    }
    log.info('🧹 Squall map layers cleaned up');
}

// ── HUD (title + data age, no legend) ──

function addSquallHUD(map: mapboxgl.Map): void {
    const old = map.getContainer().querySelector(`#${SQUALL_HUD_ID}`);
    if (old) old.remove();

    const hud = document.createElement('div');
    hud.id = SQUALL_HUD_ID;
    hud.style.cssText = `
        position: absolute;
        top: 56px;
        left: 16px;
        z-index: 300;
        background: rgba(10, 12, 20, 0.88);
        backdrop-filter: blur(12px);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 12px;
        padding: 10px 14px;
        pointer-events: none;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
        display: flex;
        align-items: center;
        gap: 10px;
    `;

    // Title
    const title = document.createElement('div');
    title.style.cssText =
        'font-size: 10px; font-weight: 800; color: #fff; letter-spacing: 0.5px; text-transform: uppercase;';
    title.textContent = '⛈️ Squall Threat';
    hud.appendChild(title);

    // Data Age — inline, compact
    const ageText = document.createElement('span');
    ageText.id = 'squall-age-text';
    ageText.style.cssText = 'font-size: 10px; font-weight: 700; color: #22c55e; letter-spacing: 0.3px;';
    ageText.textContent = '—';
    hud.appendChild(ageText);

    map.getContainer().appendChild(hud);
}

// ── Data Age Tracking ──

async function fetchDataTimestamp(ref: React.MutableRefObject<Date | null>, map: mapboxgl.Map): Promise<void> {
    try {
        const resp = await fetch(`${SUPABASE_URL}/functions/v1/satellite-tile?sat=ssec-ir&x=0&y=0&z=1`);
        if (!resp.ok) return;
        const satDate = resp.headers.get('X-Satellite-Date');
        const lastMod = resp.headers.get('Last-Modified');
        if (satDate) {
            ref.current = new Date(satDate);
        } else if (lastMod) {
            ref.current = new Date(lastMod);
        } else {
            ref.current = new Date(Date.now() - 30 * 60 * 1000);
        }
        updateDataAge(map, ref.current);
    } catch {
        /* best effort */
    }
}

function updateDataAge(map: mapboxgl.Map, tileTime: Date | null): void {
    const ageEl = map.getContainer().querySelector('#squall-age-text') as HTMLElement | null;
    if (!ageEl) return;
    if (!tileTime) {
        ageEl.textContent = '—';
        return;
    }

    const ageMin = Math.round((Date.now() - tileTime.getTime()) / 60000);
    let ageStr: string;
    if (ageMin < 1) ageStr = '< 1m';
    else if (ageMin < 60) ageStr = `${ageMin}m`;
    else {
        const h = Math.floor(ageMin / 60);
        const m = ageMin % 60;
        ageStr = m > 0 ? `${h}h ${m}m` : `${h}h`;
    }
    ageEl.textContent = ageStr;

    // Color by staleness
    if (ageMin <= 30) {
        ageEl.style.color = '#22c55e';
    } else if (ageMin <= 60) {
        ageEl.style.color = '#FFA500';
    } else {
        ageEl.style.color = '#ef4444';
    }
}
