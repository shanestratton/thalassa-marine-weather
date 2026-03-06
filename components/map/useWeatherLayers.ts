/**
 * useWeatherLayers — Weather layer toggle, isobars, rain, wind hooks.
 *
 * Manages the activeLayer state and the side-effects of switching between
 * weather overlays (rain, wind WebGL, synoptic pressure/isobars,
 * static tile overlays, velocity).
 */

import { useState, useRef, useEffect, useCallback, type MutableRefObject } from 'react';
import mapboxgl from 'mapbox-gl';
import { generateIsobars, generateIsobarsFromGrid, FORECAST_HOURS } from '../../services/weather/isobars';
import { WindStore, useWindStore } from '../../stores/WindStore';
import { WindParticleLayer } from './WindParticleLayer';
import { type WindGrid } from '../../services/weather/windField';
import { WindDataController } from '../../services/weather/WindDataController';
import { useLocationStore } from '../../stores/LocationStore';
import { triggerHaptic } from '../../utils/system';
import { type WeatherLayer, STATIC_TILES, getTileUrl, getWindColor } from './mapConstants';

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

    // Embedded maps (dashboard mini-map) default to 'none' — no velocity overlay.
    // The velocity overlay runs two 60fps GPU loops and causes severe battery drain.
    const [activeLayer, setActiveLayer] = useState<WeatherLayer>(embedded ? 'none' : 'velocity');
    const [showLayerMenu, setShowLayerMenu] = useState(false);

    // Wind GL engine
    const windEngineRef = useRef<WindParticleLayer | null>(null);
    const windGridRef = useRef<WindGrid | null>(null);
    const windMarkersRef = useRef<mapboxgl.Marker[]>([]);

    // Rain scrubber
    const rainFramesRef = useRef<{ path: string; time: number }[]>([]);
    const [rainFrameIndex, setRainFrameIndex] = useState(0);
    const [rainFrameCount, setRainFrameCount] = useState(0);
    const [rainPlaying, setRainPlaying] = useState(false);

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
                [west, north], [east, north], [east, south], [west, south],
            ];
            const existingSrc = map.getSource('pressure-heatmap') as mapboxgl.ImageSource;
            if (existingSrc) {
                existingSrc.updateImage({ url: result.heatmapDataUrl, coordinates });
            } else {
                map.addSource('pressure-heatmap', { type: 'image', url: result.heatmapDataUrl, coordinates });
                map.addLayer({
                    id: 'pressure-heatmap-layer', type: 'raster', source: 'pressure-heatmap',
                    paint: { 'raster-opacity': 0.5, 'raster-fade-duration': 0 },
                }, 'isobar-lines');
            }
        }
    }, []);

    // Pre-compute isobar frames
    const precomputeFrames = useCallback((grid: any) => {
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

    const updateIsobars = useCallback(async (map: mapboxgl.Map) => {
        const token = ++isobarFetchRef.current;
        const bounds = map.getBounds();
        if (!bounds) return;
        const zoom = map.getZoom();
        const data = await generateIsobars(
            bounds.getNorth(), bounds.getSouth(), bounds.getWest(), bounds.getEast(), zoom
        );
        if (token !== isobarFetchRef.current) return;
        if (!data) return;
        setForecastHour(0);
        cachedFramesRef.current = [data.result];
        applyFrame(0);
        precomputeFrames(data.grid);
    }, [applyFrame, precomputeFrames]);

    // Isobar playback RAF
    useEffect(() => {
        if (!isPlaying) {
            if (playRafRef.current) cancelAnimationFrame(playRafRef.current);
            playRafRef.current = null;
            return;
        }
        const animate = (timestamp: number) => {
            if (timestamp - lastFrameTimeRef.current >= 350) {
                lastFrameTimeRef.current = timestamp;
                setForecastHour(prev => {
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
        return () => { if (playRafRef.current) cancelAnimationFrame(playRafRef.current); };
    }, [isPlaying]);

    // Apply isobar frame on hour change
    useEffect(() => {
        if (activeLayer === 'pressure') applyFrame(forecastHour);
    }, [forecastHour, activeLayer, applyFrame]);

    // ── Wind scrubber: update GL engine on hour change ──
    useEffect(() => {
        if (activeLayer !== 'wind' || !windEngineRef.current || !windGridRef.current) return;
        windEngineRef.current.setForecastHour(windHour);
        setWindMaxSpeed(windEngineRef.current.getMaxSpeed());

        const m = mapRef.current;
        const grid = windGridRef.current;
        if (!m || !grid) return;
        const h = Math.min(Math.floor(windHour), grid.totalHours - 1);
        const step = Math.max(2, Math.floor(Math.max(grid.width, grid.height) / 5));

        windMarkersRef.current.forEach(mk => mk.remove());
        windMarkersRef.current = [];

        const sData = grid.speed[h];
        const uData = grid.u[h];
        const vData = grid.v[h];
        for (let r = 0; r < grid.height; r += step) {
            for (let c = 0; c < grid.width; c += step) {
                const idx = r * grid.width + c;
                const speedKts = Math.round(sData[idx] * 1.94384);
                const dir = (Math.atan2(-uData[idx], -vData[idx]) * 180 / Math.PI + 360) % 360;
                const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
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
    }, [windHour, activeLayer]);

    // Wind auto-play
    useEffect(() => {
        if (!windPlaying || activeLayer !== 'wind') return;
        const timer = setInterval(() => {
            setWindHour(prev => {
                if (prev + 1 >= windTotalHours) { setWindPlaying(false); return 0; }
                return prev + 1;
            });
        }, 500);
        return () => clearInterval(timer);
    }, [windPlaying, activeLayer, windTotalHours]);

    // Rain auto-play
    useEffect(() => {
        if (!rainPlaying || activeLayer !== 'rain') return;
        const timer = setInterval(() => {
            setRainFrameIndex(prev => {
                if (prev + 1 >= rainFrameCount) { setRainPlaying(false); return 0; }
                return prev + 1;
            });
        }, 400);
        return () => clearInterval(timer);
    }, [rainPlaying, activeLayer, rainFrameCount]);

    // Rain frame scrubber: swap tile source
    useEffect(() => {
        if (activeLayer !== 'rain') return;
        const m = mapRef.current;
        if (!m) return;
        const frames = rainFramesRef.current;
        if (rainFrameIndex >= frames.length) return;
        const frame = frames[rainFrameIndex];
        if (m.getSource('weather-tiles')) {
            try { m.removeLayer('weather-tiles'); m.removeSource('weather-tiles'); } catch (e) { console.warn('[MapHub] ignore:', e); }
        }
        m.addSource('weather-tiles', {
            type: 'raster',
            tiles: [`https://tilecache.rainviewer.com${frame.path}/256/{z}/{x}/{y}/4/1_1.png`],
            tileSize: 256,
            maxzoom: 12,
        });
        m.addLayer({
            id: 'weather-tiles', type: 'raster', source: 'weather-tiles',
            paint: { 'raster-opacity': 0.75 },
        }, m.getLayer('route-line-layer') ? 'route-line-layer' : undefined);
    }, [rainFrameIndex, activeLayer]);

    // ── Weather Layer Toggle (main effect) ──
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;

        // Remove existing weather layer
        if (map.getLayer('weather-tiles')) map.removeLayer('weather-tiles');
        if (map.getSource('weather-tiles')) map.removeSource('weather-tiles');
        if (map.getLayer('wind-labels')) map.removeLayer('wind-labels');
        if (map.getSource('wind-labels')) map.removeSource('wind-labels');
        windMarkersRef.current.forEach(mk => mk.remove());
        windMarkersRef.current = [];
        if (activeLayer !== 'wind') {
            try { map.removeLayer('wind-particles'); } catch (_) { }
            windEngineRef.current = null;
            WindDataController.deactivate(map);
        }
        if (activeLayer !== 'rain') {
            rainFramesRef.current = [];
            setRainFrameCount(0);
            setRainFrameIndex(0);
        }

        const hideIsobars = () => {
            ['isobar-lines', 'isobar-labels', 'isobar-center-circles', 'isobar-center-labels', 'wind-barb-layer', 'circulation-arrow-layer', 'movement-track-lines', 'movement-track-labels', 'pressure-heatmap-layer'].forEach(id => {
                if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
            });
        };
        const showIsobars = () => {
            ['isobar-lines', 'isobar-labels', 'isobar-center-circles', 'isobar-center-labels', 'wind-barb-layer', 'circulation-arrow-layer', 'movement-track-lines', 'movement-track-labels', 'pressure-heatmap-layer'].forEach(id => {
                if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'visible');
            });
        };

        hideIsobars();

        if (activeLayer === 'none') return;

        // ── Pressure / Isobars ──
        if (activeLayer === 'pressure') {
            const currentZoom = map.getZoom();
            if (currentZoom > 4 || currentZoom < 2.5) {
                map.flyTo({ zoom: 3, duration: 1200 });
            }

            if (!map.getSource('isobar-contours')) {
                map.addSource('isobar-contours', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
                map.addSource('isobar-centers', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

                map.addLayer({ id: 'isobar-lines', type: 'line', source: 'isobar-contours', paint: { 'line-color': '#ffffff', 'line-width': 1.5, 'line-opacity': 0.7 } });
                map.addLayer({
                    id: 'isobar-labels', type: 'symbol', source: 'isobar-contours',
                    layout: { 'symbol-placement': 'line', 'text-field': ['get', 'label'], 'text-size': 11, 'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'], 'symbol-spacing': 500, 'text-keep-upright': true },
                    paint: { 'text-color': '#e2e8f0', 'text-halo-color': '#0f172a', 'text-halo-width': 1.5 },
                });

                map.addLayer({
                    id: 'isobar-center-circles', type: 'circle', source: 'isobar-centers',
                    paint: {
                        'circle-radius': 18,
                        'circle-color': ['match', ['get', 'type'], 'H', 'rgba(239, 68, 68, 0.15)', 'L', 'rgba(59, 130, 246, 0.15)', 'rgba(100, 116, 139, 0.15)'],
                        'circle-stroke-color': ['match', ['get', 'type'], 'H', '#ef4444', 'L', '#3b82f6', '#64748b'],
                        'circle-stroke-width': 2,
                    },
                });
                map.addLayer({
                    id: 'isobar-center-labels', type: 'symbol', source: 'isobar-centers',
                    layout: { 'text-field': ['get', 'label'], 'text-size': 14, 'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'], 'text-allow-overlap': true },
                    paint: { 'text-color': ['match', ['get', 'type'], 'H', '#ef4444', 'L', '#3b82f6', '#e2e8f0'], 'text-halo-color': '#0f172a', 'text-halo-width': 1.5 },
                });

                // Wind Barbs
                map.addSource('wind-barbs', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
                const barbCanvas = document.createElement('canvas');
                barbCanvas.width = 48; barbCanvas.height = 48;
                const ctx = barbCanvas.getContext('2d');
                if (ctx) {
                    ctx.clearRect(0, 0, 48, 48);
                    ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 2; ctx.lineCap = 'round';
                    const cx = 24, bottom = 40, top = 8;
                    ctx.beginPath(); ctx.moveTo(cx, bottom); ctx.lineTo(cx, top); ctx.stroke();
                    ctx.beginPath(); ctx.moveTo(cx, top + 2); ctx.lineTo(cx + 12, top - 2); ctx.stroke();
                    ctx.beginPath(); ctx.moveTo(cx, top + 8); ctx.lineTo(cx + 10, top + 4); ctx.stroke();
                    ctx.beginPath(); ctx.moveTo(cx, top + 14); ctx.lineTo(cx + 6, top + 12); ctx.stroke();
                    ctx.beginPath(); ctx.arc(cx, bottom, 3, 0, Math.PI * 2); ctx.fillStyle = '#e2e8f0'; ctx.fill();
                }
                const barbImage = new Image(48, 48);
                barbImage.onload = () => { if (!map.hasImage('wind-barb-icon')) map.addImage('wind-barb-icon', barbImage, { sdf: false }); };
                barbImage.src = barbCanvas.toDataURL();

                map.addLayer({
                    id: 'wind-barb-layer', type: 'symbol', source: 'wind-barbs',
                    layout: {
                        'icon-image': 'wind-barb-icon', 'icon-size': 0.7, 'icon-rotate': ['get', 'rotation'],
                        'icon-rotation-alignment': 'map', 'icon-allow-overlap': true,
                        'text-field': ['concat', ['get', 'label'], ' kt'], 'text-size': 9,
                        'text-offset': [0, 2.5], 'text-anchor': 'top',
                        'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'], 'text-allow-overlap': false,
                    },
                    paint: { 'icon-opacity': 0.8, 'text-color': '#94a3b8', 'text-halo-color': '#0f172a', 'text-halo-width': 1 },
                });

                // Circulation Arrows
                map.addSource('circulation-arrows', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
                const arrowCanvas = document.createElement('canvas');
                arrowCanvas.width = 32; arrowCanvas.height = 32;
                const actx = arrowCanvas.getContext('2d');
                if (actx) {
                    actx.clearRect(0, 0, 32, 32);
                    actx.strokeStyle = '#ffffff'; actx.lineWidth = 3; actx.lineCap = 'round'; actx.lineJoin = 'round';
                    actx.beginPath(); actx.moveTo(8, 22); actx.lineTo(16, 10); actx.lineTo(24, 22); actx.stroke();
                    actx.beginPath(); actx.moveTo(16, 10); actx.lineTo(16, 28); actx.stroke();
                }
                const arrowImg = new Image(32, 32);
                arrowImg.onload = () => { if (!map.hasImage('circulation-arrow')) map.addImage('circulation-arrow', arrowImg, { sdf: true }); };
                arrowImg.src = arrowCanvas.toDataURL();
                map.addLayer({
                    id: 'circulation-arrow-layer', type: 'symbol', source: 'circulation-arrows',
                    layout: { 'icon-image': 'circulation-arrow', 'icon-size': 0.6, 'icon-rotate': ['get', 'rotation'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true },
                    paint: { 'icon-color': ['get', 'color'], 'icon-opacity': 0.7 },
                });

                // Movement Tracks
                map.addSource('movement-tracks', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
                map.addLayer({
                    id: 'movement-track-lines', type: 'line', source: 'movement-tracks',
                    paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-opacity': 0.85, 'line-dasharray': [3, 2] },
                });
                map.addLayer({
                    id: 'movement-track-labels', type: 'symbol', source: 'movement-tracks',
                    layout: { 'symbol-placement': 'line', 'text-field': ['get', 'label'], 'text-size': 11, 'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'], 'symbol-spacing': 500, 'text-anchor': 'center', 'text-keep-upright': true },
                    paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0f172a', 'text-halo-width': 1.5 },
                });
            }

            showIsobars();
            updateIsobars(map);
            const onMoveEnd = () => updateIsobars(map);
            map.on('moveend', onMoveEnd);
            return () => { map.off('moveend', onMoveEnd); };
        }

        // ── Rain ──
        if (activeLayer === 'rain') {
            fetch('https://api.rainviewer.com/public/weather-maps.json')
                .then(r => r.json())
                .then(data => {
                    if (!mapRef.current) return;
                    const past = data?.radar?.past || [];
                    const nowcast = data?.radar?.nowcast || [];
                    const allFrames = [...past, ...nowcast];
                    if (!allFrames.length) return;
                    rainFramesRef.current = allFrames;
                    setRainFrameCount(allFrames.length);
                    const startIdx = Math.max(0, past.length - 1);
                    setRainFrameIndex(startIdx);
                    const startFrame = allFrames[startIdx];
                    map.addSource('weather-tiles', {
                        type: 'raster',
                        tiles: [`https://tilecache.rainviewer.com${startFrame.path}/256/{z}/{x}/{y}/4/1_1.png`],
                        tileSize: 256,
                        maxzoom: 12,
                    });
                    map.addLayer({
                        id: 'weather-tiles', type: 'raster', source: 'weather-tiles',
                        paint: { 'raster-opacity': 0.75 },
                    }, map.getLayer('route-line-layer') ? 'route-line-layer' : undefined);
                })
                .catch(() => { });
            return;
        }

        // ── Wind ──
        if (activeLayer === 'wind') {
            map.flyTo({ center: [location.lon, location.lat], zoom: 8, duration: 800 });
            const onFlyEnd = () => {
                map.off('moveend', onFlyEnd);
                setWindHour(0);
                WindDataController.activate(map).then(() => {
                    const m = mapRef.current;
                    if (!m) return;
                    const { grid: currentGrid } = WindStore.getState();
                    if (!currentGrid) return;
                    windGridRef.current = currentGrid;
                    setWindTotalHours(currentGrid.totalHours);
                    setWindReady(true);
                    try {
                        try { m.removeLayer('wind-particles'); } catch (_) { }
                        const engine = new WindParticleLayer();
                        engine.setGrid(currentGrid, windHour);
                        m.addLayer(engine);
                        try { m.moveLayer('coastline-stroke'); } catch (_) { }
                        try { m.moveLayer('country-borders-overlay'); } catch (_) { }
                        windEngineRef.current = engine;
                        setWindMaxSpeed(engine.getMaxSpeed());
                    } catch (err) {
                        console.error('[Wind GL] Engine init failed:', err);
                    }
                }).catch(() => { });
            };
            map.on('moveend', onFlyEnd);
        }

        // Static and dynamic tile layers (sea, satellite, temperature, clouds)
        const tileUrl = getTileUrl(activeLayer);
        if (tileUrl) {
            map.addSource('weather-tiles', { type: 'raster', tiles: [tileUrl], tileSize: 256, maxzoom: activeLayer === 'satellite' ? 16 : 18 });
            map.addLayer({
                id: 'weather-tiles', type: 'raster', source: 'weather-tiles',
                paint: {
                    'raster-opacity': activeLayer === 'satellite' ? 0.8
                        : activeLayer === 'temperature' ? 0.65
                            : activeLayer === 'clouds' ? 0.6
                                : 1.0,
                },
            }, map.getLayer('route-line-layer') ? 'route-line-layer' : undefined);
        }
    }, [activeLayer, mapReady, updateIsobars]);

    return {
        activeLayer, setActiveLayer,
        showLayerMenu, setShowLayerMenu,
        // Wind
        windEngineRef, windGridRef, windMarkersRef, windState,
        windHour, setWindHour,
        windTotalHours, setWindTotalHours,
        windPlaying, setWindPlaying,
        windReady, setWindReady,
        windMaxSpeed, setWindMaxSpeed,
        // Rain
        rainFramesRef, rainFrameIndex, setRainFrameIndex,
        rainFrameCount, setRainFrameCount,
        rainPlaying, setRainPlaying,
        // GRIB
        isGribDownloading, setIsGribDownloading,
        gribProgress, setGribProgress,
        gribError, setGribError,
        // Isobars / Pressure
        forecastHour, setForecastHour,
        isPlaying, setIsPlaying,
        totalFrames, framesReady,
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
        const delayTimer = setTimeout(() => {
            (async () => {
                try {
                    const res = await fetch('https://api.rainviewer.com/public/weather-maps.json');
                    const data = await res.json();
                    const past = (data?.radar?.past ?? []).map((f: any) => ({ path: f.path, time: f.time }));
                    const forecast = (data?.radar?.nowcast ?? []).map((f: any) => ({ path: f.path, time: f.time }));
                    const allFrames = [...past, ...forecast];
                    embeddedRainFrames.current = allFrames;
                    setEmbRainCount(allFrames.length);
                    const nowIdx = Math.max(0, past.length - 1);
                    embRainNowIdx.current = nowIdx;
                    setEmbRainIdx(nowIdx);
                } catch (err) { }
            })();
        }, embedded ? 1200 : 800);
        return () => {
            clearTimeout(delayTimer);
            try {
                const mx = mapRef.current;
                if (mx?.getLayer('embedded-rain')) mx.removeLayer('embedded-rain');
                if (mx?.getSource('embedded-rain')) mx.removeSource('embedded-rain');
            } catch (_) { }
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
            try { m.removeLayer('embedded-rain'); m.removeSource('embedded-rain'); } catch (e) { console.warn('[MapHub] ok:', e); }
        }
        m.addSource('embedded-rain', {
            type: 'raster',
            tiles: [`https://tilecache.rainviewer.com${frame.path}/256/{z}/{x}/{y}/6/1_1.png`],
            tileSize: 256,
            maxzoom: 6,
        });
        m.addLayer({
            id: 'embedded-rain', type: 'raster', source: 'embedded-rain',
            paint: { 'raster-opacity': embedded ? 0.75 : 0.55, 'raster-contrast': 0.3, 'raster-brightness-min': 0.1 },
        });
    }, [enabled, embRainIdx]);

    // Auto-play
    useEffect(() => {
        if (!embRainPlaying) return;
        const timer = setInterval(() => {
            setEmbRainIdx(prev => {
                if (prev + 1 >= embRainCount) { setEmbRainPlaying(false); return embRainNowIdx.current; }
                return prev + 1;
            });
        }, 1200);
        return () => clearInterval(timer);
    }, [embRainPlaying, embRainCount]);

    return {
        embeddedRainFrames,
        embRainIdx, setEmbRainIdx,
        embRainCount,
        embRainPlaying, setEmbRainPlaying,
        embRainNowIdx,
    };
}
