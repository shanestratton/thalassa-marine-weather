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
import { WindStore } from '../../stores/WindStore';
import { ConsensusMatrix } from './ConsensusMatrix';
import { generateConsensusMatrix, type ConsensusMatrixData } from '../../services/ConsensusMatrixEngine';
import { LocationStore } from '../../stores/LocationStore';
import { useSettings } from '../../context/SettingsContext';
import { useUI } from '../../context/UIContext';
import { triggerHaptic } from '../../utils/system';
import { exportPassageAsGPX, exportBasicPassageGPX } from '../../services/passageGpxExport';
import { shareGPXFile } from '../../services/gpxService';
import { GpsService } from '../../services/GpsService';

import { type MapHubProps } from './mapConstants';
import { useMapInit, useLocationDot, usePickerMode } from './useMapInit';
import { useWeatherLayers, useEmbeddedRain } from './useWeatherLayers';
import { usePassagePlanner } from './usePassagePlanner';
import { useRouteNudge } from './useRouteNudge';
import { useAisLayer } from './useAisLayer';
import { useAisStreamLayer } from './useAisStreamLayer';
import { useChokepointLayer } from './useChokepointLayer';
import { AisLegend } from './AisLegend';
import { AisGuardAlert } from './AisGuardAlert';
import { VesselSearch } from './VesselSearch';
import { useFollowRouteMapbox } from '../../hooks/useFollowRouteMapbox';
import { MapboxVelocityOverlay } from './MapboxVelocityOverlay';
import { LayerFABMenu } from './MapHubOverlays';
import { ThalassaHelixControl, type HelixLayer } from './ThalassaHelixControl';
import { useDeviceMode } from '../../hooks/useDeviceMode';
import { PassageDataPanel } from './PassageDataPanel';
import { WeatherInspectPopup } from './WeatherInspectPopup';
import { fetchPointWeather, type PointWeatherData } from '../../services/weather/pointWeather';

// ── Component ──────────────────────────────────────────────────

