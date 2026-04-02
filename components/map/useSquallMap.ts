/**
 * useSquallMap — Global IR Squall Detection Map
 *
 * Uses NOAA GMGSI longwave IR (~12μm) global composite with BD Enhancement Curve
 * colour ramp to highlight deep convection and squall threats.
 *
 *  Satellite coverage: Global composite (GOES + Himawari + Meteosat)
 *  Resolution: ~4km, hourly updates
 *  Rendering: Pre-enhanced Dvorak/AVN color curve by SSEC meteorologists
 *            Gray=regular clouds, Blue=developing, Yellow=moderate, Red=severe
 *
 *  Data source: SSEC RealEarth globalir-avn (pre-enhanced IR tiles)
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
const SQUALL_HUD_ID = 'squall-map-hud';
const BORDER_SOURCE = 'squall-borders';
const BORDER_LAYER = 'squall-borders-layer';
const RADAR_SOURCE = 'squall-radar-source';
const RADAR_LAYER = 'squall-radar-layer';

// ── SSEC RealEarth globalir-avn via Supabase edge function proxy ──
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

/** Squall threat legend — radar precipitation intensity */
const THREAT_LEGEND = [
    { label: 'Cloud Cover', color: 'rgba(200,200,210,0.5)', min: 'IR satellite' },
    { label: 'Light Rain', color: '#1DB5E5', min: 'Radar' },
    { label: 'Moderate', color: '#28C83C', min: 'Radar' },
    { label: 'Heavy Rain', color: '#FFD119', min: 'Radar' },
    { label: 'Intense', color: '#FF6600', min: 'Radar' },
    { label: 'Extreme', color: '#FF0000', min: 'Radar' },
];

// ── Hook ──

