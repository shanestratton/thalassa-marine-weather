/**
 * useSquallMap — Global IR Squall Detection Map
 *
 * IR satellite: NASA GIBS Himawari-9 Band 13 Clean Infrared (WMTS)
 *   — direct fetch, CORS enabled, no proxy needed
 *   — coverage: Western Pacific / Australia / NZ
 *   — max zoom: 6 (GoogleMapsCompatible_Level6)
 *
 * Radar overlay: RainViewer (actual precipitation intensity)
 *   — XYZ tiles from CDN
 *
 * Zoom: integer-only 3–6 for crisp native tiles
 */

import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import { createLogger } from '../../utils/createLogger';
import type { ActiveCyclone } from '../../services/weather/CycloneTrackingService';

const log = createLogger('SquallMap');

// ── Layer/Source IDs ──
const IR_SOURCE = 'squall-ir-source';
const IR_LAYER = 'squall-ir-layer';
const RADAR_SOURCE = 'squall-radar-source';
const RADAR_LAYER = 'squall-radar-layer';
const SQUALL_HUD_ID = 'squall-map-hud';

// GIBS max zoom for Himawari tiles
const SQUALL_MAX_ZOOM = 6;

/** RainViewer API — returns radar frame paths */
const RAINVIEWER_API = 'https://api.rainviewer.com/public/weather-maps.json';

/**
 * Build NASA GIBS WMTS tile URL for Mapbox GL {z}/{x}/{y} substitution.
 *
 * GIBS serves WMTS tiles at: /wmts/epsg3857/best/wmts.cgi?...
 * The TileMatrixSet is GoogleMapsCompatible_Level6 (standard Web Mercator).
 * Mapbox replaces {z}, {x}, {y} with tile coords automatically.
 */
function buildGibsTileUrl(dateStr: string): string {
    const base = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/wmts.cgi';
    // Mapbox GL will substitute {z}, {x}, {y} at request time
    return (
        `${base}?Service=WMTS&Request=GetTile&Version=1.0.0` +
        `&Layer=Himawari_AHI_Band13_Clean_Infrared` +
        `&Style=default` +
        `&TileMatrixSet=GoogleMapsCompatible_Level6` +
        `&TileMatrix={z}&TileRow={y}&TileCol={x}` +
        `&Format=image/png` +
        `&Time=${dateStr}`
    );
}

