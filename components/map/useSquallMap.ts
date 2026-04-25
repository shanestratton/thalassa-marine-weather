/**
 * useSquallMap — Heavy-precip squall detection map.
 *
 * History:
 *   - Pre 2026-04-22: Xweather satellite-IR + radar global tiles.
 *     Decommissioned alongside the rest of the Xweather stack.
 *   - 2026-04-22 → 2026-04-25: Disabled stub — toggling it on did
 *     nothing past the HUD because we hadn't picked a replacement.
 *   - 2026-04-25 (this revision): Powered by Rainbow.ai's precip-global
 *     snapshot tiles, but rendered through SQUALL_COLOR_RAMP so anything
 *     below moderate-heavy rain intensity is invisible. The result is a
 *     "where are the actual thunder cells right now" map — light rain
 *     fades out, only the cells you'd avoid in passage planning remain
 *     visible. Refreshes every 5 minutes (Rainbow's snapshot cadence).
 *
 * The hook also keeps the cyclone spinner overlay so a user looking at
 * an active basin can see both squall cells and the storm centre at
 * once. Cyclone/squall toggles are mutually exclusive in the radial
 * menu (enforced in MapHub) so the user never has dual full-screen
 * overlays competing.
 *
 * Zoom: integer-only 3–8 — Rainbow's 1km native res doesn't add detail
 * past z8 and integer snap stops Mapbox from re-fetching tiles every
 * pinch frame.
 */

import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import { createLogger } from '../../utils/createLogger';
import type { ActiveCyclone } from '../../services/weather/CycloneTrackingService';
import { piCache } from '../../services/PiCacheService';
import { SQUALL_COLOR_RAMP } from './isobarLayerSetup';

const log = createLogger('SquallMap');

// ── Layer/Source IDs ──
const SQUALL_SOURCE = 'squall-rainbow-source';
const SQUALL_LAYER = 'squall-rainbow-layer';
const SQUALL_HUD_ID = 'squall-map-hud';

const SQUALL_MAX_ZOOM = 8;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // Rainbow snapshot cadence
const SNAPSHOT_TTL_MS = 5 * 60 * 1000;

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
    const lastRefreshAtRef = useRef<number>(0);
    const inflightRef = useRef(false);

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

            // Open at AU+NZ fit (or user location if known)
            const targetZoom = minInt;
            if (userLat && userLon && isFinite(userLat) && isFinite(userLon)) {
                map.flyTo({ center: [userLon, userLat], zoom: targetZoom, duration: 800 });
            } else {
                map.easeTo({ center: [145, -28], zoom: targetZoom, duration: 400 });
            }

            // Integer-only zoom snap — keeps Rainbow tile fetches stable
            // (no half-zoom states triggering a fresh fetch every frame).
            const onZoomEnd = () => {
                const z = map.getZoom();
                const snapped = Math.max(minInt, Math.min(Math.round(z), SQUALL_MAX_ZOOM));
                if (Math.abs(z - snapped) > 0.05) {
                    map.easeTo({ zoom: snapped, duration: 150 });
                }
            };
            map.on('zoomend', onZoomEnd);
            zoomSnapRef.current = onZoomEnd;

            addSquallHUD(map);
            isSetUp.current = true;
            log.warn('⛈️ Squall map active — fetching Rainbow snapshot');

            // Kick off the first Rainbow load.
            void loadSquallTiles(map, lastRefreshAtRef, inflightRef);
        }

        // Auto-refresh every 5 min so the user always sees recent cells.
        if (!refreshTimer.current) {
            refreshTimer.current = setInterval(() => {
                void loadSquallTiles(map, lastRefreshAtRef, inflightRef);
            }, REFRESH_INTERVAL_MS);
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

    // Tick the HUD's age display every minute — purely cosmetic so the
    // user can tell at a glance whether the data is still fresh.
    useEffect(() => {
        if (!visible) return;
        const map = mapRef.current;
        if (!map) return;
        const tick = () => {
            const ageMin = Math.round((Date.now() - lastRefreshAtRef.current) / 60000);
            updateHudAge(map, ageMin);
        };
        tick();
        const t = setInterval(tick, 60_000);
        return () => clearInterval(t);
    }, [visible]);
}

// ── Rainbow snapshot fetcher + tile source mounting ──

/**
 * Fetch the latest Rainbow precip-global snapshot ID and (re)mount
 * the squall tile layer using it. Routes through Pi cache when the
 * boat network is up so the fleet shares one snapshot fetch.
 *
 * Tiles themselves go through Mapbox GL's transformRequest →
 * passthroughTileUrl path automatically (configured in useMapInit), so
 * there's nothing to wire on the tile-side caching.
 */