export const MapHub: React.FC<MapHubProps> = ({
    mapboxToken,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    homePort,
    onLocationSelect,
    initialZoom = 5,
    mapStyle = 'mapbox://styles/mapbox/satellite-streets-v12',
    minimalLabels = false,
    embedded = false,
    center,
    pickerMode = false,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    pickerLabel,
}) => {
    // ── Pin View Mode (from chat pin tap) ──

    const [isPinView, setIsPinView] = useState(!!window.__thalassaPinView);
    const [showVesselSearch, setShowVesselSearch] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<mapboxgl.Map | null>(null);
    const pinMarkerRef = useRef<mapboxgl.Marker | null>(null);
    const locationDotRef = useRef<mapboxgl.Marker | null>(null);
    const { settings: _settings } = useSettings();
    const { setPage, previousView, currentView } = useUI();
    const [passageToast, setPassageToast] = useState<string | null>(null);
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
        };
        const onComplete = () => {
            log.info('Isochrone complete — clearing progress');
            setIsoProgress(null);
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
                el.innerHTML = `
                    <div style="display:flex;flex-direction:column;align-items:center;animation:pinDropBounce 0.5s ease-out">
                        <span style="font-size:28px;filter:drop-shadow(0 2px 6px rgba(0,0,0,0.4))">📍</span>
                        <span style="font-size:10px;color:#38bdf8;font-weight:700;background:rgba(0,0,0,0.6);padding:2px 8px;border-radius:8px;margin-top:2px;white-space:nowrap;max-width:150px;overflow:hidden;text-overflow:ellipsis">${label}</span>
                    </div>
                `;

                const mapboxgl = window.mapboxgl || window.maplibregl;
                if (mapboxgl?.Marker) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const marker = new (mapboxgl as any).Marker({ element: el }).setLngLat([lon, lat]).addTo(map);

                    // Auto-remove after 10 seconds
                    setTimeout(() => {
                        try {
                            marker.remove();
                        } catch {
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
    const [mapReady, setMapReady] = useState(false);
    const deviceMode = useDeviceMode();
    const [aisVisible, setAisVisible] = useState(true);
    const [chokepointVisible, setChokepointVisible] = useState(false);

    // ── Passage Planner ──
    const passage = usePassagePlanner(mapRef, mapReady);

    // Follow Route overlay — renders the followed planned route on the map
    useFollowRouteMapbox(mapRef, mapReady);

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
        onMapTap: (lat: number, lon: number) => {
            const map = mapRef.current;
            if (!map) return;

            // Drop a pin at the tapped location so user can navigate to WX
            dropPin(map, lat, lon);

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

    // ── Location Dot ──
    useLocationDot(mapRef, locationDotRef, mapReady);

    // ── Picker Mode ──
    usePickerMode(mapRef, pinMarkerRef, pickerMode, onLocationSelect);

    // ── Route Nudge (long-press-to-drag on route line) ──
    useRouteNudge(mapRef, mapReady, passage.showPassage);

    // ── Weather Layers ──
    const weather = useWeatherLayers(mapRef, mapReady, embedded, location);

    // ── Embedded Rain (also loads as background on full-map velocity mode) ──
    const _embRain = useEmbeddedRain(mapRef, embedded, mapReady, false);

    // ── AIS Vessel Target Layer ──
    useAisLayer(mapRef, mapReady, aisVisible);
    useAisStreamLayer(mapReady ? mapRef.current : null, aisVisible);

    // ── Chokepoint Tracker ──
    useChokepointLayer(mapReady ? mapRef.current : null, chokepointVisible);

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
        el.innerHTML = `
            <div style="
                width: 32px; height: 32px; background: linear-gradient(135deg, #f59e0b, #ef4444);
                border: 3px solid #fff; border-radius: 50% 50% 50% 0;
                transform: rotate(-45deg); box-shadow: 0 4px 16px rgba(245,158,11,0.5);
                animation: pinBounce 0.4s ease-out;
            "></div>
        `;
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
                        aria-label="Back"
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
                {!isPinView && (
                    <MapboxVelocityOverlay
                        mapboxMap={mapRef.current}
                        visible={weather.activeLayers.has('velocity')}
                        windHour={weather.windHour}
                        windGrid={weather.windGridRef?.current ?? undefined}
                        hideBadge={passage.showPassage}
                    />
                )}

                {/* LayerLegendStrip removed — replaced by ThalassaHelixControl */}

                {/* ═══ PRO DATA BAR (Phone / Deck mode during passage) ═══ */}
                {deviceMode === 'deck' && passage.showPassage && passage.routeAnalysis && !embedded && !isPinView && (
                    <div className="absolute top-14 left-3 right-3 z-[502] animate-in fade-in slide-in-from-top-2 duration-300">
                        <div className="bg-slate-950 border border-white/[0.12] rounded-2xl px-3 py-2.5 flex items-center justify-between shadow-2xl shadow-black/50">
                            <div className="text-center flex-1">
                                <p className="text-[11px] font-bold text-gray-400 uppercase tracking-widest">
                                    Distance
                                </p>
                                <p className="text-base font-black text-white tabular-nums leading-tight">
                                    {passage.routeAnalysis.totalDistance.toFixed(0)}
                                    <span className="text-[11px] text-gray-400"> NM</span>
                                </p>
                            </div>
                            <div className="w-px h-6 bg-white/10" />
                            <div className="text-center flex-1">
                                <p className="text-[11px] font-bold text-gray-400 uppercase tracking-widest">Time</p>
                                <p className="text-base font-black text-white tabular-nums leading-tight">
                                    {passage.routeAnalysis.estimatedDuration < 24
                                        ? `${passage.routeAnalysis.estimatedDuration.toFixed(1)}h`
                                        : `${Math.floor(passage.routeAnalysis.estimatedDuration / 24)}d ${Math.round(passage.routeAnalysis.estimatedDuration % 24)}h`}
                                </p>
                            </div>
                            <div className="w-px h-6 bg-white/10" />
                            <div className="text-center flex-1">
                                <p className="text-[11px] font-bold text-gray-400 uppercase tracking-widest">ETA</p>
                                <p className="text-base font-black text-amber-400 tabular-nums leading-tight">
                                    {new Date(
                                        (passage.departureTime
                                            ? new Date(passage.departureTime)
                                            : new Date()
                                        ).getTime() +
                                            passage.routeAnalysis.estimatedDuration * 3600000,
                                    ).toLocaleTimeString('en-AU', {
                                        hour: '2-digit',
                                        minute: '2-digit',
                                        hour12: false,
                                    })}
                                </p>
                            </div>
                        </div>
                    </div>
                )}

                {/* ═══ PASSAGE MODE BANNER ═══ */}
                {passage.showPassage && !embedded && (
                    <div className="absolute top-24 left-4 right-4 z-[501] animate-in fade-in slide-in-from-top-2 duration-300">
                        <div className="bg-slate-950 border border-white/[0.12] rounded-2xl px-4 py-3 shadow-2xl shadow-black/50">
                            <div className="flex items-center justify-between gap-2">
                                <div className="flex items-center gap-2 min-w-0">
                                    <div className="min-w-0">
                                        <p className="text-[11px] font-black text-white uppercase tracking-widest">
                                            Passage Planner
                                        </p>
                                        <p className="text-[11px] text-gray-400 truncate">
                                            {!passage.departure
                                                ? 'Tap map to set Departure'
                                                : !passage.arrival
                                                  ? 'Tap map to set Arrival'
                                                  : isoProgress
                                                    ? isoProgress.phase === 'loading-wind'
                                                        ? '⏳ Loading wind data…'
                                                        : isoProgress.phase === 'loading-bathy'
                                                          ? '⏳ Loading depth data…'
                                                          : `⏳ Routing… ${isoProgress.closestNM} NM to go${isoProgress.totalDistNM ? ` / ${isoProgress.totalDistNM} NM` : ''} • ${((isoProgress.elapsed ?? 0) / 1000).toFixed(0)}s`
                                                    : passage.routeAnalysis
                                                      ? `${passage.routeAnalysis.totalDistance.toFixed(0)} NM • ${passage.routeAnalysis.estimatedDuration.toFixed(0)}h`
                                                      : 'Computing route…'}
                                        </p>
                                    </div>
                                </div>
                                <button
                                    onClick={() => {
                                        passage.setShowPassage(false);
                                        triggerHaptic('light');
                                    }}
                                    className="w-8 h-8 flex items-center justify-center rounded-xl border border-white/10 bg-white/[0.05] hover:bg-white/10 transition-colors shrink-0 active:scale-95"
                                    aria-label="Close passage planner"
                                >
                                    <svg
                                        className="w-3.5 h-3.5 text-gray-400"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                        strokeWidth={2.5}
                                    >
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                    </svg>
                                </button>
                            </div>
                            {passage.departure && (
                                <div className="mt-1.5 pt-1.5 border-t border-white/5 flex gap-1.5 text-[11px]">
                                    <span className="px-1.5 py-0.5 bg-emerald-500/10 border border-emerald-500/15 rounded text-emerald-400/80 font-bold truncate">
                                        ⬤ {passage.departure.name}
                                    </span>
                                    {passage.arrival && (
                                        <span className="px-1.5 py-0.5 bg-red-500/10 border border-red-500/15 rounded text-red-400/80 font-bold truncate">
                                            ◉ {passage.arrival.name}
                                        </span>
                                    )}
                                </div>
                            )}
                            {/* Action buttons (GPX export + Save) */}
                            {passage.routeAnalysis && passage.departure && passage.arrival && (
                                <div className="mt-1.5 pt-1.5 border-t border-white/5">
                                    {/* Computing indicator */}
                                    {isoProgress && (
                                        <div className="flex items-center gap-1.5 mb-1.5 text-[11px] text-amber-400/70">
                                            <div className="w-2 h-2 border border-amber-400/60 border-t-transparent rounded-full animate-spin" />
                                            {isoProgress.phase === 'loading-wind'
                                                ? 'Loading wind data…'
                                                : isoProgress.phase === 'loading-bathy'
                                                  ? 'Loading depth data…'
                                                  : `Routing… ${isoProgress.closestNM} NM to go${isoProgress.totalDistNM ? ` / ${isoProgress.totalDistNM} NM` : ''} • ${((isoProgress.elapsed ?? 0) / 1000).toFixed(0)}s`}
                                        </div>
                                    )}
                                    <div className="flex gap-2">
                                        <button
                                            onClick={async () => {
                                                try {
                                                    let gpx: string;
                                                    if (
                                                        passage.isoResultRef.current &&
                                                        passage.turnWaypointsRef.current.length
                                                    ) {
                                                        // Full GPX with weather data from isochrone
                                                        gpx = exportPassageAsGPX(
                                                            passage.isoResultRef.current,
                                                            passage.turnWaypointsRef.current,
                                                            passage.departure!.name,
                                                            passage.arrival!.name,
                                                            passage.departureTime || new Date().toISOString(),
                                                        );
                                                    } else {
                                                        // Fallback: basic GPX from departure/arrival
                                                        gpx = exportBasicPassageGPX(
                                                            passage.departure!,
                                                            passage.arrival!,
                                                            passage.departureTime || new Date().toISOString(),
                                                            passage.routeAnalysis?.totalDistance,
                                                            passage.routeAnalysis?.estimatedDuration,
                                                        );
                                                    }
                                                    await shareGPXFile(
                                                        gpx,
                                                        `passage_${passage.departure!.name}_to_${passage.arrival!.name}.gpx`,
                                                    );
                                                } catch (err) {
                                                    log.error('GPX Export failed:', err);
                                                    setPassageToast('Export failed');
                                                    setTimeout(() => setPassageToast(null), 2000);
                                                }
                                            }}
                                            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl bg-sky-500/15 border border-sky-500/25 text-sky-400 text-[11px] font-black uppercase tracking-wider active:scale-95 transition-transform"
                                        >
                                            <svg
                                                className="w-3 h-3"
                                                fill="none"
                                                viewBox="0 0 24 24"
                                                stroke="currentColor"
                                                strokeWidth={2.5}
                                            >
                                                <path
                                                    strokeLinecap="round"
                                                    strokeLinejoin="round"
                                                    d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                                                />
                                            </svg>
                                            GPX
                                        </button>
                                        <button
                                            onClick={async () => {
                                                // Use ShipLogService for proper DB format, auth, & offline fallback
                                                try {
                                                    const { ShipLogService } =
                                                        await import('../../services/ShipLogService');
                                                    const dep = passage.departure!;
                                                    const arr = passage.arrival!;
                                                    const isoResult = passage.isoResultRef.current;
                                                    const turnWPs = passage.turnWaypointsRef.current;
                                                    const totalNM =
                                                        isoResult?.totalDistanceNM ??
                                                        passage.routeAnalysis?.totalDistance ??
                                                        0;
                                                    const totalHrs =
                                                        isoResult?.totalDurationHours ??
                                                        passage.routeAnalysis?.estimatedDuration ??
                                                        0;

                                                    // Build a VoyagePlan-compatible object
                                                    // When isochrone data exists, use the first/last turn waypoints
                                                    // (sea buoy gates) as origin/destination — NOT the port coords.
                                                    // This saves only the ocean leg (leg 2), avoiding harbour legs that cross land.
                                                    const hasIsoWPs = isoResult && turnWPs.length >= 2;
                                                    const firstWP = hasIsoWPs ? turnWPs[0] : null;
                                                    const lastWP = hasIsoWPs ? turnWPs[turnWPs.length - 1] : null;

                                                    const plan: Record<string, unknown> = {
                                                        origin:
                                                            dep.name || `${dep.lat.toFixed(2)}, ${dep.lon.toFixed(2)}`,
                                                        destination:
                                                            arr.name || `${arr.lat.toFixed(2)}, ${arr.lon.toFixed(2)}`,
                                                        originCoordinates: firstWP
                                                            ? { lat: firstWP.lat, lon: firstWP.lon }
                                                            : { lat: dep.lat, lon: dep.lon },
                                                        destinationCoordinates: lastWP
                                                            ? { lat: lastWP.lat, lon: lastWP.lon }
                                                            : { lat: arr.lat, lon: arr.lon },
                                                        waypoints:
                                                            hasIsoWPs && turnWPs.length > 2
                                                                ? turnWPs
                                                                      .slice(1, -1)
                                                                      .map(
                                                                          (wp: {
                                                                              lat: number;
                                                                              lon: number;
                                                                              name?: string;
                                                                              id?: string;
                                                                              tws?: number;
                                                                          }) => ({
                                                                              name: wp.id ?? wp.name,
                                                                              coordinates: { lat: wp.lat, lon: wp.lon },
                                                                              windSpeed: wp.tws,
                                                                              depth_m: undefined,
                                                                          }),
                                                                      )
                                                                : [],
                                                        distanceApprox: `${totalNM.toFixed(0)} NM`,
                                                        durationApprox: `${totalHrs.toFixed(0)} hours`,
                                                        departureDate:
                                                            passage.departureTime || new Date().toISOString(),
                                                    };

                                                    const voyageId = await ShipLogService.savePassagePlanToLogbook(
                                                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                                        plan as any,
                                                    );
                                                    if (voyageId) {
                                                        setPassageToast('Route saved to logbook ✓');
                                                        setTimeout(() => setPassageToast(null), 2000);
                                                    } else {
                                                        setPassageToast('Save failed ✗');
                                                        setTimeout(() => setPassageToast(null), 2000);
                                                    }
                                                } catch (err) {
                                                    log.error('Failed to save planned route:', err);
                                                    setPassageToast('Save failed ✗');
                                                    setTimeout(() => setPassageToast(null), 2000);
                                                }
                                            }}
                                            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl bg-emerald-500/15 border border-emerald-500/25 text-emerald-400 text-[11px] font-black uppercase tracking-wider active:scale-95 transition-transform"
                                        >
                                            <svg
                                                className="w-3 h-3"
                                                fill="none"
                                                viewBox="0 0 24 24"
                                                stroke="currentColor"
                                                strokeWidth={2.5}
                                            >
                                                <path
                                                    strokeLinecap="round"
                                                    strokeLinejoin="round"
                                                    d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4"
                                                />
                                            </svg>
                                            Save to Log
                                        </button>
                                    </div>
                                    {/* Toast */}
                                    {passageToast && (
                                        <div className="mt-1.5 text-center text-[11px] font-bold text-emerald-400 animate-in fade-in duration-200">
                                            {passageToast}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                )}

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
                        style={{
                            position: 'absolute',
                            top: 56,
                            right: 64,
                            zIndex: 500,
                            width: 40,
                            height: 40,
                            borderRadius: 12,
                            background: 'rgba(15,23,42,0.9)',
                            border: '1px solid rgba(255,255,255,0.08)',
                            color: '#94a3b8',
                            fontSize: 16,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            cursor: 'pointer',
                            boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
                        }}
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
                        el.innerHTML = `
                            <div style="
                                width:48px;height:48px;border-radius:50%;
                                background:radial-gradient(circle,rgba(14,165,233,0.3) 0%,transparent 70%);
                                border:2px solid rgba(14,165,233,0.6);
                                animation:pulse 1.5s ease-in-out infinite;
                                display:flex;align-items:center;justify-content:center;
                                font-size:20px;
                            ">
                                🎯
                            </div>
                        `;

                        const mapboxglLib = window.mapboxgl || window.maplibregl;
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
                    <div className="absolute bottom-44 right-4 z-[500] flex flex-col gap-2">
                        {/* Wind Mode Toggle — hidden for clean wind view */}

                        {/* GRIB Download — hidden for clean wind view */}

                        {/* GRIB Error Tooltip — hidden */}

                        {/* GPS Locate Me */}
                        <button
                            onClick={() => {
                                triggerHaptic('medium');
                                GpsService.getCurrentPosition({ staleLimitMs: 30_000, timeoutSec: 10 }).then((pos) => {
                                    if (!pos) return;
                                    const { latitude, longitude } = pos;
                                    const map = mapRef.current;
                                    if (map) {
                                        map.flyTo({ center: [longitude, latitude], zoom: 12, duration: 1200 });
                                        dropPin(map, latitude, longitude);
                                    }
                                    LocationStore.setFromGPS(latitude, longitude);
                                    onLocationSelect?.(latitude, longitude);
                                });
                            }}
                            className="w-12 h-12 bg-slate-900/90 border border-white/[0.08] rounded-2xl flex items-center justify-center shadow-2xl hover:bg-slate-800/90 transition-all active:scale-95"
                        >
                            <svg
                                className="w-5 h-5 text-emerald-400"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2}
                            >
                                <circle cx="12" cy="12" r="3" />
                                <path strokeLinecap="round" d="M12 2v3m0 14v3M2 12h3m14 0h3" />
                            </svg>
                        </button>

                        {/* Recenter on last pin */}
                        <button
                            onClick={() => {
                                if (mapRef.current) {
                                    mapRef.current.flyTo({
                                        center: [location.lon, location.lat],
                                        zoom: 10,
                                        duration: 1000,
                                    });
                                }
                                triggerHaptic('light');
                            }}
                            className="w-12 h-12 bg-slate-900/90 border border-white/[0.08] rounded-2xl flex items-center justify-center shadow-2xl hover:bg-slate-800/90 transition-all active:scale-95"
                        >
                            <svg
                                className="w-5 h-5 text-white"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={1.5}
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z"
                                />
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z"
                                />
                            </svg>
                        </button>
                    </div>
                )}

                {/* ═══ THALASSA HELIX CONTROL ═══ */}
                {!isPinView &&
                    weather.activeLayers.size === 1 &&
                    (() => {
                        // Determine active layer
                        const activeLayerKey: HelixLayer = weather.activeLayers.has('pressure')
                            ? 'pressure'
                            : weather.activeLayers.has('wind') || weather.activeLayers.has('velocity')
                              ? 'wind'
                              : weather.activeLayers.has('rain')
                                ? 'rain'
                                : weather.activeLayers.has('temperature')
                                  ? 'temperature'
                                  : null;

                        if (!activeLayerKey) return null;

                        // Compute scrubber props based on active layer
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
                            frameIndex = weather.windHour;
                            totalFrames = weather.windTotalHours;
                            const actualHour = fhrs[frameIndex] ?? frameIndex;
                            frameLabel = actualHour === 0 ? 'Now' : `+${actualHour}h`;
                            sublabel = actualHour === 0 ? 'Current' : 'Forecast';
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
                            }
                        }
                        // temperature: no scrubber, just legend (totalFrames stays 1)

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
