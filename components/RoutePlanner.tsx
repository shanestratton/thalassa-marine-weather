import React, { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
    MapPinIcon, MapIcon, RouteIcon, CalendarIcon,
    CrosshairIcon, XIcon, ClockIcon, LockIcon, BugIcon, CompassIcon,
    PowerBoatIcon, SailBoatIcon, AnchorIcon
} from './Icons';
import { MapHub } from './map/MapHub';
import { SlideToAction } from './ui/SlideToAction';
import { VoyageResults } from './VoyageResults';
import { useVoyageForm, LOADING_PHASES } from '../hooks/useVoyageForm';
import { t } from '../theme';
import { getSpatiotemporalPayload } from '../services/weatherRouter';
import PassageCanvas from './passage/PassageCanvas';



export const RoutePlanner: React.FC<{ onTriggerUpgrade: () => void; onBack?: () => void }> = ({ onTriggerUpgrade, onBack }) => {
    // ── TEMPORARY: Routing disabled while awaiting Navionics/i-Boating SDK ──
    const ROUTING_DISABLED = false;

    // Custom Hook
    const {
        origin, setOrigin,
        destination, setDestination,
        via, setVia,
        departureDate, setDepartureDate,
        isMapOpen, setIsMapOpen,
        mapSelectionTarget, setMapSelectionTarget,
        loading, loadingStep,
        error,
        analyzingDeep, deepReport,

        handleCalculate,
        handleDeepAnalysis,
        clearVoyagePlan,
        handleOriginLocation,
        handleMapSelect,
        openMap,

        routeCoords,
        isShortTrip,

        voyagePlan,
        vessel,
        isPro,
        mapboxToken,

        // Missing props
        minDate,
        checklistState, toggleCheck,
        activeChecklistTab, setActiveChecklistTab
    } = useVoyageForm(onTriggerUpgrade);

    const [tempMapSelection, setTempMapSelection] = useState<{ lat: number, lon: number, name: string } | null>(null);
    const [departureTime, setDepartureTime] = useState('06:00');
    const [suggestingDeparture, setSuggestingDeparture] = useState(false);
    const [suggestedReasoning, setSuggestedReasoning] = useState<string | null>(null);
    const [is4DCanvasOpen, setIs4DCanvasOpen] = useState(false);
    const formRef = React.useRef<HTMLFormElement>(null);

    // Extract spatiotemporal payload from the enhanced voyage plan
    const spatiotemporalPayload = useMemo(() => {
        if (!voyagePlan) return null;
        return getSpatiotemporalPayload(voyagePlan);
    }, [voyagePlan]);

    return (
        <div className="relative flex-1 h-full bg-slate-950 overflow-hidden flex flex-col">

            {/* ═══ 4D PASSAGE CANVAS (FULL SCREEN PORTAL) ═══ */}
            {is4DCanvasOpen && spatiotemporalPayload && createPortal(
                <div className="fixed inset-0 z-[3000]" style={{ background: '#040d1a' }}>
                    <PassageCanvas
                        payload={spatiotemporalPayload}
                        onClose={() => setIs4DCanvasOpen(false)}
                    />
                </div>,
                document.body
            )}

            {/* ═══ HEADER ═══ */}
            <div className="shrink-0 px-4 pt-4 pb-3">
                <div className="flex items-center gap-3">
                    {onBack && (
                        <button
                            onClick={onBack}
                            aria-label="Go back"
                            className="p-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors"
                        >
                            <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                            </svg>
                        </button>
                    )}
                    <div className="flex-1">
                        <h1 className="text-xl font-extrabold text-white uppercase tracking-wider">Passage Planning</h1>
                        <p className="text-[11px] text-gray-500 font-bold uppercase tracking-widest">Route Planning</p>
                    </div>
                </div>
            </div>

            {/* ═══ ROUTING DISABLED BANNER ═══ */}
            {ROUTING_DISABLED && (
                <div className="mx-4 mb-2">
                    <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3 flex items-center gap-3">
                        <div className="p-2 bg-amber-500/15 rounded-lg shrink-0">
                            <svg className="w-5 h-5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                            </svg>
                        </div>
                        <div className="min-w-0">
                            <p className="text-xs font-bold text-amber-400 uppercase tracking-wider">Route Calculation Temporarily Disabled</p>
                            <p className="text-[11px] text-amber-300/60 mt-0.5">Awaiting Navionics / i-Boating chart SDK approval. OpenSeaMap overlay is active on the 4D map.</p>
                        </div>
                    </div>
                </div>
            )}

            {/* FULL SCREEN MAP MODAL - PORTALED TO ESCAPE TRANSFORMS */}
            {isMapOpen && createPortal(
                <div className="fixed inset-0 z-[2000] bg-slate-900 flex flex-col">
                    <div className="relative flex-1">
                        <MapHub
                            mapboxToken={mapboxToken}
                            pickerMode={!!mapSelectionTarget}
                            pickerLabel={mapSelectionTarget ? `Tap to select ${mapSelectionTarget === 'origin' ? 'Origin' : mapSelectionTarget === 'destination' ? 'Destination' : 'Via Waypoint'}` : undefined}
                            initialZoom={8}
                            center={voyagePlan?.originCoordinates ? { lat: voyagePlan.originCoordinates.lat, lon: voyagePlan.originCoordinates.lon } : undefined}
                            onLocationSelect={(lat, lon, name) => {
                                if (mapSelectionTarget) {
                                    const selectionName = name || `WP ${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(4)}°${lon >= 0 ? 'E' : 'W'}`;
                                    handleMapSelect(lat, lon, selectionName);
                                }
                            }}
                        />
                    </div>

                    <div className="absolute top-6 right-6 z-[2200]">
                        <button
                            onClick={() => { setIsMapOpen(false); setTempMapSelection(null); }}
                            aria-label="Close Map"
                            className="bg-slate-900/90 hover:bg-slate-800 text-white p-3 rounded-full shadow-2xl border border-white/20 transition-all hover:scale-110 active:scale-95"
                        >
                            <XIcon className="w-6 h-6" />
                        </button>
                    </div>
                </div>,
                document.body
            )}

            {/* Main content — fills between heading and bottom nav */}
            {voyagePlan ? (
                /* RESULTS VIEW — scrollable */
                <div className="flex-1 min-h-0 overflow-auto">
                    <div className="relative w-full max-w-[1600px] mx-auto pb-36 md:pb-40 px-2 md:px-6 flex flex-col font-sans">
                        {/* Form header for results view */}
                        <div className="relative z-40 pt-4 pb-4 px-2 md:px-2 bg-[#0f172a]/95 backdrop-blur-xl border-b border-white/5 shadow-2xl mb-8">
                            <div className="max-w-7xl mx-auto space-y-4">
                                <div className="flex justify-between items-center">
                                    <div className="flex items-center gap-3">
                                        <div className="p-2 bg-sky-500/10 rounded-lg border border-sky-500/20">
                                            {vessel?.type === 'power' ? <PowerBoatIcon className="w-5 h-5 text-sky-400" /> : <SailBoatIcon className="w-5 h-5 text-sky-400" />}
                                        </div>
                                        <div>
                                            <h2 className="text-sm font-bold text-white uppercase tracking-widest">Passage Plan</h2>
                                            <p className="text-[11px] text-gray-500 font-mono tracking-wide">
                                                {vessel?.name.toUpperCase() || "VESSEL"} // {vessel?.length}FT {vessel?.type.toUpperCase()}
                                            </p>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-3">
                                        {!isPro && (
                                            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-800 border border-white/10">
                                                <LockIcon className="w-3 h-3 text-sky-400" />
                                                <span className="text-[11px] font-bold text-white uppercase tracking-widest">Premium</span>
                                            </div>
                                        )}
                                        {spatiotemporalPayload && (
                                            <button
                                                onClick={() => setIs4DCanvasOpen(true)}
                                                className="flex items-center gap-2 px-4 py-2 rounded-xl border transition-all"
                                                style={{
                                                    background: 'rgba(0, 240, 255, 0.08)',
                                                    borderColor: 'rgba(0, 240, 255, 0.25)',
                                                    color: '#00f0ff',
                                                    textShadow: '0 0 8px rgba(0,240,255,0.3)',
                                                }}
                                                aria-label="Open 4D route visualization"
                                            >
                                                <MapIcon className="w-4 h-4" />
                                                <span className="text-[11px] font-bold uppercase tracking-widest">4D Route</span>
                                            </button>
                                        )}
                                        <button
                                            onClick={clearVoyagePlan}
                                            className="p-2 bg-slate-800/80 hover:bg-red-500/20 border border-white/10 rounded-xl text-gray-400 hover:text-red-400 transition-all"
                                            aria-label="Close voyage results"
                                        >
                                            <XIcon className="w-5 h-5" />
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {error && (
                            <div className="max-w-4xl mx-auto mb-8 w-full animate-in fade-in slide-in-from-top-4">
                                <div className="bg-red-500/10 border border-red-500/20 p-4 rounded-xl flex items-center gap-4 text-red-200 backdrop-blur-md">
                                    <div className="p-2 bg-red-500/20 rounded-full"><BugIcon className="w-5 h-5" /></div>
                                    <div><h4 className="font-bold text-sm uppercase">Calculation Error</h4><p className="text-xs opacity-80">{error}</p></div>
                                </div>
                            </div>
                        )}


                        <VoyageResults
                            voyagePlan={voyagePlan}
                            vessel={vessel || { name: 'Unknown', type: 'sail', length: 30, displacement: 5000, draft: 2, beam: 10, maxWindSpeed: 20, maxWaveHeight: 5, cruisingSpeed: 5 }}
                            checklistState={checklistState}
                            toggleCheck={toggleCheck}
                            deepReport={deepReport}
                            analyzingDeep={analyzingDeep}
                            handleDeepAnalysis={handleDeepAnalysis}
                            activeChecklistTab={activeChecklistTab}
                            setActiveChecklistTab={setActiveChecklistTab}
                            setIsMapOpen={setIsMapOpen}
                            isShortTrip={isShortTrip}
                        />
                    </div>
                </div>
            ) : (
                /* EMPTY STATE — rigid single-screen, no scroll */
                <div className="flex-1 min-h-0 flex flex-col overflow-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">

                    {/* ─── TOP: Form inputs anchored to top ─── */}
                    <form ref={formRef} onSubmit={ROUTING_DISABLED ? (e) => e.preventDefault() : handleCalculate} className="shrink-0 px-4 pt-4">
                        <div className={`max-w-xl mx-auto w-full space-y-3 ${ROUTING_DISABLED ? 'opacity-40 pointer-events-none' : ''}`}>
                            {/* Origin */}
                            <div className="relative group">
                                <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none text-emerald-400">
                                    <MapPinIcon className="w-4 h-4" />
                                </div>
                                <input type="text" value={origin} onChange={e => setOrigin(e.target.value)}
                                    placeholder="Type port name or tap map…"
                                    aria-label="Departure port or location"
                                    className="w-full h-12 bg-slate-900/50 border border-white/10 focus:border-sky-500/50 rounded-xl pl-12 pr-24 text-sm text-white font-medium placeholder-gray-500 outline-none transition-all shadow-inner" />
                                <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                                    <button type="button" onClick={() => openMap('origin')}
                                        className="p-2 text-gray-400 hover:text-sky-400 transition-colors hover:bg-white/10 rounded-lg" title="Select on Map" aria-label="Select origin on map">
                                        <MapIcon className="w-4 h-4" />
                                    </button>
                                    <button type="button" onClick={(e) => handleOriginLocation(e as React.MouseEvent<HTMLButtonElement>)}
                                        className="p-2 text-gray-400 hover:text-sky-400 transition-colors hover:bg-white/10 rounded-lg" title="Use Current Location" aria-label="Use Current Location">
                                        <CrosshairIcon className="w-4 h-4" />
                                    </button>
                                </div>
                            </div>

                            {/* Destination */}
                            <div className="relative group">
                                <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none text-purple-400">
                                    <MapPinIcon className="w-4 h-4" />
                                </div>
                                <input type="text" value={destination} onChange={e => setDestination(e.target.value)}
                                    placeholder="Type destination or tap map…"
                                    aria-label="Destination port or location"
                                    className="w-full h-12 bg-slate-900/50 border border-white/10 focus:border-sky-500/50 rounded-xl pl-12 pr-14 text-sm text-white font-medium placeholder-gray-500 outline-none transition-all shadow-inner" />
                                <div className="absolute right-2 top-1/2 -translate-y-1/2">
                                    <button type="button" onClick={() => openMap('destination')}
                                        className="p-2 text-gray-400 hover:text-sky-400 transition-colors hover:bg-white/10 rounded-lg" title="Select on Map" aria-label="Select destination on map">
                                        <MapIcon className="w-4 h-4" />
                                    </button>
                                </div>
                            </div>

                            {/* Via */}
                            <div className="relative group">
                                <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none text-sky-400">
                                    <RouteIcon className="w-4 h-4" />
                                </div>
                                <input type="text" value={via} onChange={e => setVia(e.target.value)}
                                    placeholder="Via waypoint (optional)"
                                    aria-label="Via waypoint"
                                    className="w-full h-12 bg-slate-900/50 border border-white/10 focus:border-sky-500/50 rounded-xl pl-12 pr-20 text-sm text-white font-medium placeholder-gray-500 outline-none transition-all shadow-inner" />
                                <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                                    <button type="button" onClick={() => openMap('via')}
                                        className="p-2 text-gray-400 hover:text-sky-400 transition-colors hover:bg-white/10 rounded-lg" title="Select on Map" aria-label="Select via point on map">
                                        <MapIcon className="w-4 h-4" />
                                    </button>
                                    {via && (
                                        <button type="button" onClick={() => setVia('')} aria-label="Clear Via Point"
                                            className="p-2 text-gray-500 hover:text-white transition-colors hover:bg-white/10 rounded-lg">
                                            <XIcon className="w-4 h-4" />
                                        </button>
                                    )}
                                </div>
                            </div>

                            {/* Date & Time row */}
                            <div className="grid grid-cols-2 gap-2.5">
                                <div className="relative w-full min-w-0 group">
                                    <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none text-gray-500 group-focus-within:text-sky-400 transition-colors">
                                        <CalendarIcon className="w-4 h-4" />
                                    </div>
                                    <input type="date" min={minDate} value={departureDate}
                                        onChange={(e) => { const d = e.target.value; if (!minDate || d >= minDate) setDepartureDate(d); }}
                                        aria-label="Departure date"
                                        className="w-full h-12 bg-slate-900/50 border border-white/10 focus:border-sky-500/50 rounded-xl pl-12 pr-3 text-sm text-white font-medium outline-none transition-all shadow-inner hover:bg-slate-900/80 appearance-none min-w-0"
                                        style={{ WebkitAppearance: 'none' }} />
                                </div>
                                <div className="relative w-full min-w-0 group">
                                    <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none text-gray-500 group-focus-within:text-emerald-400 transition-colors">
                                        <ClockIcon className="w-4 h-4" />
                                    </div>
                                    <input type="time" value={departureTime}
                                        onChange={(e) => setDepartureTime(e.target.value)}
                                        aria-label="Departure time"
                                        className="w-full h-12 bg-slate-900/50 border border-white/10 focus:border-emerald-500/50 rounded-xl pl-12 pr-3 text-sm text-white font-medium outline-none transition-all shadow-inner hover:bg-slate-900/80 appearance-none min-w-0"
                                        style={{ WebkitAppearance: 'none' }} />
                                </div>
                            </div>

                            {/* AI Suggest Optimal Departure */}
                            <button
                                type="button"
                                disabled={!origin || !destination || suggestingDeparture}
                                onClick={async () => {
                                    if (!origin || !destination) return;
                                    setSuggestingDeparture(true);
                                    setSuggestedReasoning(null);
                                    try {
                                        const { fetchVoyagePlan } = await import('../services/geminiService');
                                        const dummyVessel = vessel || { name: 'Vessel', type: 'sail' as const, length: 30, displacement: 5000, draft: 2, beam: 10, maxWindSpeed: 20, maxWaveHeight: 5, cruisingSpeed: 6 };

                                        // Fetch weather context for smarter departure suggestion
                                        let weatherCtx: Record<string, unknown> | undefined;
                                        try {
                                            const coordMatch = origin.match(/\(([+-]?\d+\.?\d*),\s*([+-]?\d+\.?\d*)\)/);
                                            if (coordMatch) {
                                                const { fetchFastWeather } = await import('../services/weatherService');
                                                const wx = await fetchFastWeather("Departure-Context", {
                                                    lat: parseFloat(coordMatch[1]),
                                                    lon: parseFloat(coordMatch[2]),
                                                });
                                                if (wx) {
                                                    weatherCtx = {
                                                        current: wx.current,
                                                        tides: wx.tides?.slice(0, 8),
                                                        forecastSample: wx.hourly?.slice(0, 48).map((h) => ({
                                                            time: h.time,
                                                            wind: h.windSpeed,
                                                            gust: h.windGust,
                                                            wave: h.waveHeight,
                                                            dir: h.windDirection,
                                                        })),
                                                    };
                                                }
                                            }
                                        } catch (e) { console.warn('[RoutePlanner] non-critical:', e); }

                                        const result = await fetchVoyagePlan(origin, destination, dummyVessel, departureDate, undefined, undefined, undefined, weatherCtx);
                                        if (result.bestDepartureWindow) {
                                            const bdw = result.bestDepartureWindow;

                                            // Primary: parse the ISO datetime (new precise field)
                                            if (bdw.dateTimeISO) {
                                                try {
                                                    const dt = new Date(bdw.dateTimeISO);
                                                    if (!isNaN(dt.getTime())) {
                                                        setDepartureDate(dt.toISOString().split('T')[0]);
                                                        setDepartureTime(
                                                            `${String(dt.getUTCHours()).padStart(2, '0')}:${String(dt.getUTCMinutes()).padStart(2, '0')}`
                                                        );
                                                    }
                                                } catch (e) { console.warn('[RoutePlanner] fallthrough:', e); }
                                            }

                                            // Fallback: parse timeRange for the time only
                                            if (!bdw.dateTimeISO) {
                                                const timeMatch = bdw.timeRange?.match(/(\d{1,2}):?(\d{2})?\s*(am|pm)?/i);
                                                if (timeMatch) {
                                                    let hr = parseInt(timeMatch[1]);
                                                    const min = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
                                                    if (timeMatch[3]?.toLowerCase() === 'pm' && hr < 12) hr += 12;
                                                    if (timeMatch[3]?.toLowerCase() === 'am' && hr === 12) hr = 0;
                                                    setDepartureTime(`${String(hr).padStart(2, '0')}:${String(min).padStart(2, '0')}`);
                                                }
                                            }

                                            // Show reasoning with the suggested date
                                            const dateStr = bdw.dateTimeISO
                                                ? new Date(bdw.dateTimeISO).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
                                                : '';
                                            const prefix = dateStr ? `📅 ${dateStr}\n` : '';
                                            setSuggestedReasoning(`${prefix}${bdw.reasoning || ''}`);
                                        }
                                    } catch (e) {
                                        console.error('[DepartureSuggest] Error:', e);
                                    }
                                    setSuggestingDeparture(false);
                                }}
                                className="w-full h-10 bg-gradient-to-r from-emerald-500/10 to-sky-500/10 border border-emerald-500/20 rounded-xl flex items-center justify-center gap-2 text-emerald-300 hover:from-emerald-500/20 hover:to-sky-500/20 transition-all active:scale-[0.98] disabled:opacity-30 disabled:cursor-not-allowed"
                            >
                                {suggestingDeparture ? (
                                    <span className="text-xs font-bold uppercase tracking-widest animate-pulse">Analysing 10-Day Forecast…</span>
                                ) : (
                                    <>
                                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
                                        </svg>
                                        <span className="text-xs font-bold uppercase tracking-widest">Suggest Optimal Departure</span>
                                    </>
                                )}
                            </button>

                            {/* AI Reasoning display */}
                            {suggestedReasoning && (
                                <div className="bg-emerald-500/5 border border-emerald-500/15 rounded-xl px-3 py-2 animate-in fade-in slide-in-from-top-2">
                                    <p className="text-[11px] text-emerald-300/80 leading-relaxed whitespace-pre-line">
                                        <span className="font-bold text-emerald-300">⚡ AI: </span>{suggestedReasoning}
                                    </p>
                                </div>
                            )}
                        </div>

                        {/* Loading overlay */}
                        {loading && (
                            <div className="flex justify-center py-3 animate-in fade-in z-50">
                                <div className="flex items-center gap-3 px-6 py-3 bg-slate-900/90 backdrop-blur-md border border-sky-500/30 rounded-full shadow-[0_0_25px_rgba(14,165,233,0.15)]">
                                    <span className="text-xs text-sky-300 font-mono tracking-wide">{LOADING_PHASES[loadingStep]}</span>
                                    <div className="flex gap-1">
                                        <div className="w-1.5 h-1.5 bg-sky-400 rounded-full animate-bounce [animation-delay:-0.3s]"></div>
                                        <div className="w-1.5 h-1.5 bg-sky-400 rounded-full animate-bounce [animation-delay:-0.15s]"></div>
                                        <div className="w-1.5 h-1.5 bg-sky-400 rounded-full animate-bounce"></div>
                                    </div>
                                </div>
                            </div>
                        )}

                        {error && (
                            <div className="max-w-xl mx-auto mt-2 w-full animate-in fade-in slide-in-from-top-4">
                                <div className="bg-red-500/10 border border-red-500/20 p-4 rounded-xl flex items-center gap-4 text-red-200 backdrop-blur-md">
                                    <div className="p-2 bg-red-500/20 rounded-full"><BugIcon className="w-5 h-5" /></div>
                                    <div><h4 className="font-bold text-sm uppercase">Calculation Error</h4><p className="text-xs opacity-80">{error}</p></div>
                                </div>
                            </div>
                        )}
                    </form>

                    {/* ─── FLEXIBLE SPACER — absorbs all remaining height ─── */}
                    <div className="flex-grow" />

                    {/* ─── BOTTOM: CTA pinned, exact 8px above nav bar ─── */}
                    <div className="shrink-0 px-4" style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}>
                        <div className="max-w-xl mx-auto w-full">
                            {/* Active vessel indicator */}
                            {vessel && (
                                <div className="flex items-center justify-center gap-2 mb-2 opacity-60">
                                    {vessel.type === 'power' ? <PowerBoatIcon className="w-3.5 h-3.5 text-slate-500" /> : <SailBoatIcon className="w-3.5 h-3.5 text-slate-500" />}
                                    <span className="text-[11px] font-mono text-slate-500 tracking-wide">
                                        Active Vessel: {vessel.name}
                                    </span>
                                </div>
                            )}
                            {ROUTING_DISABLED ? (
                                <div className="h-14 w-full rounded-2xl font-bold uppercase tracking-wider text-xs flex items-center justify-center gap-3 bg-amber-500/10 border border-amber-500/20 text-amber-400">
                                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                                    </svg>
                                    Coming Soon — Awaiting Chart SDK
                                </div>
                            ) : !isPro ? (
                                <button
                                    type="button"
                                    onClick={onTriggerUpgrade}
                                    className="h-14 w-full rounded-2xl font-bold uppercase tracking-wider text-xs transition-all shadow-lg flex items-center justify-center gap-2 bg-slate-800 text-white hover:bg-slate-700"
                                >
                                    <LockIcon className="w-4 h-4 text-emerald-400" />
                                    Unlock Route Planning
                                </button>
                            ) : (
                                <SlideToAction
                                    label="Slide to Calculate Route"
                                    thumbIcon={<CompassIcon className="w-5 h-5 text-white" rotation={0} />}
                                    onConfirm={() => formRef.current?.requestSubmit()}
                                    loading={loading}
                                    loadingText={LOADING_PHASES[loadingStep] || 'Calculating…'}
                                    theme="emerald"
                                />
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
