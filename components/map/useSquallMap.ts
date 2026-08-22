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
const IR_SOURCE = 'squall-ir-source';
const IR_LAYER = 'squall-ir-layer';
const SQUALL_HUD_ID = 'squall-map-hud';

/**
 * The satellite cloud half of the squall view, restored 2026-08-21.
 *
 * This layer was always an IR-satellite + precipitation COMPOSITE — cloud
 * tops showing where the weather is organised, precip cells showing where it
 * is falling. The satellite half died on 2026-04-22 as collateral damage
 * when Xweather was decommissioned on cost ("burned through its daily quota
 * in a single dev session"), and that commit promised a NOAA replacement
 * "next session" which never shipped: squall came back precip-only three
 * days later and stayed that way for four months (Shane, 2026-08-21: "our
 * storm layer used to have a satellite cloud layer").
 *
 * NASA GIBS Himawari-9 Band 13 Clean IR is the right restoration: Himawari
 * is the satellite that actually looks at Australia, the tiles are free with
 * no key, CORS-enabled so no proxy is needed, and gibs.earthdata.nasa.gov is
 * already in the CSP. Verified serving 2026-08-21. (RainViewer's satellite
 * IR array is still empty, as it has been since April; Xweather is a
 * non-starter — its proxies are deleted and its credentials burned.)
 */
const GIBS_MAX_ZOOM = 6;

/** GIBS WMTS, with Mapbox substituting {z}/{x}/{y} at request time. */
function buildGibsTileUrl(dateStr: string): string {
    const base = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/wmts.cgi';
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

/** GIBS wants the imagery date as YYYY-MM-DD. */
function todayDateStr(): string {
    return new Date().toISOString().split('T')[0];
}

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
    const loadSessionRef = useRef(0);
    const inflightControllerRef = useRef<AbortController | null>(null);

    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;
        const loadSession = ++loadSessionRef.current;
        const isCurrentLoadSession = () => visible && loadSessionRef.current === loadSession;
        const cancelInflightLoad = () => {
            const controller = inflightControllerRef.current;
            if (!controller) return;
            controller.abort();
            if (inflightControllerRef.current === controller) {
                inflightControllerRef.current = null;
            }
        };
        const startLoad = () => {
            // Clouds go up FIRST and unconditionally — they need nothing from
            // Rainbow, so they must not wait on (or be lost to) its fetch.
            mountSatelliteLayer(map);
            if (inflightControllerRef.current) {
                log.info('Squall snapshot fetch already in flight — skipping');
                return;
            }
            const controller = new AbortController();
            inflightControllerRef.current = controller;
            void loadSquallTiles(map, lastRefreshAtRef, controller, isCurrentLoadSession).finally(() => {
                if (inflightControllerRef.current === controller) {
                    inflightControllerRef.current = null;
                }
            });
        };

        // ── Teardown when hidden ──
        if (!visible) {
            cancelInflightLoad();
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

            // Top-left HUD removed 2026-04-25 — redundant with the
            // bottom-left SquallLegend chip's status pill which already
            // shows LIVE / Nm / Nh freshness. Two HUDs saying the same
            // thing 200px apart was clutter.
            isSetUp.current = true;
            log.warn('⛈️ Squall map active — fetching Rainbow snapshot');

            // Kick off the first Rainbow load.
            startLoad();
        }

        // Auto-refresh every 5 min so the user always sees recent cells.
        if (!refreshTimer.current) {
            refreshTimer.current = setInterval(() => {
                startLoad();
            }, REFRESH_INTERVAL_MS);
        }

        return () => {
            if (loadSessionRef.current === loadSession) {
                loadSessionRef.current += 1;
            }
            cancelInflightLoad();
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
    // HUD age tick removed — SquallLegend chip handles freshness display now.
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
    controller: AbortController,
    isCurrentLoadSession: () => boolean,
): Promise<void> {
    const isCurrent = () => !controller.signal.aborted && isCurrentLoadSession();
    if (!isCurrent()) return;

    const supabaseUrl = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) || '';
    if (!supabaseUrl) {
        log.warn('Supabase URL missing — cannot fetch Rainbow snapshot');
        return;
    }

    // Use the same snapshot endpoint the rain layer hits. Pi
    // passthrough so the boat fleet shares one fetch.
    const upstream = `${supabaseUrl}/functions/v1/proxy-rainbow?action=snapshot&layer=precip-global`;

    // The same controller handles both the 3s timeout and a Chart → Plan
    // transition. Aborting alone is not sufficient because a mocked/cached
    // response may still settle; the session guard below is the final fence
    // before any Mapbox mutation.
    const timer = setTimeout(() => controller.abort(), 3000);
    let snapshot: number | null = null;
    try {
        // Pi first over the pinned transport, then direct. This used to be
        // `fetch(piUrl ?? upstream)`, which could not present the Pi's
        // self-signed cert and therefore threw on iOS whenever the Pi was
        // reachable — taking the snapshot with it instead of going direct.
        const piData = await piCache.passthroughJson<{ snapshot?: number | null }>(
            upstream,
            SNAPSHOT_TTL_MS,
            'rainbow-snapshot',
            3_000,
        );
        if (!isCurrent()) return;
        let data = piData;
        if (!data) {
            const res = await fetch(upstream, { signal: controller.signal });
            if (!isCurrent()) return;
            if (!res.ok) {
                log.warn(`Rainbow snapshot HTTP ${res.status}`);
                return;
            }
            data = await res.json();
        }
        if (!isCurrent()) return;
        snapshot = data?.snapshot ?? null;
    } catch (err) {
        if (!controller.signal.aborted) {
            log.warn('Rainbow snapshot fetch failed/timed out', err);
        }
        return;
    } finally {
        clearTimeout(timer);
    }

    if (!snapshot) {
        log.warn('Rainbow snapshot empty');
        return;
    }
    if (!isCurrent()) return;

    log.warn(`Squall snapshot ${snapshot} — mounting tile layer`);
    mountSquallLayer(map, supabaseUrl, snapshot);
    lastRefreshAtRef.current = Date.now();
    // Publish to a window-scoped ref so the SquallLegend chip's
    // age indicator can update without us threading a callback or
    // store through the React tree just for one number.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__thalassaSquallLastRefreshAt = lastRefreshAtRef.current;
}