async function loadSquallTiles(
    map: mapboxgl.Map,
    lastRefreshAtRef: React.MutableRefObject<number>,
    inflightRef: React.MutableRefObject<boolean>,
): Promise<void> {
    if (inflightRef.current) {
        log.info('Squall snapshot fetch already in flight — skipping');
        return;
    }
    inflightRef.current = true;
    try {
        const supabaseUrl = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) || '';
        if (!supabaseUrl) {
            log.warn('Supabase URL missing — cannot fetch Rainbow snapshot');
            return;
        }

        // Use the same snapshot endpoint the rain layer hits. Pi
        // passthrough so the boat fleet shares one fetch.
        const upstream = `${supabaseUrl}/functions/v1/proxy-rainbow?action=snapshot&layer=precip-global`;
        const piUrl = piCache.passthroughUrl(upstream, SNAPSHOT_TTL_MS, 'rainbow-snapshot');

        // Hard 3s timeout so a cold Supabase doesn't lock the layer.
        const timeoutCtrl = new AbortController();
        const timer = setTimeout(() => timeoutCtrl.abort(), 3000);
        let snapshot: number | null = null;
        try {
            const res = await fetch(piUrl ?? upstream, { signal: timeoutCtrl.signal });
            clearTimeout(timer);
            if (!res.ok) {
                log.warn(`Rainbow snapshot HTTP ${res.status}`);
                return;
            }
            const data = await res.json();
            snapshot = data.snapshot ?? null;
        } catch (err) {
            log.warn('Rainbow snapshot fetch failed/timed out', err);
            return;
        } finally {
            clearTimeout(timer);
        }

        if (!snapshot) {
            log.warn('Rainbow snapshot empty');
            return;
        }

        log.warn(`Squall snapshot ${snapshot} — mounting tile layer`);
        mountSquallLayer(map, supabaseUrl, snapshot);
        lastRefreshAtRef.current = Date.now();
        updateHudAge(map, 0);
    } finally {
        inflightRef.current = false;
    }
}

/**
 * Add (or replace) the Mapbox raster source + layer for the current
 * snapshot. We tear down the previous source/layer and add fresh ones
 * so Mapbox actually re-fetches tiles — `setData` on a raster source
 * doesn't exist, and just changing the URL string in setTiles isn't
 * universally supported across Mapbox GL versions.
 */
function mountSquallLayer(map: mapboxgl.Map, supabaseUrl: string, snapshot: number): void {
    // Tile URL: dbz_u8 grayscale encoding so we can apply our own
    // SQUALL_COLOR_RAMP via raster-color in the layer paint. forecast=0
    // means "current snapshot" — no forecast offset for the squall view.
    const tileUrl =
        `${supabaseUrl}/functions/v1/proxy-rainbow?action=tile&layer=precip-global` +
        `&snapshot=${snapshot}&forecast=0&z={z}&x={x}&y={y}&color=dbz_u8`;

    // Remove existing layer/source (if any) so the next addSource fetches
    // fresh tiles for the new snapshot.
    try {
        if (map.getLayer(SQUALL_LAYER)) map.removeLayer(SQUALL_LAYER);
        if (map.getSource(SQUALL_SOURCE)) map.removeSource(SQUALL_SOURCE);
    } catch (err) {
        log.warn('Squall pre-mount cleanup error', err);
    }

    map.addSource(SQUALL_SOURCE, {
        type: 'raster',
        tiles: [tileUrl],
        tileSize: 256,
        minzoom: 2,
        // Rainbow's 1km native res — overzoom past z8 looks identical
        // and saves a 16x tile request multiplication per zoom step.
        maxzoom: 8,
    });

    // Insert above satellite/base but below the first symbol layer so
    // labels/coastlines stay visible over the squall cells.
    const styleLayers = map.getStyle()?.layers ?? [];
    const beforeId = styleLayers.find((l) => l.type === 'symbol')?.id;

    map.addLayer(
        {
            id: SQUALL_LAYER,
            type: 'raster',
            source: SQUALL_SOURCE,
            paint: {
                'raster-opacity': 1,
                'raster-fade-duration': 0,
                'raster-color': SQUALL_COLOR_RAMP,
                'raster-color-mix': [1, 0, 0, 0], // R channel = value (R=G=B in grayscale)
                'raster-color-range': [0, 1],
            },
        },
        beforeId,
    );
}

// ── Cleanup ──

function cleanupLayers(map: mapboxgl.Map): void {
    try {
        if (map.getLayer(SQUALL_LAYER)) map.removeLayer(SQUALL_LAYER);
        if (map.getSource(SQUALL_SOURCE)) map.removeSource(SQUALL_SOURCE);
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
    ageText.textContent = 'LOADING…';
    hud.appendChild(ageText);

    map.getContainer().appendChild(hud);
}

function updateHudAge(map: mapboxgl.Map, ageMin: number): void {
    const el = map.getContainer().querySelector('#squall-age-text') as HTMLElement | null;
    if (!el) return;

    if (ageMin <= 5) {
        el.textContent = 'LIVE';
        el.style.color = '#22c55e';
    } else if (ageMin < 60) {
        el.textContent = `${ageMin}m`;
        el.style.color = ageMin <= 30 ? '#22c55e' : '#FFA500';
    } else {
        const h = Math.floor(ageMin / 60);
        const m = ageMin % 60;
        el.textContent = m > 0 ? `${h}h ${m}m` : `${h}h`;
        el.style.color = '#ef4444';
    }
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