/** Today's date in YYYY-MM-DD for GIBS Time parameter */
function todayDateStr(): string {
    return new Date().toISOString().split('T')[0];
}

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
    const isSetUp = useRef(false);
    const stormMarkersRef = useRef<mapboxgl.Marker[]>([]);
    const prevMaxZoomRef = useRef<number | null>(null);
    const zoomSnapRef = useRef<(() => void) | null>(null);

    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;

        // ── Teardown when hidden ──
        if (!visible) {
            cleanupLayers(map);
            isSetUp.current = false;
            if (refreshTimer.current) {
                clearInterval(refreshTimer.current);
                refreshTimer.current = null;
            }
            if (zoomSnapRef.current) {
                map.off('zoomend', zoomSnapRef.current);
                zoomSnapRef.current = null;
            }
            for (const m of stormMarkersRef.current) m.remove();
            stormMarkersRef.current = [];
            if (prevMaxZoomRef.current !== null) {
                map.setMaxZoom(prevMaxZoomRef.current);
                prevMaxZoomRef.current = null;
            }
            return;
        }

        // ── Setup ──
        if (!isSetUp.current) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ausNzMin: number = (map as any).__ausNzMinZoom ?? 3;
            const minInt = Math.round(ausNzMin);
            prevMaxZoomRef.current = map.getMaxZoom();
            map.setMinZoom(minInt);
            map.setMaxZoom(SQUALL_MAX_ZOOM);

            // Start at AU+NZ fit zoom centred on user
            const targetZoom = minInt;
            if (userLat && userLon && isFinite(userLat) && isFinite(userLon)) {
                map.flyTo({ center: [userLon, userLat], zoom: targetZoom, duration: 800 });
            } else {
                map.easeTo({ center: [145, -28], zoom: targetZoom, duration: 400 });
            }

            // Integer-only zoom snap
            const onZoomEnd = () => {
                const z = map.getZoom();
                const snapped = Math.max(minInt, Math.min(Math.round(z), SQUALL_MAX_ZOOM));
                if (Math.abs(z - snapped) > 0.05) {
                    map.easeTo({ zoom: snapped, duration: 150 });
                }
            };
            map.on('zoomend', onZoomEnd);
            zoomSnapRef.current = onZoomEnd;

            // Add satellite IR + radar
            addIRLayer(map);
            addRadarLayer(map);
            addSquallHUD(map);
            isSetUp.current = true;
            log.info('🌩️ Squall map activated — GIBS Himawari IR + RainViewer radar');
        }

        // Auto-refresh every 10 minutes
        if (!refreshTimer.current) {
            refreshTimer.current = setInterval(
                () => {
                    refreshIRLayer(map);
                    refreshRadarLayer(map);
                },
                10 * 60 * 1000,
            );
        }

        return () => {
            if (refreshTimer.current) {
                clearInterval(refreshTimer.current);
                refreshTimer.current = null;
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible, mapReady]);

    // ── Cyclone spinners ──
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady || !visible || !allCyclones?.length) {
            for (const m of stormMarkersRef.current) m.remove();
            stormMarkersRef.current = [];
            return;
        }

        for (const m of stormMarkersRef.current) m.remove();
        stormMarkersRef.current = [];

        for (const cyclone of allCyclones) {
            const el = createSquallSpinnerEl(cyclone);
            el.addEventListener('click', (e: MouseEvent) => {
                e.stopPropagation();
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

// ── NASA GIBS IR Layer ──

function addIRLayer(map: mapboxgl.Map): void {
    try {
        if (map.getLayer(IR_LAYER)) map.removeLayer(IR_LAYER);
        if (map.getSource(IR_SOURCE)) map.removeSource(IR_SOURCE);
    } catch {
        /* ignore */
    }

    map.addSource(IR_SOURCE, {
        type: 'raster',
        tiles: [buildGibsTileUrl(todayDateStr())],
        tileSize: 256,
        maxzoom: SQUALL_MAX_ZOOM,
    });

    const insertBefore = map.getLayer('route-line-layer') ? 'route-line-layer' : undefined;
    map.addLayer(
        {
            id: IR_LAYER,
            type: 'raster',
            source: IR_SOURCE,
            paint: {
                'raster-opacity': 0.85,
                'raster-fade-duration': 0,
                'raster-resampling': 'nearest',
            },
        },
        insertBefore,
    );
    log.info(`📡 GIBS Himawari IR added (date: ${todayDateStr()})`);
}

function refreshIRLayer(map: mapboxgl.Map): void {
    try {
        const src = map.getSource(IR_SOURCE) as mapboxgl.RasterTileSource | undefined;
        if (src) {
            src.setTiles([buildGibsTileUrl(todayDateStr())]);
            log.info('🔄 GIBS IR refreshed');
        }
    } catch (err) {
        log.warn('Failed to refresh GIBS IR:', err);
    }
}

// ── RainViewer Radar Layer ──

async function addRadarLayer(map: mapboxgl.Map): Promise<void> {
    try {
        const data = await fetch(RAINVIEWER_API).then((r) => r.json());
        const past: { path: string; time: number }[] = data?.radar?.past ?? [];
        if (past.length === 0) {
            log.warn('No RainViewer radar frames available');
            return;
        }
        const latest = past[past.length - 1];
        const tileUrl = `https://tilecache.rainviewer.com${latest.path}/256/{z}/{x}/{y}/4/1_1.png`;

        if (map.getLayer(RADAR_LAYER)) map.removeLayer(RADAR_LAYER);
        if (map.getSource(RADAR_SOURCE)) map.removeSource(RADAR_SOURCE);

        map.addSource(RADAR_SOURCE, {
            type: 'raster',
            tiles: [tileUrl],
            tileSize: 256,
            maxzoom: SQUALL_MAX_ZOOM,
        });

        const insertBefore = map.getLayer('route-line-layer') ? 'route-line-layer' : undefined;
        map.addLayer(
            {
                id: RADAR_LAYER,
                type: 'raster',
                source: RADAR_SOURCE,
                paint: {
                    'raster-opacity': 0.65,
                    'raster-fade-duration': 0,
                    'raster-resampling': 'nearest',
                },
            },
            insertBefore,
        );

        const radarAge = Math.round((Date.now() / 1000 - latest.time) / 60);
        log.info(`🌧️ RainViewer radar added (${radarAge} min old)`);
        updateHudAge(map, radarAge);
    } catch (err) {
        log.warn('Failed to add RainViewer radar:', err);
    }
}

async function refreshRadarLayer(map: mapboxgl.Map): Promise<void> {
    try {
        const data = await fetch(RAINVIEWER_API).then((r) => r.json());
        const past: { path: string; time: number }[] = data?.radar?.past ?? [];
        if (past.length === 0) return;
        const latest = past[past.length - 1];
        const tileUrl = `https://tilecache.rainviewer.com${latest.path}/256/{z}/{x}/{y}/4/1_1.png`;
        const src = map.getSource(RADAR_SOURCE) as mapboxgl.RasterTileSource | undefined;
        if (src) {
            src.setTiles([tileUrl]);
            const radarAge = Math.round((Date.now() / 1000 - latest.time) / 60);
            updateHudAge(map, radarAge);
            log.info(`🔄 Radar refreshed (${radarAge} min old)`);
        }
    } catch (err) {
        log.warn('Failed to refresh radar:', err);
    }
}

// ── Cleanup ──

function cleanupLayers(map: mapboxgl.Map): void {
    try {
        if (map.getLayer(RADAR_LAYER)) map.removeLayer(RADAR_LAYER);
        if (map.getSource(RADAR_SOURCE)) map.removeSource(RADAR_SOURCE);
        if (map.getLayer(IR_LAYER)) map.removeLayer(IR_LAYER);
        if (map.getSource(IR_SOURCE)) map.removeSource(IR_SOURCE);
        const hud = map.getContainer().querySelector(`#${SQUALL_HUD_ID}`);
        if (hud) hud.remove();
    } catch (err) {
        log.warn('Squall cleanup error:', err);
    }
    log.info('🧹 Squall layers cleaned up');
}

// ── HUD ──

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

    const title = document.createElement('div');
    title.style.cssText =
        'font-size: 10px; font-weight: 800; color: #fff; letter-spacing: 0.5px; text-transform: uppercase;';
    title.textContent = '⛈️ Squall Threat';
    hud.appendChild(title);

    const ageText = document.createElement('span');
    ageText.id = 'squall-age-text';
    ageText.style.cssText = 'font-size: 10px; font-weight: 700; color: #22c55e; letter-spacing: 0.3px;';
    ageText.textContent = '—';
    hud.appendChild(ageText);

    map.getContainer().appendChild(hud);
}

function updateHudAge(map: mapboxgl.Map, ageMin: number): void {
    const el = map.getContainer().querySelector('#squall-age-text') as HTMLElement | null;
    if (!el) return;

    let ageStr: string;
    if (ageMin < 1) ageStr = '< 1m';
    else if (ageMin < 60) ageStr = `${ageMin}m`;
    else {
        const h = Math.floor(ageMin / 60);
        const m = ageMin % 60;
        ageStr = m > 0 ? `${h}h ${m}m` : `${h}h`;
    }
    el.textContent = ageStr;

    if (ageMin <= 30) el.style.color = '#22c55e';
    else if (ageMin <= 60) el.style.color = '#FFA500';
    else el.style.color = '#ef4444';
}

// ── Cyclone spinner ──

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
