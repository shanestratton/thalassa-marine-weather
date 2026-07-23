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
import type { Root } from 'react-dom/client';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('TideStations');

const SOURCE_ID = 'tide-stations';
const LAYER_CIRCLES = 'tide-station-circles';
const LAYER_LABELS = 'tide-station-labels';
const LAYER_GLOW = 'tide-station-glow';
const MIN_ZOOM = 6;
const DEBOUNCE_MS = 60_000; // 60s debounce for API calls
const SEARCH_RADIUS_KM = 100; // Search within 100km (WorldTides API v3 max)
const PROXY_TIMEOUT_MS = 10_000;
const MAX_PROXY_RESPONSE_BYTES = 512_000;
const MAX_STATIONS = 500;
const MAX_EXTREMES = 48;

// ── Types ──

export interface TideStation {
    id: string;
    name: string;
    lat: number;
    lon: number;
    distance: number; // km from search center
}

export interface TideExtreme {
    date: string;
    height: number;
    type: 'High' | 'Low';
}

function escapeTidePopupHtml(value: unknown): string {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function finiteTideNumber(value: unknown): number | null {
    if (typeof value === 'string' && !value.trim()) return null;
    try {
        const parsed = typeof value === 'number' ? value : Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function normaliseTideStation(value: Record<string, unknown>): TideStation | null {
    const lat = finiteTideNumber(value.lat);
    const lon = finiteTideNumber(value.lon);
    const distance = finiteTideNumber(value.distance) ?? 0;
    if (lat == null || lon == null || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return {
        id: String(value.id || `${lat}-${lon}`).slice(0, 200),
        name: String(value.name || 'Unknown').slice(0, 300),
        lat,
        lon,
        distance: Math.max(0, distance),
    };
}

function normaliseTideExtremes(value: unknown): TideExtreme[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((candidate) => {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
        const record = candidate as Record<string, unknown>;
        const timestamp = typeof record.date === 'string' ? Date.parse(record.date) : Number.NaN;
        const height = finiteTideNumber(record.height);
        const type = record.type === 'High' || record.type === 'Low' ? record.type : null;
        if (!Number.isFinite(timestamp) || height == null || !type) return [];
        return [{ date: new Date(timestamp).toISOString(), height, type }];
    });
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
        return env?.VITE_SUPABASE_ANON_KEY || env?.VITE_SUPABASE_KEY || '';
    } catch {
        /* SSR */
    }
    return '';
}

async function readBoundedResponseText(response: Response): Promise<string | null> {
    const advertised = Number(response.headers.get('content-length'));
    if (Number.isFinite(advertised) && advertised > MAX_PROXY_RESPONSE_BYTES) return null;
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > MAX_PROXY_RESPONSE_BYTES) {
                await reader.cancel();
                return null;
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
}

async function fetchTideProxy(payload: Record<string, number | boolean>): Promise<Record<string, unknown> | null> {
    const supabaseUrl = getSupabaseUrl();
    const supabaseKey = getSupabaseKey();
    if (!supabaseUrl || !supabaseKey) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
    try {
        const response = await fetch(`${supabaseUrl}/functions/v1/proxy-tides`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${supabaseKey}`,
                apikey: supabaseKey,
            },
            body: JSON.stringify(payload),
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
            signal: controller.signal,
        });
        if (!response.ok) return null;
        const text = await readBoundedResponseText(response);
        if (text == null) return null;
        const value = JSON.parse(text) as unknown;
        return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    } catch (err) {
        log.warn('[proxy] Tide request failed:', err);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// ── Fetch stations through the server-side WorldTides proxy ──

async function fetchNearbyStations(lat: number, lon: number): Promise<TideStation[]> {
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
        return [];
    }
    const data = await fetchTideProxy({ lat, lon, stations: true, stationDistance: SEARCH_RADIUS_KM });
    if (!Array.isArray(data?.stations)) return [];
    return (data.stations as Record<string, unknown>[])
        .slice(0, MAX_STATIONS)
        .map(normaliseTideStation)
        .filter((station): station is TideStation => station !== null);
}

// ── Fetch tide predictions for a specific station ──

async function fetchStationPredictions(lat: number, lon: number): Promise<TideExtreme[]> {
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
        return [];
    }
    const data = await fetchTideProxy({ lat, lon, days: 2 });
    return normaliseTideExtremes(data?.extremes).slice(0, MAX_EXTREMES);
}

// ── Build popup HTML ──

export function buildTideStationPopupHtml(
    station: TideStation,
    predictions: TideExtreme[] | null,
    loading: boolean,
): string {
    const distance = finiteTideNumber(station.distance);
    const distLabel =
        distance == null
            ? 'Distance unavailable'
            : distance < 1
              ? `${Math.max(0, distance * 1000).toFixed(0)} m away`
              : `${Math.max(0, distance).toFixed(1)} km away`;

    let tideRows = '';
    if (loading) {
        tideRows = '<p style="color:#64748b;font-size:11px;margin:8px 0 0;">Loading predictions...</p>';
    } else if (predictions && predictions.length > 0) {
        const now = Date.now();
        tideRows = normaliseTideExtremes(predictions)
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
                    <span style="color:${color};font-size:11px;font-weight:700;">${icon} ${escapeTidePopupHtml(p.type.toUpperCase())}</span>
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
                    <p style="margin:0;color:#f1f5f9;font-size:13px;font-weight:800;">${escapeTidePopupHtml(station.name)}</p>
                    <p style="margin:2px 0 0;color:#64748b;font-size:10px;">${escapeTidePopupHtml(distLabel)}</p>
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

            const station = normaliseTideStation(props);
            if (!station) return;

            closePopup();

            // Show popup with loading state
            const popup = new mapboxgl.Popup({
                closeOnClick: true,
                closeButton: true,
                maxWidth: '280px',
                className: 'tide-station-popup',
            })
                .setLngLat([station.lon, station.lat])
                .setHTML(buildTideStationPopupHtml(station, null, true))
                .addTo(map);

            popupRef.current = popup;

            // Fetch predictions async
            const predictions = await fetchStationPredictions(station.lat, station.lon);
            if (popupRef.current === popup) {
                popup.setHTML(buildTideStationPopupHtml(station, predictions, false));
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
