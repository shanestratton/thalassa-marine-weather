/**
 * useCycloneLayer — Renders active tropical cyclones on the Mapbox map.
 *
 * Storm markers use DOM-based mapboxgl.Marker so they render ABOVE
 * the wind particle overlay (which is a separate Leaflet div).
 *
 * Track lines use standard Mapbox GL layers (underneath wind is fine).
 */

import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import {
    fetchActiveCyclones,
    findClosestCyclone,
    type ActiveCyclone,
} from '../../services/weather/CycloneTrackingService';

// ── Category → Color mapping ──────────────────────────────

function categoryColor(cat: number): string {
    switch (cat) {
        case 5:
            return '#9333ea';
        case 4:
            return '#dc2626';
        case 3:
            return '#ea580c';
        case 2:
            return '#d97706';
        case 1:
            return '#eab308';
        default:
            return '#06b6d4';
    }
}

// ── GeoJSON builder for track lines ───────────────────────

function buildTrackGeoJSON(cyclones: ActiveCyclone[]): GeoJSON.FeatureCollection {
    const features: GeoJSON.Feature[] = cyclones.map((c) => ({
        type: 'Feature',
        properties: {
            name: c.name,
            category: c.category,
            color: categoryColor(c.category),
        },
        geometry: {
            type: 'LineString',
            coordinates: c.track.map((p) => [p.lon, p.lat]),
        },
    }));
    return { type: 'FeatureCollection', features };
}

// ── Create DOM marker for a cyclone ───────────────────────

function createStormMarkerEl(cyclone: ActiveCyclone): HTMLElement {
    const color = categoryColor(cyclone.category);
    const { windKts, pressureMb } = cyclone.currentPosition;

    // Build info string
    const catStr =
        cyclone.category > 0
            ? `Cat ${cyclone.categoryLabel} · ${windKts ?? '?'} kts${pressureMb ? ` · ${pressureMb} hPa` : ''}`
            : `${cyclone.categoryLabel} · ${windKts ?? '?'} kts`;

    const el = document.createElement('div');
    el.className = 'cyclone-marker';
    el.style.cssText = `
        display: flex;
        flex-direction: column;
        align-items: center;
        pointer-events: none;
        filter: drop-shadow(0 2px 8px rgba(0,0,0,0.6));
    `;

    el.innerHTML = `
        <div style="
            font-size: 13px;
            font-weight: 800;
            color: #fff;
            text-shadow: 0 1px 4px rgba(0,0,0,0.9);
            letter-spacing: 0.5px;
            margin-bottom: 4px;
            white-space: nowrap;
        ">${cyclone.name}</div>
        <div style="
            position: relative;
            width: 52px;
            height: 52px;
            display: flex;
            align-items: center;
            justify-content: center;
        ">
            <div style="
                position: absolute;
                inset: 0;
                border-radius: 50%;
                background: ${color}33;
                animation: cyclone-pulse 2s ease-in-out infinite;
            "></div>
            <div style="
                width: 40px;
                height: 40px;
                border-radius: 50%;
                background: rgba(0,0,0,0.7);
                border: 3px solid ${color};
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 18px;
                font-weight: 900;
                color: #fff;
                text-shadow: 0 0 8px ${color};
                z-index: 1;
            ">${cyclone.categoryLabel}</div>
        </div>
        <div style="
            font-size: 11px;
            color: rgba(255,255,255,0.8);
            text-shadow: 0 1px 3px rgba(0,0,0,0.9);
            margin-top: 3px;
            white-space: nowrap;
        ">${catStr}</div>
    `;

    return el;
}

// ── Inject pulse animation CSS (once) ─────────────────────

let cssInjected = false;
function injectCycloneCSS() {
    if (cssInjected) return;
    cssInjected = true;
    const style = document.createElement('style');
    style.textContent = `
        @keyframes cyclone-pulse {
            0%, 100% { transform: scale(1); opacity: 0.6; }
            50% { transform: scale(1.4); opacity: 0.2; }
        }
    `;
    document.head.appendChild(style);
}

// ── Source & Layer IDs (track lines only) ─────────────────

const SRC_TRACKS = 'cyclone-tracks';
const LYR_TRACK_LINE = 'cyclone-track-line';

// ── Hook ──────────────────────────────────────────────────

