/**
 * MapHub — WebGL-powered map tab using Mapbox GL JS.
 *
 * Architecture pillars:
 *   1. Zero React overlay clutter — all data rendered as native map layers
 *   2. Long-press pin → LocationStore (global state)
 *   3. Weather tile layers: wind + rain (raster tiles, GPU-rendered)
 *   4. Passage planner: GeoJSON source layers for routes/isochrones
 *
 * Performance targets: 60fps pan/zoom on iPhone 16.
 *
 * This file is now a thin orchestrator — logic is split into:
 *   - mapConstants.ts      (types, constants, helpers)
 *   - useMapInit.ts        (map creation, layers, pin drop, location dot, picker)
 *   - useWeatherLayers.ts  (weather overlays, isobars, rain/wind scrubbers)
 *   - usePassagePlanner.ts (passage routing, isochrones, GPX export)
 *   - MapHubOverlays.tsx   (presentational overlay components)
 */
import React, { useRef, useState, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('MapHub');
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

import { useLocationStore } from '../../stores/LocationStore';
import { useWeather } from '../../context/WeatherContext';
import { WindStore } from '../../stores/WindStore';
import { ConsensusMatrix } from './ConsensusMatrix';
import { generateConsensusMatrix, type ConsensusMatrixData } from '../../services/ConsensusMatrixEngine';
import { LocationStore } from '../../stores/LocationStore';
import { useSettings } from '../../context/SettingsContext';
import { useUI } from '../../context/UIContext';
import { triggerHaptic } from '../../utils/system';
import { PassageBanner } from './PassageBanner';
import { GpsService } from '../../services/GpsService';

import { type MapHubProps, type WeatherLayer } from './mapConstants';
import { useMapInit, useLocationDot, usePickerMode } from './useMapInit';
import { useWeatherLayers, useEmbeddedRain } from './useWeatherLayers';
import { usePassagePlanner } from './usePassagePlanner';
import { useRouteNudge } from './useRouteNudge';
import { useAisLayer } from './useAisLayer';
import { useAisStreamLayer } from './useAisStreamLayer';
import { useChokepointLayer } from './useChokepointLayer';
import { useCycloneLayer } from './useCycloneLayer';
import { useSquallMap } from './useSquallMap';
import { useVesselTracker } from './useVesselTracker';
import { useAvNavCharts } from './useAvNavCharts';
import { useChartCatalog } from './useChartCatalog';
import { useLocalCharts } from './useLocalCharts';
import { useSeamarkLayer } from './useSeamarkLayer';
import { useTideStationLayer } from './useTideStationLayer';
import { AvNavService, type AvNavChart } from '../../services/AvNavService';
import { type ActiveCyclone, fetchActiveCyclones } from '../../services/weather/CycloneTrackingService';
import { AisLegend } from './AisLegend';
import { AisGuardAlert } from './AisGuardAlert';
import { VesselSearch } from './VesselSearch';
import { useFollowRouteMapbox } from '../../hooks/useFollowRouteMapbox';
import { MapboxVelocityOverlay } from './MapboxVelocityOverlay';
import { GhostShip } from './GhostShip';
import { LayerFABMenu } from './MapHubOverlays';
import { MapActionFabs } from './MapActionFabs';
import { ThalassaHelixControl, LegendDock, type HelixLayer } from './ThalassaHelixControl';
import { RouteLegend } from './RouteLegend';
import { useDeviceMode } from '../../hooks/useDeviceMode';
import { PassageDataPanel } from './PassageDataPanel';
import { WeatherInspectPopup } from './WeatherInspectPopup';
import { fetchPointWeather, type PointWeatherData } from '../../services/weather/pointWeather';

// ── Component ──────────────────────────────────────────────────

export const MapHub: React.FC<MapHubProps> = ({
    mapboxToken,
    onLocationSelect,
    initialZoom = 5,
    mapStyle = 'mapbox://styles/mapbox/dark-v11',
    minimalLabels = false,
    embedded = false,
    center,
    pickerMode = false,
}) => {
    // ── Pin View Mode (from chat pin tap) ──

    const [isPinView, setIsPinView] = useState(!!window.__thalassaPinView);
    const [showVesselSearch, setShowVesselSearch] = useState(false);
    const [weatherInspectMode, setWeatherInspectMode] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<mapboxgl.Map | null>(null);
    const pinMarkerRef = useRef<mapboxgl.Marker | null>(null);
    const locationDotRef = useRef<mapboxgl.Marker | null>(null);
    const { settings: _settings } = useSettings();
    const { setPage, previousView, currentView } = useUI();

    const [isoProgress, setIsoProgress] = useState<{
        step: number;
        closestNM: number;
        totalDistNM?: number;
        elapsed?: number;
        frontSize?: number;
        phase?: string;
    } | null>(null);
    const [showConsensus, setShowConsensus] = useState(false);
    const [consensusData, setConsensusData] = useState<ConsensusMatrixData | null>(null);
    const playheadMarkerRef = useRef<mapboxgl.Marker | null>(null);

    // ── Weather Inspect Popup ──
    const [_inspectData, setInspectData] = useState<PointWeatherData | null>(null);
    const [_inspectLoading, setInspectLoading] = useState(false);
    const inspectPopupRef = useRef<mapboxgl.Popup | null>(null);
    const inspectRootRef = useRef<ReturnType<typeof createRoot> | null>(null);

    // Re-check pin view when navigating TO the map tab
    useEffect(() => {
        if (currentView === 'map') {
            const pv = window.__thalassaPinView;
            setIsPinView(!!pv);
        }
    }, [currentView]);

    // Listen for isochrone progress + completion events
    useEffect(() => {
        const onProgress = (e: Event) => {
            const d = (e as CustomEvent).detail;
            log.info('Isochrone progress:', d);
            if (d)
                setIsoProgress({
                    step: d.step,
                    closestNM: d.closestNM,
                    totalDistNM: d.totalDistNM,
                    elapsed: d.elapsed,
                    frontSize: d.frontSize,
                    phase: d.phase,
                });

            // ── Progressive route rendering ──
            // Draw the partial route as the wavefronts expand so the user
            // sees the line growing — use a separate preview source to avoid
            // wiping out the harbour leg features on 'route-line'.
            if (d?.partialRoute && d.partialRoute.length >= 2) {
                const map = mapRef.current;
                if (!map) return;
                // Lazily create preview source/layer
                if (!map.getSource('route-preview')) {
                    map.addSource('route-preview', {
                        type: 'geojson',
                        data: { type: 'FeatureCollection', features: [] },
                    });
                    map.addLayer({
                        id: 'route-preview-layer',
                        type: 'line',
                        source: 'route-preview',
                        layout: { 'line-join': 'round', 'line-cap': 'round' },
                        paint: {
                            'line-color': '#00e676',
                            'line-width': 2,
                            'line-opacity': 0.5,
                            'line-dasharray': [4, 4],
                        },
                    });
                }
                const src = map.getSource('route-preview') as mapboxgl.GeoJSONSource;
                if (src) {
                    src.setData({
                        type: 'FeatureCollection',
                        features: [
                            {
                                type: 'Feature',
                                properties: {},
                                geometry: {
                                    type: 'LineString',
                                    coordinates: d.partialRoute,
                                },
                            },
                        ],
                    });
                }
            }
        };
        const onComplete = () => {
            log.info('Isochrone complete — clearing progress');
            setIsoProgress(null);
            // Clean up the progressive preview layer
            const map = mapRef.current;
            if (map) {
                if (map.getLayer('route-preview-layer')) map.removeLayer('route-preview-layer');
                if (map.getSource('route-preview')) map.removeSource('route-preview');
            }
        };
        window.addEventListener('thalassa:isochrone-progress', onProgress);
        window.addEventListener('thalassa:isochrone-complete', onComplete);
        return () => {
            window.removeEventListener('thalassa:isochrone-progress', onProgress);
            window.removeEventListener('thalassa:isochrone-complete', onComplete);
        };
    }, []);

    // Listen for pin-drop-navigate events from DM chat
    useEffect(() => {
        const onPinDrop = (e: Event) => {
            const { lat, lon, label } = (e as CustomEvent).detail;
            if (!isFinite(lat) || !isFinite(lon)) return;

            // Request tab switch to map via global event
            window.dispatchEvent(new CustomEvent('thalassa:navigate-tab', { detail: { tab: 'map' } }));

            // Fly to the pin location (delay gives map tab time to render)
            setTimeout(() => {
                const map = mapRef.current;
                if (!map) return;

                map.flyTo({ center: [lon, lat], zoom: 14, duration: 1500 });

                // Drop a temporary pin marker
                const el = document.createElement('div');
                el.className = 'pin-drop-marker';
                const wrapper = document.createElement('div');
                wrapper.style.cssText =
                    'display:flex;flex-direction:column;align-items:center;animation:pinDropBounce 0.5s ease-out';
                const pin = document.createElement('span');
                pin.style.cssText = 'font-size:28px;filter:drop-shadow(0 2px 6px rgba(0,0,0,0.4))';
                pin.textContent = '📍';
                wrapper.appendChild(pin);
                const lbl = document.createElement('span');
                lbl.style.cssText =
                    'font-size:10px;color:#38bdf8;font-weight:700;background:rgba(0,0,0,0.6);padding:2px 8px;border-radius:8px;margin-top:2px;white-space:nowrap;max-width:150px;overflow:hidden;text-overflow:ellipsis';
                lbl.textContent = label;
                wrapper.appendChild(lbl);
                el.appendChild(wrapper);

                const mapboxgl = window.mapboxgl;
                if (mapboxgl?.Marker) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const marker = new (mapboxgl as any).Marker({ element: el }).setLngLat([lon, lat]).addTo(map);

                    // Auto-remove after 10 seconds
                    setTimeout(() => {
                        try {
                            marker.remove();
                        } catch (e) {
                            console.warn('Suppressed:', e);
                            /* already removed */
                        }
                    }, 10_000);
                }
            }, 500);
        };

        window.addEventListener('pin-drop-navigate', onPinDrop);
        return () => window.removeEventListener('pin-drop-navigate', onPinDrop);
    }, []);

    const location = useLocationStore();
    const { weatherData } = useWeather();
    const weatherCoords = weatherData?.coordinates;
    const [mapReady, setMapReady] = useState(false);
    const deviceMode = useDeviceMode();
    const [aisVisible, setAisVisible] = useState(false);
    const [chokepointVisible, setChokepointVisible] = useState(false);
    const [cycloneVisible, setCycloneVisible] = useState(false);
    const [squallVisible, setSquallVisible] = useState(false);
    const [vesselTrackingVisible, setVesselTrackingVisible] = useState(true); // On by default
    const [seamarkVisible, setSeamarkVisible] = useState(false);
    const [tideStationsVisible, setTideStationsVisible] = useState(false);
    const [skChartIds, setSkChartIds] = useState<Set<string>>(new Set());
    const [skChartOpacity, setSkChartOpacity] = useState(0.7);
    const [localChartIds, setLocalChartIds] = useState<Set<string>>(new Set());
    const [localChartOpacity, setLocalChartOpacity] = useState(0.7);

    // Auto-enable newly discovered charts
    useEffect(() => {
        const unsub = AvNavService.onChartsChange((charts) => {
            if (charts.length > 0) {
                setSkChartIds((prev) => {
                    const next = new Set(prev);
                    for (const c of charts) next.add(c.id);
                    return next;
                });
            }
        });
        // Also enable any charts already discovered
        const existing = AvNavService.getCharts();
        if (existing.length > 0) {
            setSkChartIds(new Set(existing.map((c) => c.id)));
        }
        return unsub;
    }, []);

    const [closestStorm, setClosestStorm] = useState<ActiveCyclone | null>(null);
    const [allCyclones, setAllCyclones] = useState<ActiveCyclone[]>([]);
    const skipAutoFlyRef = useRef(false);

    // Fetch all active cyclones for the storm picker menu (runs regardless of layer visibility)
    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            try {
                const cyclones = await fetchActiveCyclones();
                if (!cancelled) setAllCyclones(cyclones);
            } catch (e) {
                console.warn('Suppressed:', e);
                /* non-critical */
            }
        };
        load();
        const timer = setInterval(load, 30 * 60 * 1000);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, []);

    // Ref for weather layer toggle (populated after weather hook runs)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const weatherRef = useRef<{ toggleLayer: (k: any) => void; activeLayers: Set<any> } | null>(null);

    // Handle storm selection from the picker menu
    const handleSelectStorm = useCallback(
        (storm: ActiveCyclone) => {
            // Signal useCycloneLayer to skip its auto-fly on the next load.
            // We handle the flyTo here to the user-selected storm.
            skipAutoFlyRef.current = true;
            if (!cycloneVisible) setCycloneVisible(true);
            setSquallVisible(false); // Mutually exclusive with squall
            setClosestStorm(storm);
            const map = mapRef.current;
            if (map) {
                map.flyTo({
                    center: [storm.currentPosition.lon, storm.currentPosition.lat],
                    zoom: 4,
                    duration: 2000,
                    essential: true,
                });
            }
        },
        [mapRef, cycloneVisible],
    );

    // ── Passage Planner ──
    const passage = usePassagePlanner(mapRef, mapReady);

    // Follow Route overlay — renders the followed planned route on the map
    // Suppressed during passage planning to avoid visual conflict
    // (both use dashed sky-blue lines, causing confusion)
    useFollowRouteMapbox(mapRef, mapReady && !passage.showPassage);

    // ── Cyclone Tracking Layer ──
    useCycloneLayer(
        mapRef,
        mapReady,
        cycloneVisible,
        location.lat,
        location.lon,
        setClosestStorm,
        skipAutoFlyRef,
        closestStorm,
    );

    // ── Rain Squall Map (GMGSI IR with BD Enhancement Curve) ──
    useSquallMap(mapRef, mapReady, squallVisible, allCyclones, handleSelectStorm);

    // ── Cyclone zoom center-lock — keep selected storm dead-center during zoom ──
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady || !cycloneVisible || !closestStorm) return;

        const onZoomEnd = () => {
            const storm = closestStorm;
            if (!storm) return;
            map.easeTo({
                center: [storm.currentPosition.lon, storm.currentPosition.lat],
                duration: 300,
            });
        };
        map.on('zoomend', onZoomEnd);
        return () => {
            map.off('zoomend', onZoomEnd);
        };
    }, [cycloneVisible, closestStorm, mapReady, mapRef]);

    // Clear isochrone progress when route completes
    useEffect(() => {
        if (passage.isoResultRef.current) setIsoProgress(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [passage.routeAnalysis]);

    // Generate consensus data when route completes
    useEffect(() => {
        const isoResult = passage.isoResultRef.current;
        if (!isoResult || !passage.routeAnalysis) {
            setConsensusData(null);
            return;
        }
        const windGrid = WindStore.getState().grid;
        if (!windGrid) return;

        (async () => {
            try {
                const data = await generateConsensusMatrix(
                    isoResult,
                    windGrid,
                    passage.departureTime || new Date().toISOString(),
                    undefined,
                    6,
                );
                setConsensusData(data);
            } catch (err) {
                log.warn('[Consensus] Failed to generate matrix:', err);
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [passage.routeAnalysis, passage.departureTime]);

    // Route-sync playhead marker
    const handleScrubPosition = useCallback((lat: number, lon: number) => {
        const map = mapRef.current;
        if (!map) return;

        if (!playheadMarkerRef.current) {
            const el = document.createElement('div');
            el.style.cssText = `
                width: 20px; height: 20px;
                background: linear-gradient(135deg, #38bdf8, #a78bfa);
                border: 3px solid #fff;
                border-radius: 50%;
                box-shadow: 0 0 16px rgba(56,189,248,0.5), 0 4px 12px rgba(0,0,0,0.3);
                transition: opacity 0.2s;
            `;
            playheadMarkerRef.current = new mapboxgl.Marker({ element: el, anchor: 'center' })
                .setLngLat([lon, lat])
                .addTo(map);
        } else {
            playheadMarkerRef.current.setLngLat([lon, lat]);
        }
    }, []);

    // Clean up playhead when consensus closes
    useEffect(() => {
        if (!showConsensus && playheadMarkerRef.current) {
            playheadMarkerRef.current.remove();
            playheadMarkerRef.current = null;
        }
    }, [showConsensus]);

    // ── Map Init ──
    const { dropPin } = useMapInit({
        containerRef,
        mapRef,
        pinMarkerRef,
        locationDotRef,
        mapboxToken,
        mapStyle,
        initialZoom,
        minimalLabels,
        embedded,
        center,
        location,
        onLocationSelect,
        pickerMode,
        settingPoint: passage.settingPoint,
        showPassage: passage.showPassage,
        departure: passage.departure,
        arrival: passage.arrival,
        setMapReady,
        setActiveLayer: (layer: string) => weather.setActiveLayer(layer as import('./mapConstants').WeatherLayer),
        setDeparture: passage.setDeparture,
        setArrival: passage.setArrival,
        setSettingPoint: passage.setSettingPoint,
        weatherInspect: weatherInspectMode,
        onMapTap: (lat: number, lon: number) => {
            const map = mapRef.current;
            if (!map) return;

            // Only show weather popup if the user explicitly enabled inspect mode
            if (!weatherInspectMode) return;

            // Weather inspect — stay active so user can tap multiple locations
            // They disable via the layer FAB menu

            // Close any existing inspect popup
            if (inspectPopupRef.current) {
                inspectPopupRef.current.remove();
                inspectPopupRef.current = null;
            }
            if (inspectRootRef.current) {
                inspectRootRef.current.unmount();
                inspectRootRef.current = null;
            }

            // Create popup DOM container
            const container = document.createElement('div');
            container.style.minWidth = '240px';
            const root = createRoot(container);
            inspectRootRef.current = root;

            // Render loading state immediately
            setInspectData(null);
            setInspectLoading(true);

            const closePopup = () => {
                if (inspectPopupRef.current) {
                    inspectPopupRef.current.remove();
                    inspectPopupRef.current = null;
                }
                if (inspectRootRef.current) {
                    inspectRootRef.current.unmount();
                    inspectRootRef.current = null;
                }
                setInspectData(null);
                setInspectLoading(false);
            };

            root.render(<WeatherInspectPopup data={null} loading={true} onClose={closePopup} />);

            const popup = new mapboxgl.Popup({
                closeButton: false,
                closeOnClick: true,
                className: 'weather-inspect-popup',
                maxWidth: '300px',
                offset: 8,
            })
                .setLngLat([lon, lat])
                .setDOMContent(container)
                .addTo(map);

            inspectPopupRef.current = popup;
            popup.on('close', () => {
                if (inspectRootRef.current) {
                    inspectRootRef.current.unmount();
                    inspectRootRef.current = null;
                }
                inspectPopupRef.current = null;
                setInspectData(null);
                setInspectLoading(false);
            });

            // Fetch weather data
            fetchPointWeather(lat, lon)
                .then((data) => {
                    if (!inspectPopupRef.current) return; // popup was closed
                    setInspectData(data);
                    setInspectLoading(false);
                    root.render(<WeatherInspectPopup data={data} loading={false} onClose={closePopup} />);
                })
                .catch(() => {
                    setInspectLoading(false);
                });
        },
    });

    // ── Location Dot (basic fallback — disabled when vessel tracker is active) ──
    useLocationDot(mapRef, locationDotRef, mapReady && !vesselTrackingVisible);

    // ── GPS Vessel Tracker Layer ──
    const { flyToVessel } = useVesselTracker(mapRef, mapReady, vesselTrackingVisible);

    // ── Picker Mode ──
    usePickerMode(mapRef, pinMarkerRef, pickerMode, onLocationSelect);

    // ── Route Nudge (long-press-to-drag on route line) ──
    useRouteNudge(mapRef, mapReady, passage.showPassage);

    // ── Weather Layers ──
    const weather = useWeatherLayers(mapRef, mapReady, embedded, location);
    weatherRef.current = weather;

    // ── Clear weather layers + Follow Route when passage mode activates ──
    const prevShowPassageRef = useRef(passage.showPassage);
    useEffect(() => {
        if (passage.showPassage && !prevShowPassageRef.current) {
            weather.setActiveLayer('none');
            // Force-remove Follow Route layers — the hook's useEffect cleanup
            // has a timing gap when mapReady transitions while routeCoords changes
            const map = mapRef.current;
            if (map) {
                const FR_LAYERS = [
                    'follow-route-markers-labels',
                    'follow-route-markers-circle',
                    'follow-route-active-line',
                    'follow-route-previous-line',
                ];
                const FR_SOURCES = ['follow-route-active', 'follow-route-previous', 'follow-route-markers'];
                for (const id of FR_LAYERS) {
                    if (map.getLayer(id)) map.removeLayer(id);
                }
                for (const id of FR_SOURCES) {
                    if (map.getSource(id)) map.removeSource(id);
                }
            }
        }
        prevShowPassageRef.current = passage.showPassage;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [passage.showPassage]);

    // ── Cyclone-aware temporal snap — REMOVED ──
    // Previously this scanned all GFS forecast hours to find the vortex center
    // closest to the ATCF position and overrode the wind scrubber. However, this
    // always biased toward hour-0 (model initialization) which showed wind data
    // 5-6 hours in the past. The time-based "now" index already produces correct
    // wind alignment with the tracked cyclone position.

    // ── Embedded Rain (also loads as background on full-map velocity mode) ──
    const _embRain = useEmbeddedRain(mapRef, embedded, mapReady, false);

    // ── AIS Vessel Target Layer ──
    useAisLayer(mapRef, mapReady, aisVisible);
    useAisStreamLayer(mapReady ? mapRef.current : null, aisVisible);

    // ── Chokepoint Tracker ──
    useChokepointLayer(mapReady ? mapRef.current : null, chokepointVisible);

    // ── Signal K Nautical Charts ──
    const skCharts = useAvNavCharts(mapRef, mapReady, skChartIds, skChartOpacity);

    // ── Free Chart Catalog (NOAA, LINZ) ──
    const chartCatalog = useChartCatalog(mapRef, mapReady);

    // ── Local MBTiles Charts (on-phone, no AvNav needed) ──
    const localCharts = useLocalCharts(mapRef, mapReady, localChartIds, localChartOpacity);
    const chartsActive = skChartIds.size > 0 || chartCatalog.hasEnabledCharts || localChartIds.size > 0;

    // ── Interactive Sea Marks (OpenSeaMap / Overpass API) ──
    // When o-charts are active: 'identify' mode (invisible hit targets, still click-to-identify)
    // When no charts:           'full' mode (renders IALA icons + click-to-identify)
    const seamarkMode = chartsActive ? ('identify' as const) : ('full' as const);
    const seamark = useSeamarkLayer(mapRef, mapReady, seamarkVisible, seamarkMode);

    // ── Tide Station Markers ──
    const tideStations = useTideStationLayer(mapRef, mapReady, tideStationsVisible);

    // ── Hide OpenSeaMap raster overlay when o-charts provide native icons ──
    // The openseamap-overlay (PNG tiles) is baked into the map style and shows
    // its own seamark icons. When o-charts are active they render their own
    // native marks, so we hide the raster overlay to prevent doubled icons.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;
        try {
            if (map.getLayer('openseamap-overlay')) {
                map.setLayoutProperty('openseamap-overlay', 'visibility', chartsActive ? 'none' : 'visible');
            }
        } catch {
            /* layer not yet available — harmless */
        }
    }, [mapRef, mapReady, chartsActive]);

    // ── Pin View: Drop a visual-only pin marker (no navigation side-effects) ──
    useEffect(() => {
        const pv = window.__thalassaPinView as { lat: number; lng: number } | undefined;
        if (!isPinView || !pv || !mapReady || !mapRef.current) return;
        const map = mapRef.current;

        // Remove any existing pin
        if (pinMarkerRef.current) pinMarkerRef.current.remove();

        // Create visual pin marker
        const el = document.createElement('div');
        el.className = 'mapbox-pin-marker';
        const pinDiv = document.createElement('div');
        pinDiv.style.cssText =
            'width:32px;height:32px;background:linear-gradient(135deg,#f59e0b,#ef4444);border:3px solid #fff;border-radius:50% 50% 50% 0;transform:rotate(-45deg);box-shadow:0 4px 16px rgba(245,158,11,0.5);animation:pinBounce 0.4s ease-out;';
        el.appendChild(pinDiv);
        const marker = new mapboxgl.Marker({ element: el, anchor: 'bottom' }).setLngLat([pv.lng, pv.lat]).addTo(map);
        pinMarkerRef.current = marker;

        // Fly to the pin
        map.flyTo({ center: [pv.lng, pv.lat], zoom: 7, duration: 1200 });
    }, [isPinView, mapReady]);

    // Determine if tablet split-screen is active
    const isHelmSplit = deviceMode === 'helm' && passage.showPassage && !embedded;

    return (
        <div className={`w-full h-full ${isHelmSplit ? 'flex' : 'relative'}`}>
            {/* Map container — 70% on tablet during passage, full otherwise */}
            <div className={`relative ${isHelmSplit ? 'flex-[7] h-full' : 'w-full h-full'}`}>
                <div ref={containerRef} className="w-full h-full" />

                {/* Pin bounce + location pulse animations moved to index.css */}

                {/* ═══ PIN VIEW BACK BUTTON ═══ */}
                {isPinView && (
                    <button
                        onClick={() => {
                            delete window.__thalassaPinView;
                            setIsPinView(false);
                            setPage(previousView || 'chat');
                        }}
                        className="absolute top-14 left-4 z-[700] w-10 h-10 bg-slate-900/90 border border-white/[0.12] rounded-2xl flex items-center justify-center shadow-2xl hover:bg-slate-800/90 transition-all active:scale-90"
                        aria-label="Navigate back from map"
                    >
                        <svg
                            className="w-5 h-5 text-white"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2.5}
                        >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                        </svg>
                    </button>
                )}

                {/* ═══ VELOCITY WIND OVERLAY ═══ */}
                {!isPinView && !embedded && (
                    <MapboxVelocityOverlay
                        mapboxMap={mapRef.current}
                        visible={weather.activeLayers.has('velocity') || weather.activeLayers.has('wind')}
                        windHour={weather.windHour}
                        windGrid={weather.windGridRef?.current ?? undefined}
                        hideBadge={passage.showPassage}
                    />
                )}

                {/* ═══ GHOST SHIP (route interpolation during forecast scrub) ═══ */}
                {!isPinView && !embedded && passage.showPassage && passage.routeAnalysis && (
                    <GhostShip
                        map={mapRef.current}
                        routeCoords={passage.isoResultRef.current?.routeCoordinates ?? null}
                        departureTime={passage.departureTime || new Date().toISOString()}
                        speed={passage.speed}
                        windHour={weather.windHour}
                        windForecastHours={weather.windForecastHoursRef.current}
                        windNowIdx={weather.windNowIdxRef.current}
                        visible={
                            (weather.activeLayers.has('wind') || weather.activeLayers.has('velocity')) &&
                            passage.showPassage &&
                            !!passage.routeAnalysis
                        }
                    />
                )}

                <PassageBanner
                    passage={passage}
                    isoProgress={isoProgress}
                    embedded={embedded}
                    isPinView={isPinView}
                    deviceMode={deviceMode}
                />

                {/* ═══ LAYER FAB MENU ═══ */}
                {!passage.showPassage && !embedded && !isPinView && (
                    <LayerFABMenu
                        activeLayers={weather.activeLayers}
                        showLayerMenu={weather.showLayerMenu}
                        embedded={embedded}
                        location={location}
                        initialZoom={initialZoom}
                        center={center}
                        mapRef={mapRef}
                        toggleLayer={weather.toggleLayer}
                        setShowLayerMenu={weather.setShowLayerMenu}
                        aisVisible={aisVisible}
                        onToggleAis={() => setAisVisible((v) => !v)}
                        chokepointVisible={chokepointVisible}
                        onToggleChokepoint={() => setChokepointVisible((v) => !v)}
                        weatherInspectMode={weatherInspectMode}
                        onToggleWeatherInspect={() => {
                            setWeatherInspectMode((v) => !v);
                            weather.setShowLayerMenu(false);
                        }}
                        cycloneVisible={cycloneVisible}
                        onToggleCyclones={() => {
                            const willBeVisible = !cycloneVisible;
                            setCycloneVisible(willBeVisible);
                            // Mutually exclusive with squall map
                            if (willBeVisible) setSquallVisible(false);
                            // Storm view uses Himawari-9 IR satellite — no auto-enable of wind/rain
                            // Users can manually toggle them via the layer menu if wanted
                        }}
                        cycloneStormName={closestStorm?.name ?? null}
                        allCyclones={allCyclones}
                        userLat={location.lat}
                        userLon={location.lon}
                        onSelectStorm={handleSelectStorm}
                        squallVisible={squallVisible}
                        onToggleSquall={() => {
                            const willBeVisible = !squallVisible;
                            setSquallVisible(willBeVisible);
                            // Mutually exclusive with storm layer
                            if (willBeVisible) setCycloneVisible(false);
                        }}
                        vesselTrackingVisible={vesselTrackingVisible}
                        onToggleVesselTracking={() => setVesselTrackingVisible((v) => !v)}
                        onLocateVessel={flyToVessel}
                        skCharts={skCharts.availableCharts}
                        skChartIds={skChartIds}
                        skChartOpacity={skChartOpacity}
                        skConnectionStatus={skCharts.connectionStatus}
                        onToggleSkChart={(id: string) => {
                            setSkChartIds((prev) => {
                                const next = new Set(prev);
                                if (next.has(id)) next.delete(id);
                                else next.add(id);
                                return next;
                            });
                        }}
                        onSkChartOpacityChange={setSkChartOpacity}
                        onFlyToChart={skCharts.flyToChart}
                        seamarkVisible={seamarkVisible}
                        onToggleSeamark={() => setSeamarkVisible((v) => !v)}
                        seamarkFeatureCount={seamark.featureCount}
                        seamarkLoading={seamark.loading}
                        chartsActive={chartsActive}
                        seamarkMode={seamarkMode}
                        tideStationsVisible={tideStationsVisible}
                        onToggleTideStations={() => setTideStationsVisible((v) => !v)}
                        tideStationCount={tideStations.stationCount}
                        tideStationLoading={tideStations.loading}
                        chartCatalogSources={chartCatalog.sources}
                        onToggleChartSource={chartCatalog.toggleSource}
                        onChartSourceOpacity={chartCatalog.setOpacity}
                        onFlyToChartSource={chartCatalog.flyToSource}
                        onUpdateLinzKey={chartCatalog.updateLinzKey}
                        localCharts={localCharts.availableCharts}
                        localChartIds={localChartIds}
                        localChartOpacity={localChartOpacity}
                        localChartsLoading={localCharts.loading}
                        onToggleLocalChart={(fileName: string) => {
                            setLocalChartIds((prev) => {
                                const next = new Set(prev);
                                if (next.has(fileName)) next.delete(fileName);
                                else next.add(fileName);
                                return next;
                            });
                        }}
                        onLocalChartOpacityChange={setLocalChartOpacity}
                        onFlyToLocalChart={localCharts.flyToChart}
                    />
                )}

                {/* ═══ AIS COLOUR LEGEND + GUARD ZONE TOGGLE ═══ */}
                {!passage.showPassage && !embedded && !isPinView && <AisLegend visible={aisVisible} />}

                {/* ═══ VESSEL SEARCH BUTTON ═══ */}
                {!passage.showPassage && !embedded && !isPinView && aisVisible && (
                    <button
                        onClick={() => {
                            setShowVesselSearch(true);
                            triggerHaptic('light');
                        }}
                        className="absolute z-[500] top-14 right-[128px] w-12 h-12 rounded-2xl bg-slate-900/90 border border-white/[0.08] flex items-center justify-center shadow-2xl hover:bg-slate-800/90 transition-all active:scale-95 text-slate-400"
                        aria-label="Search vessels"
                    >
                        🔍
                    </button>
                )}

                {/* ═══ VESSEL SEARCH OVERLAY ═══ */}
                <VesselSearch
                    visible={showVesselSearch}
                    onClose={() => setShowVesselSearch(false)}
                    onSelect={(lat, lon, mmsi, name) => {
                        const map = mapRef.current;
                        if (!map) return;

                        // Fly to vessel location
                        map.flyTo({
                            center: [lon, lat],
                            zoom: 14,
                            speed: 1.5,
                            curve: 1.4,
                            essential: true,
                        });

                        // Add a temporary pulse marker at the vessel
                        const el = document.createElement('div');
                        const pulseDiv = document.createElement('div');
                        pulseDiv.style.cssText =
                            'width:48px;height:48px;border-radius:50%;background:radial-gradient(circle,rgba(14,165,233,0.3) 0%,transparent 70%);border:2px solid rgba(14,165,233,0.6);animation:pulse 1.5s ease-in-out infinite;display:flex;align-items:center;justify-content:center;font-size:20px;';
                        pulseDiv.textContent = '🎯';
                        el.appendChild(pulseDiv);

                        const mapboxglLib = window.mapboxgl;
                        if (mapboxglLib?.Marker) {
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            const marker = new (mapboxglLib as any).Marker({ element: el })
                                .setLngLat([lon, lat])
                                .addTo(map);

                            // Remove after 8 seconds
                            setTimeout(() => marker.remove(), 8000);
                        }

                        log.info(`Vessel search: flying to ${name} (${mmsi}) at ${lat.toFixed(4)}, ${lon.toFixed(4)}`);
                    }}
                />

                {/* ═══ AIS GUARD ZONE ALERT TOAST ═══ */}
                <AisGuardAlert />

                {/* ═══ ROUTE LEGEND (during passage mode) ═══ */}
                <RouteLegend
                    visible={passage.showPassage && !!passage.routeAnalysis && !isPinView}
                    embedded={embedded}
                />

                {/* ═══ CONSENSUS MATRIX FAB (during passage mode) ═══ */}
                {passage.showPassage && passage.routeAnalysis && consensusData && !embedded && !isPinView && (
                    <button
                        onClick={() => {
                            setShowConsensus(!showConsensus);
                            triggerHaptic('medium');
                        }}
                        className={`absolute bottom-44 left-4 z-[500] w-12 h-12 rounded-2xl flex items-center justify-center shadow-2xl transition-all active:scale-95 ${
                            showConsensus
                                ? 'bg-gradient-to-br from-sky-500/30 to-purple-500/30 border border-sky-500/40'
                                : 'bg-slate-900/90 border border-white/[0.08] hover:bg-slate-800/90'
                        }`}
                        aria-label="Toggle Consensus Matrix"
                    >
                        <svg
                            className={`w-5 h-5 ${showConsensus ? 'text-sky-400' : 'text-white'}`}
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={1.5}
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5M9 11.25v1.5M12 9v3.75m3-6v6"
                            />
                        </svg>
                    </button>
                )}

                {/* ═══ ACTION FABS ═══ */}
                {!embedded && !passage.showPassage && !isPinView && (
                    <MapActionFabs
                        onLocateMe={() => {
                            triggerHaptic('medium');
                            GpsService.getCurrentPosition({ staleLimitMs: 30_000, timeoutSec: 10 }).then((pos) => {
                                if (!pos) return;
                                const { latitude, longitude } = pos;
                                const map = mapRef.current;
                                if (map) {
                                    map.flyTo({ center: [longitude, latitude], zoom: 12, duration: 1200 });
                                }
                                LocationStore.setFromGPS(latitude, longitude);
                                if (pickerMode) {
                                    onLocationSelect?.(latitude, longitude);
                                }
                            });
                        }}
                        onRecenter={() => {
                            if (mapRef.current && weatherCoords) {
                                mapRef.current.flyTo({
                                    center: [weatherCoords.lon, weatherCoords.lat],
                                    zoom: 10,
                                    duration: 1000,
                                });
                                dropPin(mapRef.current, weatherCoords.lat, weatherCoords.lon);
                            }
                            triggerHaptic('light');
                        }}
                        recenterDisabled={!weatherCoords}
                    />
                )}

                {/* ═══ THALASSA HELIX CONTROL ═══ */}
                {!isPinView &&
                    !embedded &&
                    weather.activeLayers.size > 0 &&
                    (() => {
                        // Identify active weather layers (only scrubble types)
                        const WEATHER_KEYS: HelixLayer[] = ['pressure', 'wind', 'rain', 'temperature', 'clouds'];
                        const activeWeatherLayers = WEATHER_KEYS.filter((k) =>
                            k === 'wind'
                                ? weather.activeLayers.has('wind' as WeatherLayer) ||
                                  weather.activeLayers.has('velocity')
                                : weather.activeLayers.has(k as WeatherLayer),
                        );

                        // ── Wind+Rain combo: synced scrubber limited to shortest timeline ──
                        const isWindRainCombo =
                            activeWeatherLayers.length === 2 &&
                            activeWeatherLayers.includes('wind') &&
                            activeWeatherLayers.includes('rain');

                        if (activeWeatherLayers.length >= 2 && !isWindRainCombo) {
                            return <LegendDock layers={activeWeatherLayers} embedded={embedded} />;
                        }

                        if (isWindRainCombo) {
                            // Synced scrubber: use rain timeline (shorter, ~4h) and drive both
                            if (weather.rainLoading) {
                                return (
                                    <ThalassaHelixControl
                                        activeLayer="rain"
                                        frameIndex={0}
                                        totalFrames={1}
                                        frameLabel="Loading..."
                                        sublabel="Rain"
                                        isPlaying={false}
                                        isLoading={true}
                                        embedded={embedded}
                                        onScrub={() => {}}
                                        onPlayToggle={() => {}}
                                    />
                                );
                            }
                            if (weather.rainReady && weather.rainFrameCount > 1) {
                                const rainNow = weather.rainNowIdxRef.current;
                                const curFrame = weather.unifiedFramesRef.current[weather.rainFrameIndex];
                                const isForecast = curFrame?.type === 'forecast';
                                return (
                                    <ThalassaHelixControl
                                        activeLayer="wind"
                                        frameIndex={weather.rainFrameIndex}
                                        totalFrames={weather.rainFrameCount}
                                        frameLabel={curFrame?.label ?? '--'}
                                        sublabel={isForecast ? 'Forecast' : 'Live'}
                                        isPlaying={weather.rainPlaying}
                                        isLoading={false}
                                        embedded={embedded}
                                        nowIndex={rainNow}
                                        dualColor={true}
                                        forecastAccent="#fbbf24"
                                        onScrub={(idx: number) => {
                                            weather.setRainFrameIndex(idx);
                                            // Map rain frame time to closest wind hour
                                            const frame = weather.unifiedFramesRef.current[idx];
                                            if (frame && weather.windForecastHoursRef.current.length > 0) {
                                                const fhrs = weather.windForecastHoursRef.current;
                                                const nowIdx = weather.windNowIdxRef.current;
                                                const rainNowIdx = weather.rainNowIdxRef.current;
                                                const deltaFrames = idx - rainNowIdx;
                                                // Each rain frame is ~10 min apart; map to wind hour index
                                                const deltaHours = (deltaFrames * 10) / 60;
                                                const targetForecastHour = (fhrs[nowIdx] ?? 0) + deltaHours;
                                                // Find closest wind forecast hour
                                                let bestWindIdx = nowIdx;
                                                let bestDist = Infinity;
                                                for (let i = 0; i < fhrs.length; i++) {
                                                    const d = Math.abs(fhrs[i] - targetForecastHour);
                                                    if (d < bestDist) {
                                                        bestDist = d;
                                                        bestWindIdx = i;
                                                    }
                                                }
                                                weather.setWindHour(bestWindIdx);
                                            }
                                        }}
                                        onScrubStart={() => weather.setRainPlaying(false)}
                                        onPlayToggle={() => weather.setRainPlaying(!weather.rainPlaying)}
                                    />
                                );
                            }
                            // Rain not ready — fall through to wind-only scrubber
                        }

                        // ── 0 weather layers (only sea/traffic/etc): nothing ──
                        if (activeWeatherLayers.length === 0) return null;

                        // ── Exactly 1 weather layer: show scrubber ──
                        const activeLayerKey = activeWeatherLayers[0];
                        if (!activeLayerKey) return null;

                        let frameIndex = 0;
                        let totalFrames = 1;
                        let frameLabel = 'Live';
                        let sublabel = 'Live';
                        let isPlaying = false;
                        let isLoading = false;
                        let framesReady: number | undefined;
                        let nowIndex: number | undefined;
                        let dualColor = false;
                        let forecastAccent = '#fbbf24';

                        let onScrub = (_f: number) => {};
                        let onScrubStart: (() => void) | undefined;
                        let onPlayToggle = () => {};

                        let applyFrame: ((f: number) => void) | undefined;

                        if (activeLayerKey === 'pressure') {
                            frameIndex = weather.forecastHour;
                            totalFrames = weather.totalFrames;
                            framesReady = weather.framesReady;
                            isPlaying = weather.isPlaying;
                            const maxF = Math.max(0, totalFrames - 1);
                            const forecastHrs = maxF > 0 ? (frameIndex / maxF) * 12 : 0;
                            frameLabel =
                                frameIndex === 0
                                    ? 'Now'
                                    : `+${forecastHrs % 1 === 0 ? forecastHrs : forecastHrs.toFixed(1)}h`;
                            sublabel = frameIndex === 0 ? 'Current' : 'Forecast';
                            onScrub = (h: number) => weather.setForecastHour(h);
                            onPlayToggle = () => weather.setIsPlaying(!weather.isPlaying);
                            onScrubStart = () => weather.setIsPlaying(false);
                            applyFrame = weather.applyFrame;
                        } else if (activeLayerKey === 'wind') {
                            const fhrs = weather.windForecastHoursRef.current;
                            const nowIdx = weather.windNowIdxRef.current;
                            const roundedIdx = Math.round(weather.windHour);
                            frameIndex = weather.windHour;
                            totalFrames = weather.windTotalHours;
                            const actualHour = fhrs[roundedIdx] ?? roundedIdx;
                            const nowHour = fhrs[nowIdx] ?? 0;

                            if (roundedIdx === nowIdx) {
                                frameLabel = 'Now';
                                sublabel = 'Current';
                            } else {
                                const relativeH = actualHour - nowHour;
                                if (relativeH > 0) {
                                    frameLabel = `+${relativeH}h`;
                                    sublabel = 'Forecast';
                                } else if (relativeH < 0) {
                                    frameLabel = `${relativeH}h`;
                                    sublabel = 'Past';
                                } else {
                                    frameLabel = 'Now';
                                    sublabel = 'Current';
                                }
                            }
                            isPlaying = weather.windPlaying;
                            onScrub = (idx: number) => weather.setWindHour(idx);
                            onPlayToggle = () => weather.setWindPlaying(!weather.windPlaying);
                            onScrubStart = () => weather.setWindPlaying(false);
                        } else if (activeLayerKey === 'rain') {
                            if (weather.rainLoading) {
                                isLoading = true;
                            } else if (weather.rainReady && weather.rainFrameCount > 1) {
                                frameIndex = weather.rainFrameIndex;
                                totalFrames = weather.rainFrameCount;
                                nowIndex = weather.rainNowIdxRef.current;
                                const curFrame = weather.unifiedFramesRef.current[weather.rainFrameIndex];
                                const isForecast = curFrame?.type === 'forecast';
                                frameLabel = curFrame?.label ?? '--';
                                sublabel = isForecast ? 'Forecast' : 'Radar';
                                isPlaying = weather.rainPlaying;
                                dualColor = true;
                                forecastAccent = '#fbbf24';
                                onScrub = (idx: number) => weather.setRainFrameIndex(idx);
                                onPlayToggle = () => weather.setRainPlaying(!weather.rainPlaying);
                                onScrubStart = () => weather.setRainPlaying(false);
                            } else {
                                frameLabel = 'No Data';
                                sublabel = 'Retry';
                            }
                        }
                        // temperature / clouds: no scrubber, just legend (totalFrames stays 1)

                        return (
                            <ThalassaHelixControl
                                activeLayer={activeLayerKey}
                                frameIndex={frameIndex}
                                totalFrames={totalFrames}
                                frameLabel={frameLabel}
                                sublabel={sublabel}
                                isPlaying={isPlaying}
                                isLoading={isLoading}
                                framesReady={framesReady}
                                embedded={embedded}
                                onScrub={onScrub}
                                onScrubStart={onScrubStart}
                                onPlayToggle={onPlayToggle}
                                applyFrame={applyFrame}
                                nowIndex={nowIndex}
                                dualColor={dualColor}
                                forecastAccent={forecastAccent}
                            />
                        );
                    })()}
            </div>

            {/* ═══ TABLET DATA PANEL / CONSENSUS MATRIX (Helm mode, 30% width) ═══ */}
            {isHelmSplit && (
                <div className="flex-[3] h-full">
                    {showConsensus && consensusData ? (
                        <ConsensusMatrix
                            data={consensusData}
                            onScrubPosition={handleScrubPosition}
                            onClose={() => setShowConsensus(false)}
                        />
                    ) : (
                        <PassageDataPanel
                            routeAnalysis={passage.routeAnalysis}
                            departure={passage.departure}
                            arrival={passage.arrival}
                            turnWaypoints={passage.turnWaypointsRef.current}
                            departureTime={passage.departureTime}
                        />
                    )}
                </div>
            )}

            {/* ═══ CONSENSUS MATRIX — Phone slide-up (Deck mode) ═══ */}
            {deviceMode === 'deck' && showConsensus && consensusData && !embedded && (
                <div className="absolute inset-0 z-[600] animate-in slide-in-from-bottom duration-300">
                    <ConsensusMatrix
                        data={consensusData}
                        onScrubPosition={handleScrubPosition}
                        onClose={() => setShowConsensus(false)}
                    />
                </div>
            )}
        </div>
    );
};
