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
import React, { Suspense, useRef, useState, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { createLogger } from '../../utils/createLogger';
import { lazyRetry } from '../../utils/lazyRetry';

const log = createLogger('MapHub');
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

import { useLocationStore } from '../../stores/LocationStore';
import { useWeather } from '../../context/WeatherContext';
import { WindStore } from '../../stores/WindStore';
import type { ConsensusMatrixData } from '../../services/ConsensusMatrixEngine';
import { LocationStore } from '../../stores/LocationStore';
import { useSettings } from '../../context/SettingsContext';
import { useUI } from '../../context/UIContext';
import { triggerHaptic } from '../../utils/system';
import { PassageBanner } from './PassageBanner';
import { GpsService } from '../../services/GpsService';
import { piCache } from '../../services/PiCacheService';
import { MapOfflineService } from '../../services/MapOfflineService';
import { toast } from '../Toast';

import { type MapHubProps, type WeatherLayer, SEA_STATE_LAYERS, ATMOSPHERE_LAYERS } from './mapConstants';
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
import { useOfflineBaseLayer } from './useOfflineBaseLayer';
import { useSeamarkLayer } from './useSeamarkLayer';
import { useTideStationLayer } from './useTideStationLayer';
import { useLightningLayer } from './useLightningLayer';
import { useOceanCurrentParticleLayer, isCmemsCurrentsEnabled } from './useOceanCurrentParticleLayer';
import { useOceanWaveParticleLayer, isCmemsWavesEnabled } from './useOceanWaveParticleLayer';
import { useSstRasterLayer, isCmemsSstEnabled } from './useSstRasterLayer';
import { useChlRasterLayer, isCmemsChlEnabled } from './useChlRasterLayer';
import { useSeaIceRasterLayer, isCmemsSeaIceEnabled } from './useSeaIceRasterLayer';
import { useMldRasterLayer, isCmemsMldEnabled } from './useMldRasterLayer';
import { useMpaLayer, isMpaEnabled } from './useMpaLayer';
import { AvNavService, type AvNavChart } from '../../services/AvNavService';
import type { ActiveCyclone } from '../../services/weather/CycloneTrackingService';
import { useFollowRouteMapbox } from '../../hooks/useFollowRouteMapbox';
import { useDestinationFlag } from './useDestinationFlag';
import { MapboxVelocityOverlay } from './MapboxVelocityOverlay';
import { LayerFABMenu } from './MapHubOverlays';
import { RadialHelmMenu } from './RadialHelmMenu';
import { StormPicker } from './StormPicker';
import { MapActionFabs } from './MapActionFabs';
import { ThalassaHelixControl, LegendDock, type HelixLayer } from './ThalassaHelixControl';
import { useDeviceMode } from '../../hooks/useDeviceMode';
import type { PointWeatherData } from '../../services/weather/pointWeather';

// ── Lazy-loaded overlay components (split into separate chunks) ──
const ConsensusMatrix = lazyRetry(
    () => import('./ConsensusMatrix').then((m) => ({ default: m.ConsensusMatrix })),
    'ConsensusMatrix',
);
const VesselSearch = lazyRetry(
    () => import('./VesselSearch').then((m) => ({ default: m.VesselSearch })),
    'VesselSearch',
);
const AisLegend = lazyRetry(() => import('./AisLegend').then((m) => ({ default: m.AisLegend })), 'AisLegend');
const CmemsAttribution = lazyRetry(
    () => import('./CmemsAttribution').then((m) => ({ default: m.CmemsAttribution })),
    'CmemsAttribution',
);
// Eager import — the chip doubles as the live diagnostic pill for the
// lightning feed, so a lazy chunk that fails to load silently (and
// leaves the user staring at an empty chart with no feedback) is the
// exact failure mode we're trying to fix. Tiny component, not worth the
// risk of a broken chunk hiding our debug surface.
import { BlitzortungAttribution } from './BlitzortungAttribution';
import { SquallLegend } from './SquallLegend';
import { ChartModes } from './ChartModes';
import { ThreatBanner } from './ThreatBanner';
import { ConnectivityChip } from './ConnectivityChip';
import { LayerSettings } from './LayerSettings';
import { PerfOverlay } from './PerfOverlay';
import { PerfDowntierToast } from './PerfDowntierToast';
import { CoachMark } from '../ui/CoachMark';
import { PerfGuardian, consumePerfDowntierToast } from '../../services/PerfGuardian';
const AisGuardAlert = lazyRetry(
    () => import('./AisGuardAlert').then((m) => ({ default: m.AisGuardAlert })),
    'AisGuardAlert',
);
const GhostShip = lazyRetry(() => import('./GhostShip').then((m) => ({ default: m.GhostShip })), 'GhostShip');
const RouteLegend = lazyRetry(() => import('./RouteLegend').then((m) => ({ default: m.RouteLegend })), 'RouteLegend');
const PassageDataPanel = lazyRetry(
    () => import('./PassageDataPanel').then((m) => ({ default: m.PassageDataPanel })),
    'PassageDataPanel',
);
const OfflineAreaModal = lazyRetry(
    () => import('./OfflineAreaModal').then((m) => ({ default: m.OfflineAreaModal })),
    'OfflineAreaModal',
);
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { usePersistedState, usePersistedStringSet } from '../../hooks/usePersistedState';
// WeatherInspectPopup is rendered imperatively via createRoot — use direct dynamic import
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _WeatherInspectPopup: React.ComponentType<any> | null = null;
const getWeatherInspectPopup = async () => {
    if (!_WeatherInspectPopup) {
        const mod = await import('./WeatherInspectPopup');
        _WeatherInspectPopup = mod.WeatherInspectPopup;
    }
    return _WeatherInspectPopup;
};

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
    const [showOfflineArea, setShowOfflineArea] = useState(false);
    const [offlineCardDismissed, setOfflineCardDismissed] = useState(false);
    const [weatherInspectMode, setWeatherInspectMode] = useState(false);
    const isOnline = useOnlineStatus();
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
    // Map state persisted across Charts tab switches so the user comes
    // back to exactly what they left on. Time-critical overlays that
    // are meant to be session-only (cyclone / squall / weather inspect)
    // deliberately stay as plain useState.
    const [aisVisible, setAisVisible] = usePersistedState('thalassa_map_ais_visible', false);
    const [chokepointVisible, setChokepointVisible] = usePersistedState('thalassa_map_chokepoint_visible', false);
    const [cycloneVisible, setCycloneVisible] = useState(false);
    const [squallVisible, setSquallVisible] = useState(false);
    // Vessel tracking now defaults to TRUE so a new user always sees
    // their own boat on the chart from the first frame — without having
    // to discover the toggle in the radial menu. Existing users who
    // explicitly turned it off keep their preference (usePersistedState
    // reads localStorage first). Toggle still works to dim down to the
    // simpler GPS dot via useLocationDot.
    const [vesselTrackingVisible, setVesselTrackingVisible] = usePersistedState(
        'thalassa_map_vessel_tracking_visible',
        true,
    );
    const [seamarkVisible, setSeamarkVisible] = usePersistedState('thalassa_map_seamark_visible', false);
    const [tideStationsVisible, setTideStationsVisible] = usePersistedState(
        'thalassa_map_tide_stations_visible',
        false,
    );
    const [lightningVisible, setLightningVisible] = usePersistedState('thalassa_map_lightning_visible', false);
    const [skChartIds, setSkChartIds] = usePersistedStringSet('thalassa_map_sk_chart_ids');
    const [skChartOpacity, setSkChartOpacity] = usePersistedState('thalassa_map_sk_chart_opacity', 0.7);
    const [localChartIds, setLocalChartIds] = usePersistedStringSet('thalassa_map_local_chart_ids');
    const [localChartOpacity, setLocalChartOpacity] = usePersistedState('thalassa_map_local_chart_opacity', 0.7);

    // Charts start hidden — user enables them via the Charts layer toggle.
    // AvNavService still discovers available charts in the background so
    // the layer menu can list them, but nothing renders until toggled on.

    const [closestStorm, setClosestStorm] = useState<ActiveCyclone | null>(null);
    const [allCyclones, setAllCyclones] = useState<ActiveCyclone[]>([]);
    const skipAutoFlyRef = useRef(false);
    // Storm picker modal — opens when the user taps Storms in the radial menu
    // AND there are multiple active cyclones to choose from.
    const [stormPickerOpen, setStormPickerOpen] = useState(false);
    const [layerSettingsOpen, setLayerSettingsOpen] = useState(false);
    /** One-time toast surfaced when PerfGuardian downtiered the device
     *  on the previous session. Cleared on dismiss / first render. */
    const [perfToast, setPerfToast] = useState<boolean>(() => consumePerfDowntierToast());

    // Start the silent FPS watchdog when the chart screen mounts. It
    // runs essentially free (one rAF callback) and writes to
    // localStorage when sustained FPS goes below 35 — the next launch
    // picks up the lower tier automatically.
    useEffect(() => {
        PerfGuardian.start();
        return () => PerfGuardian.stop();
    }, []);

    // Clear the perf-toast flag a beat after the toast's own auto-
    // dismiss so we don't keep re-rendering it across mount/remount.
    useEffect(() => {
        if (!perfToast) return;
        const t = setTimeout(() => setPerfToast(false), 6500);
        return () => clearTimeout(t);
    }, [perfToast]);

    // Fetch all active cyclones for the storm picker menu (runs regardless of layer visibility)
    // Dynamic import — CycloneTrackingService is large and only needed after map loads
    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            try {
                const { fetchActiveCyclones } = await import('../../services/weather/CycloneTrackingService');
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

    // Destination flag — pulsing green flag at the active voyage's
    // destination, with a live distance + bearing chip from the user's
    // current GPS. Hidden when no voyage is active. Sits on top of the
    // follow-route line so the user gets the full "I am here, going
    // there" picture from one glance at the chart.
    useDestinationFlag(mapRef, mapReady && !passage.showPassage);

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
        // Wire marker clicks to the same handler the picker modal uses —
        // so tapping a storm on the chart does the same thing as tapping
        // its row in the picker (fly + highlight + close any overlay).
        handleSelectStorm,
    );

    // ── Rain Squall Map (GMGSI IR with BD Enhancement Curve) ──
    useSquallMap(mapRef, mapReady, squallVisible, location.lat, location.lon, allCyclones, handleSelectStorm);

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
    // Dynamic import — ConsensusMatrixEngine is heavy computation, only needed post-route
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
                const { generateConsensusMatrix } = await import('../../services/ConsensusMatrixEngine');
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
        initialCenter: weatherCoords ? { lat: weatherCoords.lat, lon: weatherCoords.lon } : undefined,
        onLocationSelect,
        pickerMode,
        settingPoint: passage.settingPoint,
        showPassage: passage.showPassage,
        departure: passage.departure,
        arrival: passage.arrival,
        setMapReady,
        setActiveLayer: (layer: string) => {
            if (layer !== 'none') {
                setSquallVisible(false);
                setCycloneVisible(false);
            }
            weather.setActiveLayer(layer as import('./mapConstants').WeatherLayer);
        },
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

            // Render loading state — component loaded async
            getWeatherInspectPopup().then((WIP) => {
                root.render(<WIP data={null} loading={true} onClose={closePopup} />);
            });

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

            // Fetch weather data (dynamic import — pointWeather only needed on inspect tap)
            import('../../services/weather/pointWeather')
                .then(({ fetchPointWeather }) => fetchPointWeather(lat, lon))
                .then((data) => {
                    if (!inspectPopupRef.current) return; // popup was closed
                    setInspectData(data);
                    setInspectLoading(false);
                    getWeatherInspectPopup().then((WIP) => {
                        root.render(<WIP data={data} loading={false} onClose={closePopup} />);
                    });
                })
                .catch(() => {
                    setInspectLoading(false);
                });
        },
    });

    // ── Location Dot (basic fallback — disabled when vessel tracker is active) ──
    useLocationDot(mapRef, locationDotRef, mapReady && !vesselTrackingVisible);

    // ── Fly to the selected weather location when it arrives / changes ──
    // `initialCenter` on useMapInit sets the mount-time centre, but when the
    // weather data is still loading from cache it's undefined and the map
    // falls back to live GPS. This effect fills that gap: as soon as
    // weatherCoords is available — and any time it changes afterwards — we
    // recentre on the selected location. User-driven pans don't change
    // weatherCoords, so their pan sticks.
    //
    // First centre jumps instantly at the AU+NZ fit zoom (what the user
    // asked for: "width of AU and NZ together, zoom ~2.87"). Subsequent
    // centres preserve the user's current zoom so we don't yank them out
    // of a harbour view they zoomed into.
    const lastFlownCoordsRef = useRef<{ lat: number; lon: number } | null>(null);
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;
        if (embedded || pickerMode || passage.showPassage || isPinView) return;
        if (!weatherCoords) return;

        const last = lastFlownCoordsRef.current;
        if (last && Math.abs(last.lat - weatherCoords.lat) < 1e-6 && Math.abs(last.lon - weatherCoords.lon) < 1e-6) {
            return;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ausNzFitZoom = (map as any).__ausNzMinZoom ?? map.getMinZoom();
        const isFirst = last === null;
        map.jumpTo({
            center: [weatherCoords.lon, weatherCoords.lat],
            zoom: isFirst ? ausNzFitZoom : Math.max(map.getZoom(), ausNzFitZoom),
        });
        if (!isFirst) {
            map.easeTo({ center: [weatherCoords.lon, weatherCoords.lat], duration: 600 });
        }
        lastFlownCoordsRef.current = { lat: weatherCoords.lat, lon: weatherCoords.lon };
    }, [
        mapReady,
        weatherCoords?.lat,
        weatherCoords?.lon,
        embedded,
        pickerMode,
        passage.showPassage,
        isPinView,
        weatherCoords,
    ]);

    // ── Auto-cache tiles around the user when a Pi is in play ──
    // When the boat has a Pi on the network, silently download a 1000 NM
    // box of raster tiles at cruising zooms (z6-z10) so the map keeps
    // working the moment the phone drops offline. Only runs when:
    //   - Pi is available
    //   - User has a valid weatherCoords
    //   - User has moved > 100 NM since the last auto-cache (tracked in LS)
    //   - Pi's SQLite cache isn't already gigantic (>10 GB)
    // The one-time-per-mount guard prevents firing while a download's in
    // flight; subsequent weatherCoords changes that still fall within the
    // move-threshold are deduped inside MapOfflineService.
    const autoCacheRanRef = useRef(false);
    useEffect(() => {
        if (embedded || pickerMode || isPinView) return;
        if (!weatherCoords) return;
        if (autoCacheRanRef.current) return;

        let cancelled = false;
        const ctrl = new AbortController();
        const tryRun = async () => {
            if (!piCache.isAvailable()) return; // wait for Pi
            autoCacheRanRef.current = true;
            const outcome = await MapOfflineService.autoDownloadAroundUser({
                centerLat: weatherCoords.lat,
                centerLon: weatherCoords.lon,
                signal: ctrl.signal,
                onProgress: (p) => {
                    if (p.phase === 'downloading' && p.current === 0) {
                        toast.info('Auto-caching 1000 NM around you to the Pi…', 4000);
                    }
                },
            });
            if (cancelled) return;
            if (outcome.status === 'done') {
                toast.success(`Pi cached ${outcome.tilesCached.toLocaleString()} tiles — the map stays live offline.`);
            } else if (outcome.status === 'error') {
                // Reset the guard so a later weatherCoords change can retry.
                autoCacheRanRef.current = false;
                log.warn('Auto-cache failed:', outcome.message);
            } else if (outcome.status === 'skipped') {
                // Skipped for a legitimate reason (no Pi, not moved, cache full) —
                // don't toast the user, but leave the guard open so Pi arriving
                // later or movement over the threshold can still kick it off.
                autoCacheRanRef.current = false;
                log.info('Auto-cache skipped:', outcome.reason);
            }
        };

        // Run once now, then subscribe so we fire the moment the Pi is found.
        tryRun();
        const unsub = piCache.onStatusChange(() => {
            if (!autoCacheRanRef.current && piCache.isAvailable()) tryRun();
        });

        return () => {
            cancelled = true;
            ctrl.abort();
            unsub();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [weatherCoords?.lat, weatherCoords?.lon, embedded, pickerMode, isPinView]);

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

    // ── Offline OSM raster fallback — renders when offline, invisible when online ──
    useOfflineBaseLayer(mapRef, mapReady, isOnline);
    const chartsActive = skChartIds.size > 0 || chartCatalog.hasEnabledCharts || localChartIds.size > 0;

    // ── Single-select chart picker ──
    // Only one nautical chart layer visible at a time across all three kinds
    // (AvNav / free catalog / on-phone MBTiles). Clicking the currently-on
    // chart turns it off (empty state is allowed). Clicking any other chart
    // turns that one on, turns everything else off, and flies the camera
    // to the new chart's coverage.
    const selectChartExclusive = useCallback(
        (kind: 'sk' | 'catalog' | 'local', id: string) => {
            const isSkOn = kind === 'sk' && skChartIds.has(id);
            const isLocalOn = kind === 'local' && localChartIds.has(id);
            const catalogSrc = kind === 'catalog' ? chartCatalog.sources.find((s) => s.id === id) : undefined;
            const isCatalogOn = !!catalogSrc?.enabled;
            const turningOff = isSkOn || isLocalOn || isCatalogOn;

            if (turningOff) {
                // Toggle off the one they tapped; leave the (already-empty) other buckets alone.
                if (kind === 'sk') {
                    setSkChartIds((prev) => {
                        const next = new Set(prev);
                        next.delete(id);
                        return next;
                    });
                } else if (kind === 'local') {
                    setLocalChartIds((prev) => {
                        const next = new Set(prev);
                        next.delete(id);
                        return next;
                    });
                } else if (catalogSrc) {
                    chartCatalog.toggleSource(catalogSrc.id);
                }
                return;
            }

            // Turning on → wipe every other chart, enable just this one.
            setSkChartIds(kind === 'sk' ? new Set([id]) : new Set());
            setLocalChartIds(kind === 'local' ? new Set([id]) : new Set());
            chartCatalog.disableAll();
            if (kind === 'catalog' && catalogSrc) {
                chartCatalog.toggleSource(catalogSrc.id); // flips off → on
            }

            // Fly the camera so the user sees their selection.
            if (kind === 'sk') {
                const chart = skCharts.availableCharts.find((c) => c.id === id);
                if (chart) skCharts.flyToChart(chart);
            } else if (kind === 'local') {
                const chart = localCharts.availableCharts.find((c) => c.fileName === id);
                if (chart) localCharts.flyToChart(chart);
            } else if (catalogSrc) {
                chartCatalog.flyToSource(catalogSrc);
            }
        },
        [skChartIds, localChartIds, chartCatalog, skCharts, localCharts],
    );

    // ── Interactive Sea Marks (OpenSeaMap / Overpass API) ──
    // When o-charts are active: 'identify' mode (invisible hit targets, still click-to-identify)
    // When no charts:           'full' mode (renders IALA icons + click-to-identify)
    const seamarkMode = chartsActive ? ('identify' as const) : ('full' as const);
    const seamark = useSeamarkLayer(mapRef, mapReady, seamarkVisible, seamarkMode);

    // ── Tide Station Markers ──
    const tideStations = useTideStationLayer(mapRef, mapReady, tideStationsVisible);

    // ── Lightning Strikes (Xweather GLD360) ──
    useLightningLayer(mapRef, mapReady, lightningVisible);

    // ── Ocean Currents (CMEMS via Mapbox raster-particle) ──
    // Gated by VITE_CMEMS_CURRENTS_ENABLED. When the flag is off the hook
    // no-ops and the existing Xweather raster-currents tile layer renders
    // instead (managed by useWeatherLayers via the 'currents' WeatherLayer).
    const currentsVisible = weather.activeLayers.has('currents');
    useOceanCurrentParticleLayer(mapRef, mapReady, currentsVisible, weather.currentsHour);

    // ── Ocean Waves (CMEMS WAM forecast via the particle-layer engine) ──
    // Same pattern as currents: gated by VITE_CMEMS_WAVES_ENABLED, pulls
    // from /api/waves, replaces the Xweather wave-height raster when the
    // flag is on. Waves use their own scrubber step (3-hourly, 17 frames)
    // separate from currents' 13-hourly.
    const wavesVisible = weather.activeLayers.has('waves');
    useOceanWaveParticleLayer(mapRef, mapReady, wavesVisible, weather.wavesHour);

    // ── Sea-surface temperature (CMEMS daily P1D-m raster heatmap) ──
    // Scalar field — no particles. Gated by VITE_CMEMS_SST_ENABLED.
    // 5-day forecast, daily cadence = 5 scrubber steps.
    const sstVisible = weather.activeLayers.has('sst');
    useSstRasterLayer(mapRef, mapReady, sstVisible, weather.sstStep);

    // ── Chlorophyll (CMEMS BGC daily raster heatmap) ──
    // Scalar field like SST. Net-new — no Xweather fallback. Gated by
    // VITE_CMEMS_CHL_ENABLED. Daily cadence, 5-day forecast.
    const chlVisible = weather.activeLayers.has('chl');
    useChlRasterLayer(mapRef, mapReady, chlVisible, weather.chlStep);

    // ── Sea-ice concentration (CMEMS physics daily raster heatmap) ──
    // Scalar field. Polar-only by definition (shader discards <15%).
    // Net-new — unlocks high-latitude routing (Baltic winter, Alaska,
    // Svalbard, Antarctic). Gated by VITE_CMEMS_SEAICE_ENABLED.
    const seaiceVisible = weather.activeLayers.has('seaice');
    useSeaIceRasterLayer(mapRef, mapReady, seaiceVisible, weather.seaiceStep);

    // ── Mixed-layer depth (CMEMS physics daily raster heatmap) ──
    // Scalar field log-encoded over [1m, 1000m]. Plasma ramp.
    // Niche — relevant to thermocline-tracking deep-sea fishers and
    // ocean modellers. Gated by VITE_CMEMS_MLD_ENABLED.
    const mldVisible = weather.activeLayers.has('mld');
    useMldRasterLayer(mapRef, mapReady, mldVisible, weather.mldStep);

    // ── Marine Protected Areas (CAPAD GeoJSON overlay) ──
    // Independent toggle — co-exists with any weather layer because
    // "where can I fish?" is orthogonal to "what's the weather doing?".
    // Gated by VITE_MPA_ENABLED.
    useMpaLayer(mapRef, mapReady, weather.mpaVisible);

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
                        className="absolute top-[56px] left-4 z-[700] w-12 h-12 bg-slate-900/90 border border-white/[0.12] rounded-2xl flex items-center justify-center shadow-2xl hover:bg-slate-800/90 transition-all active:scale-90"
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
                <Suspense fallback={null}>
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
                </Suspense>

                <PassageBanner
                    passage={passage}
                    isoProgress={isoProgress}
                    embedded={embedded}
                    isPinView={isPinView}
                    deviceMode={deviceMode}
                />

                {/* ═══ RADIAL HELM MENU (gesture-based layer control) ═══ */}
                {!passage.showPassage && !embedded && !isPinView && (
                    <RadialHelmMenu
                        activeLayers={weather.activeLayers}
                        toggleLayer={weather.toggleLayer}
                        selectInGroup={weather.selectInGroup}
                        tacticalState={{
                            aisVisible,
                            onToggleAis: () => {
                                setAisVisible((v) => {
                                    if (!v) {
                                        setSquallVisible(false);
                                        setCycloneVisible(false);
                                    }
                                    return !v;
                                });
                            },
                            cycloneVisible,
                            onToggleCyclones: () => {
                                // When MULTIPLE cyclones are active, open the picker modal
                                // instead of just toggling — otherwise the user has no way
                                // to switch between storms (previous behaviour auto-focused
                                // only the closest one). With 0 or 1 storms, fall back to
                                // the simple toggle.
                                if (allCyclones.length > 1) {
                                    setStormPickerOpen(true);
                                    // Also enable the layer if it's off so the picked storm
                                    // becomes visible immediately.
                                    if (!cycloneVisible) {
                                        setCycloneVisible(true);
                                        setSquallVisible(false);
                                        setAisVisible(false);
                                        setChokepointVisible(false);
                                        setSeamarkVisible(false);
                                        setTideStationsVisible(false);
                                        setWeatherInspectMode(false);
                                        weather.setActiveLayer('none');
                                    }
                                    return;
                                }
                                // Single- or zero-storm case — plain toggle (existing behaviour)
                                const willBeVisible = !cycloneVisible;
                                setCycloneVisible(willBeVisible);
                                if (willBeVisible) {
                                    setSquallVisible(false);
                                    setAisVisible(false);
                                    setChokepointVisible(false);
                                    setSeamarkVisible(false);
                                    setTideStationsVisible(false);
                                    setWeatherInspectMode(false);
                                    weather.setActiveLayer('none');
                                }
                            },
                            squallVisible,
                            onToggleSquall: () => {
                                const willBeVisible = !squallVisible;
                                setSquallVisible(willBeVisible);
                                if (willBeVisible) {
                                    setCycloneVisible(false);
                                    setAisVisible(false);
                                    setChokepointVisible(false);
                                    setSeamarkVisible(false);
                                    setTideStationsVisible(false);
                                    setWeatherInspectMode(false);
                                    weather.setActiveLayer('none');
                                }
                            },
                            lightningVisible,
                            onToggleLightning: () => setLightningVisible((v) => !v),
                            weatherInspectMode,
                            onToggleWeatherInspect: () => {
                                setWeatherInspectMode((v) => {
                                    if (!v) {
                                        setSquallVisible(false);
                                        setCycloneVisible(false);
                                    }
                                    return !v;
                                });
                            },
                            seamarkVisible,
                            onToggleSeamark: () => {
                                setSeamarkVisible((v) => {
                                    if (!v) {
                                        setSquallVisible(false);
                                        setCycloneVisible(false);
                                    }
                                    return !v;
                                });
                            },
                            tideStationsVisible,
                            onToggleTideStations: () => {
                                setTideStationsVisible((v) => {
                                    if (!v) {
                                        setSquallVisible(false);
                                        setCycloneVisible(false);
                                    }
                                    return !v;
                                });
                            },
                            // Marine Protected Areas — only surface in the
                            // radial menu when the feature flag is on, so
                            // the button doesn't taunt users on builds
                            // without the data pipeline live yet.
                            ...(isMpaEnabled()
                                ? {
                                      mpaVisible: weather.mpaVisible,
                                      onToggleMpa: () => weather.setMpaVisible(!weather.mpaVisible),
                                  }
                                : {}),
                        }}
                        chartsState={{
                            // Compose chart sources from AvNav (o-charts) + free chart
                            // catalog + local MBTiles so all chart toggles live in the
                            // radial menu's 4th category.
                            sources: [
                                ...skCharts.availableCharts.map((c) => ({
                                    id: `sk-${c.id}`,
                                    label: c.name.length > 10 ? c.name.substring(0, 10) : c.name,
                                    iconKind: 'avnav' as const,
                                    enabled: skChartIds.has(c.id),
                                    onToggle: () => selectChartExclusive('sk', c.id),
                                })),
                                ...chartCatalog.sources.map((s) => ({
                                    id: `cat-${s.id}`,
                                    label:
                                        s.id === 'noaa-ncds'
                                            ? 'NOAA'
                                            : s.id === 'noaa-ecdis'
                                              ? 'ECDIS'
                                              : s.id === 'linz-charts'
                                                ? 'NZ'
                                                : s.name.length > 10
                                                  ? s.name.substring(0, 10)
                                                  : s.name,
                                    iconKind: (s.id === 'noaa-ncds'
                                        ? 'noaa'
                                        : s.id === 'noaa-ecdis'
                                          ? 'ecdis'
                                          : s.id === 'linz-charts'
                                            ? 'linz'
                                            : 'generic') as 'noaa' | 'ecdis' | 'linz' | 'generic',
                                    enabled: s.enabled && !!s.tileUrl,
                                    onToggle: () => selectChartExclusive('catalog', s.id),
                                })),
                                ...localCharts.availableCharts.map((c) => ({
                                    id: `local-${c.fileName}`,
                                    label: c.name.length > 10 ? c.name.substring(0, 10) : c.name,
                                    iconKind: 'local' as const,
                                    enabled: localChartIds.has(c.fileName),
                                    onToggle: () => selectChartExclusive('local', c.fileName),
                                })),
                            ],
                        }}
                    />
                )}

                {/* ═══ LEGACY LAYER MENU (kept for chart/SK/vessel controls not yet in radial) ═══ */}
                {!passage.showPassage && !embedded && !isPinView && weather.showLayerMenu && (
                    <LayerFABMenu
                        activeLayers={weather.activeLayers}
                        showLayerMenu={weather.showLayerMenu}
                        embedded={embedded}
                        location={location}
                        initialZoom={initialZoom}
                        center={center}
                        mapRef={mapRef}
                        toggleLayer={weather.toggleLayer}
                        onSelectSeaState={(layer) => {
                            setSquallVisible(false);
                            setCycloneVisible(false);
                            weather.selectInGroup(layer, SEA_STATE_LAYERS);
                        }}
                        onSelectAtmosphere={(layer) => {
                            setSquallVisible(false);
                            setCycloneVisible(false);
                            weather.selectInGroup(layer, ATMOSPHERE_LAYERS);
                        }}
                        setShowLayerMenu={weather.setShowLayerMenu}
                        aisVisible={aisVisible}
                        onToggleAis={() => {
                            setAisVisible((v) => {
                                if (!v) {
                                    setSquallVisible(false);
                                    setCycloneVisible(false);
                                }
                                return !v;
                            });
                        }}
                        chokepointVisible={chokepointVisible}
                        onToggleChokepoint={() => {
                            setChokepointVisible((v) => {
                                if (!v) {
                                    setSquallVisible(false);
                                    setCycloneVisible(false);
                                }
                                return !v;
                            });
                        }}
                        weatherInspectMode={weatherInspectMode}
                        onToggleWeatherInspect={() => {
                            setWeatherInspectMode((v) => {
                                if (!v) {
                                    setSquallVisible(false);
                                    setCycloneVisible(false);
                                }
                                return !v;
                            });
                            weather.setShowLayerMenu(false);
                        }}
                        cycloneVisible={cycloneVisible}
                        onToggleCyclones={() => {
                            const willBeVisible = !cycloneVisible;
                            setCycloneVisible(willBeVisible);
                            if (willBeVisible) {
                                setSquallVisible(false);
                                setAisVisible(false);
                                setChokepointVisible(false);
                                setSeamarkVisible(false);
                                setTideStationsVisible(false);
                                setWeatherInspectMode(false);
                                weather.setActiveLayer('none');
                            }
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
                            if (willBeVisible) {
                                setCycloneVisible(false);
                                setAisVisible(false);
                                setChokepointVisible(false);
                                setSeamarkVisible(false);
                                setTideStationsVisible(false);
                                setWeatherInspectMode(false);
                                weather.setActiveLayer('none');
                            }
                        }}
                        lightningVisible={lightningVisible}
                        onToggleLightning={() => {
                            setLightningVisible((v) => !v);
                        }}
                        vesselTrackingVisible={vesselTrackingVisible}
                        onToggleVesselTracking={() => {
                            setVesselTrackingVisible((v) => {
                                if (!v) {
                                    setSquallVisible(false);
                                    setCycloneVisible(false);
                                }
                                return !v;
                            });
                        }}
                        onLocateVessel={flyToVessel}
                        skCharts={skCharts.availableCharts}
                        skChartIds={skChartIds}
                        skChartOpacity={skChartOpacity}
                        skConnectionStatus={skCharts.connectionStatus}
                        onToggleSkChart={(id: string) => selectChartExclusive('sk', id)}
                        onSkChartOpacityChange={setSkChartOpacity}
                        onFlyToChart={skCharts.flyToChart}
                        seamarkVisible={seamarkVisible}
                        onToggleSeamark={() => {
                            setSeamarkVisible((v) => {
                                if (!v) {
                                    setSquallVisible(false);
                                    setCycloneVisible(false);
                                }
                                return !v;
                            });
                        }}
                        seamarkFeatureCount={seamark.featureCount}
                        seamarkLoading={seamark.loading}
                        chartsActive={chartsActive}
                        seamarkMode={seamarkMode}
                        tideStationsVisible={tideStationsVisible}
                        onToggleTideStations={() => {
                            setTideStationsVisible((v) => {
                                if (!v) {
                                    setSquallVisible(false);
                                    setCycloneVisible(false);
                                }
                                return !v;
                            });
                        }}
                        tideStationCount={tideStations.stationCount}
                        tideStationLoading={tideStations.loading}
                        {...(isMpaEnabled()
                            ? {
                                  mpaVisible: weather.mpaVisible,
                                  onToggleMpa: () => weather.setMpaVisible(!weather.mpaVisible),
                              }
                            : {})}
                        chartCatalogSources={chartCatalog.sources}
                        onToggleChartSource={(id) => selectChartExclusive('catalog', id)}
                        onChartSourceOpacity={chartCatalog.setOpacity}
                        onFlyToChartSource={chartCatalog.flyToSource}
                        onUpdateLinzKey={chartCatalog.updateLinzKey}
                        localCharts={localCharts.availableCharts}
                        localChartIds={localChartIds}
                        localChartOpacity={localChartOpacity}
                        localChartsLoading={localCharts.loading}
                        onToggleLocalChart={(fileName: string) => selectChartExclusive('local', fileName)}
                        onLocalChartOpacityChange={setLocalChartOpacity}
                        onFlyToLocalChart={localCharts.flyToChart}
                    />
                )}

                {/* Lightning legend pill — rendered OUTSIDE the AisLegend
                    Suspense block. The eager-imported BlitzortungAttribution
                    used to live inside that Suspense, which meant if any
                    sibling lazy component (AisLegend, etc.) suspended, the
                    fallback={null} would hide the entire block — including
                    our chip. The chip then "disappeared" even though its
                    own code was loaded and ready. Now it stands alone so
                    it renders independently of any other component's
                    loading state. */}
                {/* Chart modes — top-center one-tap layer presets so a
                    new user can go from blank chart to "Day Sail" or
                    "Storm Watch" in a single tap, instead of hunting
                    through 20 layer toggles. Always visible while on
                    the chart screen. */}
                <ChartModes
                    visible={!passage.showPassage && !embedded && !isPinView}
                    onOpenSettings={() => setLayerSettingsOpen(true)}
                    activeSkyLayers={weather.activeLayers as Set<string>}
                    toggleSkyLayer={(layer) => weather.toggleLayer(layer as never)}
                    setActiveSkyLayer={(layer) =>
                        weather.setActiveLayer(layer as import('./mapConstants').WeatherLayer)
                    }
                    aisVisible={aisVisible}
                    setAisVisible={setAisVisible}
                    lightningVisible={lightningVisible}
                    setLightningVisible={setLightningVisible}
                    cycloneVisible={cycloneVisible}
                    setCycloneVisible={setCycloneVisible}
                    squallVisible={squallVisible}
                    setSquallVisible={setSquallVisible}
                    seamarkVisible={seamarkVisible}
                    setSeamarkVisible={setSeamarkVisible}
                    tideStationsVisible={tideStationsVisible}
                    setTideStationsVisible={setTideStationsVisible}
                    chokepointVisible={chokepointVisible}
                    setChokepointVisible={setChokepointVisible}
                    vesselTrackingVisible={vesselTrackingVisible}
                    setVesselTrackingVisible={setVesselTrackingVisible}
                    mpaVisible={weather.mpaVisible}
                    setMpaVisible={(v) => weather.setMpaVisible(v)}
                />

                {/* First-run coach marks — fire once per device. Five
                    one-sentence prompts covering the chart screen's
                    main affordances. Each gated by its own seenKey so
                    they fire independently as the user encounters them. */}
                {!passage.showPassage && !embedded && !isPinView && (
                    <>
                        <CoachMark
                            seenKey="thalassa_coach_chart_modes"
                            visibleWhen={mapReady}
                            anchor="top-left"
                            arrow="up"
                            initialDelayMs={1200}
                            className="!top-[60px] !left-1/2 !-translate-x-1/2 items-center"
                            message="Tap a mode at the top to set up the chart for your situation in one go."
                        />
                        <CoachMark
                            seenKey="thalassa_coach_radial_menu"
                            visibleWhen={mapReady}
                            anchor="bottom-right"
                            arrow="down"
                            initialDelayMs={8000}
                            message="Open the radial menu to fine-tune any individual layer."
                        />
                        <CoachMark
                            seenKey="thalassa_coach_legend_chip"
                            visibleWhen={mapReady && (lightningVisible || squallVisible)}
                            anchor="bottom-left"
                            arrow="down"
                            initialDelayMs={2000}
                            message="The legend in the bottom-left explains every colour you see on the chart."
                        />
                        {/* Layer-menu surface — fires the FIRST time the
                            radial menu is opened (which sets
                            weather.showLayerMenu=true). Explains the
                            three category structure so users don't have
                            to discover Sky / Tactical / Charts by tapping
                            blindly. */}
                        <CoachMark
                            seenKey="thalassa_coach_layer_menu"
                            visibleWhen={mapReady && weather.showLayerMenu}
                            anchor="center"
                            arrow="up"
                            initialDelayMs={400}
                            message="Sky for weather. Tactical for safety. Charts for navigation. Tap to switch."
                        />
                        {/* Chart-library hint — when the user enters the
                            chart catalog tab specifically. They might
                            not realise that tapping a chart enables it
                            and tapping again switches to a different one
                            (single-select, no hidden multi-toggle). */}
                        <CoachMark
                            seenKey="thalassa_coach_chart_catalog"
                            visibleWhen={mapReady && weather.showLayerMenu && chartCatalog.sources.length > 0}
                            anchor="bottom-left"
                            arrow="up"
                            initialDelayMs={2200}
                            message="Tap any chart to load it. Tap a different one to switch — only one chart shows at a time."
                        />
                    </>
                )}

                {/* Perf-guardian toast — surfaced on session-start when
                    the previous session hit sustained low FPS and we
                    auto-downtiered the device. Informs the user that
                    particle density is reduced for performance.
                    Auto-clears state after the toast's own TTL. */}
                <PerfDowntierToast visible={perfToast && !passage.showPassage && !embedded && !isPinView} />

                {/* Performance HUD — only renders when ?perf=1 in URL.
                    Used for diagnosing perf hitches on lower-spec
                    devices. Zero cost in normal use. */}
                <PerfOverlay
                    mapRef={mapRef}
                    activeLayerCount={
                        weather.activeLayers.size +
                        (lightningVisible ? 1 : 0) +
                        (squallVisible ? 1 : 0) +
                        (cycloneVisible ? 1 : 0) +
                        (aisVisible ? 1 : 0) +
                        (seamarkVisible ? 1 : 0) +
                        (tideStationsVisible ? 1 : 0)
                    }
                />

                {/* Layer-opacity settings sheet — opened from the cog
                    inside the ChartModes chip. Lets the user dim any
                    active raster layer in real time so they can see
                    the chart underneath without having to toggle the
                    layer off entirely. */}
                <LayerSettings
                    visible={layerSettingsOpen && !passage.showPassage && !embedded && !isPinView}
                    onClose={() => setLayerSettingsOpen(false)}
                    mapRef={mapRef}
                    activeSkyLayers={weather.activeLayers as Set<string>}
                    squallVisible={squallVisible}
                />

                {/* Threat proximity banner — surfaces nearby lightning
                    or active cyclones with bearing + distance. The
                    safety feature competitors don't have. Tap → fly to
                    threat. Hidden when nothing is dangerously near. */}
                <ThreatBanner
                    visible={!passage.showPassage && !embedded && !isPinView}
                    userLat={location.lat}
                    userLon={location.lon}
                    cyclones={allCyclones}
                    lightningActive={lightningVisible}
                    flyTo={(lat, lon, zoom) => {
                        const map = mapRef.current;
                        if (!map) return;
                        map.flyTo({ center: [lon, lat], zoom, duration: 1200, essential: true });
                    }}
                />

                {/* At-a-glance network status — Pi (boat network) /
                    Online (cellular/WiFi) / Offline. Critical for
                    marine users who need to know what their data costs
                    them and whether live feeds will update. */}
                <ConnectivityChip visible={!passage.showPassage && !embedded && !isPinView} />

                <BlitzortungAttribution visible={lightningVisible} />

                {/* Squall colormap legend — same anchor as the lightning
                    chip. Both layers are mutually exclusive in the radial
                    menu so there's no risk of them rendering on top of
                    each other in the bottom-left corner. */}
                <SquallLegend visible={squallVisible} />

                {/* ═══ AIS COLOUR LEGEND + GUARD ZONE TOGGLE ═══ */}
                <Suspense fallback={null}>
                    {!passage.showPassage && !embedded && !isPinView && <AisLegend visible={aisVisible} />}
                    {isCmemsCurrentsEnabled() && (
                        <React.Suspense fallback={null}>
                            <CmemsAttribution visible={currentsVisible} />
                        </React.Suspense>
                    )}

                    {/* ═══ VESSEL SEARCH BUTTON ═══ */}
                    {!passage.showPassage && !embedded && !isPinView && aisVisible && (
                        <button
                            onClick={() => {
                                setShowVesselSearch(true);
                                triggerHaptic('light');
                            }}
                            className="absolute z-[500] top-[56px] right-[128px] w-12 h-12 rounded-2xl bg-slate-900/90 border border-white/[0.08] flex items-center justify-center shadow-2xl hover:bg-slate-800/90 transition-all active:scale-95 text-slate-400"
                            aria-label="Search vessels"
                        >
                            🔍
                        </button>
                    )}

                    {/* ═══ VESSEL SEARCH OVERLAY ═══ */}
                    <Suspense fallback={null}>
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

                                log.info(
                                    `Vessel search: flying to ${name} (${mmsi}) at ${lat.toFixed(4)}, ${lon.toFixed(4)}`,
                                );
                            }}
                        />
                    </Suspense>

                    {/* ═══ AIS GUARD ZONE ALERT TOAST ═══ */}
                    <AisGuardAlert />
                </Suspense>

                {/* ═══ OFFLINE AREA DOWNLOAD — FAB + MODAL ═══
                    Below the ℹ button on the right rail. Opens a modal that
                    pre-caches raster map tiles (OSM + OpenSeaMap) for the
                    current view, routed through the boat Pi if available. */}
                {!embedded && !isPinView && !passage.showPassage && (
                    <>
                        <button
                            onClick={() => {
                                triggerHaptic('light');
                                setShowOfflineArea(true);
                            }}
                            className="absolute z-[500] top-[184px] right-[16px] w-12 h-12 rounded-2xl bg-slate-900/90 border border-white/[0.08] flex items-center justify-center shadow-2xl hover:bg-slate-800/90 transition-all active:scale-95"
                            aria-label="Download offline map area"
                            title="Download offline area"
                        >
                            <svg
                                className="w-5 h-5 text-sky-400"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={1.8}
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M12 3v12m0 0l-4-4m4 4l4-4M4.5 17.25V19.5A1.5 1.5 0 006 21h12a1.5 1.5 0 001.5-1.5v-2.25"
                                />
                            </svg>
                        </button>
                        <Suspense fallback={null}>
                            <OfflineAreaModal
                                isOpen={showOfflineArea}
                                onClose={() => setShowOfflineArea(false)}
                                map={mapRef.current}
                            />
                        </Suspense>
                    </>
                )}

                {/* ═══ OFFLINE — NO CACHED TILES CARD ═══
                    Shown when the device is offline. Explains why the map
                    might look blank and offers a one-tap route into the
                    offline-area download modal (useful if the boat Pi has
                    internet even when the phone doesn't). */}
                {!isOnline && !offlineCardDismissed && !embedded && !isPinView && !passage.showPassage && (
                    <div className="absolute z-[550] left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(320px,calc(100vw-32px))] p-4 rounded-2xl bg-slate-900/95 backdrop-blur-xl border border-white/[0.08] shadow-2xl pointer-events-auto">
                        <div className="flex items-start gap-3">
                            <span className="text-xl leading-none">{'\u{1F6F0}\uFE0F'}</span>
                            <div className="flex-1">
                                <p className="text-sm font-bold text-white">Offline</p>
                                <p className="text-[11px] text-gray-400 leading-relaxed mt-1">
                                    The base map may not fully render — tiles can only load when there was internet
                                    before, or when a boat Pi has them cached. Your downloaded{' '}
                                    <span className="text-emerald-400 font-bold">.mbtiles</span> charts and GPS work
                                    fully offline.
                                </p>
                            </div>
                            <button
                                onClick={() => setOfflineCardDismissed(true)}
                                aria-label="Dismiss offline notice"
                                className="shrink-0 w-6 h-6 rounded-full text-gray-500 hover:text-gray-300 hover:bg-white/[0.06] flex items-center justify-center transition-colors"
                            >
                                <svg
                                    className="w-4 h-4"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={2}
                                >
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        </div>
                        <button
                            onClick={() => {
                                setOfflineCardDismissed(true);
                                setShowOfflineArea(true);
                            }}
                            className="mt-3 w-full py-2 rounded-xl text-[11px] font-black uppercase tracking-widest bg-sky-500/15 border border-sky-500/30 text-sky-400 hover:bg-sky-500/25 transition-all active:scale-95"
                        >
                            Download This Area
                        </button>
                    </div>
                )}

                {/* ═══ ROUTE LEGEND (during passage mode) ═══ */}
                <Suspense fallback={null}>
                    <RouteLegend
                        visible={passage.showPassage && !!passage.routeAnalysis && !isPinView}
                        embedded={embedded}
                    />
                </Suspense>

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
                            // Exit full-screen overlay layers so user returns to base map
                            if (squallVisible) setSquallVisible(false);
                            if (cycloneVisible) setCycloneVisible(false);
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
                        const WEATHER_KEYS: HelixLayer[] = [
                            'pressure',
                            'wind',
                            'rain',
                            'temperature',
                            'clouds',
                            // Currents + waves + SST + chl only get the scrubber when
                            // their CMEMS pipeline is on. Under Xweather raster the
                            // tiles are just static heatmaps.
                            ...(isCmemsCurrentsEnabled() ? (['currents'] as HelixLayer[]) : []),
                            ...(isCmemsWavesEnabled() ? (['waves'] as HelixLayer[]) : []),
                            ...(isCmemsSstEnabled() ? (['sst'] as HelixLayer[]) : []),
                            ...(isCmemsChlEnabled() ? (['chl'] as HelixLayer[]) : []),
                            ...(isCmemsSeaIceEnabled() ? (['seaice'] as HelixLayer[]) : []),
                            ...(isCmemsMldEnabled() ? (['mld'] as HelixLayer[]) : []),
                        ];
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
                            const nowIdx = weather.pressureNowIdx;
                            nowIndex = nowIdx; // feed the scrubber's Now-marker
                            // Label is RELATIVE to Now, not to cycle hour. If
                            // the GFS cycle is 4h old and we're on sub-frame 4
                            // (= wall-clock now), we want "Now", not "+4h".
                            // If we're on sub-frame 8 (= 4h in the future),
                            // we want "+4h". Matches the wind scrubber.
                            const forecastHrs = maxF > 0 ? ((frameIndex - nowIdx) / maxF) * 12 : 0;
                            if (frameIndex === nowIdx) {
                                frameLabel = 'Now';
                                sublabel = 'Current';
                            } else if (forecastHrs > 0) {
                                frameLabel = `+${forecastHrs % 1 === 0 ? forecastHrs : forecastHrs.toFixed(1)}h`;
                                sublabel = 'Forecast';
                            } else {
                                frameLabel = `${forecastHrs % 1 === 0 ? forecastHrs : forecastHrs.toFixed(1)}h`;
                                sublabel = 'Past';
                            }
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
                        } else if (activeLayerKey === 'currents' && isCmemsCurrentsEnabled()) {
                            frameIndex = weather.currentsHour;
                            totalFrames = weather.currentsTotalHours;
                            // Label is RELATIVE to Now. nowIdx is whatever
                            // step aligns with wall-clock now given how old
                            // the CMEMS manifest is. frame === nowIdx → Now.
                            const nowIdx = weather.currentsNowIdx;
                            nowIndex = nowIdx;
                            const relH = Math.round(frameIndex) - nowIdx;
                            if (relH === 0) {
                                frameLabel = 'Now';
                                sublabel = 'Nowcast';
                            } else {
                                frameLabel = relH > 0 ? `+${relH}h` : `${relH}h`;
                                sublabel = relH > 0 ? 'Forecast' : 'Past';
                            }
                            isPlaying = weather.currentsPlaying;
                            onScrub = (h: number) => weather.setCurrentsHour(Math.round(h));
                            onPlayToggle = () => weather.setCurrentsPlaying(!weather.currentsPlaying);
                            onScrubStart = () => weather.setCurrentsPlaying(false);
                        } else if (activeLayerKey === 'waves' && isCmemsWavesEnabled()) {
                            frameIndex = weather.wavesHour;
                            totalFrames = weather.wavesTotalHours;
                            // Waves are 3-hourly — each step = +3h of forecast.
                            const nowIdx = weather.wavesNowIdx;
                            nowIndex = nowIdx;
                            const relH = (Math.round(frameIndex) - nowIdx) * 3;
                            if (relH === 0) {
                                frameLabel = 'Now';
                                sublabel = 'Nowcast';
                            } else {
                                frameLabel = relH > 0 ? `+${relH}h` : `${relH}h`;
                                sublabel = relH > 0 ? 'Forecast' : 'Past';
                            }
                            isPlaying = weather.wavesPlaying;
                            onScrub = (h: number) => weather.setWavesHour(Math.round(h));
                            onPlayToggle = () => weather.setWavesPlaying(!weather.wavesPlaying);
                            onScrubStart = () => weather.setWavesPlaying(false);
                        } else if (activeLayerKey === 'sst' && isCmemsSstEnabled()) {
                            frameIndex = weather.sstStep;
                            totalFrames = weather.sstTotalSteps;
                            // SST is daily — each step = +1 day of forecast.
                            const nowIdx = weather.sstNowIdx;
                            nowIndex = nowIdx;
                            const relD = Math.round(frameIndex) - nowIdx;
                            if (relD === 0) {
                                frameLabel = 'Today';
                                sublabel = 'Daily mean';
                            } else {
                                frameLabel = relD > 0 ? `+${relD}d` : `${relD}d`;
                                sublabel = relD > 0 ? 'Forecast' : 'Past';
                            }
                            isPlaying = weather.sstPlaying;
                            onScrub = (h: number) => weather.setSstStep(Math.round(h));
                            onPlayToggle = () => weather.setSstPlaying(!weather.sstPlaying);
                            onScrubStart = () => weather.setSstPlaying(false);
                        } else if (activeLayerKey === 'chl' && isCmemsChlEnabled()) {
                            frameIndex = weather.chlStep;
                            totalFrames = weather.chlTotalSteps;
                            const nowIdx = weather.chlNowIdx;
                            nowIndex = nowIdx;
                            const relD = Math.round(frameIndex) - nowIdx;
                            if (relD === 0) {
                                frameLabel = 'Today';
                                sublabel = 'Daily mean';
                            } else {
                                frameLabel = relD > 0 ? `+${relD}d` : `${relD}d`;
                                sublabel = relD > 0 ? 'Forecast' : 'Past';
                            }
                            isPlaying = weather.chlPlaying;
                            onScrub = (h: number) => weather.setChlStep(Math.round(h));
                            onPlayToggle = () => weather.setChlPlaying(!weather.chlPlaying);
                            onScrubStart = () => weather.setChlPlaying(false);
                        } else if (activeLayerKey === 'seaice' && isCmemsSeaIceEnabled()) {
                            frameIndex = weather.seaiceStep;
                            totalFrames = weather.seaiceTotalSteps;
                            const nowIdx = weather.seaiceNowIdx;
                            nowIndex = nowIdx;
                            const relD = Math.round(frameIndex) - nowIdx;
                            if (relD === 0) {
                                frameLabel = 'Today';
                                sublabel = 'Daily mean';
                            } else {
                                frameLabel = relD > 0 ? `+${relD}d` : `${relD}d`;
                                sublabel = relD > 0 ? 'Forecast' : 'Past';
                            }
                            isPlaying = weather.seaicePlaying;
                            onScrub = (h: number) => weather.setSeaiceStep(Math.round(h));
                            onPlayToggle = () => weather.setSeaicePlaying(!weather.seaicePlaying);
                            onScrubStart = () => weather.setSeaicePlaying(false);
                        } else if (activeLayerKey === 'mld' && isCmemsMldEnabled()) {
                            frameIndex = weather.mldStep;
                            totalFrames = weather.mldTotalSteps;
                            const nowIdx = weather.mldNowIdx;
                            nowIndex = nowIdx;
                            const relD = Math.round(frameIndex) - nowIdx;
                            if (relD === 0) {
                                frameLabel = 'Today';
                                sublabel = 'Daily mean';
                            } else {
                                frameLabel = relD > 0 ? `+${relD}d` : `${relD}d`;
                                sublabel = relD > 0 ? 'Forecast' : 'Past';
                            }
                            isPlaying = weather.mldPlaying;
                            onScrub = (h: number) => weather.setMldStep(Math.round(h));
                            onPlayToggle = () => weather.setMldPlaying(!weather.mldPlaying);
                            onScrubStart = () => weather.setMldPlaying(false);
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
            <Suspense fallback={null}>
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
            </Suspense>

            {/* ═══ STORM PICKER — opens when user taps Storms with multiple cyclones ═══ */}
            <StormPicker
                visible={stormPickerOpen}
                cyclones={allCyclones}
                userLat={location.lat}
                userLon={location.lon}
                selectedStormName={closestStorm?.name ?? null}
                onSelect={handleSelectStorm}
                onClose={() => setStormPickerOpen(false)}
                onClearStorms={() => {
                    setCycloneVisible(false);
                    setClosestStorm(null);
                }}
            />
        </div>
    );
};