export function useCycloneLayer(
    mapRef: React.MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    visible: boolean,
    userLat: number,
    userLon: number,
    onClosestStorm?: (storm: ActiveCyclone | null) => void,
) {
    const layersCreated = useRef(false);
    const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);
    const hasFlown = useRef(false);
    const markersRef = useRef<mapboxgl.Marker[]>([]);
    const userLatRef = useRef(userLat);
    const userLonRef = useRef(userLon);
    const onClosestStormRef = useRef(onClosestStorm);

    userLatRef.current = userLat;
    userLonRef.current = userLon;
    onClosestStormRef.current = onClosestStorm;

    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;

        if (!visible) {
            // Hide track layer
            if (map.getLayer(LYR_TRACK_LINE)) {
                map.setLayoutProperty(LYR_TRACK_LINE, 'visibility', 'none');
            }
            // Remove DOM markers
            for (const m of markersRef.current) m.remove();
            markersRef.current = [];
            hasFlown.current = false;
            if (refreshTimer.current) {
                clearInterval(refreshTimer.current);
                refreshTimer.current = null;
            }
            return;
        }

        // Inject pulse CSS
        injectCycloneCSS();

        // Create track source/layer once
        if (!layersCreated.current) {
            const empty: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
            if (!map.getSource(SRC_TRACKS)) {
                map.addSource(SRC_TRACKS, { type: 'geojson', data: empty });
            }
            if (!map.getLayer(LYR_TRACK_LINE)) {
                map.addLayer({
                    id: LYR_TRACK_LINE,
                    type: 'line',
                    source: SRC_TRACKS,
                    paint: {
                        'line-color': ['get', 'color'],
                        'line-width': 2.5,
                        'line-opacity': 0.7,
                        'line-dasharray': [3, 2],
                    },
                    layout: { visibility: 'visible' },
                });
            }
            layersCreated.current = true;
            console.info('[CYCLONE] Track layer created');
        }

        // Show track layer
        if (map.getLayer(LYR_TRACK_LINE)) {
            map.setLayoutProperty(LYR_TRACK_LINE, 'visibility', 'visible');
        }

        // Fetch and render
        let cancelled = false;

        const loadCyclones = async () => {
            console.info('[CYCLONE] 🌀 Fetching active cyclones...');
            try {
                const cyclones = await fetchActiveCyclones();
                if (cancelled) return;

                console.info(`[CYCLONE] Got ${cyclones.length} active cyclone(s)`);

                if (cyclones.length === 0) {
                    onClosestStormRef.current?.(null);
                    return;
                }

                // Update track source
                const trackSrc = map.getSource(SRC_TRACKS) as mapboxgl.GeoJSONSource;
                if (trackSrc) trackSrc.setData(buildTrackGeoJSON(cyclones));

                // Remove old DOM markers
                for (const m of markersRef.current) m.remove();
                markersRef.current = [];

                // Create new DOM markers (renders above wind overlay!)
                for (const c of cyclones) {
                    const el = createStormMarkerEl(c);
                    const marker = new mapboxgl.Marker({ element: el, anchor: 'center' })
                        .setLngLat([c.currentPosition.lon, c.currentPosition.lat])
                        .addTo(map);
                    markersRef.current.push(marker);
                }

                // Find & report closest storm
                const closest = findClosestCyclone(cyclones, userLatRef.current, userLonRef.current);
                onClosestStormRef.current?.(closest);

                // Fly to closest storm on first load
                if (closest && !hasFlown.current) {
                    hasFlown.current = true;
                    const { lat, lon } = closest.currentPosition;
                    console.info(
                        `[CYCLONE] ✈️ Flying to ${closest.name} (Cat ${closest.categoryLabel}) at ${lat.toFixed(1)}, ${lon.toFixed(1)}`,
                    );
                    map.flyTo({
                        center: [lon, lat],
                        zoom: 5,
                        duration: 2000,
                        essential: true,
                    });
                }
            } catch (e) {
                console.error('[CYCLONE] ❌ Error loading cyclones:', e);
            }
        };

        loadCyclones();
        refreshTimer.current = setInterval(loadCyclones, 30 * 60 * 1000);

        return () => {
            cancelled = true;
            if (refreshTimer.current) {
                clearInterval(refreshTimer.current);
                refreshTimer.current = null;
            }
            // Clean up markers on unmount
            for (const m of markersRef.current) m.remove();
            markersRef.current = [];
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible, mapReady]);
}
