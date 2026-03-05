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
import React, { useRef, useState, useEffect } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

import { useLocationStore } from '../../stores/LocationStore';
import { LocationStore } from '../../stores/LocationStore';
import { useSettings } from '../../context/SettingsContext';
import { useUI } from '../../context/UIContext';
import { triggerHaptic } from '../../utils/system';
import { exportPassageAsGPX, exportBasicPassageGPX } from '../../services/passageGpxExport';
import { shareGPXFile } from '../../services/gpxService';
import { WindDataController } from '../../services/weather/WindDataController';
import { GpsService } from '../../services/GpsService';
import { WindParticleLayer } from './WindParticleLayer';

import { type MapHubProps, MAP_ANIMATIONS_CSS } from './mapConstants';
import { useMapInit, useLocationDot, usePickerMode } from './useMapInit';
import { useWeatherLayers, useEmbeddedRain } from './useWeatherLayers';
import { usePassagePlanner } from './usePassagePlanner';
import { SynopticScrubber } from './SynopticScrubber';
import { MapboxVelocityOverlay } from './MapboxVelocityOverlay';
import {
    PointInput,
    ResultCard,
    WindSpeedLegend,
    LayerLegendStrip,
    LayerFABMenu,
} from './MapHubOverlays';

// ── Component ──────────────────────────────────────────────────

