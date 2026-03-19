/**
 * useCycloneLayer — Renders active tropical cyclones on the Mapbox map.
 *
 * Creates:
 *   - Track polylines (dashed lines showing storm path)
 *   - Eye marker circles (category-colored pulsing circles)
 *   - Category labels (bold number in the eye)
 *   - Name labels (storm name below the eye)
 *
 * All layers are standard Mapbox data-driven, so they move with panning/zooming.
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
            return '#9333ea'; // Purple — catastrophic
        case 4:
            return '#dc2626'; // Red — devastating
        case 3:
            return '#ea580c'; // Orange — dangerous
        case 2:
            return '#d97706'; // Amber — very destructive
        case 1:
            return '#eab308'; // Yellow — destructive
        default:
            return '#06b6d4'; // Cyan — tropical storm
    }
}

function categoryGlow(cat: number): string {
    switch (cat) {
        case 5:
            return 'rgba(147, 51, 234, 0.4)';
        case 4:
            return 'rgba(220, 38, 38, 0.35)';
        case 3:
            return 'rgba(234, 88, 12, 0.3)';
        case 2:
            return 'rgba(217, 119, 6, 0.25)';
        case 1:
            return 'rgba(234, 179, 8, 0.2)';
        default:
            return 'rgba(6, 182, 212, 0.2)';
    }
}

// ── GeoJSON builders ──────────────────────────────────────

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

function buildEyeGeoJSON(cyclones: ActiveCyclone[]): GeoJSON.FeatureCollection {
    const features: GeoJSON.Feature[] = cyclones.map((c) => ({
        type: 'Feature',
        properties: {
            name: c.name,
            category: c.category,
            label: c.categoryLabel,
            wind: c.currentPosition.windKts,
            pressure: c.currentPosition.pressureMb,
            color: categoryColor(c.category),
            glow: categoryGlow(c.category),
            // Info line: "Cat 4 · 115 kts · 937 hPa"
            info:
                c.category > 0
                    ? `Cat ${c.categoryLabel} · ${c.currentPosition.windKts ?? '?'} kts${c.currentPosition.pressureMb ? ` · ${c.currentPosition.pressureMb} hPa` : ''}`
                    : `${c.categoryLabel} · ${c.currentPosition.windKts ?? '?'} kts`,
        },
        geometry: {
            type: 'Point',
            coordinates: [c.currentPosition.lon, c.currentPosition.lat],
        },
    }));
    return { type: 'FeatureCollection', features };
}

// ── Source & Layer IDs ─────────────────────────────────────

const SRC_TRACKS = 'cyclone-tracks';
const SRC_EYES = 'cyclone-eyes';

const LYR_TRACK_LINE = 'cyclone-track-line';
const LYR_TRACK_DOTS = 'cyclone-track-dots';
const LYR_EYE_GLOW = 'cyclone-eye-glow';
const LYR_EYE_CIRCLE = 'cyclone-eye-circle';
const LYR_EYE_LABEL = 'cyclone-eye-label';
const LYR_NAME_LABEL = 'cyclone-name-label';
const LYR_INFO_LABEL = 'cyclone-info-label';

const ALL_LAYERS = [
    LYR_TRACK_LINE,
    LYR_TRACK_DOTS,
    LYR_EYE_GLOW,
    LYR_EYE_CIRCLE,
    LYR_EYE_LABEL,
    LYR_NAME_LABEL,
    LYR_INFO_LABEL,
];

// ── Hook ──────────────────────────────────────────────────

export function useCycloneLayer(
    mapRef: React.MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    visible: boolean,
    userLat: number,
    userLon: number,
    onClosestStorm?: (storm: ActiveCyclone | null) => void,
) {
    // Use refs for values that shouldn't trigger effect re-runs
    const layersCreated = useRef(false);
    const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);
    const hasFlown = useRef(false);
    const userLatRef = useRef(userLat);
    const userLonRef = useRef(userLon);
    const onClosestStormRef = useRef(onClosestStorm);

    // Keep refs in sync without triggering effects
    userLatRef.current = userLat;
    userLonRef.current = userLon;
    onClosestStormRef.current = onClosestStorm;

    // Main effect — only re-runs when visible or mapReady changes
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;

        if (!visible) {
            // Hide layers
            for (const id of ALL_LAYERS) {
                if (map.getLayer(id)) {
                    map.setLayoutProperty(id, 'visibility', 'none');
                }
            }
            hasFlown.current = false;
            if (refreshTimer.current) {
                clearInterval(refreshTimer.current);
                refreshTimer.current = null;
            }
            return;
        }

        // ── Create sources & layers (once) ──
        if (!layersCreated.current) {
            console.info('[CYCLONE] Creating Mapbox sources and layers...');
            const empty: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

            if (!map.getSource(SRC_TRACKS)) {
                map.addSource(SRC_TRACKS, { type: 'geojson', data: empty });
            }
            if (!map.getSource(SRC_EYES)) {
                map.addSource(SRC_EYES, { type: 'geojson', data: empty });
            }

            // Track line (dashed)
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

            // Track position dots
            if (!map.getLayer(LYR_TRACK_DOTS)) {
                map.addLayer({
                    id: LYR_TRACK_DOTS,
                    type: 'circle',
                    source: SRC_TRACKS,
                    paint: {
                        'circle-radius': 3,
                        'circle-color': ['get', 'color'],
                        'circle-opacity': 0.5,
                    },
                    layout: { visibility: 'visible' },
                });
            }

            // Eye glow (large soft circle)
            if (!map.getLayer(LYR_EYE_GLOW)) {
                map.addLayer({
                    id: LYR_EYE_GLOW,
                    type: 'circle',
                    source: SRC_EYES,
                    paint: {
                        'circle-radius': 35,
                        'circle-color': ['get', 'glow'],
                        'circle-blur': 0.8,
                        'circle-opacity': 0.6,
                    },
                    layout: { visibility: 'visible' },
                });
            }

            // Eye circle (solid ring)
            if (!map.getLayer(LYR_EYE_CIRCLE)) {
                map.addLayer({
                    id: LYR_EYE_CIRCLE,
                    type: 'circle',
                    source: SRC_EYES,
                    paint: {
                        'circle-radius': 20,
                        'circle-color': 'rgba(0, 0, 0, 0.6)',
                        'circle-stroke-color': ['get', 'color'],
                        'circle-stroke-width': 3,
                    },
                    layout: { visibility: 'visible' },
                });
            }

            // Category number in the eye
            if (!map.getLayer(LYR_EYE_LABEL)) {
                map.addLayer({
                    id: LYR_EYE_LABEL,
                    type: 'symbol',
                    source: SRC_EYES,
                    layout: {
                        'text-field': ['get', 'label'],
                        'text-size': 18,
                        'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'],
                        'text-allow-overlap': true,
                        'text-ignore-placement': true,
                        visibility: 'visible',
                    },
                    paint: {
                        'text-color': '#ffffff',
                        'text-halo-color': ['get', 'color'],
                        'text-halo-width': 2,
                    },
                });
            }

            // Storm name (above eye)
            if (!map.getLayer(LYR_NAME_LABEL)) {
                map.addLayer({
                    id: LYR_NAME_LABEL,
                    type: 'symbol',
                    source: SRC_EYES,
                    layout: {
                        'text-field': ['get', 'name'],
                        'text-size': 13,
                        'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'],
                        'text-offset': [0, -2.8],
                        'text-anchor': 'bottom',
                        'text-allow-overlap': true,
                        'text-ignore-placement': true,
                        'text-letter-spacing': 0.1,
                        visibility: 'visible',
                    },
                    paint: {
                        'text-color': '#ffffff',
                        'text-halo-color': 'rgba(0, 0, 0, 0.8)',
                        'text-halo-width': 1.5,
                    },
                });
            }

            // Info line below eye
            if (!map.getLayer(LYR_INFO_LABEL)) {
                map.addLayer({
                    id: LYR_INFO_LABEL,
                    type: 'symbol',
                    source: SRC_EYES,
                    layout: {
                        'text-field': ['get', 'info'],
                        'text-size': 11,
                        'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
                        'text-offset': [0, 2.5],
                        'text-anchor': 'top',
                        'text-allow-overlap': true,
                        'text-ignore-placement': true,
                        visibility: 'visible',
                    },
                    paint: {
                        'text-color': 'rgba(255, 255, 255, 0.7)',
                        'text-halo-color': 'rgba(0, 0, 0, 0.8)',
                        'text-halo-width': 1,
                    },
                });
            }

            layersCreated.current = true;
            console.info('[CYCLONE] ✅ Layers created');
        }

        // Show layers
        for (const id of ALL_LAYERS) {
            if (map.getLayer(id)) {
                map.setLayoutProperty(id, 'visibility', 'visible');
            }
        }

        // ── Fetch and render ──
        let cancelled = false;

        const loadCyclones = async () => {
            console.info('[CYCLONE] 🌀 Fetching active cyclones from NOAA IBTrACS...');
            try {
                const cyclones = await fetchActiveCyclones();

                if (cancelled) return;

                console.info(`[CYCLONE] Got ${cyclones.length} active cyclone(s)`);

                if (cyclones.length === 0) {
                    onClosestStormRef.current?.(null);
                    return;
                }

                // Update sources
                const trackSrc = map.getSource(SRC_TRACKS) as mapboxgl.GeoJSONSource;
                const eyeSrc = map.getSource(SRC_EYES) as mapboxgl.GeoJSONSource;
                if (trackSrc) trackSrc.setData(buildTrackGeoJSON(cyclones));
                if (eyeSrc) eyeSrc.setData(buildEyeGeoJSON(cyclones));

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

        // Auto-refresh every 30 mins
        refreshTimer.current = setInterval(loadCyclones, 30 * 60 * 1000);

        return () => {
            cancelled = true;
            if (refreshTimer.current) {
                clearInterval(refreshTimer.current);
                refreshTimer.current = null;
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible, mapReady]);
}
