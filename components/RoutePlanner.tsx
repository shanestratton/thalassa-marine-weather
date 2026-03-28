import React, { useState, useEffect, useRef } from 'react';
import { createLogger } from '../utils/createLogger';

const log = createLogger('RoutePlanner');
import { createPortal } from 'react-dom';
import {
    MapPinIcon,
    MapIcon,
    XIcon,
    LockIcon,
    CompassIcon,
    CrosshairIcon,
    CalendarIcon,
    ClockIcon,
    SailBoatIcon,
    PowerBoatIcon,
} from './Icons';
import { SlideToAction } from './ui/SlideToAction';
import { MapHub } from './map/MapHub';
import { useVoyageForm, LOADING_PHASES } from '../hooks/useVoyageForm';
import { useUI } from '../context/UIContext';
import { scrollInputAboveKeyboard } from '../utils/keyboardScroll';

export const RoutePlanner: React.FC<{ onTriggerUpgrade: () => void; onBack?: () => void }> = ({
    onTriggerUpgrade,
    onBack,
}) => {
    const {
        origin,
        setOrigin,
        destination,
        setDestination,
        departureDate,
        setDepartureDate,
        isMapOpen,
        setIsMapOpen,
        mapSelectionTarget,
        loading,
        loadingStep,
        error,
        minDate,

        handleCalculate,
        clearVoyagePlan,
        handleOriginLocation,
        handleMapSelect,
        openMap,

        voyagePlan,
        vessel,
        isPro,
        mapboxToken,
    } = useVoyageForm(onTriggerUpgrade);

    const [departureTime, setDepartureTime] = useState('06:00');
    const formRef = React.useRef<HTMLFormElement>(null);

    const [_tempMapSelection, setTempMapSelection] = useState<{ lat: number; lon: number; name: string } | null>(null);
    const { setPage } = useUI();

    // ── Auto-Calculate: trigger when both inputs have values ──
    const autoCalcTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastCalcRef = useRef<string>('');

    useEffect(() => {
        // Only auto-calc when we have both, user is pro, and not already loading
        if (!origin.trim() || !destination.trim() || !isPro || loading) return;

        const calcKey = `${origin}||${destination}`;
        if (calcKey === lastCalcRef.current) return; // Already calculated this combo

        // Debounce: wait 1.2s after last keystroke before firing
        if (autoCalcTimerRef.current) clearTimeout(autoCalcTimerRef.current);
        autoCalcTimerRef.current = setTimeout(() => {
            lastCalcRef.current = calcKey;
            handleCalculate();
        }, 1200);

        return () => {
            if (autoCalcTimerRef.current) clearTimeout(autoCalcTimerRef.current);
        };
    }, [origin, destination, isPro, loading, handleCalculate]);

    return (
        <div className="relative flex-1 bg-slate-950 overflow-hidden flex flex-col">
            {/* ═══ HEADER ═══ */}
            <div className="shrink-0 px-4 pt-4 pb-3">
                <div className="flex items-center gap-3">
                    {onBack && (
                        <button
                            onClick={onBack}
                            aria-label="Go back"
                            className="p-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors"
                        >
                            <svg
                                className="w-5 h-5 text-gray-400"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2}
                            >
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                            </svg>
                        </button>
                    )}
                    <div className="flex-1">
                        <h1 className="text-xl font-extrabold text-white uppercase tracking-wider">Route Planner</h1>
                    </div>
                    {/* Clear / New Route when results exist */}
                    {voyagePlan && (
                        <button
                            onClick={() => {
                                clearVoyagePlan();
                                lastCalcRef.current = '';
                            }}
                            className="p-2 bg-slate-800/80 hover:bg-red-500/20 border border-white/10 rounded-xl text-gray-400 hover:text-red-400 transition-all"
                            aria-label="Clear route"
                        >
                            <XIcon className="w-5 h-5" />
                        </button>
                    )}
                </div>
            </div>

            {/* FULL SCREEN MAP MODAL - PORTALED TO ESCAPE TRANSFORMS */}
            {isMapOpen &&
                createPortal(
                    <div className="fixed inset-0 z-[2000] bg-slate-900 flex flex-col">
                        <div className="relative flex-1">
                            <MapHub
                                mapboxToken={mapboxToken}
                                pickerMode={!!mapSelectionTarget}
                                pickerLabel={
                                    mapSelectionTarget
                                        ? `Tap to select ${mapSelectionTarget === 'origin' ? 'Origin' : 'Destination'}`
                                        : undefined
                                }
                                initialZoom={8}
                                center={
                                    voyagePlan?.originCoordinates
                                        ? {
                                              lat: voyagePlan.originCoordinates.lat,
                                              lon: voyagePlan.originCoordinates.lon,
                                          }
                                        : undefined
                                }
                                onLocationSelect={(lat, lon, name) => {
                                    if (mapSelectionTarget) {
                                        const selectionName =
                                            name ||
                                            `WP ${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(4)}°${lon >= 0 ? 'E' : 'W'}`;
                                        handleMapSelect(lat, lon, selectionName);
                                    }
                                }}
                            />
                        </div>

                        <div className="absolute top-6 left-4 z-[2200]">
                            <button
                                onClick={() => {
                                    setIsMapOpen(false);
                                    setTempMapSelection(null);
                                }}
                                aria-label="Back"
                                className="bg-slate-900/90 hover:bg-slate-800 text-white p-3 rounded-full shadow-2xl border border-white/20 transition-all hover:scale-110 active:scale-95"
                            >
                                <svg
                                    className="w-6 h-6"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={2}
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="M15.75 19.5L8.25 12l7.5-7.5"
                                    />
                                </svg>
                            </button>
                        </div>
                    </div>,
                    document.body,
                )}

            {/* ═══ FORM INPUTS — always visible at top ═══ */}
            <div className="shrink-0 px-4 pb-3">
                <div className="max-w-xl mx-auto w-full space-y-2.5">
                    {/* Origin */}
                    <div className="relative group">
                        <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none text-emerald-400">
                            <MapPinIcon className="w-4 h-4" />
                        </div>
                        <input
                            type="text"
                            value={origin}
                            onChange={(e) => setOrigin(e.target.value)}
                            onFocus={scrollInputAboveKeyboard}
                            placeholder="Type departure port or tap map…"
                            aria-label="Departure port or location"
                            className="w-full h-12 bg-slate-900/50 border border-white/10 focus:border-sky-500/50 rounded-xl pl-12 pr-24 text-sm text-white font-medium placeholder-gray-500 outline-none transition-all shadow-inner"
                        />
                        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                            <button
                                type="button"
                                onClick={() => openMap('origin')}
                                className="p-2 text-gray-400 hover:text-sky-400 transition-colors hover:bg-white/10 rounded-lg"
                                title="Select on Map"
                                aria-label="Select origin on map"
                            >
                                <MapIcon className="w-4 h-4" />
                            </button>
                            <button
                                type="button"
                                onClick={(e) => handleOriginLocation(e as React.MouseEvent<HTMLButtonElement>)}
                                className="p-2 text-gray-400 hover:text-sky-400 transition-colors hover:bg-white/10 rounded-lg"
                                title="Use Current Location"
                                aria-label="Use Current Location"
                            >
                                <CrosshairIcon className="w-4 h-4" />
                            </button>
                        </div>
                    </div>

                    {/* Destination */}
                    <div className="relative group">
                        <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none text-purple-400">
                            <MapPinIcon className="w-4 h-4" />
                        </div>
                        <input
                            type="text"
                            value={destination}
                            onChange={(e) => setDestination(e.target.value)}
                            onFocus={scrollInputAboveKeyboard}
                            placeholder="Type destination or tap map…"
                            aria-label="Destination port or location"
                            className="w-full h-12 bg-slate-900/50 border border-white/10 focus:border-sky-500/50 rounded-xl pl-12 pr-14 text-sm text-white font-medium placeholder-gray-500 outline-none transition-all shadow-inner"
                        />
                        <div className="absolute right-2 top-1/2 -translate-y-1/2">
                            <button
                                type="button"
                                onClick={() => openMap('destination')}
                                className="p-2 text-gray-400 hover:text-sky-400 transition-colors hover:bg-white/10 rounded-lg"
                                title="Select on Map"
                                aria-label="Select destination on map"
                            >
                                <MapIcon className="w-4 h-4" />
                            </button>
                        </div>
                    </div>

                    {/* Date & Time row */}
                    <div className="grid grid-cols-2 gap-2.5">
                        <div className="relative w-full min-w-0 group">
                            <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none text-gray-400 group-focus-within:text-sky-400 transition-colors">
                                <CalendarIcon className="w-4 h-4" />
                            </div>
                            <input
                                type="date"
                                min={minDate}
                                value={departureDate}
                                onChange={(e) => {
                                    const d = e.target.value;
                                    if (!minDate || d >= minDate) setDepartureDate(d);
                                }}
                                onFocus={scrollInputAboveKeyboard}
                                aria-label="Departure date"
                                className="w-full h-12 bg-slate-900/50 border border-white/10 focus:border-sky-500/50 rounded-xl pl-12 pr-3 text-sm text-white font-medium outline-none transition-all shadow-inner hover:bg-slate-900/80 appearance-none min-w-0"
                                style={{ WebkitAppearance: 'none' }}
                            />
                        </div>
                        <div className="relative w-full min-w-0 group">
                            <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none text-gray-400 group-focus-within:text-emerald-400 transition-colors">
                                <ClockIcon className="w-4 h-4" />
                            </div>
                            <input
                                type="time"
                                value={departureTime}
                                onChange={(e) => setDepartureTime(e.target.value)}
                                onFocus={scrollInputAboveKeyboard}
                                aria-label="Departure time"
                                className="w-full h-12 bg-slate-900/50 border border-white/10 focus:border-emerald-500/50 rounded-xl pl-12 pr-3 text-sm text-white font-medium outline-none transition-all shadow-inner hover:bg-slate-900/80 appearance-none min-w-0"
                                style={{ WebkitAppearance: 'none' }}
                            />
                        </div>
                    </div>
                </div>
            </div>

            {/* ═══ LOADING INDICATOR ═══ */}
            {loading && (
                <div className="shrink-0 flex justify-center py-2 animate-in fade-in z-10">
                    <div className="flex items-center gap-3 px-6 py-2.5 bg-slate-900/90 border border-sky-500/30 rounded-full shadow-[0_0_25px_rgba(14,165,233,0.15)]">
                        <span className="text-xs text-sky-300 font-mono tracking-wide">
                            {LOADING_PHASES[loadingStep]}
                        </span>
                        <div className="flex gap-1">
                            <div className="w-1.5 h-1.5 bg-sky-400 rounded-full animate-bounce [animation-delay:-0.3s]"></div>
                            <div className="w-1.5 h-1.5 bg-sky-400 rounded-full animate-bounce [animation-delay:-0.15s]"></div>
                            <div className="w-1.5 h-1.5 bg-sky-400 rounded-full animate-bounce"></div>
                        </div>
                    </div>
                </div>
            )}

            {/* ═══ ERROR ═══ */}
            {error && (
                <div className="shrink-0 px-4 pb-2">
                    <div className="max-w-xl mx-auto bg-red-500/10 border border-red-500/20 p-3 rounded-xl flex items-center gap-3 text-red-200 animate-in fade-in">
                        <span className="text-base">⚠️</span>
                        <p className="text-xs flex-1">{error}</p>
                    </div>
                </div>
            )}

            {/* ═══ MAP — fills remaining space ═══ */}
            <div className="flex-1 min-h-0 relative">
                {voyagePlan ? (
                    <>
                        {/* Route summary overlay */}
                        <div className="absolute top-3 left-3 right-3 z-10 pointer-events-none">
                            <div className="pointer-events-auto inline-flex items-center gap-3 px-4 py-2.5 rounded-xl bg-slate-900/90 border border-white/10 backdrop-blur-sm shadow-2xl">
                                <div className="flex items-center gap-2">
                                    <div className="w-2 h-2 rounded-full bg-emerald-400" />
                                    <span className="text-[11px] font-bold text-white truncate max-w-[120px]">
                                        {voyagePlan.origin}
                                    </span>
                                </div>
                                <svg
                                    className="w-4 h-4 text-gray-500 shrink-0"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={2}
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3"
                                    />
                                </svg>
                                <div className="flex items-center gap-2">
                                    <div className="w-2 h-2 rounded-full bg-purple-400" />
                                    <span className="text-[11px] font-bold text-white truncate max-w-[120px]">
                                        {voyagePlan.destination}
                                    </span>
                                </div>
                                {voyagePlan.distanceApprox && (
                                    <span className="ml-1 px-2 py-0.5 rounded-full bg-sky-500/10 text-sky-400 text-[10px] font-bold border border-sky-500/15">
                                        {voyagePlan.distanceApprox}
                                    </span>
                                )}
                                {voyagePlan.durationApprox && (
                                    <span className="px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 text-[10px] font-bold border border-amber-500/15">
                                        {voyagePlan.durationApprox}
                                    </span>
                                )}
                                {/* View on main map */}
                                <button
                                    onClick={() => {
                                        const detail: Record<string, unknown> = {};
                                        if (voyagePlan.originCoordinates) {
                                            detail.departure = {
                                                lat: voyagePlan.originCoordinates.lat,
                                                lon: voyagePlan.originCoordinates.lon,
                                                name: origin,
                                            };
                                        }
                                        if (voyagePlan.destinationCoordinates) {
                                            detail.arrival = {
                                                lat: voyagePlan.destinationCoordinates.lat,
                                                lon: voyagePlan.destinationCoordinates.lon,
                                                name: destination,
                                            };
                                        }
                                        log.info('[ViewOnMap] Passing coords:', JSON.stringify(detail));
                                        setPage('map');
                                        setTimeout(() => {
                                            window.dispatchEvent(new CustomEvent('thalassa:passage-mode', { detail }));
                                        }, 200);
                                    }}
                                    className="ml-auto p-1.5 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/20 text-emerald-400 transition-all"
                                    aria-label="Open on main map"
                                    title="Open on main map"
                                >
                                    <CompassIcon className="w-4 h-4" rotation={0} />
                                </button>
                            </div>
                        </div>

                        {/* Inline route map */}
                        <MapHub
                            mapboxToken={mapboxToken}
                            pickerMode={false}
                            embedded
                            initialZoom={5}
                            center={
                                voyagePlan.originCoordinates
                                    ? {
                                          lat: voyagePlan.originCoordinates.lat,
                                          lon: voyagePlan.originCoordinates.lon,
                                      }
                                    : undefined
                            }
                        />
                    </>
                ) : (
                    /* Empty state — subtle map placeholder */
                    <div className="w-full h-full bg-slate-950" />
                )}
            </div>

            {/* ─── BOTTOM: CTA pinned above nav bar ─── */}
            {!voyagePlan && (
                <div
                    className="fixed bottom-0 left-0 right-0 px-4 z-10 pointer-events-none"
                    style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}
                >
                    <div className="max-w-xl mx-auto w-full pointer-events-auto">
                        {/* Active vessel indicator */}
                        {vessel && (
                            <div className="flex items-center justify-center gap-2 mb-2 opacity-60">
                                {vessel.type === 'power' ? (
                                    <PowerBoatIcon className="w-3.5 h-3.5 text-slate-400" />
                                ) : (
                                    <SailBoatIcon className="w-3.5 h-3.5 text-slate-400" />
                                )}
                                <span className="text-[11px] font-mono text-slate-400 tracking-wide">
                                    Active Vessel: {vessel.name}
                                </span>
                            </div>
                        )}
                        {!isPro ? (
                            <button
                                aria-label="Trigger Upgrade"
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
                                onConfirm={() => {
                                    lastCalcRef.current = '';
                                    handleCalculate();
                                }}
                                loading={loading}
                                loadingText={LOADING_PHASES[loadingStep] || 'Calculating…'}
                                theme="emerald"
                            />
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};
