import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
    MapPinIcon, MapIcon, RouteIcon, CalendarIcon,
    CrosshairIcon, XIcon, ClockIcon, LockIcon, BugIcon, CompassIcon,
    PowerBoatIcon, SailBoatIcon, AnchorIcon
} from './Icons';
import { WeatherMap } from './WeatherMap';
import { SlideToAction } from './ui/SlideToAction';
import { VoyageResults } from './VoyageResults';
import { useVoyageForm, LOADING_PHASES } from '../hooks/useVoyageForm';
import { t } from '../theme';



export const RoutePlanner: React.FC<{ onTriggerUpgrade: () => void }> = ({ onTriggerUpgrade }) => {
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
    const formRef = React.useRef<HTMLFormElement>(null);

    return (
        <div className={`h-full ${t.colors.bg.base} flex flex-col overflow-hidden`}>
            {/* Page heading — transparent, sits on deep navy */}
            <div className="px-4 py-2 shrink-0">
                <div className="flex items-center gap-2.5">
                    <span className={t.typography.pageTitle}>Passage Planning</span>
                </div>
            </div>

            {/* FULL SCREEN MAP MODAL - PORTALED TO ESCAPE TRANSFORMS */}
            {isMapOpen && createPortal(
                <div className="fixed inset-0 z-[2000] bg-slate-900 flex flex-col">
                    <div className="relative flex-1">
                        <WeatherMap
                            locationName={mapSelectionTarget ? (tempMapSelection?.name || `Select ${mapSelectionTarget === 'origin' ? 'Start' : mapSelectionTarget === 'destination' ? 'End' : 'Via'} Location`) : (origin || "Route Map")}
                            lat={voyagePlan?.originCoordinates?.lat}
                            lon={voyagePlan?.originCoordinates?.lon}
                            routeCoordinates={routeCoords}
                            waypoints={voyagePlan?.waypoints}
                            minimal={!mapSelectionTarget}
                            enableZoom={true}
                            showWeather={false}
                            mapboxToken={mapboxToken}
                            showZoomControl={false}
                            restrictBounds={false}
                            initialLayer={mapSelectionTarget ? 'buoys' : 'wind'}
                            isConfirmMode={false}
                            hideLayerControls={false}
                            onLocationSelect={(lat, lon, name) => {
                                const latStr = Math.abs(lat).toFixed(4) + '°' + (lat >= 0 ? 'N' : 'S');
                                const lonStr = Math.abs(lon).toFixed(4) + '°' + (lon >= 0 ? 'E' : 'W');
                                const selectionName = name || `WP ${latStr}, ${lonStr}`;
                                setTempMapSelection({ lat, lon, name: selectionName });
                            }}
                        />

                        {mapSelectionTarget && (
                            <div className="fixed bottom-12 left-0 right-0 z-[11000] px-6 pointer-events-none flex justify-center w-full">
                                <div className="pointer-events-auto w-full max-w-md">
                                    <button
                                        onClick={() => {
                                            if (tempMapSelection) {
                                                handleMapSelect(tempMapSelection.lat, tempMapSelection.lon, tempMapSelection.name);
                                            }
                                        }}
                                        disabled={!tempMapSelection}
                                        aria-label="Confirm Map Selection"
                                        className={`w-full font-bold py-4 px-6 rounded-xl shadow-2xl flex items-center justify-center gap-2 border transition-all ${tempMapSelection ? 'bg-sky-500 hover:bg-sky-400 text-white border-transparent scale-105' : 'bg-slate-800/90 backdrop-blur-md text-gray-500 border-white/10'}`}
                                        style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
                                    >
                                        <MapPinIcon className={`w-5 h-5 ${tempMapSelection ? 'text-white' : 'text-gray-600'}`} />
                                        {tempMapSelection ? "Confirm Selection" : "Tap Map to Select Point"}
                                    </button>
                                </div>
                            </div>
                        )}
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
                                            <p className="text-[10px] text-gray-500 font-mono tracking-wide">
                                                {vessel?.name.toUpperCase() || "VESSEL"} // {vessel?.length}FT {vessel?.type.toUpperCase()}
                                            </p>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-3">
                                        {!isPro && (
                                            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-800 border border-white/10">
                                                <LockIcon className="w-3 h-3 text-sky-400" />
                                                <span className="text-[10px] font-bold text-white uppercase tracking-widest">Premium</span>
                                            </div>
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
                /* EMPTY STATE — single screen, no scroll */
                <form ref={formRef} onSubmit={handleCalculate} className="flex-1 flex flex-col min-h-0 px-4">
                    {/* Form inputs at top */}
                    <div className="pt-4 space-y-3 max-w-xl mx-auto w-full">
                        {/* Origin */}
                        <div className="relative group">
                            <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none text-emerald-400">
                                <MapPinIcon className="w-4 h-4" />
                            </div>
                            <input type="text" value={origin} onChange={e => setOrigin(e.target.value)}
                                placeholder="Type port name or tap map…"
                                className="w-full h-12 bg-slate-900/50 border border-white/10 focus:border-sky-500/50 rounded-xl pl-12 pr-24 text-sm text-white font-medium placeholder-gray-600 outline-none transition-all shadow-inner" />
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
                                className="w-full h-12 bg-slate-900/50 border border-white/10 focus:border-sky-500/50 rounded-xl pl-12 pr-14 text-sm text-white font-medium placeholder-gray-600 outline-none transition-all shadow-inner" />
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
                                className="w-full h-12 bg-slate-900/50 border border-white/10 focus:border-sky-500/50 rounded-xl pl-12 pr-20 text-sm text-white font-medium placeholder-gray-600 outline-none transition-all shadow-inner" />
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
                        <div className="grid grid-cols-2 gap-3">
                            <div className="relative w-full min-w-0 group">
                                <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none text-gray-500 group-focus-within:text-sky-400 transition-colors">
                                    <CalendarIcon className="w-4 h-4" />
                                </div>
                                <input type="date" min={minDate} value={departureDate}
                                    onChange={(e) => { const d = e.target.value; if (!minDate || d >= minDate) setDepartureDate(d); }}
                                    className="w-full h-12 bg-slate-900/50 border border-white/10 focus:border-sky-500/50 rounded-xl pl-12 pr-3 text-sm text-white font-medium outline-none transition-all shadow-inner hover:bg-slate-900/80 appearance-none min-w-0"
                                    style={{ WebkitAppearance: 'none' }} />
                            </div>
                            <div className="relative w-full min-w-0 group">
                                <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none text-gray-500 group-focus-within:text-teal-400 transition-colors">
                                    <ClockIcon className="w-4 h-4" />
                                </div>
                                <input type="time" value={departureTime}
                                    onChange={(e) => setDepartureTime(e.target.value)}
                                    className="w-full h-12 bg-slate-900/50 border border-white/10 focus:border-teal-500/50 rounded-xl pl-12 pr-3 text-sm text-white font-medium outline-none transition-all shadow-inner hover:bg-slate-900/80 appearance-none min-w-0"
                                    style={{ WebkitAppearance: 'none' }} />
                            </div>
                        </div>
                    </div>

                    {/* Hero text — vertically centered in remaining space */}
                    <div className="flex-1 flex items-center justify-center">
                        <div className="text-center animate-in fade-in zoom-in-95 duration-700">
                            <h1 className="text-3xl md:text-5xl font-black text-white tracking-tighter mb-3 drop-shadow-2xl">
                                {loading ? (
                                    <span className="animate-pulse text-transparent bg-clip-text bg-gradient-to-r from-teal-300 to-white">Plotting Course...</span>
                                ) : (
                                    <>Plot Your <span className="text-transparent bg-clip-text bg-gradient-to-r from-teal-400 to-cyan-200">Passage</span></>
                                )}
                            </h1>
                            {!loading && (
                                <p className="text-base text-slate-400 max-w-sm mx-auto leading-relaxed">
                                    Enter your origin and destination to generate a tactical passage plan with real-time meteorology.
                                </p>
                            )}
                        </div>
                    </div>

                    {/* Loading overlay */}
                    {loading && (
                        <div className="flex justify-center mb-4 animate-in fade-in z-50">
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
                        <div className="max-w-xl mx-auto mb-4 w-full animate-in fade-in slide-in-from-top-4">
                            <div className="bg-red-500/10 border border-red-500/20 p-4 rounded-xl flex items-center gap-4 text-red-200 backdrop-blur-md">
                                <div className="p-2 bg-red-500/20 rounded-full"><BugIcon className="w-5 h-5" /></div>
                                <div><h4 className="font-bold text-sm uppercase">Calculation Error</h4><p className="text-xs opacity-80">{error}</p></div>
                            </div>
                        </div>
                    )}

                    {/* Active vessel indicator */}
                    {vessel && (
                        <div className="max-w-xl mx-auto w-full flex items-center justify-center gap-2 mb-2 opacity-60">
                            {vessel.type === 'power' ? <PowerBoatIcon className="w-3.5 h-3.5 text-slate-500" /> : <SailBoatIcon className="w-3.5 h-3.5 text-slate-500" />}
                            <span className="text-[11px] font-mono text-slate-500 tracking-wide">
                                Active Vessel: {vessel.name}
                            </span>
                        </div>
                    )}

                    {/* Calculate Route slider — pinned 8px above menu bar */}
                    <div className="pb-[calc(8px+env(safe-area-inset-bottom))] mb-[72px] max-w-xl mx-auto w-full">
                        {!isPro ? (
                            <button
                                type="button"
                                onClick={onTriggerUpgrade}
                                className="h-14 w-full rounded-2xl font-bold uppercase tracking-wider text-xs transition-all shadow-lg flex items-center justify-center gap-2 bg-slate-800 text-white hover:bg-slate-700"
                            >
                                <LockIcon className="w-4 h-4 text-teal-400" />
                                Unlock Route Planning
                            </button>
                        ) : (
                            <SlideToAction
                                label="Slide to Calculate Route"
                                thumbIcon={<CompassIcon className="w-5 h-5 text-white" rotation={0} />}
                                onConfirm={() => formRef.current?.requestSubmit()}
                                loading={loading}
                                loadingText={LOADING_PHASES[loadingStep] || 'Calculating…'}
                                theme="teal"
                            />
                        )}
                    </div>
                </form>
            )}
        </div>
    );
};
