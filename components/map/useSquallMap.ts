/**
 * useSquallMap — Global IR Squall Detection Map
 *
 * Uses RainViewer satellite IR + radar tiles — proper XYZ slippy map
 * tiles served from RainViewer's CDN. Both layers come from the same
 * API call so they're always in sync.
 *
 *  Satellite coverage: Global (Himawari-9, GOES-16/18, Meteosat)
 *  Resolution: ~4km, updates every 10-15 min
 *  Tile source: RainViewer CDN (no proxy needed)
 *  Radar: RainViewer (actual precipitation intensity)
 *  Zoom: integer-only 3–7 for crisp native tiles
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

/** RainViewer API — returns satellite + radar frame paths */
const RAINVIEWER_API = 'https://api.rainviewer.com/public/weather-maps.json';

// Max zoom where RainViewer satellite tiles look good
const SQUALL_MAX_ZOOM = 7;

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
    /** Cached RainViewer API response so we can refresh without re-fetching */
    const rainviewerDataRef = useRef<RainViewerData | null>(null);

    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;

        // ── Teardown when hidden ──
        if (!visible) {
            cleanupSquallLayers(map);
            isSetUp.current = false;
            rainviewerDataRef.current = null;
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

            // Fetch RainViewer API and add both layers
            addRainViewerLayers(map, rainviewerDataRef);
            isSetUp.current = true;
            log.info('🌩️ Squall map activated — RainViewer IR + radar');
        }

        // Auto-refresh every 10 minutes
        if (!refreshTimer.current) {
            refreshTimer.current = setInterval(
                () => {
                    refreshRainViewerLayers(map, rainviewerDataRef);
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

    // ── Cyclone spinners on squall map ──
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

// ── RainViewer API types ──

interface RainViewerFrame {
    path: string;
    time: number;
}
interface RainViewerData {
    radar: { past: RainViewerFrame[] };
    satellite: { infrared: RainViewerFrame[] };
}

// ── RainViewer tile layer management ──

async function addRainViewerLayers(
    map: mapboxgl.Map,
    dataRef: React.MutableRefObject<RainViewerData | null>,
): Promise<void> {
    try {
        const data: RainViewerData = await fetch(RAINVIEWER_API).then((r) => r.json());
        dataRef.current = data;

        // ── Satellite IR (base layer) ──
        const irFrames = data?.satellite?.infrared ?? [];
        if (irFrames.length > 0) {
            const latestIR = irFrames[irFrames.length - 1];
            // Color scheme 0 = original IR, smooth 0 = no smoothing
            const irUrl = `https://tilecache.rainviewer.com${latestIR.path}/256/{z}/{x}/{y}/0/0_0.png`;

            if (map.getLayer(SQUALL_LAYER)) map.removeLayer(SQUALL_LAYER);
            if (map.getSource(SQUALL_SOURCE)) map.removeSource(SQUALL_SOURCE);

            map.addSource(SQUALL_SOURCE, {
                type: 'raster',
                tiles: [irUrl],
                tileSize: 256,
                maxzoom: SQUALL_MAX_ZOOM,
            });

            const insertBefore = map.getLayer('route-line-layer') ? 'route-line-layer' : undefined;
            map.addLayer(
                {
                    id: SQUALL_LAYER,
                    type: 'raster',
                    source: SQUALL_SOURCE,
                    paint: {
                        'raster-opacity': 0.85,
                        'raster-fade-duration': 0,
                        'raster-resampling': 'nearest',
                    },
                },
                insertBefore,
            );

            const irAge = Math.round((Date.now() / 1000 - latestIR.time) / 60);
            log.info(`📡 RainViewer satellite IR added (${irAge} min old)`);
            updateHudAge(map, irAge);
        }

        // ── Radar (overlay on top of IR) ──
        const radarFrames = data?.radar?.past ?? [];
        if (radarFrames.length > 0) {
            const latestRadar = radarFrames[radarFrames.length - 1];
            // Color scheme 4 = Universal Blue, smooth 1 = smoothed
            const radarUrl = `https://tilecache.rainviewer.com${latestRadar.path}/256/{z}/{x}/{y}/4/1_1.png`;

            if (map.getLayer(RADAR_LAYER)) map.removeLayer(RADAR_LAYER);
            if (map.getSource(RADAR_SOURCE)) map.removeSource(RADAR_SOURCE);

            map.addSource(RADAR_SOURCE, {
                type: 'raster',
                tiles: [radarUrl],
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

            const radarAge = Math.round((Date.now() / 1000 - latestRadar.time) / 60);
            log.info(`🌧️ RainViewer radar overlay added (${radarAge} min old)`);
        }

        // HUD
        addSquallHUD(map);
    } catch (err) {
        log.warn('Failed to add RainViewer layers:', err);
    }
}

async function refreshRainViewerLayers(
    map: mapboxgl.Map,
    dataRef: React.MutableRefObject<RainViewerData | null>,
): Promise<void> {
    try {
        const data: RainViewerData = await fetch(RAINVIEWER_API).then((r) => r.json());
        dataRef.current = data;

        // Refresh IR tiles in-place
        const irFrames = data?.satellite?.infrared ?? [];
        if (irFrames.length > 0) {
            const latestIR = irFrames[irFrames.length - 1];
            const irUrl = `https://tilecache.rainviewer.com${latestIR.path}/256/{z}/{x}/{y}/0/0_0.png`;
            const src = map.getSource(SQUALL_SOURCE) as mapboxgl.RasterTileSource | undefined;
            if (src) {
                src.setTiles([irUrl]);
            }
            const irAge = Math.round((Date.now() / 1000 - latestIR.time) / 60);
            updateHudAge(map, irAge);
            log.info(`🔄 Squall IR refreshed (${irAge} min old)`);
        }

        // Refresh radar tiles in-place
        const radarFrames = data?.radar?.past ?? [];
        if (radarFrames.length > 0) {
            const latestRadar = radarFrames[radarFrames.length - 1];
            const radarUrl = `https://tilecache.rainviewer.com${latestRadar.path}/256/{z}/{x}/{y}/4/1_1.png`;
            const src = map.getSource(RADAR_SOURCE) as mapboxgl.RasterTileSource | undefined;
            if (src) {
                src.setTiles([radarUrl]);
            }
        }
    } catch (err) {
        log.warn('Failed to refresh RainViewer layers:', err);
    }
}

// ── Cleanup ──

function cleanupSquallLayers(map: mapboxgl.Map): void {
    try {
        if (map.getLayer(RADAR_LAYER)) map.removeLayer(RADAR_LAYER);
        if (map.getSource(RADAR_SOURCE)) map.removeSource(RADAR_SOURCE);
        if (map.getLayer(SQUALL_LAYER)) map.removeLayer(SQUALL_LAYER);
        if (map.getSource(SQUALL_SOURCE)) map.removeSource(SQUALL_SOURCE);
        const hud = map.getContainer().querySelector(`#${SQUALL_HUD_ID}`);
        if (hud) hud.remove();
    } catch (err) {
        log.warn('Squall map cleanup error:', err);
    }
    log.info('🧹 Squall map layers cleaned up');
}

// ── HUD (title + data age) ──

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

// ── Compact cyclone spinner for squall map ──

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