/**
 * Mount the satellite cloud layer. INDEPENDENT of Rainbow by design.
 *
 * This lived inside mountSquallLayer when it was restored earlier today,
 * which coupled it to the Rainbow snapshot fetch — and that path has five
 * early returns (no Supabase URL, fetch throw, 3 s timeout, non-OK status,
 * empty snapshot). Any one of them meant no clouds either, even though GIBS
 * needs nothing from Rainbow: no key, no proxy, no snapshot. Shane saw
 * exactly that on 2026-08-21 ("the storms layer does not show the satellite
 * info").
 *
 * The two halves of this composite now fail independently, which is the
 * whole point of it being a composite.
 */
function mountSatelliteLayer(map: mapboxgl.Map): void {
    try {
        if (map.getLayer(IR_LAYER)) map.removeLayer(IR_LAYER);
        if (map.getSource(IR_SOURCE)) map.removeSource(IR_SOURCE);
    } catch (err) {
        log.warn('Squall IR pre-mount cleanup error', err);
    }
    try {
        map.addSource(IR_SOURCE, {
            type: 'raster',
            tiles: [buildGibsTileUrl(todayDateStr())],
            tileSize: 256,
            // GoogleMapsCompatible_Level6 is GIBS's ceiling for this product.
            // The precip layer runs to z8; past z6 the cloud simply stops
            // sharpening rather than 404-ing every tile.
            maxzoom: GIBS_MAX_ZOOM,
        });
        // THE CLOUD IS OPAQUE — STACKING ALONE CAN NEVER SHOW IT.
        //
        // Third report of "the satellite imagery is still not showing"
        // (Shane 2026-08-23). The first two rounds moved the layer's ANCHOR,
        // which could not have worked, because the tile is not an overlay:
        //
        //   measured 2026-08-23, z3 tile over the Coral Sea, 76 080 B PNG:
        //   colour type 6 (RGBA), and alpha == 255 on 100% of sampled
        //   pixels. Clear sky is not transparent — it is mid-grey
        //   (luminance clusters at 96-160 of 255; only the cold cloud tops
        //   run above ~192).
        //
        // So below the base imagery it is hidden, and above it, it would
        // grey out the entire world. There is no anchor that shows cloud and
        // keeps the chart. The alpha has to come from the PIXELS.
        //
        // raster-color does exactly that, and this file already proves the
        // technique works — mountSquallLayer ramps Rainbow's grayscale dbz
        // the same way. Map brightness → colour+alpha: warm background
        // (dark/mid) to fully transparent, cold tops (bright) to white.
        // Thresholds come from the measured histogram above, not taste.
        const styleLayers = map.getStyle()?.layers ?? [];
        // Anchor immediately ABOVE the base imagery and BELOW the ENC stack.
        // Deliberately not the top of the stack: if raster-color is ever not
        // honoured, an opaque IR on top would hide the whole chart, while
        // here the chart still paints over it and the failure is cosmetic.
        // Deliberately not 'settlement-major-label' either — MapHub's
        // ordering pass RELOCATES that layer to encBottom whenever imagery
        // is lit, so it is not the stable high-water mark it looks like.
        const imageryIdx = ['satellite-base-layer', 'hybrid-base-layer', 'maptiler-ocean-layer']
            .map((id) => styleLayers.findIndex((l) => l.id === id))
            .reduce((hi, i) => Math.max(hi, i), -1);
        const beforeId =
            imageryIdx >= 0 && imageryIdx + 1 < styleLayers.length
                ? styleLayers[imageryIdx + 1].id
                : (styleLayers.find((l) => l.id.startsWith('enc-vec-')) ?? styleLayers.find((l) => l.type === 'symbol'))
                      ?.id;
        map.addLayer(
            {
                id: IR_LAYER,
                type: 'raster',
                source: IR_SOURCE,
                paint: {
                    'raster-opacity': 0.9,
                    'raster-fade-duration': 0,
                    'raster-resampling': 'nearest',
                    // Luminance of the RGB channels (the product is near-grey
                    // but not exactly R==G==B, so weight rather than take one
                    // channel), looked up over the full 0-1 range.
                    'raster-color-mix': [0.2126, 0.7152, 0.0722, 0],
                    'raster-color-range': [0, 1],
                    'raster-color': [
                        'interpolate',
                        ['linear'],
                        ['raster-value'],
                        // Everything at or below the warm-background band is sky.
                        0.0,
                        'rgba(255,255,255,0)',
                        0.64,
                        'rgba(255,255,255,0)',
                        // Mid cloud feathers in…
                        0.72,
                        'rgba(235,245,255,0.35)',
                        0.82,
                        'rgba(248,251,255,0.72)',
                        // …cold tops (deep convection) paint solid.
                        1.0,
                        'rgba(255,255,255,0.95)',
                    ],
                },
            },
            beforeId,
        );
        // Says WHERE it landed, so a fourth "still not showing" is one log
        // line to diagnose instead of another round of reasoning from source.
        const idx = (map.getStyle()?.layers ?? []).findIndex((l) => l.id === IR_LAYER);
        log.warn(
            `📡 GIBS Himawari IR mounted (${todayDateStr()}) at layer ${idx}/${styleLayers.length}` +
                `${beforeId ? ` before '${beforeId}'` : ' on top'}, imageryIdx=${imageryIdx}`,
        );
    } catch (err) {
        log.warn('Squall IR mount failed — continuing with precip only', err);
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
        if (map.getLayer(IR_LAYER)) map.removeLayer(IR_LAYER);
        if (map.getSource(IR_SOURCE)) map.removeSource(IR_SOURCE);
        const hud = map.getContainer().querySelector(`#${SQUALL_HUD_ID}`);
        if (hud) hud.remove();
    } catch (err) {
        log.warn('Squall cleanup error:', err);
    }
    log.info('🧹 Squall layers cleaned up');
}

// (Top-left HUD + updateHudAge removed 2026-04-25 — replaced by the
// SquallLegend chip in the bottom-left corner. Kept SQUALL_HUD_ID as
// a constant in cleanupLayers in case any stale HUD from a previous
// build is still lingering in the DOM.)

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
