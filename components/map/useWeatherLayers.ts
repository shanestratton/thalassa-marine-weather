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
import { type WeatherLayer, getTileUrl, getWindColor, SEA_STATE_LAYERS, ATMOSPHERE_LAYERS } from './mapConstants';
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

    // Select a layer with mutual exclusion within its group.
    // Other layers in the same group are turned off; cross-group layers stay.
    const selectInGroup = useCallback((layer: WeatherLayer, group: WeatherLayer[]) => {
        setActiveLayers((prev) => {
            const next = new Set(prev);
            // Remove other layers in the same group
            for (const g of group) {
                if (g !== layer) next.delete(g);
            }
            // Toggle the selected layer (tap again to deselect)
            if (next.has(layer)) next.delete(layer);
            else next.add(layer);
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
    /** Timestamp of last rain-layer fetch. Used to auto-refresh the radar+forecast
     *  frames when the layer has been loaded for longer than RAIN_MAX_AGE_MS —
     *  otherwise the chart keeps showing hours-old radar while the weather has
     *  moved on. */
    const rainFetchedAtRef = useRef<number>(0);
    const RAIN_MAX_AGE_MS = 10 * 60 * 1000; // RainViewer publishes every 10 min
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

    // Currents scrubber (CMEMS hourly forecast, h00..h12)
    const [currentsHour, setCurrentsHour] = useState(0);
    const [currentsPlaying, setCurrentsPlaying] = useState(false);
    const currentsTotalHours = 12;

    // Waves scrubber (CMEMS WAM, 3-hourly native, 48h window = 17 frames).
    // wavesHour is a STEP index (0..16); each step is +3h of forecast.
    const [wavesHour, setWavesHour] = useState(0);
    const [wavesPlaying, setWavesPlaying] = useState(false);
    const wavesTotalHours = 17;

    // SST scrubber (CMEMS daily-mean, today + 5 forecast days = 6 frames
    // because the pipeline's start→end range is inclusive on both ends).
    const [sstStep, setSstStep] = useState(0);
    const [sstPlaying, setSstPlaying] = useState(false);
    const sstTotalSteps = 6;

    // Chlorophyll scrubber (CMEMS BGC daily, today + 5d = 6 frames).
    const [chlStep, setChlStep] = useState(0);
    const [chlPlaying, setChlPlaying] = useState(false);
    const chlTotalSteps = 6;

    // Sea-ice scrubber (CMEMS physics daily, today + 5d = 6 frames).
    const [seaiceStep, setSeaiceStep] = useState(0);
    const [seaicePlaying, setSeaicePlaying] = useState(false);
    const seaiceTotalSteps = 6;

    // Mixed-layer depth scrubber (CMEMS physics daily, today + 5d = 6 frames).
    const [mldStep, setMldStep] = useState(0);
    const [mldPlaying, setMldPlaying] = useState(false);
    const mldTotalSteps = 6;

    // Marine Protected Areas (CAPAD vector tiles). Static overlay —
    // not time-scrubbed, can co-exist with any weather layer (a user
    // wants to see currents AND know where they can fish). Persisted
    // separately from the WeatherLayer set since it isn't mutually
    // exclusive with anything.
    const MPA_STORAGE_KEY = 'thalassa_mpa_visible';
    const [mpaVisible, setMpaVisibleState] = useState<boolean>(() => {
        try {
            return localStorage.getItem(MPA_STORAGE_KEY) === '1';
        } catch {
            return false;
        }
    });
    const setMpaVisible = useCallback((next: boolean) => {
        setMpaVisibleState(next);
        try {
            localStorage.setItem(MPA_STORAGE_KEY, next ? '1' : '0');
        } catch {
            /* private mode / quota — ignore */
        }
    }, []);

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cachedGridRef = useRef<any>(null); // Cache the raw grid to avoid re-fetching
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
                        paint: { 'raster-opacity': 0.75, 'raster-fade-duration': 0 },
                    },
                    map.getLayer('isobar-lines') ? 'isobar-lines' : undefined,
                );
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Pre-compute remaining isobar frames in background (frame 0 already shown).
    // Skip heatmap for interpolated sub-frames — they reuse the nearest keyframe's heatmap.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const precomputeFrames = useCallback((grid: any) => {
        const total = grid.totalHours as number;
        setTotalFrames(total);

        // Preserve frame 0 which was already computed in updateIsobars
        const existing = cachedFramesRef.current;
        cachedFramesRef.current = new Array(total);
        if (existing[0]) cachedFramesRef.current[0] = existing[0];
        setFramesReady(1);

        let idx = 1; // Start from frame 1 — frame 0 is already done
        const KEYFRAME_INTERVAL = 3;
        const computeBatch = () => {
            // Process all remaining frames in one batch — the global grid is small
            // enough that this completes in <200ms on modern phones
            const batchEnd = Math.min(idx + total, total);
            for (let h = idx; h < batchEnd; h++) {
                const isKeyframe = h % KEYFRAME_INTERVAL === 0 || h === total - 1;
                cachedFramesRef.current[h] = generateIsobarsFromGrid(grid, h, !isKeyframe);
            }
            setFramesReady(batchEnd);
            idx = batchEnd;
            if (idx < total) setTimeout(computeBatch, 0);
        };
        // Small delay to let frame 0 render first, then compute the rest
        setTimeout(computeBatch, 50);
    }, []);

    const updateIsobars = useCallback(
        async (map: mapboxgl.Map) => {
            const token = ++isobarFetchRef.current;

            // If we already have a cached grid, just re-apply frame 0 (instant).
            // The grid is global at 1° resolution — no need to re-fetch on pan/zoom.
            if (cachedGridRef.current && cachedFramesRef.current.length > 0) {
                setForecastHour(0);
                applyFrame(0);
                return;
            }

            // Fetch ONCE: fixed global grid. At 1° resolution this is only ~65K
            // points per frame (~320K total for 5 frames) — fast to fetch and process.
            const data = await generateIsobars(85, -85, -180, 180, map.getZoom());
            if (token !== isobarFetchRef.current) return;
            if (!data) return;

            // Cache the raw grid permanently (until layer is toggled off)
            cachedGridRef.current = data.grid;

            // Show frame 0 immediately — user sees the chart in <1s after data arrives
            setForecastHour(0);
            cachedFramesRef.current = [data.result];
            applyFrame(0);

            // Precompute remaining frames in background (non-blocking)
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

    // ── Currents play/pause auto-advance (one tileset per forecast hour) ──
    useEffect(() => {
        if (!currentsPlaying || !activeLayers.has('currents')) return;
        const timer = setInterval(() => {
            setCurrentsHour((prev) => {
                const next = prev + 1;
                if (next >= currentsTotalHours) {
                    setCurrentsPlaying(false);
                    return 0;
                }
                return next;
            });
        }, 800);
        return () => clearInterval(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentsPlaying, activeKey, currentsTotalHours]);

    // ── Waves play/pause auto-advance (mirrors currents) ──
    useEffect(() => {
        if (!wavesPlaying || !activeLayers.has('waves')) return;
        const timer = setInterval(() => {
            setWavesHour((prev) => {
                const next = prev + 1;
                if (next >= wavesTotalHours) {
                    setWavesPlaying(false);
                    return 0;
                }
                return next;
            });
        }, 800);
        return () => clearInterval(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [wavesPlaying, activeKey, wavesTotalHours]);

    // ── SST play/pause auto-advance (daily cadence, 5 frames) ──
    useEffect(() => {
        if (!sstPlaying || !activeLayers.has('sst')) return;
        const timer = setInterval(() => {
            setSstStep((prev) => {
                const next = prev + 1;
                if (next >= sstTotalSteps) {
                    setSstPlaying(false);
                    return 0;
                }
                return next;
            });
        }, 1200);
        return () => clearInterval(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sstPlaying, activeKey, sstTotalSteps]);

    // ── Chlorophyll play/pause auto-advance (daily, 5 frames) ──
    useEffect(() => {
        if (!chlPlaying || !activeLayers.has('chl')) return;
        const timer = setInterval(() => {
            setChlStep((prev) => {
                const next = prev + 1;
                if (next >= chlTotalSteps) {
                    setChlPlaying(false);
                    return 0;
                }
                return next;
            });
        }, 1200);
        return () => clearInterval(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [chlPlaying, activeKey, chlTotalSteps]);

    // ── Sea-ice play/pause auto-advance (daily, 5 frames) ──
    useEffect(() => {
        if (!seaicePlaying || !activeLayers.has('seaice')) return;
        const timer = setInterval(() => {
            setSeaiceStep((prev) => {
                const next = prev + 1;
                if (next >= seaiceTotalSteps) {
                    setSeaicePlaying(false);
                    return 0;
                }
                return next;
            });
        }, 1200);
        return () => clearInterval(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [seaicePlaying, activeKey, seaiceTotalSteps]);

    // ── Mixed-layer depth play/pause auto-advance (daily, 6 frames) ──
    useEffect(() => {
        if (!mldPlaying || !activeLayers.has('mld')) return;
        const timer = setInterval(() => {
            setMldStep((prev) => {
                const next = prev + 1;
                if (next >= mldTotalSteps) {
                    setMldPlaying(false);
                    return 0;
                }
                return next;
            });
        }, 1200);
        return () => clearInterval(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mldPlaying, activeKey, mldTotalSteps]);

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

        // AU+NZ fit zoom is published by useMapInit as the "opens-on" target
        // but is NOT used as a hard floor — the user wants to pinch out to
        // world view when no weather layer forces a constraint.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ausNzMin: number = (map as any).__ausNzMinZoom ?? 3;

        if (hasPressureLayer) {
            // Pressure/synoptic — only makes sense at synoptic scale, so clamp
            // tight around the AU+NZ view.
            map.setMinZoom(Math.max(ausNzMin, 3));
            map.setMaxZoom(7);
            map.setMaxBounds(undefined!);
        } else if (hasWind) {
            // Wind particle overlay needs enough pixels on screen to look right,
            // so clamp to AU+NZ width. Max stays at standard tile depth.
            map.setMinZoom(ausNzMin);
            map.setMaxZoom(18);
            map.setMaxBounds(undefined!);
        } else {
            // No weather layer → restore the full constructor range so the user
            // can pinch out to world view (z1) or deep into a harbour (z22).
            map.setMinZoom(1);
            map.setMaxZoom(22);
            map.setMaxBounds(undefined!);
        }

        // Fly to Aus+NZ overview on FIRST layer activation (not every toggle)
        if (layerCount > 0 && prevLayerCountRef.current === 0) {
            map.flyTo({ center: [145, -28], zoom: ausNzMin, duration: 800 });
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
            rainFetchedAtRef.current = 0; // Next activation gets a fresh fetch
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

        if (!activeLayers.has('pressure')) {
            hideIsobarLayers(map, savedLandFillColorsRef.current);
            // Clear cached grid so a fresh one is fetched next time the layer activates
            cachedGridRef.current = null;
            cachedFramesRef.current = [];
        }

        // ── Static tile layers (sea, temperature, clouds) ──
        // Remove tile layers NOT in active set — must run BEFORE the early return
        // below, otherwise toggling off the last layer skips cleanup.
        // When the CMEMS particle layer is enabled, `currents` is served by
        // useOceanCurrentParticleLayer instead of the Xweather raster tile.
        const cmemsCurrentsEnabled =
            String(import.meta.env.VITE_CMEMS_CURRENTS_ENABLED ?? 'false').toLowerCase() === 'true';
        const cmemsWavesEnabled = String(import.meta.env.VITE_CMEMS_WAVES_ENABLED ?? 'false').toLowerCase() === 'true';
        const cmemsSstEnabled = String(import.meta.env.VITE_CMEMS_SST_ENABLED ?? 'false').toLowerCase() === 'true';
        // Note: chlorophyll isn't in this gate — it's a net-new CMEMS
        // layer with no Xweather tile equivalent to replace.
        const TILE_LAYERS: WeatherLayer[] = [
            'sea',
            'temperature',
            'clouds',
            ...(cmemsWavesEnabled ? [] : (['waves'] as WeatherLayer[])),
            ...(cmemsCurrentsEnabled ? [] : (['currents'] as WeatherLayer[])),
            ...(cmemsSstEnabled ? [] : (['sst'] as WeatherLayer[])),
            // wind-gusts/visibility/cape removed 2026-04-22 with Xweather.
        ];
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
        // When CMEMS currents is on, ensure the legacy Xweather raster currents
        // tile is gone — it was served by this loop before the feature flag was
        // introduced and may still be on the map from a prior session.
        if (cmemsCurrentsEnabled) {
            try {
                if (map.getLayer('tiles-currents')) map.removeLayer('tiles-currents');
            } catch (_) {
                log.warn('[useWeatherLayers] tiles-currents layer cleanup', _);
            }
            try {
                if (map.getSource('tiles-currents')) map.removeSource('tiles-currents');
            } catch (_) {
                log.warn('[useWeatherLayers] tiles-currents source cleanup', _);
            }
        }
        // Same for CMEMS waves — replaces the Xweather wave-height raster.
        if (cmemsWavesEnabled) {
            try {
                if (map.getLayer('tiles-waves')) map.removeLayer('tiles-waves');
            } catch (_) {
                log.warn('[useWeatherLayers] tiles-waves layer cleanup', _);
            }
            try {
                if (map.getSource('tiles-waves')) map.removeSource('tiles-waves');
            } catch (_) {
                log.warn('[useWeatherLayers] tiles-waves source cleanup', _);
            }
        }
        // Same for CMEMS SST — replaces the Xweather sst raster.
        if (cmemsSstEnabled) {
            try {
                if (map.getLayer('tiles-sst')) map.removeLayer('tiles-sst');
            } catch (_) {
                log.warn('[useWeatherLayers] tiles-sst layer cleanup', _);
            }
            try {
                if (map.getSource('tiles-sst')) map.removeSource('tiles-sst');
            } catch (_) {
                log.warn('[useWeatherLayers] tiles-sst source cleanup', _);
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
        // Fetch when: not loaded yet OR loaded but stale (>10 min). Without
        // the staleness gate the chart would keep showing hours-old radar
        // while current weather has moved on — one of the symptoms behind
        // the user's "it's showing rain here but sky is clear" report.
        const rainAge = Date.now() - rainFetchedAtRef.current;
        const rainStale = rainFetchedAtRef.current > 0 && rainAge > RAIN_MAX_AGE_MS;
        if (activeLayers.has('rain') && (unifiedFramesRef.current.length === 0 || rainStale)) {
            if (rainStale) {
                log.info(`[Rain] Layer data ${Math.round(rainAge / 60000)}m old — refreshing`);
                // Clear old layers so they get re-created with fresh frames
                for (let i = 0; i < unifiedFramesRef.current.length; i++) {
                    try {
                        if (map.getLayer(`rain-frame-${i}`)) map.removeLayer(`rain-frame-${i}`);
                        if (map.getSource(`rain-frame-${i}`)) map.removeSource(`rain-frame-${i}`);
                    } catch {
                        /* best effort */
                    }
                }
                unifiedFramesRef.current = [];
                visibleRadarIdxRef.current = null;
                visibleForecastIdxRef.current = null;
            }
            setRainLoading(true);
            setRainReady(false);
            setRainFrameIndex(0);

            const abortCtrl = new AbortController();
            let stale = false;

            (async () => {
                try {
                    // 1. Fetch RainViewer radar frames (past + short nowcast).
                    // Goes through the shared rainviewerIndex module so we
                    // coalesce with useEmbeddedRain + EssentialMapSlide
                    // (5min memo + inflight dedup). Drops 2-3 duplicate
                    // requests per session in the typical Dashboard → Map
                    // navigation flow.
                    const { fetchRainviewerIndex } = await import('../../services/weather/api/rainviewerIndex');
                    const radarData = await fetchRainviewerIndex();
                    if (abortCtrl.signal.aborted) return;
                    const past = radarData?.radar?.past ?? [];
                    const nowcast = radarData?.radar?.nowcast ?? [];
                    const allRadar = [...past, ...nowcast];

                    // 2. Rainbow Global forecast tiles (1km res, satellite+radar fusion) — via Supabase Edge Proxy
                    // Uses precip-global layer for worldwide coverage (not just radar footprints).
                    // API key stays server-side in Supabase Secrets (RAINBOW_API_KEY).
                    let rainbowSnapshot: number | null = null;
                    const RAINBOW_FORECAST_MINUTES = [10, 20, 30, 40, 50, 60, 80, 100, 120, 150, 180, 210, 240];
                    const supabaseUrl =
                        (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) || '';

                    if (supabaseUrl) {
                        try {
                            const snapResp = await fetch(
                                `${supabaseUrl}/functions/v1/proxy-rainbow?action=snapshot&layer=precip-global`,
                                { signal: abortCtrl.signal },
                            );
                            if (snapResp.ok) {
                                const snapData = await snapResp.json();
                                rainbowSnapshot = snapData.snapshot || null;
                                log.info(`Rainbow.ai snapshot: ${rainbowSnapshot}`);
                            } else {
                                log.warn(`Rainbow.ai snapshot failed: ${snapResp.status}`);
                            }
                        } catch (err) {
                            if (abortCtrl.signal.aborted) return;
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
                            const tileUrl = `${supabaseUrl}/functions/v1/proxy-rainbow?action=tile&layer=precip-global&snapshot=${rainbowSnapshot}&forecast=${forecastSecs}&z={z}&x={x}&y={y}&color=dbz_u8`;
                            unified.push({ type: 'forecast', forecastTileUrl: tileUrl, label });
                        }
                    }

                    unifiedFramesRef.current = unified;
                    rainFetchedAtRef.current = Date.now(); // Stamp for staleness-based auto-refresh
                    setRainFrameCount(unified.length);
                    setRainFrameIndex(nowIdx);

                    // 4. Set up map sources
                    if (stale || abortCtrl.signal.aborted) return; // Bail if effect was cleaned up during fetch
                    const m = mapRef.current;
                    if (!m) return;

                    // Insert rain layers ABOVE the satellite base layer but BELOW labels.
                    // Previously used 'route-line-layer' as beforeId, which put rain BELOW
                    // the tiles-satellite layer (85% opacity) — completely hiding the radar.
                    // Fix: use the first symbol layer (same anchor as satellite) so rain
                    // stacks directly above satellite in the visual z-order.
                    const rainBeforeId = (() => {
                        const layers = m.getStyle()?.layers ?? [];
                        const firstSymbol = layers.find((l) => l.type === 'symbol');
                        return firstSymbol?.id;
                    })();

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
                            rainBeforeId,
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
                            rainBeforeId,
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

            // Store cleanup for this rain session (called ONLY when rain is toggled off)
            rainCleanupRef.current = () => {
                stale = true;
                abortCtrl.abort();
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
                // Per-layer opacity: sea marks stay solid, weather heatmaps
                // are translucent so coastlines/countries remain visible.
                const LAYER_OPACITY: Partial<Record<WeatherLayer, number>> = {
                    sea: 1.0,
                    temperature: 0.6,
                    clouds: 0.6,
                    waves: 0.65,
                    currents: 0.65,
                    sst: 0.65,
                    // wind-gusts/visibility/cape opacities removed with Xweather decommission.
                };
                map.addLayer(
                    {
                        id: tileId,
                        type: 'raster',
                        source: tileId,
                        paint: {
                            'raster-opacity': LAYER_OPACITY[tl] ?? 0.65,
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

        // ── Scoped cleanup: rain teardown is handled at two distinct points ──
        // 1. Line 701: when rain is toggled OFF (removes layers + resets state)
        // 2. Unmount effect: resets refs (line ~1165)
        // Previously this return() destroyed rain on EVERY activeKey change,
        // causing rain to vanish when toggling wind/pressure/etc.
        return () => {
            // No-op — intentionally empty.
            // Rain layers persist across layer toggles and are only cleaned up
            // when rain is explicitly toggled off or the component unmounts.
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeKey, mapReady, updateIsobars]);

    // Global grid covers all zoom levels and viewport positions — no moveend re-fetch needed.
    // The grid is fetched once on layer activation and cached until the layer is toggled off.

    // ── Cleanup on unmount — ensures fresh re-initialization on re-entry ──
    useEffect(() => {
        return () => {
            // Invoke rain cleanup to remove map layers + abort pending fetches
            if (rainCleanupRef.current) {
                rainCleanupRef.current();
                rainCleanupRef.current = null;
            }
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
        selectInGroup,
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
        // Currents (CMEMS hourly forecast, gated by VITE_CMEMS_CURRENTS_ENABLED)
        currentsHour,
        setCurrentsHour,
        currentsTotalHours,
        currentsPlaying,
        setCurrentsPlaying,
        // Waves (CMEMS WAM 3-hourly, gated by VITE_CMEMS_WAVES_ENABLED)
        wavesHour,
        setWavesHour,
        wavesTotalHours,
        wavesPlaying,
        setWavesPlaying,
        // SST (CMEMS daily-mean 5-day forecast, gated by VITE_CMEMS_SST_ENABLED)
        sstStep,
        setSstStep,
        sstTotalSteps,
        sstPlaying,
        setSstPlaying,
        // Chlorophyll (CMEMS BGC daily, gated by VITE_CMEMS_CHL_ENABLED)
        chlStep,
        setChlStep,
        chlTotalSteps,
        chlPlaying,
        setChlPlaying,
        // Sea-ice (CMEMS physics daily, gated by VITE_CMEMS_SEAICE_ENABLED)
        seaiceStep,
        setSeaiceStep,
        seaiceTotalSteps,
        seaicePlaying,
        setSeaicePlaying,
        // Mixed-layer depth (CMEMS physics daily, gated by VITE_CMEMS_MLD_ENABLED)
        mldStep,
        setMldStep,
        mldTotalSteps,
        mldPlaying,
        setMldPlaying,
        // Marine Protected Areas (CAPAD, gated by VITE_MPA_ENABLED)
        mpaVisible,
        setMpaVisible,
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
