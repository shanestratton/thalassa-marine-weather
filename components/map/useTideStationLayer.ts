/**
 * useTideStationLayer — Tide station markers on MapHub.
 *
 * Shows nearby tide stations as interactive markers on the map.
 * On viewport change (60s debounce): fetches station list from WorldTides API.
 * On tap: shows popup with station name, distance, and 24h tide predictions.
 *
 * Uses the WorldTides `stations` endpoint (1 credit per search).
 * Predictions are fetched on-demand when user taps a marker.
 */
import { useEffect, useRef, useCallback, useState, type MutableRefObject } from 'react';
import mapboxgl from 'mapbox-gl';
import { createRoot, type Root } from 'react-dom/client';
import { CapacitorHttp } from '@capacitor/core';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('TideStations');

const SOURCE_ID = 'tide-stations';
const LAYER_CIRCLES = 'tide-station-circles';
const LAYER_LABELS = 'tide-station-labels';
const LAYER_GLOW = 'tide-station-glow';
const MIN_ZOOM = 6;
const DEBOUNCE_MS = 60_000; // 60s debounce for API calls
const SEARCH_RADIUS_KM = 100; // Search within 100km (WorldTides API v3 max)

// ── Types ──

interface TideStation {
    id: string;
    name: string;
    lat: number;
    lon: number;
    distance: number; // km from search center
}

interface TideExtreme {
    date: string;
    height: number;
    type: 'High' | 'Low';
}

// ── API Key ──

function getWorldTidesKey(): string {
    try {
        const env = import.meta.env;
        if (env?.VITE_WORLDTIDES_API_KEY) return env.VITE_WORLDTIDES_API_KEY;
    } catch {
        /* SSR */
    }
    return '';
}

function getSupabaseUrl(): string {
    try {
        const env = import.meta.env;
        if (env?.VITE_SUPABASE_URL) return env.VITE_SUPABASE_URL;
    } catch {
        /* SSR */
    }
    return '';
}

function getSupabaseKey(): string {
    try {
        const env = import.meta.env;
        if (env?.VITE_SUPABASE_KEY) return env.VITE_SUPABASE_KEY;
    } catch {
        /* SSR */
    }
    return '';
}

// ── Fetch stations from WorldTides ──