export function useSquallMap(
    mapRef: React.MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    visible: boolean,
    allCyclones?: ActiveCyclone[],
    onSelectStorm?: (storm: ActiveCyclone) => void,
) {
    const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);
    const ageTimer = useRef<ReturnType<typeof setInterval> | null>(null);
    const latestTileTime = useRef<Date | null>(null);
    const isSetUp = useRef(false);
    const stormMarkersRef = useRef<mapboxgl.Marker[]>([]);

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
            // Clean up storm markers
            for (const m of stormMarkersRef.current) m.remove();
            stormMarkersRef.current = [];
            return;
        }

        // ── Setup squall IR layer ──
        if (!isSetUp.current) {
            addSquallLayer(map);
            addRadarLayer(map);
            addBorderLayer(map);
            addSquallHUD(map);
            fetchDataTimestamp(latestTileTime, map);
            isSetUp.current = true;
            log.info('🌩️ Squall map activated — GMGSI IR + RainViewer radar composite');
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
        maxzoom: 8,
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
                'raster-fade-duration': 300,
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
            maxzoom: 7,
        });

        // Insert above IR but below borders
        const insertBefore = map.getLayer(BORDER_LAYER)
            ? BORDER_LAYER
            : map.getLayer('route-line-layer')
              ? 'route-line-layer'
              : undefined;

        map.addLayer(
            {
                id: RADAR_LAYER,
                type: 'raster',
                source: RADAR_SOURCE,
                paint: {
                    'raster-opacity': 0.65,
                    'raster-fade-duration': 300,
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

function addBorderLayer(map: mapboxgl.Map): void {
    if (map.getSource(BORDER_SOURCE)) return;

    fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json')
        .then((r) => r.json())
        .then((topology) => {
            if (map.getSource(BORDER_SOURCE)) return;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const topo = topology as any;
            const { scale, translate } = topo.transform;
            const arcs: number[][][] = topo.arcs.map((arc: number[][]) => {
                let x = 0,
                    y = 0;
                return arc.map(([dx, dy]: number[]) => {
                    x += dx;
                    y += dy;
                    return [x * scale[0] + translate[0], y * scale[1] + translate[1]];
                });
            });

            const resolveRing = (indices: number[]): number[][] => {
                const coords: number[][] = [];
                for (const idx of indices) {
                    const arc = idx >= 0 ? arcs[idx] : arcs[~idx].slice().reverse();
                    coords.push(...(coords.length > 0 ? arc.slice(1) : arc));
                }
                return coords;
            };

            const obj = topo.objects.countries;
            const features: GeoJSON.Feature[] = [];
            for (const geom of obj.geometries) {
                if (geom.type === 'Polygon') {
                    features.push({
                        type: 'Feature',
                        properties: {},
                        geometry: { type: 'Polygon', coordinates: geom.arcs.map(resolveRing) },
                    });
                } else if (geom.type === 'MultiPolygon') {
                    features.push({
                        type: 'Feature',
                        properties: {},
                        geometry: {
                            type: 'MultiPolygon',
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            coordinates: geom.arcs.map((polygon: any) => polygon.map(resolveRing)),
                        },
                    });
                }
            }

            map.addSource(BORDER_SOURCE, {
                type: 'geojson',
                data: { type: 'FeatureCollection', features },
            });
            map.addLayer({
                id: BORDER_LAYER,
                type: 'line',
                source: BORDER_SOURCE,
                paint: {
                    'line-color': '#ffffff',
                    'line-width': 0.8,
                    'line-opacity': 0.35,
                },
                layout: {
                    'line-join': 'round',
                    'line-cap': 'round',
                },
            });
            log.info('🗺️ Added country borders for squall map');
        })
        .catch((err) => log.warn('Failed to load squall map borders:', err));
}

function addSquallHUD(map: mapboxgl.Map): void {
    // Remove existing
    const old = map.getContainer().querySelector(`#${SQUALL_HUD_ID}`);
    if (old) old.remove();

    const hud = document.createElement('div');
    hud.id = SQUALL_HUD_ID;
    hud.style.cssText = `
        position: absolute;
        bottom: 80px;
        left: 12px;
        z-index: 300;
        background: rgba(10, 12, 20, 0.88);
        backdrop-filter: blur(12px);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 12px;
        padding: 10px 12px;
        pointer-events: none;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    `;

    // Title
    const title = document.createElement('div');
    title.style.cssText =
        'font-size: 10px; font-weight: 800; color: #fff; letter-spacing: 0.5px; margin-bottom: 6px; text-transform: uppercase;';
    title.textContent = '⛈️ Squall Threat';
    hud.appendChild(title);

    // Legend rows
    for (const { label, color, min } of THREAT_LEGEND) {
        const row = document.createElement('div');
        row.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 3px;';

        const swatch = document.createElement('span');
        swatch.style.cssText = `
            width: 10px; height: 10px; border-radius: 2px;
            background: ${color};
            border: 1px solid rgba(255,255,255,0.15);
            flex-shrink: 0;
        `;
        row.appendChild(swatch);

        const text = document.createElement('span');
        text.style.cssText = 'font-size: 10px; color: rgba(255,255,255,0.7); font-weight: 600;';
        text.textContent = `${label}`;
        row.appendChild(text);

        const temp = document.createElement('span');
        temp.style.cssText = 'font-size: 9px; color: rgba(255,255,255,0.35); margin-left: auto;';
        temp.textContent = min;
        row.appendChild(temp);

        hud.appendChild(row);
    }

    // Data source
    const source = document.createElement('div');
    source.style.cssText =
        'font-size: 8px; color: rgba(255,255,255,0.25); margin-top: 6px; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 5px;';
    source.textContent = 'IR: SSEC Dvorak Enhanced · Radar: RainViewer';
    hud.appendChild(source);

    // Data Age warning — prominent, tactical
    const ageRow = document.createElement('div');
    ageRow.id = 'squall-data-age';
    ageRow.style.cssText = `
        margin-top: 6px;
        padding: 5px 8px;
        background: rgba(255, 165, 0, 0.15);
        border: 1px solid rgba(255, 165, 0, 0.3);
        border-radius: 6px;
        display: flex;
        align-items: center;
        gap: 5px;
    `;
    const ageIcon = document.createElement('span');
    ageIcon.style.cssText = 'font-size: 12px;';
    ageIcon.textContent = '⏱️';
    ageRow.appendChild(ageIcon);

    const ageText = document.createElement('span');
    ageText.id = 'squall-age-text';
    ageText.style.cssText = 'font-size: 11px; font-weight: 800; color: #FFA500; letter-spacing: 0.3px;';
    ageText.textContent = 'Data Age: —';
    ageRow.appendChild(ageText);
    hud.appendChild(ageRow);

    map.getContainer().appendChild(hud);
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
        // Borders
        if (map.getLayer(BORDER_LAYER)) map.removeLayer(BORDER_LAYER);
        if (map.getSource(BORDER_SOURCE)) map.removeSource(BORDER_SOURCE);
        // HUD
        const hud = map.getContainer().querySelector(`#${SQUALL_HUD_ID}`);
        if (hud) hud.remove();
    } catch (err) {
        log.warn('Squall map cleanup error:', err);
    }
    log.info('🧹 Squall map layers cleaned up');
}

// ── Data Age Tracking ──

/** Fetch data timestamp from SSEC RealEarth tile server */
async function fetchDataTimestamp(ref: React.MutableRefObject<Date | null>, map: mapboxgl.Map): Promise<void> {
    try {
        // Fetch a sample tile via proxy to get Last-Modified header
        const resp = await fetch(`${SUPABASE_URL}/functions/v1/satellite-tile?sat=ssec-ir&x=0&y=0&z=1`);
        if (!resp.ok) {
            log.warn(`SSEC tile HEAD failed: ${resp.status}`);
            return;
        }
        const lastMod = resp.headers.get('Last-Modified');
        if (lastMod) {
            ref.current = new Date(lastMod);
            log.info(`📡 SSEC IR tile timestamp: ${lastMod}`);
            updateDataAge(map, ref.current);
            return;
        }
        // Fallback: use current time minus 30 min as estimate
        ref.current = new Date(Date.now() - 30 * 60 * 1000);
        updateDataAge(map, ref.current);
        log.info('📡 SSEC timestamp fallback: estimated ~30 min old');
    } catch (err) {
        log.warn('Failed to fetch SSEC timestamp:', err);
    }
}

/** Update the data age display in the HUD */
function updateDataAge(map: mapboxgl.Map, tileTime: Date | null): void {
    const ageEl = map.getContainer().querySelector('#squall-age-text') as HTMLElement | null;
    const ageRow = map.getContainer().querySelector('#squall-data-age') as HTMLElement | null;
    if (!ageEl || !ageRow) return;

    if (!tileTime) {
        ageEl.textContent = 'Data Age: —';
        return;
    }

    const ageMs = Date.now() - tileTime.getTime();
    const ageMin = Math.round(ageMs / 60000);

    // Format display
    let ageStr: string;
    if (ageMin < 1) ageStr = '< 1 min';
    else if (ageMin < 60) ageStr = `${ageMin} min`;
    else {
        const h = Math.floor(ageMin / 60);
        const m = ageMin % 60;
        ageStr = m > 0 ? `${h}h ${m}m` : `${h}h`;
    }
    ageEl.textContent = `Data Age: ${ageStr}`;

    // Color-code by staleness
    if (ageMin <= 30) {
        // Fresh — green
        ageEl.style.color = '#22c55e';
        ageRow.style.background = 'rgba(34, 197, 94, 0.12)';
        ageRow.style.borderColor = 'rgba(34, 197, 94, 0.25)';
    } else if (ageMin <= 60) {
        // Aging — amber
        ageEl.style.color = '#FFA500';
        ageRow.style.background = 'rgba(255, 165, 0, 0.12)';
        ageRow.style.borderColor = 'rgba(255, 165, 0, 0.25)';
    } else if (ageMin <= 120) {
        // Stale — red
        ageEl.style.color = '#ef4444';
        ageRow.style.background = 'rgba(239, 68, 68, 0.15)';
        ageRow.style.borderColor = 'rgba(239, 68, 68, 0.3)';
    } else {
        // Very stale — pulsing red
        ageEl.style.color = '#dc2626';
        ageRow.style.background = 'rgba(220, 38, 38, 0.2)';
        ageRow.style.borderColor = 'rgba(220, 38, 38, 0.4)';
        ageEl.textContent = `⚠ Data Age: ${ageStr}`;
    }
}
