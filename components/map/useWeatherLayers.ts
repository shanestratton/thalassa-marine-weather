/**
 * useWeatherLayers — Weather layer toggle, isobars, rain, wind hooks.
 *
 * Manages the activeLayer state and the side-effects of switching between
 * weather overlays (rain, wind WebGL, synoptic pressure/isobars,
 * static tile overlays, velocity).
 */

import { useState, useRef, useEffect, useCallback, type MutableRefObject } from 'react';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('WeatherLayers');
import mapboxgl from 'mapbox-gl';
import { generateIsobars, generateIsobarsFromGrid, FORECAST_HOURS } from '../../services/weather/isobars';
import { WindStore, useWindStore } from '../../stores/WindStore';
import { WindParticleLayer } from './WindParticleLayer';
import { type WindGrid } from '../../services/weather/windField';
import { WindDataController } from '../../services/weather/WindDataController';
import { type WeatherLayer, getTileUrl, getWindColor } from './mapConstants';
// PrecipHeatmapResult removed — replaced by Rainbow.ai XYZ tiles

/**
 * useWeatherLayers — all weather overlay state + side effects.
 */
export function useWeatherLayers(
    mapRef: MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    embedded: boolean,
    location: { lat: number; lon: number },
) {
    const windState = useWindStore();

    // Multi-layer support — users can toggle multiple layers simultaneously.
    // Max 3 active layers for mobile performance.
    // Persisted to localStorage so selection survives app restart.
    const MAX_LAYERS = 3;
    const STORAGE_KEY = 'thalassa_active_layers';
    const [activeLayers, setActiveLayers] = useState<Set<WeatherLayer>>(() => {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored) {
                const arr = JSON.parse(stored) as WeatherLayer[];
                if (Array.isArray(arr) && arr.length > 0) return new Set(arr);
            }
        } catch {
            /* ignore */
        }
        return new Set();
    });
    const [showLayerMenu, setShowLayerMenu] = useState(false);

    // Toggle a layer on/off. 'none' clears all layers.
    const toggleLayer = useCallback((layer: WeatherLayer) => {
        setActiveLayers((prev) => {
            if (layer === 'none') return new Set<WeatherLayer>();
            const next = new Set(prev);
            if (next.has(layer)) {
                next.delete(layer);
            } else {
                if (next.size >= MAX_LAYERS) {
                    // At limit — remove the oldest (first) to make room
                    const first = next.values().next().value;
                    if (first) next.delete(first);
                }
                next.add(layer);
            }
            return next;
        });
    }, []);

    // Persist layer selection to localStorage whenever it changes
    useEffect(() => {
        try {
            const arr = [...activeLayers];
            if (arr.length > 0) localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
            else localStorage.removeItem(STORAGE_KEY);
        } catch {
            /* ignore */
        }
    }, [activeLayers]);

    // Backward-compatible single-layer getter (priority: wind > rain > pressure > first)
    const activeLayer: WeatherLayer = (() => {
        if (activeLayers.size === 0) return 'none';
        if (activeLayers.has('velocity') || activeLayers.has('wind'))
            return activeLayers.has('velocity') ? 'velocity' : 'wind';
        if (activeLayers.has('rain')) return 'rain';
        if (activeLayers.has('pressure')) return 'pressure';
        return activeLayers.values().next().value ?? 'none';
    })();

    // Stable string key for useEffect deps — prevents re-fires from Set reference changes
    const activeKey = [...activeLayers].sort().join(',');
    // Fast boolean flags
    const hasWind = activeLayers.has('wind') || activeLayers.has('velocity');
    const hasRain = activeLayers.has('rain');
    const hasPressure = activeLayers.has('pressure');

    // Legacy setter — sets exactly one layer (for backward compat with MapUI etc.)
    const setActiveLayer = useCallback((layer: WeatherLayer) => {
        if (layer === 'none') setActiveLayers(new Set());
        else setActiveLayers(new Set([layer]));
    }, []);

    // Wind GL engine
    const windEngineRef = useRef<WindParticleLayer | null>(null);
    const windGridRef = useRef<WindGrid | null>(null);
    const windMarkersRef = useRef<mapboxgl.Marker[]>([]);
    /** Actual GFS forecast hours for each timeline index (e.g. [0,3,6,9,12,18,24,36,48,72]) */
    const windForecastHoursRef = useRef<number[]>([0]);

    // ── Unified Rain + Forecast scrubber ──
    interface UnifiedRainFrame {
        type: 'radar' | 'forecast';
        /** RainViewer tile path (radar only) */
        radarPath?: string;
        /** Unix timestamp (radar only) */
        radarTime?: number;
        /** Rainbow.ai XYZ tile URL template (forecast only) — contains {z}/{x}/{y} */
        forecastTileUrl?: string;
        /** Label for the scrubber */
        label: string;
    }
    const unifiedFramesRef = useRef<UnifiedRainFrame[]>([]);
    /** Track which radar/forecast layer index is currently visible */
    const visibleRadarIdxRef = useRef<number | null>(null);
    const visibleForecastIdxRef = useRef<number | null>(null);
    const [rainFrameIndex, setRainFrameIndex] = useState(0);
    const [rainFrameCount, setRainFrameCount] = useState(0);
    const [rainPlaying, setRainPlaying] = useState(false);
    const [rainLoading, setRainLoading] = useState(false);
    const [rainReady, setRainReady] = useState(false);
    /** Index where radar frames end and forecast frames begin */
    const rainNowIdxRef = useRef(0);

    // Wind scrubber
    const [windHour, setWindHour] = useState(0);
    const [windTotalHours, setWindTotalHours] = useState(48);
    const [windPlaying, setWindPlaying] = useState(false);
    const [windReady, setWindReady] = useState(false);
    const [windMaxSpeed, setWindMaxSpeed] = useState(30);

    // GRIB download
    const [isGribDownloading, setIsGribDownloading] = useState(false);
    const [gribProgress, setGribProgress] = useState(0);
    const [gribError, setGribError] = useState<string | null>(null);

    // ── Isobar state ──
    const isobarFetchRef = useRef<number>(0);
    const cachedFramesRef = useRef<any[]>([]);
    const [forecastHour, setForecastHour] = useState(0);
    const [isPlaying, setIsPlaying] = useState(false);
    const [totalFrames, setTotalFrames] = useState(FORECAST_HOURS);
    const [framesReady, setFramesReady] = useState(0);
    const playRafRef = useRef<number | null>(null);
    const lastFrameTimeRef = useRef(0);

    // Swap pre-computed isobar data into map sources
    const applyFrame = useCallback((hour: number) => {
        const map = mapRef.current;
        const frames = cachedFramesRef.current;
        if (!map || !frames[hour]) return;
        const result = frames[hour];
        const contourSrc = map.getSource('isobar-contours') as mapboxgl.GeoJSONSource;
        const centersSrc = map.getSource('isobar-centers') as mapboxgl.GeoJSONSource;
        const barbsSrc = map.getSource('wind-barbs') as mapboxgl.GeoJSONSource;
        const arrowsSrc = map.getSource('circulation-arrows') as mapboxgl.GeoJSONSource;
        const tracksSrc = map.getSource('movement-tracks') as mapboxgl.GeoJSONSource;
        if (contourSrc) contourSrc.setData(result.contours);
        if (centersSrc) centersSrc.setData(result.centers);
        if (barbsSrc) barbsSrc.setData(result.barbs);
        if (arrowsSrc) arrowsSrc.setData(result.arrows);
        if (tracksSrc) tracksSrc.setData(result.tracks);

        if (result.heatmapDataUrl && result.heatmapBounds) {
            const [west, south, east, north] = result.heatmapBounds;
            const coordinates: [[number, number], [number, number], [number, number], [number, number]] = [
                [west, north],
                [east, north],
                [east, south],
                [west, south],
            ];
            const existingSrc = map.getSource('pressure-heatmap') as mapboxgl.ImageSource;
            if (existingSrc) {
                existingSrc.updateImage({ url: result.heatmapDataUrl, coordinates });
            } else {
                map.addSource('pressure-heatmap', { type: 'image', url: result.heatmapDataUrl, coordinates });
                map.addLayer(
                    {
                        id: 'pressure-heatmap-layer',
                        type: 'raster',
                        source: 'pressure-heatmap',
                        paint: { 'raster-opacity': 0.5, 'raster-fade-duration': 0 },
                    },
                    'isobar-lines',
                );
            }
        }
    }, []);

    // Pre-compute isobar frames
    const precomputeFrames = useCallback((grid: Record<string, unknown>) => {
        const total = grid.totalHours;
        setTotalFrames(total);
        setFramesReady(0);
        cachedFramesRef.current = new Array(total);
        let idx = 0;
        const computeBatch = () => {
            const batchEnd = Math.min(idx + 4, total);
            for (let h = idx; h < batchEnd; h++) {
                cachedFramesRef.current[h] = generateIsobarsFromGrid(grid, h);
            }
            setFramesReady(batchEnd);
            idx = batchEnd;
            if (idx < total) setTimeout(computeBatch, 0);
        };
        computeBatch();
    }, []);

    const updateIsobars = useCallback(
        async (map: mapboxgl.Map) => {
            const token = ++isobarFetchRef.current;
            const bounds = map.getBounds();
            if (!bounds) return;
            const zoom = map.getZoom();
            let west = bounds.getWest();
            let east = bounds.getEast();
            // Mapbox can return lons outside [-180, 180] when map wraps (e.g. east=200°)
            // Normalize and detect dateline crossing
            const span = east - west;
            if (span >= 360) {
                // Viewport covers full globe
                west = -180;
                east = 180;
            } else {
                // Normalize to [-180, 180]
                const normLon = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;
                west = normLon(west);
                east = normLon(east);
                // After normalization, west > east means dateline crossing
                if (west > east) {
                    west = -180;
                    east = 180;
                }
            }
            const data = await generateIsobars(bounds.getNorth(), bounds.getSouth(), west, east, zoom);
            if (token !== isobarFetchRef.current) return;
            if (!data) return;
            setForecastHour(0);
            cachedFramesRef.current = [data.result];
            applyFrame(0);
            precomputeFrames(data.grid);
        },
        [applyFrame, precomputeFrames],
    );

    // Isobar playback RAF
    useEffect(() => {
        if (!isPlaying) {
            if (playRafRef.current) cancelAnimationFrame(playRafRef.current);
            playRafRef.current = null;
            return;
        }
        const animate = (timestamp: number) => {
            // Skip processing when app is backgrounded — saves battery
            if (document.hidden) {
                playRafRef.current = requestAnimationFrame(animate);
                return;
            }
            if (timestamp - lastFrameTimeRef.current >= 350) {
                lastFrameTimeRef.current = timestamp;
                setForecastHour((prev) => {
                    const max = cachedFramesRef.current.length;
                    const next = prev + 1;
                    if (next >= max || !cachedFramesRef.current[next]) return 0;
                    return next;
                });
            }
            playRafRef.current = requestAnimationFrame(animate);
        };
        lastFrameTimeRef.current = performance.now();
        playRafRef.current = requestAnimationFrame(animate);
        return () => {
            if (playRafRef.current) cancelAnimationFrame(playRafRef.current);
        };
    }, [isPlaying]);

    // Apply isobar frame on hour change
    useEffect(() => {
        if (activeLayers.has('pressure')) applyFrame(forecastHour);
    }, [forecastHour, activeKey, applyFrame]);

    // ── Wind scrubber: update GL engine on hour change ──
    useEffect(() => {
        if (
            (!activeLayers.has('wind') && !activeLayers.has('velocity')) ||
            !windEngineRef.current ||
            !windGridRef.current
        )
            return;
        windEngineRef.current.setForecastHour(windHour);
        setWindMaxSpeed(windEngineRef.current.getMaxSpeed());

        const m = mapRef.current;
        const grid = windGridRef.current;
        if (!m || !grid) return;
        const h = Math.min(Math.floor(windHour), grid.totalHours - 1);
        const step = Math.max(2, Math.floor(Math.max(grid.width, grid.height) / 5));

        windMarkersRef.current.forEach((mk) => mk.remove());
        windMarkersRef.current = [];

        const sData = grid.speed[h];
        const uData = grid.u[h];
        const vData = grid.v[h];
        for (let r = 0; r < grid.height; r += step) {
            for (let c = 0; c < grid.width; c += step) {
                const idx = r * grid.width + c;
                const speedKts = Math.round(sData[idx] * 1.94384);
                const dir = ((Math.atan2(-uData[idx], -vData[idx]) * 180) / Math.PI + 360) % 360;
                const dirs = [
                    'N',
                    'NNE',
                    'NE',
                    'ENE',
                    'E',
                    'ESE',
                    'SE',
                    'SSE',
                    'S',
                    'SSW',
                    'SW',
                    'WSW',
                    'W',
                    'WNW',
                    'NW',
                    'NNW',
                ];
                const cardinal = dirs[Math.round(dir / 22.5) % 16];

                const el = document.createElement('div');
                el.className = 'wind-label-marker';
                el.style.cssText = `
                        display: inline-block;
                        background: ${getWindColor(speedKts)};
                        color: ${speedKts > 25 ? '#fff' : '#1a1a2e'};
                        font-size: 10px; font-weight: 800; line-height: 1.2;
                        text-align: center; padding: 3px 6px; border-radius: 6px;
                        white-space: nowrap; pointer-events: none; text-shadow: none;
                        box-shadow: 0 1px 4px rgba(0,0,0,0.4);
                        border: 1px solid rgba(255,255,255,0.15);
                        position: relative; z-index: 20;
                    `;
                el.innerHTML = `${speedKts}kt<br/>${cardinal}`;

                const marker = new mapboxgl.Marker({ element: el, anchor: 'center' })
                    .setLngLat([grid.lons[c], grid.lats[r]])
                    .addTo(m);
                windMarkersRef.current.push(marker);
            }
        }
    }, [windHour, activeKey]);

    // Wind auto-play — fractional steps for smooth morphing between hours
    useEffect(() => {
        if (!windPlaying || (!activeLayers.has('wind') && !activeLayers.has('velocity'))) return;
        const timer = setInterval(() => {
            setWindHour((prev) => {
                const next = prev + 0.1;
                if (next >= windTotalHours) {
                    setWindPlaying(false);
                    return 0;
                }
                return Math.round(next * 10) / 10; // avoid float drift
            });
        }, 100);
        return () => clearInterval(timer);
    }, [windPlaying, activeKey, windTotalHours]);

    // ── Wind forecast data loading (for scrubber — rendering handled by MapboxVelocityOverlay) ──
    useEffect(() => {
        if ((!activeLayers.has('wind') && !activeLayers.has('velocity')) || !mapReady) return;
        setWindHour(0);

        // Small delay to let the geolock flyTo settle
        const windTimer = setTimeout(() => {
            const m = mapRef.current;
            if (!m) return;
            WindDataController.activate(m)
                .then(() => {
                    const { grid: currentGrid } = WindStore.getState();
                    if (!currentGrid) {
                        console.warn('[WindScrubber] activate() resolved but no grid in store');
                        return;
                    }
                    windGridRef.current = currentGrid;
                    const GFS_HOURS = [0, 3, 6, 9, 12, 18, 24, 36, 48, 72];
                    windForecastHoursRef.current = GFS_HOURS.slice(0, currentGrid.totalHours);
                    setWindTotalHours(currentGrid.totalHours);
                    setWindReady(true);
                    console.warn(
                        `[WindScrubber] Grid loaded: totalHours=${currentGrid.totalHours}, u.length=${currentGrid.u.length}`,
                    );
                })
                .catch((err) => {
                    console.warn('[WindScrubber] activate() failed:', err);
                });
        }, 1200);
        return () => clearTimeout(windTimer);
    }, [activeKey, mapReady]);

    // ── Center map when switching layers + WIND GEOLOCK ──
    const prevLayerCountRef = useRef(0);
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady || embedded) return;

        const hasWind = activeLayers.has('wind') || activeLayers.has('velocity');
        const layerCount = activeLayers.size;

        if (hasWind) {
            // Wind active — constrain min zoom only (overlay handles its own visibility at high zoom)
            map.setMinZoom(1);
            map.setMaxZoom(18);
            map.setMaxBounds(undefined as any);
        } else {
            // No wind — full freedom
            map.setMinZoom(1);
            map.setMaxZoom(20);
            map.setMaxBounds(undefined as any);
        }

        // Fly to user only on FIRST layer activation (not every toggle)
        if (layerCount > 0 && prevLayerCountRef.current === 0) {
            map.flyTo({ center: [location.lon, location.lat], zoom: 5, duration: 800 });
        }
        prevLayerCountRef.current = layerCount;
    }, [activeKey, mapReady, embedded]);

    // Rain auto-play (unified radar + forecast) — loops continuously
    useEffect(() => {
        if (!rainPlaying || !activeLayers.has('rain') || activeLayers.size > 1) return;
        const timer = setInterval(() => {
            // Pause when app is backgrounded
            if (document.hidden) return;
            setRainFrameIndex((prev) => {
                if (prev + 1 >= rainFrameCount) return 0; // loop back to start
                return prev + 1;
            });
        }, 600);
        return () => clearInterval(timer);
    }, [rainPlaying, activeKey, rainFrameCount]);

    // Unified rain frame swap: toggle visibility on pre-loaded layers
    const rainFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        if (!activeLayers.has('rain') || !rainReady) return;
        const m = mapRef.current;
        if (!m) return;
        const frames = unifiedFramesRef.current;
        if (rainFrameIndex >= frames.length) return;
        const frame = frames[rainFrameIndex];

        // Clear any pending fade timer
        if (rainFadeTimerRef.current) {
            clearTimeout(rainFadeTimerRef.current);
            rainFadeTimerRef.current = null;
        }

        if (frame.type === 'radar' && frame.radarPath) {
            // Pre-loaded radar — just toggle visibility
            const radarFrames = frames.filter((f) => f.type === 'radar');
            const rdIdx = radarFrames.indexOf(frame);
            const prevRdIdx = visibleRadarIdxRef.current;

            // Hide any visible forecast layer
            if (visibleForecastIdxRef.current !== null) {
                const fcId = `rainbow-fc-${visibleForecastIdxRef.current}`;
                try {
                    if (m.getLayer(fcId)) m.setPaintProperty(fcId, 'raster-opacity', 0);
                } catch (_) {}
                visibleForecastIdxRef.current = null;
            }

            // Hide previous radar layer
            if (prevRdIdx !== null && prevRdIdx !== rdIdx) {
                const prevId = `radar-${prevRdIdx}`;
                try {
                    if (m.getLayer(prevId)) m.setPaintProperty(prevId, 'raster-opacity', 0);
                } catch (_) {}
            }

            // Show current radar layer
            if (rdIdx >= 0) {
                const layerId = `radar-${rdIdx}`;
                try {
                    if (m.getLayer(layerId)) m.setPaintProperty(layerId, 'raster-opacity', 0.75);
                } catch (_) {}
                visibleRadarIdxRef.current = rdIdx;
            }
        } else if (frame.type === 'forecast' && frame.forecastTileUrl) {
            // Pre-loaded forecast — just toggle visibility
            const forecastFrames = frames.filter((f) => f.type === 'forecast');
            const fcIdx = forecastFrames.indexOf(frame);
            const prevFcIdx = visibleForecastIdxRef.current;

            // Hide any visible radar layer
            if (visibleRadarIdxRef.current !== null) {
                const rdId = `radar-${visibleRadarIdxRef.current}`;
                try {
                    if (m.getLayer(rdId)) m.setPaintProperty(rdId, 'raster-opacity', 0);
                } catch (_) {}
                visibleRadarIdxRef.current = null;
            }

            // Hide previous forecast layer
            if (prevFcIdx !== null && prevFcIdx !== fcIdx) {
                const prevId = `rainbow-fc-${prevFcIdx}`;
                try {
                    if (m.getLayer(prevId)) m.setPaintProperty(prevId, 'raster-opacity', 0);
                } catch (_) {}
            }

            // Show current forecast layer
            if (fcIdx >= 0) {
                const layerId = `rainbow-fc-${fcIdx}`;
                try {
                    if (m.getLayer(layerId)) m.setPaintProperty(layerId, 'raster-opacity', 0.75);
                } catch (_) {}
                visibleForecastIdxRef.current = fcIdx;
            }
        }
    }, [rainFrameIndex, activeKey, rainReady]);

    // ── Weather Layer Toggle (main effect) ──
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;

        // Remove layers NOT in active set
        if (!activeLayers.has('rain')) {
            for (let i = 0; i < 30; i++) {
                ['radar-', 'rainbow-fc-'].forEach((prefix) => {
                    const id = `${prefix}${i}`;
                    try {
                        if (map.getLayer(id)) map.removeLayer(id);
                        if (map.getSource(id)) map.removeSource(id);
                    } catch (_) {}
                });
            }
            unifiedFramesRef.current = [];
            setRainFrameCount(0);
            setRainFrameIndex(0);
        }
        if (!activeLayers.has('wind') && !activeLayers.has('velocity')) {
            if (map.getLayer('wind-labels')) map.removeLayer('wind-labels');
            if (map.getSource('wind-labels')) map.removeSource('wind-labels');
            windMarkersRef.current.forEach((mk) => mk.remove());
            windMarkersRef.current = [];
            try {
                if (map.getLayer('wind-particles')) map.removeLayer('wind-particles');
            } catch (_) {}
            windEngineRef.current = null;
            WindDataController.deactivate(map);
        }

        const hideIsobars = () => {
            [
                'isobar-lines',
                'isobar-labels',
                'isobar-center-circles',
                'isobar-center-labels',
                'wind-barb-layer',
                'circulation-arrow-layer',
                'movement-track-lines',
                'movement-track-labels',
                'pressure-heatmap-layer',
            ].forEach((id) => {
                if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
            });
        };
        const showIsobars = () => {
            [
                'isobar-lines',
                'isobar-labels',
                'isobar-center-circles',
                'isobar-center-labels',
                'wind-barb-layer',
                'circulation-arrow-layer',
                'movement-track-lines',
                'movement-track-labels',
                'pressure-heatmap-layer',
            ].forEach((id) => {
                if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'visible');
            });
        };

        if (!activeLayers.has('pressure')) hideIsobars();

        if (activeLayers.size === 0) return;

        // ── Pressure / Isobars ──
        if (activeLayers.has('pressure')) {
            // Only adjust zoom when pressure is the sole layer
            if (activeLayers.size === 1) {
                const currentZoom = map.getZoom();
                if (currentZoom > 4 || currentZoom < 2.5) {
                    map.flyTo({ zoom: 3, duration: 1200 });
                }
            }

            if (!map.getSource('isobar-contours')) {
                map.addSource('isobar-contours', {
                    type: 'geojson',
                    data: { type: 'FeatureCollection', features: [] },
                });
                map.addSource('isobar-centers', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

                map.addLayer({
                    id: 'isobar-lines',
                    type: 'line',
                    source: 'isobar-contours',
                    paint: { 'line-color': '#ffffff', 'line-width': 1.5, 'line-opacity': 0.7 },
                });
                map.addLayer({
                    id: 'isobar-labels',
                    type: 'symbol',
                    source: 'isobar-contours',
                    layout: {
                        'symbol-placement': 'line',
                        'text-field': ['get', 'label'],
                        'text-size': 11,
                        'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'],
                        'symbol-spacing': 500,
                        'text-keep-upright': true,
                    },
                    paint: { 'text-color': '#e2e8f0', 'text-halo-color': '#0f172a', 'text-halo-width': 1.5 },
                });

                map.addLayer({
                    id: 'isobar-center-circles',
                    type: 'circle',
                    source: 'isobar-centers',
                    paint: {
                        'circle-radius': 18,
                        'circle-color': [
                            'match',
                            ['get', 'type'],
                            'H',
                            'rgba(239, 68, 68, 0.15)',
                            'L',
                            'rgba(59, 130, 246, 0.15)',
                            'rgba(100, 116, 139, 0.15)',
                        ],
                        'circle-stroke-color': ['match', ['get', 'type'], 'H', '#ef4444', 'L', '#3b82f6', '#64748b'],
                        'circle-stroke-width': 2,
                    },
                });
                map.addLayer({
                    id: 'isobar-center-labels',
                    type: 'symbol',
                    source: 'isobar-centers',
                    layout: {
                        'text-field': ['get', 'label'],
                        'text-size': 14,
                        'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'],
                        'text-allow-overlap': true,
                    },
                    paint: {
                        'text-color': ['match', ['get', 'type'], 'H', '#ef4444', 'L', '#3b82f6', '#e2e8f0'],
                        'text-halo-color': '#0f172a',
                        'text-halo-width': 1.5,
                    },
                });

                // Wind Barbs
                map.addSource('wind-barbs', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
                const barbCanvas = document.createElement('canvas');
                barbCanvas.width = 48;
                barbCanvas.height = 48;
                const ctx = barbCanvas.getContext('2d');
                if (ctx) {
                    ctx.clearRect(0, 0, 48, 48);
                    ctx.strokeStyle = '#e2e8f0';
                    ctx.lineWidth = 2;
                    ctx.lineCap = 'round';
                    const cx = 24,
                        bottom = 40,
                        top = 8;
                    ctx.beginPath();
                    ctx.moveTo(cx, bottom);
                    ctx.lineTo(cx, top);
                    ctx.stroke();
                    ctx.beginPath();
                    ctx.moveTo(cx, top + 2);
                    ctx.lineTo(cx + 12, top - 2);
                    ctx.stroke();
                    ctx.beginPath();
                    ctx.moveTo(cx, top + 8);
                    ctx.lineTo(cx + 10, top + 4);
                    ctx.stroke();
                    ctx.beginPath();
                    ctx.moveTo(cx, top + 14);
                    ctx.lineTo(cx + 6, top + 12);
                    ctx.stroke();
                    ctx.beginPath();
                    ctx.arc(cx, bottom, 3, 0, Math.PI * 2);
                    ctx.fillStyle = '#e2e8f0';
                    ctx.fill();
                }
                const barbImage = new Image(48, 48);
                barbImage.onload = () => {
                    if (!map.hasImage('wind-barb-icon')) map.addImage('wind-barb-icon', barbImage, { sdf: false });
                };
                barbImage.src = barbCanvas.toDataURL();

                map.addLayer({
                    id: 'wind-barb-layer',
                    type: 'symbol',
                    source: 'wind-barbs',
                    layout: {
                        'icon-image': 'wind-barb-icon',
                        'icon-size': 0.7,
                        'icon-rotate': ['get', 'rotation'],
                        'icon-rotation-alignment': 'map',
                        'icon-allow-overlap': true,
                        'text-field': ['concat', ['get', 'label'], ' kt'],
                        'text-size': 9,
                        'text-offset': [0, 2.5],
                        'text-anchor': 'top',
                        'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
                        'text-allow-overlap': false,
                    },
                    paint: {
                        'icon-opacity': 0.8,
                        'text-color': '#94a3b8',
                        'text-halo-color': '#0f172a',
                        'text-halo-width': 1,
                    },
                });

                // Circulation Arrows
                map.addSource('circulation-arrows', {
                    type: 'geojson',
                    data: { type: 'FeatureCollection', features: [] },
                });
                const arrowCanvas = document.createElement('canvas');
                arrowCanvas.width = 32;
                arrowCanvas.height = 32;
                const actx = arrowCanvas.getContext('2d');
                if (actx) {
                    actx.clearRect(0, 0, 32, 32);
                    actx.strokeStyle = '#ffffff';
                    actx.lineWidth = 3;
                    actx.lineCap = 'round';
                    actx.lineJoin = 'round';
                    actx.beginPath();
                    actx.moveTo(8, 22);
                    actx.lineTo(16, 10);
                    actx.lineTo(24, 22);
                    actx.stroke();
                    actx.beginPath();
                    actx.moveTo(16, 10);
                    actx.lineTo(16, 28);
                    actx.stroke();
                }
                const arrowImg = new Image(32, 32);
                arrowImg.onload = () => {
                    if (!map.hasImage('circulation-arrow')) map.addImage('circulation-arrow', arrowImg, { sdf: true });
                };
                arrowImg.src = arrowCanvas.toDataURL();
                map.addLayer({
                    id: 'circulation-arrow-layer',
                    type: 'symbol',
                    source: 'circulation-arrows',
                    layout: {
                        'icon-image': 'circulation-arrow',
                        'icon-size': 0.6,
                        'icon-rotate': ['get', 'rotation'],
                        'icon-rotation-alignment': 'map',
                        'icon-allow-overlap': true,
                    },
                    paint: { 'icon-color': ['get', 'color'], 'icon-opacity': 0.7 },
                });

                // Movement Tracks
                map.addSource('movement-tracks', {
                    type: 'geojson',
                    data: { type: 'FeatureCollection', features: [] },
                });
                map.addLayer({
                    id: 'movement-track-lines',
                    type: 'line',
                    source: 'movement-tracks',
                    paint: {
                        'line-color': ['get', 'color'],
                        'line-width': 3,
                        'line-opacity': 0.85,
                        'line-dasharray': [3, 2],
                    },
                });
                map.addLayer({
                    id: 'movement-track-labels',
                    type: 'symbol',
                    source: 'movement-tracks',
                    layout: {
                        'symbol-placement': 'line',
                        'text-field': ['get', 'label'],
                        'text-size': 11,
                        'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'],
                        'symbol-spacing': 500,
                        'text-anchor': 'center',
                        'text-keep-upright': true,
                    },
                    paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0f172a', 'text-halo-width': 1.5 },
                });
            }

            showIsobars();
            updateIsobars(map);
        }

        // ── Rain (unified: RainViewer radar past + GFS forecast future) ──
        if (activeLayers.has('rain') && unifiedFramesRef.current.length === 0) {
            // Only fetch if not already loaded (idempotent guard)
            setRainLoading(true);
            setRainReady(false);
            setRainFrameIndex(0);

            (async () => {
                try {
                    // 1. Fetch RainViewer radar frames (past + short nowcast)
                    const radarData = await fetch('https://api.rainviewer.com/public/weather-maps.json')
                        .then((r) => r.json())
                        .catch(() => null);
                    const past: { path: string; time: number }[] = radarData?.radar?.past ?? [];
                    const nowcast: { path: string; time: number }[] = radarData?.radar?.nowcast ?? [];
                    const allRadar = [...past, ...nowcast];

                    // 2. Rainbow.ai forecast tiles (1km res) — via Supabase Edge Proxy
                    // API key stays server-side in Supabase Secrets (RAINBOW_API_KEY).
                    let rainbowSnapshot: number | null = null;
                    const RAINBOW_FORECAST_MINUTES = [10, 20, 30, 40, 50, 60, 80, 100, 120, 150, 180, 210, 240];
                    const supabaseUrl =
                        (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) || '';

                    if (supabaseUrl) {
                        try {
                            const snapResp = await fetch(`${supabaseUrl}/functions/v1/proxy-rainbow?action=snapshot`);
                            if (snapResp.ok) {
                                const snapData = await snapResp.json();
                                rainbowSnapshot = snapData.snapshot || null;
                                log.info(`Rainbow.ai snapshot: ${rainbowSnapshot}`);
                            } else {
                                log.warn(`Rainbow.ai snapshot failed: ${snapResp.status}`);
                            }
                        } catch (err) {
                            log.warn('Rainbow.ai snapshot fetch failed, using radar only:', err);
                        }
                    }

                    // 3. Build unified timeline
                    const unified: UnifiedRainFrame[] = [];
                    const now = Date.now() / 1000;

                    // Add radar frames
                    for (const f of allRadar) {
                        const diffMin = Math.round((f.time - now) / 60);
                        let label: string;
                        if (Math.abs(diffMin) < 3) label = 'Now';
                        else if (Math.abs(diffMin) >= 60) {
                            const h = Math.round(diffMin / 60);
                            label = `${h > 0 ? '+' : ''}${h}h`;
                        } else label = `${diffMin > 0 ? '+' : ''}${diffMin}m`;

                        unified.push({ type: 'radar', radarPath: f.path, radarTime: f.time, label });
                    }

                    // Mark where "now" is (last past frame)
                    const nowIdx = Math.max(0, past.length - 1);
                    rainNowIdxRef.current = nowIdx;

                    // forecast_time is in SECONDS (not minutes!)
                    // Use raw dBZ tiles (color=dbz_u8) so we can apply custom raster-color
                    // matching RainViewer scheme 4 exactly
                    if (rainbowSnapshot) {
                        for (const mins of RAINBOW_FORECAST_MINUTES) {
                            // Format: +10m, +1h, +1h 20m, +2h 30m
                            let label: string;
                            if (mins < 60) label = `+${mins}m`;
                            else if (mins % 60 === 0) label = `+${mins / 60}h`;
                            else label = `+${Math.floor(mins / 60)}h${mins % 60}m`;
                            const forecastSecs = mins * 60;
                            // All tile requests go through proxy-rainbow (API key stays server-side)
                            const tileUrl = `${supabaseUrl}/functions/v1/proxy-rainbow?action=tile&snapshot=${rainbowSnapshot}&forecast=${forecastSecs}&z={z}&x={x}&y={y}&color=dbz_u8`;
                            unified.push({ type: 'forecast', forecastTileUrl: tileUrl, label });
                        }
                    }

                    unifiedFramesRef.current = unified;
                    setRainFrameCount(unified.length);
                    setRainFrameIndex(nowIdx);

                    // 4. Set up map sources
                    if (!mapRef.current) return;
                    const m = mapRef.current;

                    // Pre-create ALL radar layers (hidden) — same instant approach as forecast
                    const radarFrames = unified.filter((f) => f.type === 'radar');
                    for (let i = 0; i < radarFrames.length; i++) {
                        const rf = radarFrames[i];
                        if (!rf.radarPath) continue;
                        const srcId = `radar-${i}`;
                        m.addSource(srcId, {
                            type: 'raster',
                            tiles: [`https://tilecache.rainviewer.com${rf.radarPath}/256/{z}/{x}/{y}/4/1_1.png`],
                            tileSize: 256,
                            minzoom: 2,
                            maxzoom: 7,
                        });
                        m.addLayer(
                            {
                                id: srcId,
                                type: 'raster',
                                source: srcId,
                                paint: {
                                    'raster-opacity': i === nowIdx ? 0.75 : 0,
                                    'raster-opacity-transition': { duration: 200, delay: 0 },
                                    'raster-fade-duration': 0,
                                },
                            },
                            m.getLayer('route-line-layer') ? 'route-line-layer' : undefined,
                        );
                    }
                    log.info(`Pre-created ${radarFrames.length} radar layers`);

                    // Pre-create ALL Rainbow.ai forecast layers (hidden)
                    // Uses raw dBZ tiles + raster-color to match RainViewer scheme 4 exactly
                    // dBZ encoding: pixel value 12 = no rain, 13-83 = light→heavy precip
                    // Colour ramp: transparent → blue → cyan → yellow → orange → red
                    const RAINVIEWER_COLOR_RAMP: mapboxgl.Expression = [
                        'interpolate',
                        ['linear'],
                        ['raster-value'],
                        // Normalized: pixel/255. dBZ 12 = 0.047, 83 = 0.325
                        0.047,
                        'rgba(0,0,0,0)', // ≤12: transparent (no rain)
                        0.052,
                        'rgba(0,72,120,0.8)', // ~13: deep blue (light drizzle)
                        0.078,
                        'rgba(0,120,180,0.8)', // ~20: medium blue
                        0.11,
                        'rgba(0,150,210,0.8)', // ~28: bright blue
                        0.137,
                        'rgba(56,190,230,0.85)', // ~35: cyan
                        0.165,
                        'rgba(130,220,235,0.85)', // ~42: light cyan
                        0.196,
                        'rgba(250,235,0,0.9)', // ~50: yellow
                        0.22,
                        'rgba(250,210,0,0.9)', // ~56: yellow-orange
                        0.247,
                        'rgba(250,180,0,0.9)', // ~63: orange
                        0.275,
                        'rgba(250,120,0,0.95)', // ~70: dark orange
                        0.302,
                        'rgba(200,0,0,0.95)', // ~77: red
                        0.325,
                        'rgba(143,0,0,1)', // ~83: dark red (extreme)
                    ];

                    const forecastFrames = unified.filter((f) => f.type === 'forecast');
                    for (let i = 0; i < forecastFrames.length; i++) {
                        const ff = forecastFrames[i];
                        if (!ff.forecastTileUrl) continue;
                        const srcId = `rainbow-fc-${i}`;
                        m.addSource(srcId, {
                            type: 'raster',
                            tiles: [ff.forecastTileUrl],
                            tileSize: 256,
                            minzoom: 2,
                            maxzoom: 12,
                        });
                        m.addLayer(
                            {
                                id: srcId,
                                type: 'raster',
                                source: srcId,
                                paint: {
                                    'raster-opacity': 0,
                                    'raster-opacity-transition': { duration: 200, delay: 0 },
                                    'raster-fade-duration': 0,
                                    'raster-color': RAINVIEWER_COLOR_RAMP,
                                    'raster-color-mix': [1, 0, 0, 0], // Use red channel as value (R=G=B in grayscale)
                                    'raster-color-range': [0, 1],
                                },
                            },
                            m.getLayer('route-line-layer') ? 'route-line-layer' : undefined,
                        );
                    }
                    log.info(`Pre-created ${forecastFrames.length} Rainbow.ai forecast layers`);

                    setRainReady(true);
                    const forecastCount = rainbowSnapshot ? RAINBOW_FORECAST_MINUTES.length : 0;
                    log.info(
                        `Unified timeline: ${unified.length} frames (${allRadar.length} radar + ${forecastCount} Rainbow.ai forecast)`,
                    );
                } catch (err) {
                    log.error('Error loading unified rain data:', err);
                } finally {
                    setRainLoading(false);
                }
            })();

            return () => {
                // Clear pending fade timer
                if (rainFadeTimerRef.current) {
                    clearTimeout(rainFadeTimerRef.current);
                    rainFadeTimerRef.current = null;
                }
                try {
                    const m = mapRef.current;
                    // Clean up pre-created radar + forecast layers
                    for (let i = 0; i < 30; i++) {
                        ['radar-', 'rainbow-fc-'].forEach((prefix) => {
                            const id = `${prefix}${i}`;
                            try {
                                if (m?.getLayer(id)) m.removeLayer(id);
                            } catch (_) {}
                            try {
                                if (m?.getSource(id)) m.removeSource(id);
                            } catch (_) {}
                        });
                    }
                } catch (_) {}

                unifiedFramesRef.current = [];
                setRainFrameCount(0);
                setRainReady(false);
            };
        }

        // ── Static tile layers (sea, satellite, temperature, clouds) ──
        // Remove tile layers NOT in active set
        const TILE_LAYERS: WeatherLayer[] = ['temperature', 'clouds', 'sea', 'satellite'];
        for (const tl of TILE_LAYERS) {
            const tileId = `tiles-${tl}`;
            if (!activeLayers.has(tl)) {
                try {
                    if (map.getLayer(tileId)) map.removeLayer(tileId);
                } catch (_) {}
                try {
                    if (map.getSource(tileId)) map.removeSource(tileId);
                } catch (_) {}
            }
        }
        // Also clean up legacy single 'weather-tiles' source/layer
        try {
            if (map.getLayer('weather-tiles')) map.removeLayer('weather-tiles');
        } catch (_) {}
        try {
            if (map.getSource('weather-tiles')) map.removeSource('weather-tiles');
        } catch (_) {}

        // Add tile layers that ARE active
        for (const tl of TILE_LAYERS) {
            if (!activeLayers.has(tl)) continue;
            const tileId = `tiles-${tl}`;
            const tileUrl = getTileUrl(tl);
            if (!tileUrl) continue;
            // Skip if already added
            if (map.getLayer(tileId)) continue;
            try {
                map.addSource(tileId, {
                    type: 'raster',
                    tiles: [tileUrl],
                    tileSize: 256,
                    maxzoom: tl === 'satellite' ? 16 : 18,
                });
                map.addLayer(
                    {
                        id: tileId,
                        type: 'raster',
                        source: tileId,
                        paint: {
                            'raster-opacity':
                                tl === 'satellite' ? 0.8 : tl === 'temperature' ? 0.65 : tl === 'clouds' ? 0.6 : 1.0,
                        },
                    },
                    map.getLayer('route-line-layer') ? 'route-line-layer' : undefined,
                );
            } catch (_) {}
        }

        // ── Glass Pane: promote nav layers above any newly-added weather layers ──
        // This is the core safety net: regardless of which weather layers were just
        // added/removed, route and supporting overlays always render on top.
        const navLayerIds = [
            'isochrone-fan-layer',
            'isochrone-time-labels',
            'comfort-zone-layer',
            'route-glow',
            'route-line-layer',
            'route-harbour-dash',
            'route-core',
            'waypoint-circles',
            'waypoint-labels',
        ];
        for (const id of navLayerIds) {
            try {
                if (map.getLayer(id)) map.moveLayer(id);
            } catch (_) {
                /* layer not present — skip */
            }
        }
    }, [activeKey, mapReady, updateIsobars]);

    // ── Isobar moveend re-fetch (separate stable effect, debounced) ──
    // Debounce: wait 1.5s after the last pan/zoom before re-fetching.
    // Existing isobar data stays visible during the delay (geo-locked).
    const isobarDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady || !hasPressure) return;
        const onMoveEnd = () => {
            if (isobarDebounceRef.current) clearTimeout(isobarDebounceRef.current);
            isobarDebounceRef.current = setTimeout(() => updateIsobars(map), 1500);
        };
        map.on('moveend', onMoveEnd);
        return () => {
            map.off('moveend', onMoveEnd);
            if (isobarDebounceRef.current) clearTimeout(isobarDebounceRef.current);
        };
    }, [hasPressure, mapReady, updateIsobars]);

    return {
        activeLayer,
        setActiveLayer,
        activeLayers,
        toggleLayer,
        showLayerMenu,
        setShowLayerMenu,
        // Wind
        windEngineRef,
        windGridRef,
        windMarkersRef,
        windState,
        windHour,
        setWindHour,
        windTotalHours,
        setWindTotalHours,
        windPlaying,
        setWindPlaying,
        windReady,
        setWindReady,
        windMaxSpeed,
        setWindMaxSpeed,
        windForecastHoursRef,
        // Rain (unified radar + forecast)
        unifiedFramesRef,
        rainFrameIndex,
        setRainFrameIndex,
        rainFrameCount,
        setRainFrameCount,
        rainPlaying,
        setRainPlaying,
        rainReady,
        rainLoading,
        rainNowIdxRef,
        // GRIB
        isGribDownloading,
        setIsGribDownloading,
        gribProgress,
        setGribProgress,
        gribError,
        setGribError,
        // Isobars / Pressure
        forecastHour,
        setForecastHour,
        isPlaying,
        setIsPlaying,
        totalFrames,
        framesReady,
        applyFrame,
    };
}

