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
import { CompassIcon, SearchIcon } from '../Icons';
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
import { RouteEnhancementChip } from '../passage/RouteEnhancementChip';
import { GpsService } from '../../services/GpsService';
import { piCache } from '../../services/PiCacheService';
import { MapOfflineService } from '../../services/MapOfflineService';
import { getConnectionState, onConnectionChange } from '../../services/ConnectionPriorityService';

import { type MapHubProps, type WeatherLayer, SEA_STATE_LAYERS, ATMOSPHERE_LAYERS } from './mapConstants';
import { useMapInit, useLocationDot, usePickerMode } from './useMapInit';
import { useWeatherLayers, useEmbeddedRain } from './useWeatherLayers';
import { usePassagePlanner } from './usePassagePlanner';
// useRouteNudge removed 2026-05-05 — long-press-to-drag the route line was
// half-implemented (the dispatched 'route-nudge' just set arrival to the
// via-point, dropping the actual destination) and unreliable in practice.
// Manual route editing happens through the route planner instead.
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
import { useEncCoverageLayer } from './useEncCoverageLayer';
import { useEncVectorLayer } from './useEncVectorLayer';
import { useEncTestRouteLayer, type EncTestRoute } from './useEncTestRouteLayer';
import { useSeawayDebugLayer } from './useSeawayDebugLayer';
import { tryInshoreRoute } from '../../services/InshoreRouter';
import { listCells as listEncCells } from '../../services/enc/EncCellMetadata';
import { subscribe as subscribeToEnc } from '../../services/enc/EncHazardService';
import { bootstrapEncSamplesIfNeeded } from '../../services/enc/bootstrapEncSamples';
import { startAutoSyncPolling } from '../../services/enc/autoSyncFromPi';
import { consumeMapFit, peekMapFit, subscribeMapFit } from '../../stores/MapFitTargetStore';
import { AvNavService, type AvNavChart } from '../../services/AvNavService';
import type { ActiveCyclone } from '../../services/weather/CycloneTrackingService';
import { useFollowRouteMapbox } from '../../hooks/useFollowRouteMapbox';
import { useDestinationFlag } from './useDestinationFlag';
import { useRouteTrackLayer } from './useRouteTrackLayer';
import { RouteTrackPicker } from './RouteTrackPicker';
import type { RouteOrTrack } from '../../services/shiplog/RoutesAndTracks';
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
import { EncAttributionChip } from './EncAttributionChip';
import { HazardReportPanel } from '../passage/HazardReportPanel';
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
    // Current map zoom level — surfaced in a small FAB top-left so
    // the skipper has at-a-glance idea of detail vs overview. Mirror
    // position of the mic FAB in App.tsx (top: 56px, right: 16px).
    const [zoomLevel, setZoomLevel] = useState<number | null>(null);
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
    const { weatherData, saveVoyagePlan } = useWeather();
    const weatherCoords = weatherData?.coordinates;
    const [mapReady, setMapReady] = useState(false);
    const deviceMode = useDeviceMode();
    // Map state persisted across Charts tab switches so the user comes
    // back to exactly what they left on. Time-critical overlays that
    // are meant to be session-only (cyclone / squall / weather inspect)
    // deliberately stay as plain useState.
    const [aisVisible, setAisVisible] = usePersistedState('thalassa_map_ais_visible', false);
    // ENC vector chart visibility — separate from cell *presence*. When the user
    // has imported cells we still let them toggle the chart off (e.g. to compare
    // with raster charts underneath). Default true so first import is visible.
    const [encVisible, setEncVisible] = usePersistedState('thalassa_map_enc_visible', true);
    // Chart-detail toggle. Default OFF = land + markers + hazards only (the
    // "clean chart" user asked for 2026-05-17). When ON, depth-fills + coastlines
    // come back. Independent of `encVisible` — the master switch wins.
    const [encChartDetail, setEncChartDetail] = usePersistedState('thalassa_map_enc_chart_detail', false);
    // Live cell-count so the layer FAB shows the right "N cells imported" caption
    // and surfaces the toggle the moment the first cell lands.
    const [encCellCount, setEncCellCount] = useState(() => listEncCells().length);
    useEffect(() => {
        const refresh = () => {
            const cells = listEncCells();
            // Diagnostic — log every time the FAB-input value changes so we
            // can see whether MapHub agrees with the bootstrap about state.
            // Safe to demote to log.info once the ENC toggle is known-good.

            console.warn(
                `[MapHub] encCellCount = ${cells.length}` +
                    (cells.length > 0 ? ` (${cells.map((c) => c.id).join(', ')})` : ''),
            );
            setEncCellCount(cells.length);
        };
        refresh();
        return subscribeToEnc(refresh);
    }, []);
    // One-shot import of any bundled sample cells the dev server is serving.
    // No-op once the localStorage flag is set or when real cells already exist.
    useEffect(() => {
        void bootstrapEncSamplesIfNeeded();
        // After the bundled NOAA demo lands, also check if the user's Bosun
        // Pi is reachable on local wifi and silently pull any AU/NZ/EU cells
        // they've decrypted there. Polling — runs immediately + every 10 min
        // while foregrounded so a user who buys a chart at the marina cafe
        // walks back to the boat and the cells flow in within a poll cycle.
        // Throttled to never hit the Pi more than once per 5 min.
        startAutoSyncPolling();
    }, []);
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
    // Seaway Graph debug overlay (masterplan Stage IV Phase 10) — gates/
    // edges compiled from installed ENC cells. Per-device flag, never
    // cloud-synced (it's dev tooling, not a user setting).
    const [seawayDebugVisible, setSeawayDebugVisible] = usePersistedState('thalassa_map_seaway_debug_visible', false);
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
    /** Currently-displayed planned route on the chart. Null when none.
     *  Independent from the active follow-route — these come from saved
     *  ship-log entries, not the live voyage system. */
    const [activeChartRoute, setActiveChartRoute] = useState<RouteOrTrack | null>(null);
    /** Currently-displayed recorded track on the chart. Null when none. */
    const [activeChartTrack, setActiveChartTrack] = useState<RouteOrTrack | null>(null);
    const [routePickerOpen, setRoutePickerOpen] = useState(false);
    const [trackPickerOpen, setTrackPickerOpen] = useState(false);

    /** Active Voyage Mode flag — mirrored from the voyages cache. When
     *  true, the chart auto-displays the boat's GPS position, the live
     *  voyage track, and the planned route, regardless of which weather
     *  layer is on. Listens for `thalassa:active-voyage-changed` so the
     *  flag flips the moment Cast Off / End Voyage runs. */
    const [activeVoyageMode, setActiveVoyageMode] = useState<boolean>(() => {
        try {
            const raw = localStorage.getItem('thalassa_active_voyage');
            if (!raw) return false;
            const parsed = JSON.parse(raw);
            return parsed?.status === 'active';
        } catch {
            return false;
        }
    });
    const [activeVoyageId, setActiveVoyageId] = useState<string | null>(() => {
        try {
            const raw = localStorage.getItem('thalassa_active_voyage');
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            return parsed?.status === 'active' ? (parsed.id as string) : null;
        } catch {
            return null;
        }
    });
    const [activeVoyageName, setActiveVoyageName] = useState<string | null>(() => {
        try {
            const raw = localStorage.getItem('thalassa_active_voyage');
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            return parsed?.status === 'active' ? (parsed.voyage_name as string) : null;
        } catch {
            return null;
        }
    });
    useEffect(() => {
        const sync = () => {
            try {
                const raw = localStorage.getItem('thalassa_active_voyage');
                const v = raw ? JSON.parse(raw) : null;
                const isActive = v?.status === 'active';
                setActiveVoyageMode(isActive);
                setActiveVoyageId(isActive ? (v.id as string) : null);
                setActiveVoyageName(isActive ? (v.voyage_name as string) : null);
            } catch {
                setActiveVoyageMode(false);
                setActiveVoyageId(null);
                setActiveVoyageName(null);
            }
        };
        window.addEventListener('thalassa:active-voyage-changed', sync);
        return () => window.removeEventListener('thalassa:active-voyage-changed', sync);
    }, []);

    /** Vessel position + trail are FORCED visible during Active Voyage
     *  Mode, regardless of the user's persisted toggle. The user can
     *  still toggle off in normal mode; toggling off mid-voyage is a
     *  no-op for the actual rendering (the underlying preference is
     *  preserved for when the voyage ends). */
    const effectiveVesselTrackingVisible = vesselTrackingVisible || activeVoyageMode;

    /** Auto-select the active voyage's planned route + sailed track on
     *  the chart so the skipper sees "I am here, I came from there, I'm
     *  heading there" from one glance — no manual route/track picking
     *  required while underway. Match planned route by normalised name
     *  (matches the same scheme CrewManagement uses); match track by
     *  voyage.id (ShipLogService.startTracking seeds entries.voyageId
     *  with the voyages-table UUID at Cast Off time). */
    useEffect(() => {
        if (!activeVoyageMode || !activeVoyageId) return;
        let cancelled = false;
        const sync = async () => {
            try {
                const { fetchRoutesAndTracks } = await import('../../services/shiplog/RoutesAndTracks');
                // Force-refresh — newly logged GPS points need to flow into
                // the rendered track without waiting on the 60s cache.
                const { routes, tracks } = await fetchRoutesAndTracks(true);
                if (cancelled) return;

                const norm = (s: string) => s.trim().toLowerCase();
                if (activeVoyageName) {
                    const wantLabel = norm(activeVoyageName);
                    const matchedRoute = routes.find((r) => norm(r.label) === wantLabel) ?? null;
                    if (matchedRoute) {
                        setActiveChartRoute((cur) => (cur?.id === matchedRoute.id ? cur : matchedRoute));
                    }
                }

                const matchedTrack = tracks.find((t) => t.id === activeVoyageId) ?? null;
                if (matchedTrack) {
                    setActiveChartTrack((cur) => (cur?.id === matchedTrack.id ? cur : matchedTrack));
                }
            } catch (e) {
                log.warn('Active voyage auto-select failed:', e);
            }
        };
        sync();

        const onRefresh = () => sync();
        window.addEventListener('thalassa:routes-and-tracks-changed', onRefresh);
        // Periodic refresh while underway so the trail extends as new GPS
        // points come in. 60s matches the RoutesAndTracks cache TTL — any
        // shorter and we'd just hit the cache anyway.
        const t = setInterval(sync, 60_000);
        return () => {
            cancelled = true;
            window.removeEventListener('thalassa:routes-and-tracks-changed', onRefresh);
            clearInterval(t);
        };
    }, [activeVoyageMode, activeVoyageId, activeVoyageName]);

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

    // Routes (planned) and Tracks (sailed) chart layers. Both come
    // from the user's ship-log entries — Routes are voyageIds prefixed
    // `planned_*`, Tracks are everything else. Each is its own layer
    // so the user can have one of each visible simultaneously, with
    // distinct colours so they read clearly when overlapped.
    useRouteTrackLayer({
        mapRef,
        mapReady: mapReady && !passage.showPassage,
        variant: 'route',
        selected: activeChartRoute,
    });
    useRouteTrackLayer({
        mapRef,
        mapReady: mapReady && !passage.showPassage,
        variant: 'track',
        selected: activeChartTrack,
    });

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

    // Live zoom-level subscription — drives the top-left zoom FAB.
    // Mapbox fires 'zoom' continuously during pinch / wheel; we
    // throttle to next animation frame so we update at display rate,
    // not 60+ times per second. Falls back to zoomend in case the
    // continuous events get coalesced on slower devices.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;
        setZoomLevel(map.getZoom());
        let frameQueued = false;
        const onZoom = () => {
            if (frameQueued) return;
            frameQueued = true;
            requestAnimationFrame(() => {
                frameQueued = false;
                if (mapRef.current) setZoomLevel(mapRef.current.getZoom());
            });
        };
        map.on('zoom', onZoom);
        map.on('zoomend', onZoom);
        return () => {
            map.off('zoom', onZoom);
            map.off('zoomend', onZoom);
        };
    }, [mapReady]);

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
    useLocationDot(mapRef, locationDotRef, mapReady && !effectiveVesselTrackingVisible);

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
    // When the boat has a Pi on the network AND the user has a strong
    // internet connection, silently download a 1000 NM tiered shell of
    // raster tiles around the user so the map keeps working the moment
    // they drop offline. Tier breakdown lives in MapOfflineService:
    //   1000 NM @ z4-7   (ocean-wide)
    //   500 NM  @ z8-9   (regional)
    //   150 NM  @ z10-11 (coastal approach)
    //   40 NM   @ z12-13 (harbour detail)
    //
    // Conditions for firing:
    //   - Pi is reachable (piCache.isAvailable())
    //   - Connection quality is 'high' (WiFi / good 4G — NOT cellular
    //     2G/3G, NOT satellite, NOT save-data mode). User explicitly
    //     asked for "only if they have a strong connection".
    //   - User has a valid weatherCoords
    //   - User has moved > 100 NM since the last auto-cache (tracked
    //     in localStorage by MapOfflineService)
    //   - Pi's SQLite cache isn't already gigantic (>10 GB)
    //
    // Re-evaluates on three triggers — Pi appearing, connection
    // improving to 'high', or location changing — so a phone that
    // started on weak cellular and later joined a marina WiFi will
    // pick up the cache automatically without the user having to do
    // anything. No prompts, no confirmations.
    const autoCacheRanRef = useRef(false);
    useEffect(() => {
        if (embedded || pickerMode || isPinView) return;
        if (!weatherCoords) return;
        if (autoCacheRanRef.current) return;

        let cancelled = false;
        const ctrl = new AbortController();
        const tryRun = async () => {
            if (!piCache.isAvailable()) return; // wait for Pi
            // Connection-quality gate — only auto-cache when the user
            // actually has the bandwidth to spare. Strong = WiFi or
            // 4G+ with > 0.5 Mbps downlink + saveData off. Weak = 2G,
            // 3G with low downlink, satellite, or saveData enabled.
            const conn = getConnectionState();
            if (conn.quality !== 'high') {
                log.info(
                    `Auto-cache: skipping — connection quality '${conn.quality}' (type=${conn.type}, downlink=${conn.effectiveDownlink}). Will retry when it improves.`,
                );
                return;
            }
            autoCacheRanRef.current = true;
            const outcome = await MapOfflineService.autoDownloadAroundUser({
                centerLat: weatherCoords.lat,
                centerLon: weatherCoords.lon,
                signal: ctrl.signal,
                // Toast progress callback removed — Shane found the
                // "Auto-caching 1000 NM…" + "Pi cached N tiles…"
                // toasts unannounced/distracting on the Charts page.
                // The cache fills silently in the background; if the
                // user wants to verify, the Pi cache status badge in
                // settings shows tile counts.
                onProgress: () => {},
            });
            if (cancelled) return;
            if (outcome.status === 'error') {
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

        // Run once now, then subscribe so we fire the moment EITHER
        //   (a) the Pi is found, or
        //   (b) the connection upgrades to high quality
        // — whichever was the missing condition the first time.
        tryRun();
        const unsubPi = piCache.onStatusChange(() => {
            if (!autoCacheRanRef.current && piCache.isAvailable()) tryRun();
        });
        const unsubConn = onConnectionChange((state) => {
            if (!autoCacheRanRef.current && state.quality === 'high' && piCache.isAvailable()) {
                log.info(`Auto-cache: connection upgraded to high (${state.type}) — kicking off`);
                tryRun();
            }
        });

        return () => {
            cancelled = true;
            ctrl.abort();
            unsubPi();
            unsubConn();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [weatherCoords?.lat, weatherCoords?.lon, embedded, pickerMode, isPinView]);

    // ── GPS Vessel Tracker Layer ──
    const { flyToVessel } = useVesselTracker(mapRef, mapReady, effectiveVesselTrackingVisible);

    // ── Picker Mode ──
    usePickerMode(mapRef, pinMarkerRef, pickerMode, onLocationSelect);

    // Route Nudge removed — see import note above.

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

    // ── ENC Chart Coverage (dashed bbox overview) ──
    // Auto-mounts whenever the user has imported S-57 ENC cells.
    // Dashed-outline overlay showing which areas are ENC-covered;
    // most useful at low zooms (zoom <8) where the vector layer
    // is hidden. Colour-coded by CATZOC confidence.
    useEncCoverageLayer(mapRef, mapReady);

    // ── ENC Vector Chart Display ──
    // The real chart — surveyed depth contours (DEPARE),
    // coastlines (COALNE), tan land (LNDARE), and magenta
    // obstruction/wreck/rock symbols. Depth-graduated blues so
    // the user can read shoals at a glance. Mounts at zoom 7+
    // (lower zooms get the dashed coverage overlay above).
    useEncVectorLayer(mapRef, mapReady, encVisible, encChartDetail);

    // ── ENC test route line ──
    // One-off rendering of `tryInshoreRoute` output triggered by the
    // EncRouteButton chip. Independent of the passage-planner pipeline so
    // we can demo on-chart routing without the planner UI in scope.
    const [encTestRoute, setEncTestRoute] = useState<EncTestRoute | null>(null);
    useEncTestRouteLayer(mapRef, mapReady, encTestRoute);

    // Seaway Graph debug overlay — compiles gates/edges from the installed
    // cells for the viewport whenever the toggle is on (Phase 10).
    useSeawayDebugLayer(mapRef, mapReady, seawayDebugVisible);

    // ── Pending fit-to-bbox request ──
    // Used by EncCellManager (and any future "show me on the map"
    // entry point) to fit the viewport to a bbox after navigating
    // to the map. We consume on mount (if a request was staged
    // before navigation) and on subscription bumps (if one comes
    // in while the map is already mounted).
    useEffect(() => {
        if (!mapReady) return;
        const apply = () => {
            const map = mapRef.current;
            if (!map) return;
            const target = consumeMapFit();
            if (!target) return;
            const [minLon, minLat, maxLon, maxLat] = target.bbox;
            try {
                map.fitBounds(
                    [
                        [minLon, minLat],
                        [maxLon, maxLat],
                    ],
                    {
                        padding: target.paddingPx ?? 60,
                        maxZoom: target.maxZoom ?? 11,
                        duration: 1200,
                        essential: true,
                    },
                );
            } catch (err) {
                // Mapbox throws on degenerate bboxes (single point).
                // Fall back to a simple flyTo at the centre.
                map.flyTo({
                    center: [(minLon + maxLon) / 2, (minLat + maxLat) / 2],
                    zoom: target.maxZoom ?? 11,
                    essential: true,
                });
            }
        };
        // Apply any request staged before mount.
        if (peekMapFit()) apply();
        // Apply any future requests dispatched while we're mounted.
        return subscribeMapFit(apply);
    }, [mapReady]);

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

    // ── Pin View: temporarily clear weather overlays for a clean map ──
    // Shane: "when the punter does click the pin, we need to ensure
    // there are no other layers showing. at the moment, all the layers
    // that where on stay there." Solution: snapshot the user's active
    // weather layers + cyclone/squall toggles when entering pin view,
    // turn them off, restore on exit. The user's chart-catalog
    // selection (their chosen vector charts) stays — that's
    // legitimate context for navigating to a pin.
    const savedLayersRef = useRef<{
        weather: Set<WeatherLayer> | null;
        cyclone: boolean;
        squall: boolean;
    } | null>(null);
    useEffect(() => {
        if (!isPinView) return;
        // Snapshot
        savedLayersRef.current = {
            weather: new Set(weather.activeLayers),
            cyclone: cycloneVisible,
            squall: squallVisible,
        };
        // Clear
        weather.setActiveLayer('none');
        setCycloneVisible(false);
        setSquallVisible(false);
        return () => {
            // Restore on exit
            const saved = savedLayersRef.current;
            if (!saved) return;
            // Restore weather layers one by one (toggleLayer preserves
            // cross-group selections, which is how the user had them).
            saved.weather?.forEach((layer) => {
                if (!weather.activeLayers.has(layer)) weather.toggleLayer(layer);
            });
            setCycloneVisible(saved.cyclone);
            setSquallVisible(saved.squall);
            savedLayersRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isPinView]);

    // ── Pin View: Get Directions handler ──
    // Builds a Mapbox driving route from current GPS to the pin and
    // saves it as a VoyagePlan. Exits pin view on success so the
    // user's normal layers come back along with the route, ready to
    // navigate.
    const [pinDirectionsBusy, setPinDirectionsBusy] = useState(false);
    const [pinDirectionsError, setPinDirectionsError] = useState<string | null>(null);
    const handlePinDirections = useCallback(async () => {
        const pv = window.__thalassaPinView as { lat: number; lng: number } | undefined;
        if (!pv || pinDirectionsBusy) return;
        setPinDirectionsBusy(true);
        setPinDirectionsError(null);
        try {
            const { GpsService } = await import('../../services/GpsService');
            const pos = await GpsService.getCurrentPosition({ staleLimitMs: 30_000, timeoutSec: 10 });
            if (!pos) {
                setPinDirectionsError('Could not get your GPS position.');
                return;
            }
            const { buildDirectionsVoyagePlan } = await import('../../services/MapboxDirectionsService');
            const plan = await buildDirectionsVoyagePlan(
                { lat: pos.latitude, lon: pos.longitude, name: 'My Location' },
                { lat: pv.lat, lon: pv.lng, name: 'Pin' },
                'driving',
            );
            if (!plan) {
                setPinDirectionsError('No driving route found.');
                return;
            }
            saveVoyagePlan(plan);
            // Exit pin view so layers/route are visible normally.
            delete window.__thalassaPinView;
            setIsPinView(false);
        } catch (e) {
            setPinDirectionsError(e instanceof Error ? e.message : 'Directions failed.');
        } finally {
            setPinDirectionsBusy(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pinDirectionsBusy]);

    // Determine if tablet split-screen is active
    const isHelmSplit = deviceMode === 'helm' && passage.showPassage && !embedded;

    return (
        <div className={`w-full h-full ${isHelmSplit ? 'flex' : 'relative'}`}>
            {/* Floating route-enhancement chip — visible while the */}
            {/* passage planner's bathymetric/weather/depth pipeline runs */}
            {/* in the background after the basic plan lands. */}
            <RouteEnhancementChip />
            {/* Map container — 70% on tablet during passage, full otherwise */}
            <div className={`relative ${isHelmSplit ? 'flex-[7] h-full' : 'w-full h-full'}`}>
                <div ref={containerRef} className="w-full h-full" />

                {/* Pin bounce + location pulse animations moved to index.css */}

                {/* PIN VIEW BACK BUTTON removed — there's already a
                    middle-left back chevron in the global chrome, no
                    need for a second one in the top-left slot fighting
                    the zoom pill. Exit paths now: tap the existing
                    middle-left chevron, tap Get Directions (which
                    auto-exits on success), or use the bottom nav to
                    leave Charts. Shane: "there is already a chevron
                    middle left claude." */}

                {/* ═══ PIN VIEW · GET DIRECTIONS CTA ═══
                    Bottom-anchored emerald button so the punter can
                    immediately ask "how do I get there?" after a pin
                    tap from Scuttlebutt. Sits above the bottom nav
                    (88px reserve) with safe-area padding so it never
                    lands behind the tab bar — the earlier complaint
                    that drove the PinMapViewer portal fix (since
                    discovered to be dead code). z-[700] matches the
                    back-button stacking, well above the map but below
                    full-screen modals. */}
                {isPinView && (
                    <div className="absolute left-4 right-4 bottom-[calc(env(safe-area-inset-bottom)+88px)] z-[700] space-y-2 pointer-events-none">
                        {pinDirectionsError && (
                            <div className="rounded-xl border border-red-500/30 bg-red-500/90 backdrop-blur-md px-3 py-2 text-xs text-white shadow-lg pointer-events-auto">
                                {pinDirectionsError}
                            </div>
                        )}
                        <button
                            onClick={() => void handlePinDirections()}
                            disabled={pinDirectionsBusy}
                            aria-label="Get driving directions to pin"
                            className="pointer-events-auto w-full h-12 rounded-xl bg-emerald-500 hover:bg-emerald-400 active:scale-[0.98] transition-all text-white font-bold flex items-center justify-center gap-2 disabled:opacity-50 shadow-2xl"
                        >
                            {pinDirectionsBusy ? (
                                <>
                                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                    <span>Routing…</span>
                                </>
                            ) : (
                                <>
                                    <CompassIcon className="w-5 h-5" rotation={0} />
                                    <span>Get Directions</span>
                                </>
                            )}
                        </button>
                    </div>
                )}

                {/* ═══ ZOOM-LEVEL FAB ═══
                    Top-left pill showing current map zoom. Mirrors the
                    Bosun mic FAB top-right position (top:56px right:16px
                    in App.tsx). Visible in pin-view too — the back
                    chevron now sits at middle-left so the top-left slot
                    is free. Mapbox zoom is a float 0-22; we show one
                    decimal so wheel/pinch increments are visible. */}
                {zoomLevel !== null && (
                    <div
                        className="absolute top-[56px] left-4 z-[700] h-11 px-2.5 min-w-[3rem] rounded-full bg-slate-900/85 border border-white/[0.10] flex items-center justify-center backdrop-blur-md shadow-lg pointer-events-none select-none"
                        aria-label={`Map zoom level ${zoomLevel.toFixed(1)}`}
                        title="Map zoom level"
                    >
                        <span className="text-[10px] font-bold text-sky-400/70 uppercase tracking-wider mr-1">Z</span>
                        <span className="text-sm font-mono font-bold text-white tabular-nums">
                            {zoomLevel.toFixed(1)}
                        </span>
                    </div>
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
                            // catalog + local MBTiles + Routes + Tracks so all chart
                            // toggles live in the radial menu's 4th category.
                            sources: [
                                // Routes — picker for saved planned passages from
                                // the ships log. Tap opens a sheet listing them;
                                // selection draws the route as a green dashed line
                                // and fits the map to its bounds.
                                {
                                    id: 'routes',
                                    label: 'Routes',
                                    iconKind: 'generic' as const,
                                    enabled: activeChartRoute !== null,
                                    onToggle: () => setRoutePickerOpen((v) => !v),
                                },
                                // Tracks — picker for actually-sailed passages.
                                // Same UX as Routes; renders amber solid line so
                                // the two can be visible together without confusing
                                // which is the plan vs the reality.
                                {
                                    id: 'tracks',
                                    label: 'Tracks',
                                    iconKind: 'generic' as const,
                                    enabled: activeChartTrack !== null,
                                    onToggle: () => setTrackPickerOpen((v) => !v),
                                },
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

                {/* Plan ENC Route action moved into the ChartModes dropdown
                    (2026-05-18) — sits between "Charts Only" and "Clear All".
                    The floating top-left pill was easily missed and crowded
                    the FAB column. */}

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
                        encVisible={encVisible}
                        onToggleEnc={() => setEncVisible(!encVisible)}
                        encCellCount={encCellCount}
                        encChartDetail={encChartDetail}
                        onToggleEncChartDetail={() => setEncChartDetail(!encChartDetail)}
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
                    encCellCount={encCellCount}
                    seawayDebugVisible={seawayDebugVisible}
                    onToggleSeawayDebug={() => setSeawayDebugVisible(!seawayDebugVisible)}
                    onPlanEncRoute={async () => {
                        // Demo waypoints — hardcoded Newport → Rivergate
                        // until the full two-tap workflow lands. Tayana 55
                        // draft for the safety margin.
                        const FROM = { lat: -27.157, lon: 153.103 };
                        const TO = { lat: -27.435, lon: 153.105 };
                        const DRAFT_M = 1.9;
                        try {
                            const res = await tryInshoreRoute(FROM, TO, DRAFT_M);
                            if (res && 'polyline' in res) {
                                setEncTestRoute({ polyline: res.polyline, cautionMask: res.cautionMask });
                                const cautionCount = res.cautionMask?.filter(Boolean).length ?? 0;
                                return {
                                    ok: true,
                                    summary: `${res.distanceNM.toFixed(1)} NM · ${res.polyline.length} pts · ${cautionCount} caution`,
                                };
                            }
                            if (res && 'error' in res) {
                                setEncTestRoute(null);
                                return { ok: false, summary: `failed: ${res.error}` };
                            }
                            setEncTestRoute(null);
                            return { ok: false, summary: 'no route (gated)' };
                        } catch (err) {
                            setEncTestRoute(null);
                            return {
                                ok: false,
                                summary: `crash: ${err instanceof Error ? err.message : String(err)}`,
                            };
                        }
                    }}
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

                {/* Routes picker — saved planned passages from the
                    ships log. Selection becomes activeChartRoute; the
                    useRouteTrackLayer renders + fits bounds. */}
                <RouteTrackPicker
                    visible={routePickerOpen && !passage.showPassage && !embedded && !isPinView}
                    variant="route"
                    selectedId={activeChartRoute?.id ?? null}
                    onSelect={(item) => setActiveChartRoute(item)}
                    onClose={() => setRoutePickerOpen(false)}
                />

                {/* Tracks picker — actually-sailed passages. Same UX as
                    Routes; the two can be active simultaneously. */}
                <RouteTrackPicker
                    visible={trackPickerOpen && !passage.showPassage && !embedded && !isPinView}
                    variant="track"
                    selectedId={activeChartTrack?.id ?? null}
                    onSelect={(item) => setActiveChartTrack(item)}
                    onClose={() => setTrackPickerOpen(false)}
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

                {/* Bottom-left legend stack. flex-col-reverse → first child
                    sits at the bottom of the column. When any weather layer
                    is active, ThalassaHelixControl / LegendDock occupies the
                    bottom-left corner with a ~140px-tall vertical legend bar;
                    lift the stack above that whole control to keep both
                    readable. */}
                {(lightningVisible || squallVisible) && (
                    <div
                        className="fixed left-2 z-[140] flex flex-col-reverse gap-2 pointer-events-none"
                        style={{
                            bottom:
                                weather.activeLayers.size > 0
                                    ? 'calc(env(safe-area-inset-bottom) + 240px)'
                                    : 'max(96px, calc(env(safe-area-inset-bottom) + 80px))',
                        }}
                    >
                        <BlitzortungAttribution visible={lightningVisible} />
                        <SquallLegend visible={squallVisible} />
                    </div>
                )}

                {/* ═══ ENC SOURCE ATTRIBUTION ═══ */}
                {/* Viewport-aware — only renders when ENC cells overlap the
                    current view. IHO standard practice for chart displays.
                    Self-contained: subscribes to its own viewport + cell-list
                    events. Tap to expand into a full per-cell list. */}
                <EncAttributionChip mapRef={mapRef} mapReady={mapReady} />

                {/* ═══ ENC HAZARD REPORT (route-adjacent obstructions) ═══ */}
                {/* Auto-populated by validateRouteSegments after a successful
                    route plan. Self-subscribes to the hazard-report singleton —
                    no prop drilling required. Hidden when not in passage mode
                    or when no hazards within the buffer. */}
                <HazardReportPanel
                    visible={passage.showPassage}
                    onHazardClick={(entry) => {
                        const map = mapRef.current;
                        if (!map) return;
                        triggerHaptic('light');
                        // Zoom 13 ≈ ~1 NM/cm — tight enough to show
                        // chart context around the hazard, loose
                        // enough to keep the surrounding route visible.
                        map.flyTo({
                            center: [entry.representativePoint.lon, entry.representativePoint.lat],
                            zoom: Math.max(map.getZoom(), 13),
                            speed: 1.6,
                            essential: true,
                        });
                    }}
                />

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
                            // Right-rail column — sits below Offline FAB (top-[192px])
                            // at top-[256px]. z-[700] matches the rail's other FABs.
                            className="absolute z-[700] top-[256px] right-[16px] w-12 h-12 rounded-2xl bg-slate-900/90 border border-white/[0.08] flex items-center justify-center shadow-2xl hover:bg-slate-800/90 transition-all active:scale-95 text-slate-400"
                            aria-label="Search vessels"
                        >
                            <SearchIcon className="w-5 h-5" />
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
                            // Right-rail column — sits at top-[128px], directly below the
                            // SysStatus button. Above the Radial Helm FAB (top-[192px]) so
                            // opening the radial menu doesn't fan upward into the top-center
                            // mode chip.
                            className="absolute z-[700] top-[128px] right-[16px] w-12 h-12 rounded-2xl bg-slate-900/90 border border-white/[0.08] flex items-center justify-center shadow-2xl hover:bg-slate-800/90 transition-all active:scale-95"
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