async function fetchNearbyStations(lat: number, lon: number): Promise<TideStation[]> {
    // Try Supabase proxy first (keeps key server-side)
    const supabaseUrl = getSupabaseUrl();
    const supabaseKey = getSupabaseKey();

    if (supabaseUrl && supabaseKey) {
        try {
            const res = await fetch(`${supabaseUrl}/functions/v1/proxy-tides`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${supabaseKey}`,
                    apikey: supabaseKey,
                },
                body: JSON.stringify({ lat, lon, stations: true, stationDistance: SEARCH_RADIUS_KM }),
            });

            if (res.status === 200) {
                const data = await res.json();
                if (data?.stations?.length) {
                    return data.stations.map((s: Record<string, unknown>) => ({
                        id: String(s.id || `${s.lat}-${s.lon}`),
                        name: String(s.name || 'Unknown'),
                        lat: Number(s.lat),
                        lon: Number(s.lon),
                        distance: Number(s.distance || 0),
                    }));
                }
            }
        } catch {
            // Fall through to direct
        }
    }

    // Direct fallback
    const key = getWorldTidesKey();
    if (!key) {
        log.warn('[stations] No WorldTides API key available');
        return [];
    }

    try {
        const url = `https://www.worldtides.info/api/v3?stations&lat=${lat}&lon=${lon}&stationDistance=${SEARCH_RADIUS_KM}&key=${key}`;
        const res = await CapacitorHttp.get({ url });
        if (res.status === 200 && res.data?.stations) {
            return res.data.stations.map((s: Record<string, unknown>) => ({
                id: String(s.id || `${s.lat}-${s.lon}`),
                name: String(s.name || 'Unknown'),
                lat: Number(s.lat),
                lon: Number(s.lon),
                distance: Number(s.distance || 0),
            }));
        }
    } catch (err) {
        log.warn('[stations] Fetch failed:', err);
    }

    return [];
}

// ── Fetch tide predictions for a specific station ──

async function fetchStationPredictions(lat: number, lon: number): Promise<TideExtreme[]> {
    const supabaseUrl = getSupabaseUrl();
    const supabaseKey = getSupabaseKey();

    if (supabaseUrl && supabaseKey) {
        try {
            const res = await fetch(`${supabaseUrl}/functions/v1/proxy-tides`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${supabaseKey}`,
                    apikey: supabaseKey,
                },
                body: JSON.stringify({ lat, lon, days: 2 }),
            });
            if (res.status === 200) {
                const data = await res.json();
                if (data?.extremes) return data.extremes as TideExtreme[];
            }
        } catch {
            /* fall through */
        }
    }

    const key = getWorldTidesKey();
    if (!key) return [];

    try {
        const start = Math.floor(Date.now() / 1000) - 3600;
        const url = `https://www.worldtides.info/api/v3?extremes&lat=${lat}&lon=${lon}&days=2&datum=LAT&start=${start}&key=${key}`;
        const res = await CapacitorHttp.get({ url });
        if (res.status === 200 && res.data?.extremes) {
            return res.data.extremes as TideExtreme[];
        }
    } catch (err) {
        log.warn('[predictions] Fetch failed:', err);
    }

    return [];
}

// ── Build popup HTML ──

function buildPopupContent(station: TideStation, predictions: TideExtreme[] | null, loading: boolean): string {
    const distLabel =
        station.distance < 1
            ? `${(station.distance * 1000).toFixed(0)} m away`
            : `${station.distance.toFixed(1)} km away`;

    let tideRows = '';
    if (loading) {
        tideRows = '<p style="color:#64748b;font-size:11px;margin:8px 0 0;">Loading predictions...</p>';
    } else if (predictions && predictions.length > 0) {
        const now = Date.now();
        tideRows = predictions
            .slice(0, 6) // Show up to 6 events
            .map((p) => {
                const t = new Date(p.date);
                const isPast = t.getTime() < now;
                const timeStr = t.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false });
                const dayStr = t.toLocaleDateString('en-AU', { weekday: 'short' });
                const icon = p.type === 'High' ? '▲' : '▼';
                const color = p.type === 'High' ? '#38bdf8' : '#94a3b8';
                const opacity = isPast ? '0.4' : '1';
                return `<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;opacity:${opacity}">
                    <span style="color:${color};font-size:11px;font-weight:700;">${icon} ${p.type.toUpperCase()}</span>
                    <span style="color:#e2e8f0;font-size:11px;font-family:monospace;">${p.height.toFixed(1)}m</span>
                    <span style="color:#64748b;font-size:10px;">${dayStr} ${timeStr}</span>
                </div>`;
            })
            .join('');
    } else {
        tideRows = '<p style="color:#64748b;font-size:11px;margin:8px 0 0;">No predictions available</p>';
    }

    return `
        <div style="min-width:200px;max-width:260px;">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
                <span style="font-size:16px;">🌊</span>
                <div>
                    <p style="margin:0;color:#f1f5f9;font-size:13px;font-weight:800;">${station.name}</p>
                    <p style="margin:2px 0 0;color:#64748b;font-size:10px;">${distLabel}</p>
                </div>
            </div>
            <div style="border-top:1px solid rgba(255,255,255,0.08);padding-top:6px;">
                ${tideRows}
            </div>
        </div>
    `;
}

// ── Main Hook ──

export function useTideStationLayer(
    mapRef: MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    visible: boolean,
) {
    const [stationCount, setStationCount] = useState(0);
    const [loading, setLoading] = useState(false);
    const popupRef = useRef<mapboxgl.Popup | null>(null);
    const popupRootRef = useRef<Root | null>(null);
    const moveEndTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastFetchCenter = useRef<{ lat: number; lon: number } | null>(null);
    const stationsCache = useRef<TideStation[]>([]);

    const closePopup = useCallback(() => {
        if (popupRef.current) {
            popupRef.current.remove();
            popupRef.current = null;
        }
        if (popupRootRef.current) {
            popupRootRef.current = null;
        }
    }, []);

    // Convert stations to GeoJSON
    const stationsToGeoJSON = useCallback(
        (stations: TideStation[]): GeoJSON.FeatureCollection => ({
            type: 'FeatureCollection',
            features: stations.map((s) => ({
                type: 'Feature' as const,
                geometry: {
                    type: 'Point' as const,
                    coordinates: [s.lon, s.lat],
                },
                properties: {
                    id: s.id,
                    name: s.name,
                    distance: s.distance,
                    lat: s.lat,
                    lon: s.lon,
                },
            })),
        }),
        [],
    );

    // Update map source
    const updateMapSource = useCallback(
        (stations: TideStation[]) => {
            const map = mapRef.current;
            if (!map) return;

            const source = map.getSource(SOURCE_ID) as mapboxgl.GeoJSONSource;
            if (source) {
                source.setData(stationsToGeoJSON(stations));
            }
            setStationCount(stations.length);
            stationsCache.current = stations;
        },
        [mapRef, stationsToGeoJSON],
    );

    // Fetch stations for current viewport
    const loadForViewport = useCallback(
        async (map: mapboxgl.Map) => {
            if (map.getZoom() < MIN_ZOOM) return;

            const center = map.getCenter();

            // Skip if we haven't moved far enough (50km)
            if (lastFetchCenter.current) {
                const dlat = center.lat - lastFetchCenter.current.lat;
                const dlon = center.lng - lastFetchCenter.current.lon;
                const distKm = Math.sqrt(dlat * dlat + dlon * dlon) * 111;
                if (distKm < 50) return;
            }

            setLoading(true);
            lastFetchCenter.current = { lat: center.lat, lon: center.lng };

            const stations = await fetchNearbyStations(center.lat, center.lng);
            log.info(
                `[load] Found ${stations.length} stations near ${center.lat.toFixed(2)}, ${center.lng.toFixed(2)}`,
            );
            updateMapSource(stations);
            setLoading(false);
        },
        [updateMapSource],
    );

    // ── Add source + layers ──
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;

        if (visible) {
            if (!map.getSource(SOURCE_ID)) {
                map.addSource(SOURCE_ID, {
                    type: 'geojson',
                    data: { type: 'FeatureCollection', features: [] },
                });
            }

            // Outer glow
            if (!map.getLayer(LAYER_GLOW)) {
                map.addLayer({
                    id: LAYER_GLOW,
                    type: 'circle',
                    source: SOURCE_ID,
                    minzoom: MIN_ZOOM,
                    paint: {
                        'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 12, 10, 16, 14, 20],
                        'circle-color': 'rgba(20, 184, 166, 0.12)',
                        'circle-blur': 0.8,
                    },
                });
            }

            // Inner circle
            if (!map.getLayer(LAYER_CIRCLES)) {
                map.addLayer({
                    id: LAYER_CIRCLES,
                    type: 'circle',
                    source: SOURCE_ID,
                    minzoom: MIN_ZOOM,
                    paint: {
                        'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 4, 10, 6, 14, 8],
                        'circle-color': '#14b8a6',
                        'circle-stroke-width': 1.5,
                        'circle-stroke-color': 'rgba(255, 255, 255, 0.6)',
                    },
                });
            }

            // Station name labels
            if (!map.getLayer(LAYER_LABELS)) {
                map.addLayer({
                    id: LAYER_LABELS,
                    type: 'symbol',
                    source: SOURCE_ID,
                    minzoom: 9, // Only show labels at moderate zoom
                    layout: {
                        'text-field': ['get', 'name'],
                        'text-size': ['interpolate', ['linear'], ['zoom'], 9, 9, 14, 11],
                        'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
                        'text-offset': [0, 1.5],
                        'text-anchor': 'top',
                        'text-max-width': 8,
                    },
                    paint: {
                        'text-color': '#5eead4',
                        'text-halo-color': 'rgba(0, 0, 0, 0.8)',
                        'text-halo-width': 1,
                        'text-opacity': ['interpolate', ['linear'], ['zoom'], 9, 0.5, 12, 0.9],
                    },
                });
            }

            // Load for initial viewport
            loadForViewport(map);
        } else {
            closePopup();
            if (map.getLayer(LAYER_LABELS)) map.removeLayer(LAYER_LABELS);
            if (map.getLayer(LAYER_CIRCLES)) map.removeLayer(LAYER_CIRCLES);
            if (map.getLayer(LAYER_GLOW)) map.removeLayer(LAYER_GLOW);
            if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
            setStationCount(0);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mapRef, mapReady, visible]);

    // ── Viewport change → fetch stations ──
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady || !visible) return;

        const onMoveEnd = () => {
            if (moveEndTimer.current) clearTimeout(moveEndTimer.current);
            moveEndTimer.current = setTimeout(() => loadForViewport(map), DEBOUNCE_MS);
        };

        map.on('moveend', onMoveEnd);
        return () => {
            map.off('moveend', onMoveEnd);
            if (moveEndTimer.current) clearTimeout(moveEndTimer.current);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mapRef, mapReady, visible]);

    // ── Click handler → show tide prediction popup ──
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady || !visible) return;

        const onClick = async (e: mapboxgl.MapMouseEvent & { features?: mapboxgl.MapboxGeoJSONFeature[] }) => {
            const features = map.queryRenderedFeatures(e.point, { layers: [LAYER_CIRCLES] });
            if (!features.length) return;

            const props = features[0].properties;
            if (!props) return;

            const station: TideStation = {
                id: String(props.id),
                name: String(props.name),
                lat: Number(props.lat),
                lon: Number(props.lon),
                distance: Number(props.distance),
            };

            closePopup();

            // Show popup with loading state
            const popup = new mapboxgl.Popup({
                closeOnClick: true,
                closeButton: true,
                maxWidth: '280px',
                className: 'tide-station-popup',
            })
                .setLngLat([station.lon, station.lat])
                .setHTML(buildPopupContent(station, null, true))
                .addTo(map);

            popupRef.current = popup;

            // Fetch predictions async
            const predictions = await fetchStationPredictions(station.lat, station.lon);
            if (popupRef.current === popup) {
                popup.setHTML(buildPopupContent(station, predictions, false));
            }
        };

        map.on('click', LAYER_CIRCLES, onClick);

        // Cursor style
        const onEnter = () => {
            map.getCanvas().style.cursor = 'pointer';
        };
        const onLeave = () => {
            map.getCanvas().style.cursor = '';
        };
        map.on('mouseenter', LAYER_CIRCLES, onEnter);
        map.on('mouseleave', LAYER_CIRCLES, onLeave);

        return () => {
            map.off('click', LAYER_CIRCLES, onClick);
            map.off('mouseenter', LAYER_CIRCLES, onEnter);
            map.off('mouseleave', LAYER_CIRCLES, onLeave);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mapRef, mapReady, visible]);

    return { stationCount, loading };
}
