import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
    MapPinIcon, MapIcon, RouteIcon, CalendarIcon,
    CrosshairIcon, XIcon, ClockIcon, LockIcon, BugIcon, CompassIcon,
    PowerBoatIcon, SailBoatIcon
} from './Icons';
import { WeatherMap } from './WeatherMap';
import { VoyageResults } from './VoyageResults';
import { useVoyageForm, LOADING_PHASES } from '../hooks/useVoyageForm';

// Sea Quotes
const SEA_QUOTES = [
    { text: "The pessimist complains about the wind; the optimist expects it to change; the realist adjusts the sails.", author: "William Arthur Ward" },
    { text: "At sea, I learned how little a person needs, not how much.", author: "Robin Lee Graham" },
    { text: "The cure for anything is salt water: sweat, tears or the sea.", author: "Isak Dinesen" },
    { text: "Man cannot discover new oceans unless he has the courage to lose sight of the shore.", author: "André Gide" },
    { text: "There is nothing - absolutely nothing - half so much worth doing as simply messing about in boats.", author: "Kenneth Grahame" },
    { text: "The sea, once it casts its spell, holds one in its net of wonder forever.", author: "Jacques Cousteau" }
];

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

    const [quote, setQuote] = useState(SEA_QUOTES[0]);
    const [tempMapSelection, setTempMapSelection] = useState<{ lat: number, lon: number, name: string } | null>(null);

    useEffect(() => { setQuote(SEA_QUOTES[Math.floor(Math.random() * SEA_QUOTES.length)]); }, []);

    return (
        <div className="w-full max-w-[1600px] mx-auto pb-36 md:pb-40 px-2 md:px-6 flex flex-col min-h-full font-sans">


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
                            isConfirmMode={false} // DISABLE INTERNAL BUTTON
                            hideLayerControls={false}
                            onLocationSelect={(lat, lon, name) => {
                                // INTERCEPT: Update local temp state instead of closing
                                const selectionName = name || `WP ${lat.toFixed(4)}, ${lon.toFixed(4)}`;
                                setTempMapSelection({ lat, lon, name: selectionName });
                            }}
                        />

                        {/* EXTERNAL OVERLAY BUTTON - FIXED & HIGH Z-INDEX */}
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
                                        style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }} // Extra safe area padding
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

            {/* HEADER: MISSION PARAMETERS */}
            <div className="relative md:sticky md:top-0 z-40 pt-4 pb-4 -mx-2 md:-mx-6 px-4 md:px-8 bg-[#0f172a]/95 backdrop-blur-xl border-b border-white/5 shadow-2xl mb-8">
                <div className="max-w-7xl mx-auto space-y-4">
                    <div className="flex justify-between items-center">
                        <div className="flex items-center gap-3">
                            <div className="p-2 bg-sky-500/10 rounded-lg border border-sky-500/20">
                                {vessel?.type === 'power' ? <PowerBoatIcon className="w-5 h-5 text-sky-400" /> : <SailBoatIcon className="w-5 h-5 text-sky-400" />}
                            </div>
                            <div>
                                <h2 className="text-sm font-bold text-white uppercase tracking-widest flex items-center gap-2">
                                    Passage Plan
                                </h2>
                                <p className="text-[10px] text-gray-500 font-mono tracking-wide">
                                    {vessel?.name.toUpperCase() || "VESSEL"} // {vessel?.length}FT {vessel?.type.toUpperCase()}
                                </p>
                            </div>
                        </div>

                        {/* PRO BADGE */}
                        {!isPro && (
                            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-800 border border-white/10">
                                <LockIcon className="w-3 h-3 text-sky-400" />
                                <span className="text-[10px] font-bold text-white uppercase tracking-widest">Premium</span>
                            </div>
                        )}
                    </div>

                    <form onSubmit={handleCalculate} className="relative">
                        <div className="space-y-4">
                            {/* ROW 1: Origin & Destination - Map/GPS Only */}
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div className="relative group cursor-pointer" onClick={() => openMap('origin')}>
                                    <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none text-gray-500 group-hover:text-sky-400 transition-colors">
                                        <MapPinIcon className="w-4 h-4 text-emerald-400" />
                                    </div>
                                    <input
                                        type="text"
                                        readOnly
                                        value={origin}
                                        placeholder="Tap to Select Start Port"
                                        className="w-full h-14 bg-slate-900/50 border border-white/10 group-hover:border-sky-500/50 rounded-2xl pl-12 pr-14 text-sm text-white font-medium placeholder-gray-600 outline-none transition-all shadow-inner cursor-pointer"
                                    />
                                    <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                                        {/* GPS Button - Prevent bubbling to map open */}
                                        <button
                                            type="button"
                                            onClick={(e) => { e.stopPropagation(); handleOriginLocation(e as React.MouseEvent<HTMLButtonElement>); }}
                                            className="p-2 text-gray-400 hover:text-white transition-colors hover:bg-white/10 rounded-lg z-10"
                                            title="Use Current Location"
                                            aria-label="Use Current Location"
                                        >
                                            <CrosshairIcon className="w-5 h-5 text-sky-400" />
                                        </button>
                                    </div>
                                </div>

                                <div className="relative group cursor-pointer" onClick={() => openMap('destination')}>
                                    <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none text-gray-500 group-hover:text-sky-400 transition-colors">
                                        <MapPinIcon className="w-4 h-4 text-purple-400" />
                                    </div>
                                    <input
                                        type="text"
                                        readOnly
                                        value={destination}
                                        placeholder="Tap to Select Destination"
                                        className="w-full h-14 bg-slate-900/50 border border-white/10 group-hover:border-sky-500/50 rounded-2xl pl-12 pr-4 text-sm text-white font-medium placeholder-gray-600 outline-none transition-all shadow-inner cursor-pointer"
                                    />
                                    <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-gray-600 group-hover:text-sky-400 transition-colors">
                                        <MapIcon className="w-4 h-4" />
                                    </div>
                                </div>
                            </div>

                            {/* ROW 2: Via, Date, Action - Consistent sizing */}
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 md:gap-4">
                                <div className="relative group cursor-pointer" onClick={() => openMap('via')}>
                                    <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none text-gray-500 group-hover:text-sky-400 transition-colors">
                                        <RouteIcon className="w-4 h-4 text-sky-400" />
                                    </div>
                                    <input
                                        type="text"
                                        readOnly
                                        value={via}
                                        placeholder="Add Via Point (Opt)"
                                        className="w-full h-14 bg-slate-900/50 border border-white/10 group-hover:border-sky-500/50 rounded-2xl pl-12 pr-4 text-sm text-white font-medium placeholder-gray-600 outline-none transition-all shadow-inner cursor-pointer"
                                    />
                                    {via && (
                                        <button
                                            onClick={(e) => { e.stopPropagation(); setVia(''); }}
                                            aria-label="Clear Via Point"
                                            className="absolute right-3 top-1/2 -translate-y-1/2 p-2 hover:text-white text-gray-500"
                                        >
                                            <XIcon className="w-4 h-4" />
                                        </button>
                                    )}
                                    {!via && (
                                        <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-gray-600 group-hover:text-sky-400 transition-colors">
                                            <MapIcon className="w-4 h-4" />
                                        </div>
                                    )}
                                </div>
                                {/* DATE INPUT - RAW CONTROL */}
                                <div className="relative w-full min-w-0 group">
                                    <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none text-gray-500 group-focus-within:text-sky-400 transition-colors">
                                        <CalendarIcon className="w-4 h-4" />
                                    </div>
                                    <input
                                        type="date"
                                        min={minDate}
                                        value={departureDate}
                                        onChange={(e) => {
                                            const newDate = e.target.value;
                                            if (!minDate || newDate >= minDate) {
                                                setDepartureDate(newDate);
                                            }
                                        }}
                                        className="w-full h-14 bg-slate-900/50 border border-white/10 focus:border-sky-500/50 rounded-2xl pl-12 pr-4 text-sm text-white font-medium outline-none transition-all shadow-inner hover:bg-slate-900/80 appearance-none min-w-0"
                                        style={{ WebkitAppearance: 'none' }}
                                    />
                                </div>
                                <button
                                    type="submit"
                                    disabled={loading}
                                    className={`h-14 w-full rounded-2xl font-bold uppercase tracking-wider text-xs transition-all shadow-lg flex items-center justify-center gap-2 ${isPro ? 'bg-gradient-to-r from-sky-600 to-blue-600 hover:from-sky-500 hover:to-blue-500 text-white shadow-sky-900/20' : 'bg-slate-800 text-white hover:bg-slate-700'}`}
                                >
                                    {!isPro ? (
                                        <>
                                            <LockIcon className="w-4 h-4 text-sky-400" />
                                            Unlock Route Planning
                                        </>
                                    ) : loading ? (
                                        <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                    ) : (
                                        "Calculate Route"
                                    )}
                                </button>
                            </div>
                        </div>

                        {/* Loading State Overlay */}
                        {loading && (
                            <div className="absolute top-full left-0 right-0 mt-4 flex justify-center animate-in fade-in z-50">
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
                    </form>
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

            {/* --- RESULTS DASHBOARD --- */}
            {voyagePlan ? (
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
            ) : (
                /* EMPTY STATE HERO */
                <div className="flex-1 flex items-center justify-center p-8 min-h-[500px]">
                    <div className="max-w-2xl w-full text-center space-y-8 animate-in fade-in zoom-in-95 duration-700">
                        <div className="relative w-32 h-32 mx-auto">
                            <div className="absolute inset-0 bg-sky-500/10 rounded-full animate-ping duration-1000"></div>
                            <div className="relative bg-gradient-to-br from-sky-600 to-blue-700 w-32 h-32 rounded-full flex items-center justify-center shadow-[0_0_60px_rgba(14,165,233,0.3)] border border-white/10 backdrop-blur-md">
                                <CompassIcon rotation={45} className="w-16 h-16 text-white opacity-90" />
                            </div>
                        </div>
                        <div>
                            <h1 className="text-4xl md:text-6xl font-black text-white tracking-tighter mb-4 drop-shadow-2xl">
                                {loading ? (
                                    <span className="animate-pulse text-transparent bg-clip-text bg-gradient-to-r from-sky-300 to-white">Plotting Course...</span>
                                ) : (
                                    <>Chart Your <span className="text-transparent bg-clip-text bg-gradient-to-r from-sky-400 to-cyan-200">Odyssey</span></>
                                )}
                            </h1>
                            {!loading && (
                                <p className="text-lg text-slate-400 max-w-lg mx-auto leading-relaxed">
                                    Enter your origin and destination above to generate a tactical passage plan using real-time meteorology and AI routing.
                                </p>
                            )}
                        </div>

                        <div className="inline-flex items-center gap-3 px-6 py-3 rounded-full bg-white/5 border border-white/10 text-sm text-gray-400 italic backdrop-blur-sm">
                            <span className="text-sky-500">“</span>{quote.text}<span className="text-sky-500">”</span>
                        </div>
                    </div>
                </div>
            )
            }
        </div >
    );
};