/**
 * useEmbeddedRain — Rain radar overlay that runs independently of activeLayer.
 * Works in both embedded mode and full map mode (background rain under velocity particles).
 */
export function useEmbeddedRain(
    mapRef: MutableRefObject<mapboxgl.Map | null>,
    embedded: boolean,
    mapReady: boolean,
    backgroundRain: boolean = false,
) {
    const enabled = embedded || backgroundRain;
    const embeddedRainFrames = useRef<{ path: string; time: number }[]>([]);
    const embRainNowIdx = useRef(0);
    const [embRainIdx, setEmbRainIdx] = useState(-1);
    const [embRainCount, setEmbRainCount] = useState(0);
    const [embRainPlaying, setEmbRainPlaying] = useState(false);

    // Load rain frames
    useEffect(() => {
        if (!enabled || !mapReady || !mapRef.current) return;
        const delayTimer = setTimeout(
            () => {
                (async () => {
                    try {
                        const res = await fetch('https://api.rainviewer.com/public/weather-maps.json');
                        const data = await res.json();
                        const past = (data?.radar?.past ?? []).map((f: { path: string; time: number }) => ({ path: f.path, time: f.time }));
                        const forecast = (data?.radar?.nowcast ?? []).map((f: { path: string; time: number }) => ({ path: f.path, time: f.time }));
                        const allFrames = [...past, ...forecast];
                        embeddedRainFrames.current = allFrames;
                        setEmbRainCount(allFrames.length);
                        const nowIdx = Math.max(0, past.length - 1);
                        embRainNowIdx.current = nowIdx;
                        setEmbRainIdx(nowIdx);
                    } catch (err) {}
                })();
            },
            embedded ? 1200 : 800,
        );
        return () => {
            clearTimeout(delayTimer);
            try {
                const mx = mapRef.current;
                if (mx?.getLayer('embedded-rain')) mx.removeLayer('embedded-rain');
                if (mx?.getSource('embedded-rain')) mx.removeSource('embedded-rain');
            } catch (_) {}
        };
    }, [enabled, mapReady]);

    // Swap rain tile on frame change
    useEffect(() => {
        if (!enabled || !mapRef.current) return;
        const m = mapRef.current;
        const frames = embeddedRainFrames.current;
        if (!frames.length || embRainIdx < 0 || embRainIdx >= frames.length) return;
        const frame = frames[embRainIdx];
        if (m.getSource('embedded-rain')) {
            try {
                m.removeLayer('embedded-rain');
                m.removeSource('embedded-rain');
            } catch (e) {
                log.warn('rain layer cleanup:', e);
            }
        }
        m.addSource('embedded-rain', {
            type: 'raster',
            tiles: [`https://tilecache.rainviewer.com${frame.path}/256/{z}/{x}/{y}/6/1_1.png`],
            tileSize: 256,
            minzoom: 2,
            maxzoom: 6,
        });
        m.addLayer({
            id: 'embedded-rain',
            type: 'raster',
            source: 'embedded-rain',
            paint: { 'raster-opacity': embedded ? 0.75 : 0.55, 'raster-contrast': 0.3, 'raster-brightness-min': 0.1 },
        });
    }, [enabled, embRainIdx]);

    // Auto-play
    useEffect(() => {
        if (!embRainPlaying) return;
        const timer = setInterval(() => {
            if (document.hidden) return;
            setEmbRainIdx((prev) => {
                if (prev + 1 >= embRainCount) return 0; // loop back
                return prev + 1;
            });
        }, 600);
        return () => clearInterval(timer);
    }, [embRainPlaying, embRainCount]);

    return {
        embeddedRainFrames,
        embRainIdx,
        setEmbRainIdx,
        embRainCount,
        embRainPlaying,
        setEmbRainPlaying,
        embRainNowIdx,
    };
}
