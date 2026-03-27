/**
 * @filesize-justified useEmbeddedRain already extracted. Remaining hook manages 8+ map layer sources that share lifecycle.
 */
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
import { createWindLabelMarker } from '../../utils/createMarkerEl';
import {
    initIsobarLayers,
    hideIsobarLayers,
    showIsobarLayers,
    RAINVIEWER_COLOR_RAMP,
    promoteNavLayers,
} from './isobarLayerSetup';
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
    const MAX_LAYERS = 4;
    const STORAGE_KEY = 'thalassa_active_layers';
    const [activeLayers, setActiveLayers] = useState<Set<WeatherLayer>>(() => {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored) {
                const arr = JSON.parse(stored) as WeatherLayer[];
                if (Array.isArray(arr) && arr.length > 0) {
                    // Wind OFF by default — filter it out so satellite view is clean
                    const filtered = arr.filter((l) => l !== 'wind' && l !== 'velocity');
                    return filtered.length > 0 ? new Set(filtered) : new Set();
                }
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
                    // At limit — prefer evicting static layers (temp, clouds, sea) over interactive (wind, rain)
                    const EVICTION_ORDER: WeatherLayer[] = [
                        'sea',
                        'clouds',
                        'temperature',
                        'pressure',
                        'rain',
                        'velocity',
                        'wind',
                    ];
                    let evicted = false;
                    for (const candidate of EVICTION_ORDER) {
                        if (next.has(candidate) && candidate !== layer) {
                            next.delete(candidate);
                            evicted = true;
                            break;
                        }
                    }
                    if (!evicted) {
                        // Fallback: remove the oldest (first)
                        const first = next.values().next().value;
                        if (first) next.delete(first);
                    }
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
    const _hasWind = activeLayers.has('wind') || activeLayers.has('velocity');
    const _hasRain = activeLayers.has('rain');
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
    const [windHour, setWindHourInternal] = useState(0);
    const [windTotalHours, setWindTotalHours] = useState(48);
    const [windPlaying, setWindPlaying] = useState(false);
    const [windReady, setWindReady] = useState(false);
    const [windMaxSpeed, setWindMaxSpeed] = useState(30);
    /** The wind scrubber index that corresponds to 'now' (current time) */
    const windNowIdxRef = useRef(0);
    /** GFS model run time for dynamic 'now' recomputation */
    const windRefTimeRef = useRef<string | null>(null);
    /** Whether the user has manually scrubbed (prevents auto-advance temporarily) */
    const windUserScrubbedRef = useRef(false);
    /** Timestamp of last manual scrub — auto-advance resumes after 5 min */
    const windUserScrubbedTimeRef = useRef(0);

    /** Wrapper for external callers — marks manual scrub */
    const setWindHour = useCallback((valOrFn: number | ((prev: number) => number)) => {
        windUserScrubbedRef.current = true;
        windUserScrubbedTimeRef.current = Date.now();
        setWindHourInternal((prev) => {
            const next = typeof valOrFn === 'function' ? valOrFn(prev) : valOrFn;
            WindStore.setState({ hour: next });
            return next;
        });
    }, []);

    /** Compute which forecast hour index best matches 'now' given the model refTime */
    const computeNowIndex = useCallback((refTime: string, fhrs: number[]): number => {
        const ageMs = Date.now() - new Date(refTime).getTime();
        const ageHours = ageMs / (60 * 60 * 1000);
        let bestIdx = 0;
        let bestDiff = Math.abs(fhrs[0] - ageHours);
        for (let i = 1; i < fhrs.length; i++) {
            const diff = Math.abs(fhrs[i] - ageHours);
            if (diff < bestDiff) {
                bestDiff = diff;
                bestIdx = i;
            }
        }
        return bestIdx;
    }, []);

    // GRIB download
    const [isGribDownloading, setIsGribDownloading] = useState(false);
    const [gribProgress, setGribProgress] = useState(0);
    const [gribError, setGribError] = useState<string | null>(null);

    // ── Isobar state ──
    const isobarFetchRef = useRef<number>(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
                        paint: { 'raster-opacity': 0.65, 'raster-fade-duration': 0 },
                    },
                    map.getLayer('isobar-lines') ? 'isobar-lines' : undefined,
                );
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Pre-compute isobar frames
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const precomputeFrames = useCallback((grid: any) => {
        const total = grid.totalHours as number;
        setTotalFrames(total);
        setFramesReady(0);
        cachedFramesRef.current = new Array(total);
        let idx = 0;
        const computeBatch = () => {
            const batchEnd = Math.min(idx + 8, total);
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
            const zoom = map.getZoom();

            let north: number, south: number, west: number, east: number;

            if (zoom < 4) {
                // Zoomed out: global coverage
                north = 85;
                south = -85;
                west = -180;
                east = 180;
            } else {
                // Zoomed in: viewport bounds with 30% padding for detail
                const bounds = map.getBounds();
                if (!bounds) return;
                const latSpan = bounds.getNorth() - bounds.getSouth();
                const lonSpan = bounds.getEast() - bounds.getWest();
                const latPad = latSpan * 0.3;
                const lonPad = lonSpan * 0.3;
                north = Math.min(bounds.getNorth() + latPad, 85);
                south = Math.max(bounds.getSouth() - latPad, -85);
                west = bounds.getWest() - lonPad;
                east = bounds.getEast() + lonPad;
                // Normalize longitudes
                const normLon = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;
                west = normLon(west);
                east = normLon(east);
                if (west > east) {
                    west = -180;
                    east = 180;
                }
            }

            const data = await generateIsobars(north, south, west, east, zoom);
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
        // eslint-disable-next-line react-hooks/exhaustive-deps
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

                const el = createWindLabelMarker(speedKts, cardinal, getWindColor(speedKts));

                const marker = new mapboxgl.Marker({ element: el, anchor: 'center' })
                    .setLngLat([grid.lons[c], grid.lats[r]])
                    .addTo(m);
                windMarkersRef.current.push(marker);
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
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
        // eslint-disable-next-line react-hooks/exhaustive-deps
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
                        log.warn('activate() resolved but no grid in store');
                        return;
                    }
                    windGridRef.current = currentGrid;
                    const GFS_HOURS = [0, 3, 6, 9, 12, 18, 24, 36, 48, 72];
                    windForecastHoursRef.current = GFS_HOURS.slice(0, currentGrid.totalHours);
                    setWindTotalHours(currentGrid.totalHours);
                    setWindReady(true);

                    // ── Default scrubber to "now" ──
                    // Compute hours since GFS model run, find closest forecast index
                    if (currentGrid.refTime) {
                        windRefTimeRef.current = currentGrid.refTime;
                        const fhrs = windForecastHoursRef.current;
                        const bestIdx = computeNowIndex(currentGrid.refTime, fhrs);
                        setWindHourInternal(bestIdx);
                        WindStore.setState({ hour: bestIdx });
                        windNowIdxRef.current = bestIdx;
                        // Reset manual scrub flag on fresh GRIB load
                        windUserScrubbedRef.current = false;
                        const ageMs = Date.now() - new Date(currentGrid.refTime).getTime();
                        const ageHours = ageMs / (60 * 60 * 1000);
                        log.info(
                            `[WindScrubber] Auto-set to "now": refTime=${currentGrid.refTime}, age=${ageHours.toFixed(1)}h, index=${bestIdx} (forecast hour ${fhrs[bestIdx]})`,
                        );
                    }

                    log.info(
                        `[WindScrubber] Grid loaded: totalHours=${currentGrid.totalHours}, u.length=${currentGrid.u.length}`,
                    );
                })
                .catch((err) => {
                    log.warn('activate() failed:', err);
                });
        }, 800);
        return () => clearTimeout(windTimer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeKey, mapReady]);

    // ── Periodically recompute "now" index (every 1 min) ──
    useEffect(() => {
        if (!windReady) return;
        const interval = setInterval(() => {
            const refTime = windRefTimeRef.current;
            const fhrs = windForecastHoursRef.current;
            if (!refTime || fhrs.length === 0) return;
            const newNowIdx = computeNowIndex(refTime, fhrs);
            const oldNowIdx = windNowIdxRef.current;

            // Always update the now-index reference
            if (newNowIdx !== oldNowIdx) {
                windNowIdxRef.current = newNowIdx;
            }

            // Auto-advance scrubber to track real time:
            // Skip if user manually scrubbed within the last 5 minutes
            const manualAge = Date.now() - windUserScrubbedTimeRef.current;
            const MANUAL_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
            if (windUserScrubbedRef.current && manualAge < MANUAL_COOLDOWN_MS) {
                return; // User recently scrubbed — leave their position alone
            }

            // Reset the manual flag after cooldown, then auto-advance
            windUserScrubbedRef.current = false;
            setWindHourInternal((prev) => {
                if (prev !== newNowIdx) {
                    log.info(
                        `[WindScrubber] Auto-tracking "now": ${prev} → ${newNowIdx} (forecast hour ${fhrs[newNowIdx]})`,
                    );
                    WindStore.setState({ hour: newNowIdx });
                    return newNowIdx;
                }
                return prev;
            });
        }, 60 * 1000); // Every 1 minute
        return () => clearInterval(interval);
    }, [windReady, computeNowIndex]);

    // ── Center map when switching layers + WIND GEOLOCK ──
    const prevLayerCountRef = useRef(0);
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady || embedded) return;

        const hasWind = activeLayers.has('wind') || activeLayers.has('velocity');
        const hasPressureLayer = activeLayers.has('pressure');
        const layerCount = activeLayers.size;

        if (hasPressureLayer) {
            // Pressure/synoptic — lock zoom to synoptic range (~3-7)
            map.setMinZoom(3);
            map.setMaxZoom(7);
            map.setMaxBounds(undefined!); // Mapbox runtime API accepts undefined to clear bounds
        } else if (hasWind) {
            // Wind active — constrain min zoom only (overlay handles its own visibility at high zoom)
            map.setMinZoom(1);
            map.setMaxZoom(18);
            map.setMaxBounds(undefined!); // Mapbox runtime API accepts undefined to clear bounds
        } else {
            // No weather layers — full freedom
            map.setMinZoom(1);
            map.setMaxZoom(20);
            map.setMaxBounds(undefined!); // Mapbox runtime API accepts undefined to clear bounds
        }

        // Fly to user only on FIRST layer activation (not every toggle)
        if (layerCount > 0 && prevLayerCountRef.current === 0) {
            map.flyTo({ center: [location.lon, location.lat], zoom: 5, duration: 800 });
        }
        prevLayerCountRef.current = layerCount;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mapReady, embedded, activeLayers.size]);

    // Rain auto-play (unified radar + forecast) — loops continuously
    useEffect(() => {
        if (!rainPlaying || !activeLayers.has('rain')) return;
        const timer = setInterval(() => {
            // Pause when app is backgrounded
            if (document.hidden) return;
            setRainFrameIndex((prev) => {
                if (prev + 1 >= rainFrameCount) return 0; // loop back to start
                return prev + 1;
            });
        }, 600);
        return () => clearInterval(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rainPlaying, activeKey, rainFrameCount]);

    // Unified rain frame swap: toggle visibility on pre-loaded layers
    const rainFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const rainCleanupRef = useRef<(() => void) | null>(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const savedLandFillColorsRef = useRef<Map<string, any>>(new Map());

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
                } catch (_) {
                    log.warn('[useWeatherLayers]', _);
                }
                visibleForecastIdxRef.current = null;
            }

            // Hide previous radar layer
            if (prevRdIdx !== null && prevRdIdx !== rdIdx) {
                const prevId = `radar-${prevRdIdx}`;
                try {
                    if (m.getLayer(prevId)) m.setPaintProperty(prevId, 'raster-opacity', 0);
                } catch (_) {
                    log.warn('[useWeatherLayers]', _);
                }
            }

            // Show current radar layer
            if (rdIdx >= 0) {
                const layerId = `radar-${rdIdx}`;
                try {
                    if (m.getLayer(layerId)) m.setPaintProperty(layerId, 'raster-opacity', 0.75);
                } catch (_) {
                    log.warn('[useWeatherLayers]', _);
                }
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
                } catch (_) {
                    log.warn('[useWeatherLayers]', _);
                }
                visibleRadarIdxRef.current = null;
            }

            // Hide previous forecast layer
            if (prevFcIdx !== null && prevFcIdx !== fcIdx) {
                const prevId = `rainbow-fc-${prevFcIdx}`;
                try {
                    if (m.getLayer(prevId)) m.setPaintProperty(prevId, 'raster-opacity', 0);
                } catch (_) {
                    log.warn('[useWeatherLayers]', _);
                }
            }

            // Show current forecast layer
            if (fcIdx >= 0) {
                const layerId = `rainbow-fc-${fcIdx}`;
                try {
                    if (m.getLayer(layerId)) m.setPaintProperty(layerId, 'raster-opacity', 0.75);
                } catch (_) {
                    log.warn('[useWeatherLayers]', _);
                }
                visibleForecastIdxRef.current = fcIdx;
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rainFrameIndex, activeKey, rainReady]);

    // ── Weather Layer Toggle (main effect) ──
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;

        // Remove layers NOT in active set
        if (!activeLayers.has('rain')) {
            // Clean up rain sources/layers when rain is deactivated
            if (rainFadeTimerRef.current) {
                clearTimeout(rainFadeTimerRef.current);
                rainFadeTimerRef.current = null;
            }
            for (let i = 0; i < 30; i++) {
                ['radar-', 'rainbow-fc-'].forEach((prefix) => {
                    const id = `${prefix}${i}`;
                    try {
                        if (map.getLayer(id)) map.removeLayer(id);
                        if (map.getSource(id)) map.removeSource(id);
                    } catch (_) {
                        log.warn('[useWeatherLayers]', _);
                    }
                });
            }
            unifiedFramesRef.current = [];
            setRainFrameCount(0);
            setRainFrameIndex(0);
            setRainReady(false);
        }
        if (!activeLayers.has('wind') && !activeLayers.has('velocity')) {
            if (map.getLayer('wind-labels')) map.removeLayer('wind-labels');
            if (map.getSource('wind-labels')) map.removeSource('wind-labels');
            windMarkersRef.current.forEach((mk) => mk.remove());
            windMarkersRef.current = [];
            try {
                if (map.getLayer('wind-particles')) map.removeLayer('wind-particles');
            } catch (_) {
                log.warn('[useWeatherLayers]', _);
            }
            windEngineRef.current = null;
            WindDataController.deactivate(map);
            setWindReady(false);
        }

        if (!activeLayers.has('pressure')) hideIsobarLayers(map, savedLandFillColorsRef.current);

        // ── Static tile layers (sea, temperature, clouds) ──
        // Remove tile layers NOT in active set — must run BEFORE the early return
        // below, otherwise toggling off the last layer skips cleanup.
        const TILE_LAYERS: WeatherLayer[] = ['sea', 'temperature', 'clouds'];
        for (const tl of TILE_LAYERS) {
            const tileId = `tiles-${tl}`;
            if (!activeLayers.has(tl)) {
                try {
                    if (map.getLayer(tileId)) map.removeLayer(tileId);
                } catch (_) {
                    log.warn('[useWeatherLayers]', _);
                }
                try {
                    if (map.getSource(tileId)) map.removeSource(tileId);
                } catch (_) {
                    log.warn('[useWeatherLayers]', _);
                }
            }
        }
        // Sync permanent sea marks layers with the 'sea' toggle
        const seaVisible = activeLayers.has('sea') ? 'visible' : 'none';
        for (const lid of [
            'openseamap-permanent',
            'harbour-seamarks-circle',
            'harbour-seamarks-label',
            'nav-markers-glow',
            'nav-markers-dot',
        ]) {
            try {
                if (map.getLayer(lid)) map.setLayoutProperty(lid, 'visibility', seaVisible);
            } catch (_) {
                // Layer may not exist yet
            }
        }
        // Also clean up legacy single 'weather-tiles' source/layer
        try {
            if (map.getLayer('weather-tiles')) map.removeLayer('weather-tiles');
        } catch (_) {
            log.warn('[useWeatherLayers]', _);
        }
        try {
            if (map.getSource('weather-tiles')) map.removeSource('weather-tiles');
        } catch (_) {
            log.warn('[useWeatherLayers]', _);
        }

        // ── Permanent base layer: Esri satellite imagery ──
        const SAT_ID = 'tiles-satellite';
        if (!map.getSource(SAT_ID)) {
            try {
                map.addSource(SAT_ID, {
                    type: 'raster',
                    tiles: [getTileUrl('satellite')!],
                    tileSize: 256,
                    maxzoom: 16,
                });
                // Insert above base fill/background but below symbol/label layers
                const styleLayers = map.getStyle()?.layers ?? [];
                const firstSymbolId = styleLayers.find((l) => l.type === 'symbol')?.id;
                map.addLayer(
                    {
                        id: SAT_ID,
                        type: 'raster',
                        source: SAT_ID,
                        paint: { 'raster-opacity': 0.85, 'raster-fade-duration': 0 },
                    },
                    firstSymbolId,
                );
                log.info('Added permanent Esri satellite base layer');
            } catch (err) {
                log.warn('Failed to add satellite base layer:', err);
            }
        }

        // Himawari-9 IR satellite layer is now managed by useCycloneLayer.ts
        // — only shown when viewing active cyclones (storm page).

        if (activeLayers.size === 0) return;

        // ── Pressure / Isobars ──
        if (activeLayers.has('pressure')) {
            // Only adjust zoom when pressure is the sole layer
            if (activeLayers.size === 1) {
                const currentZoom = map.getZoom();
                if (currentZoom > 4 || currentZoom < 0.5) {
                    map.flyTo({ zoom: 1, duration: 1200 });
                }
            }

            initIsobarLayers(map);

            showIsobarLayers(map, savedLandFillColorsRef.current);
            updateIsobars(map);

            // ── Coastal Vignette Glow ──
            if (!map.getLayer('coastal-vignette') && map.getSource('composite')) {
                map.addLayer({
                    id: 'coastal-vignette',
                    type: 'line',
                    source: 'composite',
                    'source-layer': 'water',
                    paint: {
                        'line-color': '#000814',
                        'line-width': 6,
                        'line-blur': 8,
                        'line-opacity': 0.6,
                    },
                });
            }
        }

        // ── Rain (unified: RainViewer radar past + GFS forecast future) ──
        if (activeLayers.has('rain') && unifiedFramesRef.current.length === 0) {
            // Only fetch if not already loaded (idempotent guard)
            setRainLoading(true);
            setRainReady(false);
            setRainFrameIndex(0);

            let stale = false;

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
                    if (stale) return; // Bail if effect was cleaned up during fetch
                    const m = mapRef.current;
                    if (!m) return;

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
                    setRainReady(false);
                } finally {
                    setRainLoading(false);
                }
            })();

            // Store cleanup for this rain session (called by effect teardown)
            rainCleanupRef.current = () => {
                stale = true;
                if (rainFadeTimerRef.current) {
                    clearTimeout(rainFadeTimerRef.current);
                    rainFadeTimerRef.current = null;
                }
                try {
                    const m = map;
                    for (let i = 0; i < 30; i++) {
                        ['radar-', 'rainbow-fc-'].forEach((prefix) => {
                            const id = `${prefix}${i}`;
                            try {
                                if (m?.getLayer(id)) m.removeLayer(id);
                            } catch (_) {
                                log.warn('[useWeatherLayers]', _);
                            }
                            try {
                                if (m?.getSource(id)) m.removeSource(id);
                            } catch (_) {
                                log.warn('[useWeatherLayers]', _);
                            }
                        });
                    }
                } catch (_) {
                    log.warn('[useWeatherLayers]', _);
                }
                unifiedFramesRef.current = [];
                setRainFrameCount(0);
                setRainReady(false);
            };
        }

        // Add tile layers that ARE active
        for (const tl of TILE_LAYERS) {
            if (!activeLayers.has(tl)) continue;
            const tileId = `tiles-${tl}`;
            const tileUrl = getTileUrl(tl);
            if (!tileUrl) continue;
            // Skip if layer already exists and is visible
            if (map.getLayer(tileId)) continue;
            try {
                // Remove stale source if layer was removed but source persists
                if (map.getSource(tileId)) {
                    try {
                        map.removeSource(tileId);
                    } catch (_) {
                        /* source cleanup */
                    }
                }
                map.addSource(tileId, {
                    type: 'raster',
                    tiles: [tileUrl],
                    tileSize: 256,
                    maxzoom: 18,
                });
                map.addLayer(
                    {
                        id: tileId,
                        type: 'raster',
                        source: tileId,
                        paint: {
                            'raster-opacity': 1.0,
                        },
                    },
                    map.getLayer('route-line-layer') ? 'route-line-layer' : undefined,
                );
                log.info(`Added tile layer: ${tileId}`);
            } catch (err) {
                log.warn(`Failed to add tile layer ${tileId}:`, err);
            }
        }

        // ── Glass Pane: promote nav layers above any newly-added weather layers ──
        // This is the core safety net: regardless of which weather layers were just
        // added/removed, route and supporting overlays always render on top.
        promoteNavLayers(map);

        // ── Unified cleanup: runs when activeKey changes ──
        return () => {
            // Call rain cleanup if it was set up in this render
            if (rainCleanupRef.current) {
                rainCleanupRef.current();
                rainCleanupRef.current = null;
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeKey, mapReady, updateIsobars]);

    // ── Isobar moveend re-fetch (zoom-based progressive detail) ──
    const isobarDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastIsobarZoomRef = useRef<number | null>(null);
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady || !hasPressure) return;
        const onMoveEnd = () => {
            const currentZoom = map.getZoom();
            const lastZoom = lastIsobarZoomRef.current;
            // Only re-fetch when zoom changes significantly (crossing the detail threshold)
            const crossedThreshold =
                lastZoom !== null &&
                ((lastZoom < 4 && currentZoom >= 4) ||
                    (lastZoom >= 4 && currentZoom < 4) ||
                    (currentZoom >= 4 && Math.abs(currentZoom - lastZoom) >= 1));
            if (!crossedThreshold && lastZoom !== null) return;
            if (isobarDebounceRef.current) clearTimeout(isobarDebounceRef.current);
            isobarDebounceRef.current = setTimeout(() => {
                lastIsobarZoomRef.current = currentZoom;
                updateIsobars(map);
            }, 1500);
        };
        map.on('moveend', onMoveEnd);
        return () => {
            map.off('moveend', onMoveEnd);
            if (isobarDebounceRef.current) clearTimeout(isobarDebounceRef.current);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [hasPressure, mapReady, updateIsobars]);

    // ── Cleanup on unmount — ensures fresh re-initialization on re-entry ──
    useEffect(() => {
        return () => {
            setWindReady(false);
            setRainReady(false);
            setRainFrameCount(0);
            windEngineRef.current = null;
            windGridRef.current = null;
            unifiedFramesRef.current = [];
            // eslint-disable-next-line react-hooks/exhaustive-deps
            savedLandFillColorsRef.current.clear();
        };
    }, []);

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
        windNowIdxRef,
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

// Re-export for backward compatibility
export { useEmbeddedRain } from './useEmbeddedRain';