export const MapHub: React.FC<MapHubProps> = ({
    mapboxToken,
    homePort,
    onLocationSelect,
    initialZoom = 6,
    mapStyle = 'mapbox://styles/mapbox/dark-v11',
    minimalLabels = false,
    embedded = false,
    center,
    pickerMode = false,
    pickerLabel,
}) => {
    // ── Pin View Mode (from chat pin tap) ──
    const pinView = (window as any).__thalassaPinView as { lat: number; lng: number } | undefined;
    const isPinView = !!pinView;
    const containerRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<mapboxgl.Map | null>(null);
    const pinMarkerRef = useRef<mapboxgl.Marker | null>(null);
    const locationDotRef = useRef<mapboxgl.Marker | null>(null);
    const { settings } = useSettings();
    const { setPage } = useUI();
    const [passageToast, setPassageToast] = useState<string | null>(null);
    const [isoProgress, setIsoProgress] = useState<{ step: number; closestNM: number; totalDistNM?: number; elapsed?: number; frontSize?: number; phase?: string } | null>(null);

    // Listen for isochrone progress + completion events
    useEffect(() => {
        const onProgress = (e: Event) => {
            const d = (e as CustomEvent).detail;
            console.info('[MapHub] Isochrone progress:', d);
            if (d) setIsoProgress({ step: d.step, closestNM: d.closestNM, totalDistNM: d.totalDistNM, elapsed: d.elapsed, frontSize: d.frontSize, phase: d.phase });
        };
        const onComplete = () => { console.info('[MapHub] Isochrone complete — clearing progress'); setIsoProgress(null); };
        window.addEventListener('thalassa:isochrone-progress', onProgress);
        window.addEventListener('thalassa:isochrone-complete', onComplete);
        return () => {
            window.removeEventListener('thalassa:isochrone-progress', onProgress);
            window.removeEventListener('thalassa:isochrone-complete', onComplete);
        };
    }, []);

    const location = useLocationStore();
    const [mapReady, setMapReady] = useState(false);

    // ── Passage Planner ──
    const passage = usePassagePlanner(mapRef, mapReady);

    // Clear isochrone progress when route completes
    useEffect(() => {
        if (passage.isoResultRef.current) setIsoProgress(null);
    }, [passage.routeAnalysis]);

    // ── Map Init ──
    const { dropPin } = useMapInit({
        containerRef, mapRef, pinMarkerRef, locationDotRef,
        mapboxToken, mapStyle, initialZoom, minimalLabels, embedded,
        center, location, onLocationSelect, pickerMode,
        settingPoint: passage.settingPoint,
        showPassage: passage.showPassage,
        departure: passage.departure,
        arrival: passage.arrival,
        setMapReady,
        setActiveLayer: (layer: any) => weather.setActiveLayer(layer),
        setDeparture: passage.setDeparture,
        setArrival: passage.setArrival,
        setSettingPoint: passage.setSettingPoint,
    });

    // ── Location Dot ──
    useLocationDot(mapRef, locationDotRef, mapReady);

    // ── Picker Mode ──
    usePickerMode(mapRef, pinMarkerRef, pickerMode, onLocationSelect);

    // ── Weather Layers ──
    const weather = useWeatherLayers(mapRef, mapReady, embedded, location);

    // ── Embedded Rain (also loads as background on full-map velocity mode) ──
    const embRain = useEmbeddedRain(mapRef, embedded, mapReady, !embedded);

    // ── Pin View: Drop a visual-only pin marker (no navigation side-effects) ──
    useEffect(() => {
        if (!isPinView || !pinView || !mapReady || !mapRef.current) return;
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
        const marker = new mapboxgl.Marker({ element: el, anchor: 'bottom' })
            .setLngLat([pinView.lng, pinView.lat])
            .addTo(map);
        pinMarkerRef.current = marker;

        // Fly to the pin
        map.flyTo({ center: [pinView.lng, pinView.lat], zoom: 14, duration: 1200 });
    }, [isPinView, mapReady]);

    // ── Render ──
    return (
        <div className="w-full h-full relative">
            {/* Map container */}
            <div ref={containerRef} className="w-full h-full" />

            {/* Pin bounce + location pulse animations */}
            <style>{MAP_ANIMATIONS_CSS}</style>

            {/* ═══ VELOCITY WIND OVERLAY ═══ */}
            {!isPinView && <MapboxVelocityOverlay mapboxMap={mapRef.current} visible={weather.activeLayer === 'velocity'} />}

            {/* ═══ WIND SPEED LEGEND ═══ */}
            {!isPinView && (weather.activeLayer === 'velocity' || weather.activeLayer === 'wind') && <WindSpeedLegend />}

            {/* ═══ EMBEDDED / BACKGROUND RAIN SCRUBBER ═══ */}
            {!isPinView && (embedded || (!embedded && weather.activeLayer === 'velocity')) && embRain.embRainCount > 1 && embRain.embRainIdx >= 0 && (
                <div
                    className="absolute left-2 right-2 z-[600] flex items-center gap-2 px-2.5 py-1.5 rounded-xl border border-white/10 shadow-lg"
                    style={{ bottom: embedded ? 8 : 'calc(64px + env(safe-area-inset-bottom) + 8px)', background: 'rgba(15, 23, 42, 0.85)' }}
                >
                    <style>{`
                        .emb-rain-slider { -webkit-appearance: none; appearance: none; background: transparent; cursor: pointer; }
                        .emb-rain-slider::-webkit-slider-runnable-track { height: 3px; background: rgba(255,255,255,0.15); border-radius: 2px; }
                        .emb-rain-slider::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%; background: #22c55e; margin-top: -5.5px; box-shadow: 0 0 6px rgba(34,197,94,0.5); }
                    `}</style>
                    <button
                        onClick={() => embRain.setEmbRainPlaying(!embRain.embRainPlaying)}
                        className="w-6 h-6 flex items-center justify-center shrink-0 text-white/70 active:scale-90 transition-transform"
                    >
                        {embRain.embRainPlaying ? (
                            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><rect x="1" y="1" width="3" height="8" rx="0.5" /><rect x="6" y="1" width="3" height="8" rx="0.5" /></svg>
                        ) : (
                            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><polygon points="2,1 9,5 2,9" /></svg>
                        )}
                    </button>
                    <input
                        type="range"
                        min={0}
                        max={embRain.embRainCount - 1}
                        value={embRain.embRainIdx}
                        onChange={e => { embRain.setEmbRainPlaying(false); embRain.setEmbRainIdx(parseInt(e.target.value)); }}
                        className="emb-rain-slider flex-1 h-3"
                    />
                    <span className="text-[11px] font-bold text-white/60 min-w-[32px] text-right font-mono">
                        {(() => {
                            const frames = embRain.embeddedRainFrames.current;
                            if (!frames.length) return '--';
                            const now = Date.now() / 1000;
                            const ft = frames[embRain.embRainIdx]?.time ?? now;
                            const dm = Math.round((ft - now) / 60);
                            if (Math.abs(dm) < 3) return 'NOW';
                            if (Math.abs(dm) >= 60) {
                                const h = Math.round(dm / 60);
                                return `${h > 0 ? '+' : ''}${h}h`;
                            }
                            return `${dm > 0 ? '+' : ''}${dm}m`;
                        })()}
                    </span>
                </div>
            )}

            {/* ═══ LAYER LEGEND STRIP ═══ */}
            {!isPinView && <LayerLegendStrip activeLayer={weather.activeLayer} windMaxSpeed={weather.windMaxSpeed} />}

            {/* ═══ PASSAGE MODE BANNER ═══ */}
            {passage.showPassage && !embedded && (
                <div className="absolute top-24 left-4 right-4 z-[501] animate-in fade-in slide-in-from-top-2 duration-300">
                    <div className="bg-slate-900/85 border border-white/10 rounded-xl px-3 py-2 shadow-lg">
                        <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 min-w-0">
                                <div className="min-w-0">
                                    <p className="text-[10px] font-black text-white/70 uppercase tracking-widest">Passage Planner</p>
                                    <p className="text-[10px] text-gray-500 truncate">
                                        {!passage.departure ? 'Tap map to set Departure' :
                                            !passage.arrival ? 'Tap map to set Arrival' :
                                                isoProgress
                                                    ? isoProgress.phase === 'loading-wind' ? '⏳ Loading wind data…'
                                                        : isoProgress.phase === 'loading-bathy' ? '⏳ Loading depth data…'
                                                            : `⏳ Routing… ${isoProgress.closestNM} NM to go${isoProgress.totalDistNM ? ` / ${isoProgress.totalDistNM} NM` : ''} • ${((isoProgress.elapsed ?? 0) / 1000).toFixed(0)}s`
                                                    : passage.routeAnalysis ? `${passage.routeAnalysis.totalDistance.toFixed(0)} NM • ${passage.routeAnalysis.estimatedDuration.toFixed(0)}h`
                                                        : 'Computing route…'}
                                    </p>
                                </div>
                            </div>
                            <button
                                onClick={() => {
                                    passage.setShowPassage(false);
                                    triggerHaptic('light');
                                }}
                                className="p-1.5 rounded-lg hover:bg-white/10 transition-colors shrink-0"
                                aria-label="Close passage planner"
                            >
                                <svg className="w-3.5 h-3.5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        </div>
                        {passage.departure && (
                            <div className="mt-1.5 pt-1.5 border-t border-white/5 flex gap-1.5 text-[9px]">
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
                                    <div className="flex items-center gap-1.5 mb-1.5 text-[9px] text-amber-400/70">
                                        <div className="w-2 h-2 border border-amber-400/60 border-t-transparent rounded-full animate-spin" />
                                        {isoProgress.phase === 'loading-wind' ? 'Loading wind data…'
                                            : isoProgress.phase === 'loading-bathy' ? 'Loading depth data…'
                                                : `Routing… ${isoProgress.closestNM} NM to go${isoProgress.totalDistNM ? ` / ${isoProgress.totalDistNM} NM` : ''} • ${((isoProgress.elapsed ?? 0) / 1000).toFixed(0)}s`}
                                    </div>
                                )}
                                <div className="flex gap-2">
                                    <button
                                        onClick={async () => {
                                            try {
                                                let gpx: string;
                                                if (passage.isoResultRef.current && passage.turnWaypointsRef.current.length) {
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
                                                await shareGPXFile(gpx, `passage_${passage.departure!.name}_to_${passage.arrival!.name}.gpx`);
                                            } catch (err) {
                                                console.error('[GPX Export]', err);
                                                setPassageToast('Export failed');
                                                setTimeout(() => setPassageToast(null), 2000);
                                            }
                                        }}
                                        className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg bg-sky-500/15 border border-sky-500/20 text-sky-400 text-[9px] font-bold uppercase tracking-wider active:scale-95 transition-transform"
                                    >
                                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                        </svg>
                                        GPX
                                    </button>
                                    <button
                                        onClick={async () => {
                                            // Use ShipLogService for proper DB format, auth, & offline fallback
                                            try {
                                                const { ShipLogService } = await import('../../services/ShipLogService');
                                                const dep = passage.departure!;
                                                const arr = passage.arrival!;
                                                const isoResult = passage.isoResultRef.current;
                                                const turnWPs = passage.turnWaypointsRef.current;
                                                const totalNM = isoResult?.totalDistanceNM ?? passage.routeAnalysis?.totalDistance ?? 0;
                                                const totalHrs = isoResult?.totalDurationHours ?? passage.routeAnalysis?.estimatedDuration ?? 0;

                                                // Build a VoyagePlan-compatible object
                                                // When isochrone data exists, use the first/last turn waypoints
                                                // (sea buoy gates) as origin/destination — NOT the port coords.
                                                // This saves only the ocean leg (leg 2), avoiding harbour legs that cross land.
                                                const hasIsoWPs = isoResult && turnWPs.length >= 2;
                                                const firstWP = hasIsoWPs ? turnWPs[0] : null;
                                                const lastWP = hasIsoWPs ? turnWPs[turnWPs.length - 1] : null;

                                                const plan: any = {
                                                    origin: dep.name || `${dep.lat.toFixed(2)}, ${dep.lon.toFixed(2)}`,
                                                    destination: arr.name || `${arr.lat.toFixed(2)}, ${arr.lon.toFixed(2)}`,
                                                    originCoordinates: firstWP
                                                        ? { lat: firstWP.lat, lon: firstWP.lon }
                                                        : { lat: dep.lat, lon: dep.lon },
                                                    destinationCoordinates: lastWP
                                                        ? { lat: lastWP.lat, lon: lastWP.lon }
                                                        : { lat: arr.lat, lon: arr.lon },
                                                    waypoints: (hasIsoWPs && turnWPs.length > 2)
                                                        ? turnWPs.slice(1, -1).map((wp: any) => ({
                                                            name: wp.id,
                                                            coordinates: { lat: wp.lat, lon: wp.lon },
                                                            windSpeed: wp.tws,
                                                            depth_m: undefined,
                                                        }))
                                                        : [],
                                                    distanceApprox: `${totalNM.toFixed(0)} NM`,
                                                    durationApprox: `${totalHrs.toFixed(0)} hours`,
                                                    departureDate: passage.departureTime || new Date().toISOString(),
                                                };

                                                const voyageId = await ShipLogService.savePassagePlanToLogbook(plan);
                                                if (voyageId) {
                                                    setPassageToast('Route saved to logbook ✓');
                                                    setTimeout(() => setPassageToast(null), 2000);
                                                } else {
                                                    setPassageToast('Save failed ✗');
                                                    setTimeout(() => setPassageToast(null), 2000);
                                                }
                                            } catch (err) {
                                                console.error('[MapHub] Failed to save planned route:', err);
                                                setPassageToast('Save failed ✗');
                                                setTimeout(() => setPassageToast(null), 2000);
                                            }
                                        }}
                                        className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/20 text-emerald-400 text-[9px] font-bold uppercase tracking-wider active:scale-95 transition-transform"
                                    >
                                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
                                        </svg>
                                        Save to Log
                                    </button>
                                </div>
                                {/* Toast */}
                                {passageToast && (
                                    <div className="mt-1.5 text-center text-[9px] font-bold text-emerald-400 animate-in fade-in duration-200">
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
                    activeLayer={weather.activeLayer}
                    showLayerMenu={weather.showLayerMenu}
                    embedded={embedded}
                    location={location}
                    initialZoom={initialZoom}
                    center={center}
                    mapRef={mapRef}
                    setActiveLayer={weather.setActiveLayer}
                    setShowLayerMenu={weather.setShowLayerMenu}
                />
            )}

            {/* ═══ ACTION FABS ═══ */}
            {!embedded && !passage.showPassage && !isPinView && (
                <div className="absolute bottom-44 right-4 z-[500] flex flex-col gap-2">

                    {/* Wind Mode Toggle */}
                    {weather.activeLayer === 'wind' && (
                        <button
                            onClick={() => {
                                triggerHaptic('medium');
                                const map = mapRef.current;
                                if (!map) return;
                                WindDataController.switchMode(map).then(() => {
                                    const { grid } = weather.windState;
                                    if (grid && weather.windEngineRef.current) {
                                        weather.windEngineRef.current.setGrid(grid, 0);
                                        weather.windGridRef.current = grid;
                                        weather.setWindTotalHours(grid.totalHours);
                                        weather.setWindHour(0);
                                    }
                                });
                            }}
                            className={`w-12 h-12 border rounded-2xl flex items-center justify-center shadow-2xl transition-all active:scale-95 ${weather.windState.isGlobalMode
                                ? 'bg-sky-600/90 border-sky-500/30'
                                : 'bg-amber-600/90 border-amber-500/30'
                                }`}
                            title={weather.windState.isGlobalMode ? 'Global Live Wind' : 'Passage Wind'}
                        >
                            {weather.windState.isGlobalMode ? (
                                <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                    <circle cx="12" cy="12" r="9" />
                                    <path strokeLinecap="round" d="M3.5 12h17M12 3c-2 2.5-3 5.5-3 9s1 6.5 3 9c2-2.5 3-5.5 3-9s-1-6.5-3-9" />
                                </svg>
                            ) : (
                                <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                    <circle cx="12" cy="12" r="9" />
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.24 7.76l-6.17 2.47-2.47 6.17 6.17-2.47 2.47-6.17z" />
                                    <circle cx="12" cy="12" r="1.5" fill="currentColor" />
                                </svg>
                            )}
                        </button>
                    )}

                    {/* GRIB Download */}
                    {weather.activeLayer === 'wind' && (
                        <button
                            onClick={async () => {
                                if (weather.isGribDownloading) return;
                                triggerHaptic('medium');
                                weather.setIsGribDownloading(true);
                                weather.setGribProgress(0);
                                weather.setGribError(null);
                                try {
                                    const map = mapRef.current;
                                    if (!map) throw new Error('Map not ready');
                                    const b = map.getBounds();
                                    if (!b) throw new Error('Cannot get map bounds');

                                    const isGlobal = weather.windState.isGlobalMode;
                                    const north = isGlobal ? 90 : b.getNorth();
                                    const south = isGlobal ? -90 : b.getSouth();
                                    const east = isGlobal ? 180 : b.getEast();
                                    const west = isGlobal ? -180 : b.getWest();

                                    const body = { north, south, east, west };
                                    const supabaseUrl = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) || '';
                                    if (!supabaseUrl) throw new Error('Supabase URL not configured');
                                    const supabaseKey = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_KEY) || '';
                                    const url = `${supabaseUrl}/functions/v1/fetch-wind-grid`;
                                    weather.setGribProgress(10);

                                    const resp = await fetch(url, {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json', ...(supabaseKey ? { Authorization: `Bearer ${supabaseKey}` } : {}) },
                                        body: JSON.stringify(body),
                                    });
                                    weather.setGribProgress(50);

                                    if (!resp.ok) {
                                        let errDetail = `Server ${resp.status}`;
                                        try { const errJson = await resp.json(); errDetail = errJson.error || errJson.detail || errDetail; } catch (e) { console.warn('[MapHub]', e); errDetail = await resp.text().catch(() => errDetail); }
                                        throw new Error(errDetail);
                                    }

                                    const buffer = await resp.arrayBuffer();
                                    weather.setGribProgress(80);

                                    if (buffer.byteLength < 200) {
                                        const text = new TextDecoder().decode(buffer);
                                        throw new Error(`NOAA returned invalid data (${buffer.byteLength}B): ${text.substring(0, 100)}`);
                                    }

                                    const { decodeGrib2Wind } = await import('../../services/weather/decodeGrib2Wind');
                                    const grib = decodeGrib2Wind(buffer);

                                    let engine = weather.windEngineRef.current;
                                    if (!engine) {
                                        const map = mapRef.current;
                                        if (!map) throw new Error('Map not available for wind layer');
                                        try { map.removeLayer('wind-particles'); } catch (_) { }
                                        engine = new WindParticleLayer();
                                        map.addLayer(engine);
                                        try { map.moveLayer('coastline-stroke'); } catch (_) { }
                                        try { map.moveLayer('country-borders-overlay'); } catch (_) { }
                                        weather.windEngineRef.current = engine;
                                    }

                                    engine.setWindData(grib.u, grib.v, grib.width, grib.height, {
                                        north: grib.north, south: grib.south, east: grib.east, west: grib.west,
                                    });
                                    weather.setWindMaxSpeed(engine.getMaxSpeed());
                                    weather.setGribProgress(100);
                                    triggerHaptic('light');
                                } catch (err) {
                                    const msg = err instanceof Error ? err.message : 'Download failed';
                                    weather.setGribError(msg);
                                    console.error('[GRIB] Error:', msg, err);
                                    triggerHaptic('heavy');
                                    setTimeout(() => weather.setGribError(null), 5000);
                                } finally {
                                    weather.setIsGribDownloading(false);
                                }
                            }}
                            disabled={weather.isGribDownloading}
                            className={`w-12 h-12 border rounded-2xl flex items-center justify-center shadow-2xl transition-all active:scale-95 ${weather.isGribDownloading
                                ? 'bg-sky-700/90 border-sky-500/30 cursor-wait'
                                : weather.gribError
                                    ? 'bg-red-800/90 border-red-500/30'
                                    : 'bg-slate-900/90 border-white/[0.08] hover:bg-slate-800/90'
                                }`}
                            title={weather.isGribDownloading ? `Downloading ${weather.gribProgress}%` : weather.gribError ?? 'Download GRIB'}
                        >
                            {weather.isGribDownloading ? (
                                <svg className="w-5 h-5 text-white animate-spin" fill="none" viewBox="0 0 24 24">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                </svg>
                            ) : (
                                <svg className={`w-5 h-5 ${weather.gribError ? 'text-red-300' : 'text-sky-400'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9.75v6.75m0 0l-3-3m3 3l3-3m-8.25 6a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z" />
                                </svg>
                            )}
                        </button>
                    )}

                    {/* GRIB Error Tooltip */}
                    {weather.gribError && weather.activeLayer === 'wind' && (
                        <div className="max-w-[200px] bg-red-900/95 border border-red-500/30 rounded-xl px-3 py-2 shadow-2xl">
                            <p className="text-[11px] font-bold text-red-300 leading-tight">{weather.gribError}</p>
                        </div>
                    )}

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
                        <svg className="w-5 h-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <circle cx="12" cy="12" r="3" />
                            <path strokeLinecap="round" d="M12 2v3m0 14v3M2 12h3m14 0h3" />
                        </svg>
                    </button>

                    {/* Recenter on last pin */}
                    <button
                        onClick={() => {
                            if (mapRef.current) {
                                mapRef.current.flyTo({ center: [location.lon, location.lat], zoom: 10, duration: 1000 });
                            }
                            triggerHaptic('light');
                        }}
                        className="w-12 h-12 bg-slate-900/90 border border-white/[0.08] rounded-2xl flex items-center justify-center shadow-2xl hover:bg-slate-800/90 transition-all active:scale-95"
                    >
                        <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
                        </svg>
                    </button>
                </div>
            )}

            {/* ═══ SYNOPTIC TIMELINE SCRUBBER ═══ */}
            {!isPinView && weather.activeLayer === 'pressure' && (
                <SynopticScrubber
                    forecastHour={weather.forecastHour}
                    totalFrames={weather.totalFrames}
                    framesReady={weather.framesReady}
                    isPlaying={weather.isPlaying}
                    onHourChange={(h: number) => { weather.setForecastHour(h); }}
                    onPlayToggle={() => { weather.setIsPlaying(!weather.isPlaying); triggerHaptic('light'); }}
                    onScrubStart={() => { weather.setIsPlaying(false); }}
                    applyFrame={weather.applyFrame}
                    triggerHaptic={triggerHaptic}
                />
            )}

            {/* ═══ WIND TIMELINE SCRUBBER ═══ */}
            {!isPinView && weather.activeLayer === 'wind' && weather.windReady && (
                <div className="absolute left-4 right-4 z-[500]" style={{ bottom: embedded ? 8 : 'calc(64px + env(safe-area-inset-bottom) + 8px)' }}>
                    <div className="bg-slate-900/90 border border-white/[0.08] rounded-2xl px-4 py-2.5 flex items-center gap-3">
                        <button
                            onClick={() => { weather.setWindPlaying(!weather.windPlaying); triggerHaptic('light'); }}
                            className="w-8 h-8 flex items-center justify-center rounded-xl bg-sky-500/20 border border-sky-500/30 shrink-0 active:scale-90 transition-transform"
                        >
                            <span className="text-sm">{weather.windPlaying ? '⏸' : '▶️'}</span>
                        </button>

                        <div
                            className="flex-1 relative h-10 flex items-center cursor-pointer"
                            style={{ touchAction: 'none' }}
                            onPointerDown={e => {
                                e.preventDefault(); e.stopPropagation();
                                (e.target as HTMLElement).setPointerCapture(e.pointerId);
                                const rect = e.currentTarget.getBoundingClientRect();
                                const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                                const hr = ratio * (weather.windTotalHours - 1);
                                weather.setWindPlaying(false);
                                weather.setWindHour(hr);
                                triggerHaptic('light');
                            }}
                            onPointerMove={e => {
                                if (e.buttons === 0) return;
                                const rect = e.currentTarget.getBoundingClientRect();
                                const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                                const hr = ratio * (weather.windTotalHours - 1);
                                weather.setWindPlaying(false);
                                weather.setWindHour(hr);
                            }}
                        >
                            <div className="w-full h-1.5 bg-white/10 rounded-full relative overflow-hidden">
                                <div className="absolute inset-y-0 left-0 bg-sky-500/40 rounded-full" style={{ width: `${(weather.windHour / Math.max(1, weather.windTotalHours - 1)) * 100}%` }} />
                            </div>
                            <div
                                className="absolute top-1/2 w-5 h-5 bg-sky-400 rounded-full shadow-lg shadow-sky-400/30 border-2 border-white/40 pointer-events-none"
                                style={{ left: `${(weather.windHour / Math.max(1, weather.windTotalHours - 1)) * 100}%`, transform: 'translate(-50%, -50%)' }}
                            />
                        </div>

                        <div className="shrink-0 text-right min-w-[52px]">
                            <p className="text-xs font-black text-white">+{weather.windHour.toFixed(1)}h</p>
                            <p className="text-[11px] text-gray-500 font-bold uppercase tracking-widest">
                                {weather.windHour < 24 ? 'Today' : weather.windHour < 48 ? 'Tomorrow' : `+${Math.floor(weather.windHour / 24)}d`}
                            </p>
                        </div>
                    </div>
                </div>
            )}

            {/* ═══ RAIN TIMELINE SCRUBBER ═══ */}
            {!isPinView && weather.activeLayer === 'rain' && weather.rainFrameCount > 1 && (
                <div className="absolute left-4 right-4 z-[500]" style={{ bottom: embedded ? 8 : 'calc(64px + env(safe-area-inset-bottom) + 8px)' }}>
                    <div className="bg-slate-900/90 border border-white/[0.08] rounded-2xl px-4 py-2.5 flex items-center gap-3">
                        <button
                            onClick={() => { weather.setRainPlaying(!weather.rainPlaying); triggerHaptic('light'); }}
                            className="w-8 h-8 flex items-center justify-center rounded-xl bg-emerald-500/20 border border-emerald-500/30 shrink-0 active:scale-90 transition-transform"
                        >
                            <span className="text-sm">{weather.rainPlaying ? '⏸' : '▶️'}</span>
                        </button>

                        <div
                            className="flex-1 relative h-10 flex items-center cursor-pointer"
                            style={{ touchAction: 'none' }}
                            onPointerDown={e => {
                                e.preventDefault(); e.stopPropagation();
                                (e.target as HTMLElement).setPointerCapture(e.pointerId);
                                const rect = e.currentTarget.getBoundingClientRect();
                                const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                                const idx = Math.round(ratio * (weather.rainFrameCount - 1));
                                weather.setRainPlaying(false);
                                weather.setRainFrameIndex(idx);
                                triggerHaptic('light');
                            }}
                            onPointerMove={e => {
                                if (e.buttons === 0) return;
                                const rect = e.currentTarget.getBoundingClientRect();
                                const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                                const idx = Math.round(ratio * (weather.rainFrameCount - 1));
                                weather.setRainPlaying(false);
                                weather.setRainFrameIndex(idx);
                            }}
                        >
                            <div className="w-full h-1.5 bg-white/10 rounded-full relative overflow-hidden">
                                <div className="absolute inset-y-0 left-0 bg-emerald-500/40 rounded-full" style={{ width: `${(weather.rainFrameIndex / Math.max(1, weather.rainFrameCount - 1)) * 100}%` }} />
                            </div>
                            <div
                                className="absolute top-1/2 w-5 h-5 bg-emerald-400 rounded-full shadow-lg shadow-emerald-400/30 border-2 border-white/40 pointer-events-none"
                                style={{ left: `${(weather.rainFrameIndex / Math.max(1, weather.rainFrameCount - 1)) * 100}%`, transform: 'translate(-50%, -50%)' }}
                            />
                        </div>

                        <div className="shrink-0 text-right min-w-[52px]">
                            <p className="text-xs font-black text-white">
                                {(() => {
                                    const frames = weather.rainFramesRef.current;
                                    if (!frames.length) return '--';
                                    const now = Date.now() / 1000;
                                    const frameTime = frames[weather.rainFrameIndex]?.time ?? now;
                                    const diffMin = Math.round((frameTime - now) / 60);
                                    if (Math.abs(diffMin) < 3) return 'NOW';
                                    return `${diffMin > 0 ? '+' : ''}${diffMin}m`;
                                })()}
                            </p>
                            <p className="text-[11px] text-gray-500 font-bold uppercase tracking-widest">Radar</p>
                        </div>
                    </div>
                </div>
            )}
        </div >
    );
};
