import React, { Suspense } from 'react';
import { CompassIcon, MapIcon, MapPinIcon, SearchIcon, XIcon } from '../Icons';
import { lazyRetry } from '../../utils/lazyRetry';

// Lazy-load the modern Mapbox-GL map so we don't ship it to first-paint.
// Matches the App.tsx loading pattern used for the main map view.
const MapHub = lazyRetry(() => import('../map/MapHub').then((m) => ({ default: m.MapHub })), 'HomePortMapHub');

interface HomePortStepProps {
    homePort: string;
    onHomePortChange: (value: string) => void;
    isLocating: boolean;
    showMap: boolean;
    onShowMap: (show: boolean) => void;
    tempLocation: { lat: number; lon: number; name: string } | null;
    onLocate: () => void;
    onMapSelect: (lat: number, lon: number, name?: string) => void;
    onConfirmMapSelection: () => void;
    firstName: string;
    onFirstNameChange: (value: string) => void;
    lastName: string;
    onLastNameChange: (value: string) => void;
    onNext: () => void;
}

export const HomePortStep: React.FC<HomePortStepProps> = ({
    homePort,
    onHomePortChange,
    isLocating,
    showMap,
    onShowMap,
    tempLocation,
    onLocate,
    onMapSelect,
    onConfirmMapSelection,
    firstName,
    onFirstNameChange,
    lastName,
    onLastNameChange,
    onNext,
}) => (
    <>
        {/* Map Modal — MapHub in pickerMode: tap anywhere drops a pin
            and auto-reverse-geocodes the coord into a human-readable
            name, which flows through onMapSelect into tempLocation. */}
        {showMap && (
            <div className="fixed inset-0 z-[150] bg-slate-950 animate-in fade-in duration-200 flex flex-col">
                <div className="flex-1 relative">
                    <Suspense
                        fallback={
                            <div className="absolute inset-0 flex items-center justify-center bg-slate-950">
                                <div className="flex flex-col items-center gap-3 text-white/60">
                                    <div className="w-8 h-8 border-2 border-sky-500 border-t-transparent rounded-full animate-spin"></div>
                                    <span className="text-xs font-medium">Loading chart…</span>
                                </div>
                            </div>
                        }
                    >
                        <MapHub
                            mapboxToken={import.meta.env.VITE_MAPBOX_ACCESS_TOKEN as string}
                            pickerMode={true}
                            pickerLabel="Select Home Port"
                            onLocationSelect={onMapSelect}
                            lat={tempLocation?.lat}
                            lon={tempLocation?.lon}
                            initialZoom={tempLocation ? 10 : 4}
                            minimalLabels={true}
                        />
                    </Suspense>

                    {/* Close button — top-right, glassy */}
                    <div className="absolute top-[max(1rem,env(safe-area-inset-top))] right-4 z-[160]">
                        <button
                            aria-label="Close map"
                            onClick={() => onShowMap(false)}
                            className="p-3 bg-slate-900/80 backdrop-blur text-white rounded-full shadow-xl border border-white/15 hover:bg-slate-800 active:scale-95 transition-all"
                        >
                            <XIcon className="w-5 h-5" />
                        </button>
                    </div>

                    {/* Title pill — top-center, reinforces intent */}
                    <div className="absolute top-[max(1.25rem,env(safe-area-inset-top))] left-1/2 -translate-x-1/2 z-[160] pointer-events-none">
                        <div className="bg-slate-900/80 backdrop-blur text-white/80 text-xs font-bold uppercase tracking-wider px-4 py-2 rounded-full border border-white/10 shadow-lg">
                            Tap the chart to pick your home port
                        </div>
                    </div>

                    {/* Confirm bar — bottom, only appears once a pin exists */}
                    <div className="absolute bottom-[max(1.5rem,env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2 z-[160] w-full max-w-sm px-4">
                        {tempLocation ? (
                            <button
                                aria-label={`Confirm ${tempLocation.name} as home port`}
                                onClick={onConfirmMapSelection}
                                className="w-full bg-sky-500 hover:bg-sky-400 text-white font-bold py-4 px-6 rounded-2xl shadow-2xl flex items-center justify-center gap-2 animate-in slide-in-from-bottom-4 duration-300 active:scale-[0.98] transition-all"
                            >
                                <MapPinIcon className="w-5 h-5" />
                                <span className="truncate">
                                    {tempLocation.name === 'Identifying...'
                                        ? 'Resolving location…'
                                        : `Confirm: ${tempLocation.name}`}
                                </span>
                            </button>
                        ) : (
                            <div className="bg-slate-900/80 backdrop-blur text-white/70 text-xs px-4 py-2.5 rounded-full border border-white/10 pointer-events-none shadow-lg text-center">
                                Tap any location on the chart to drop a pin
                            </div>
                        )}
                    </div>
                </div>
            </div>
        )}

        <div className="animate-in fade-in slide-in-from-right-8 duration-500">
            <div className="text-center mb-8">
                <div className="w-16 h-16 bg-white/5 rounded-full mx-auto mb-4 flex items-center justify-center border border-white/10">
                    <MapPinIcon className="w-8 h-8 text-sky-400" />
                </div>
                <h2 className="text-2xl font-bold text-white mb-2">About You & Home Port</h2>
                <p className="text-sm text-gray-400">Tell us your name and where you sail from.</p>
            </div>

            <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                    <input
                        type="text"
                        value={firstName}
                        onChange={(e) => onFirstNameChange(e.target.value)}
                        placeholder="First Name"
                        className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3.5 text-white focus:border-sky-500 outline-none text-sm font-medium transition-colors placeholder:text-gray-500"
                    />
                    <input
                        type="text"
                        value={lastName}
                        onChange={(e) => onLastNameChange(e.target.value)}
                        placeholder="Last Name"
                        className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3.5 text-white focus:border-sky-500 outline-none text-sm font-medium transition-colors placeholder:text-gray-500"
                    />
                </div>

                <div className="relative flex items-center gap-4 py-1">
                    <div className="h-px bg-white/10 flex-1"></div>
                    <span className="text-[11px] text-gray-500 font-bold uppercase">Home Port</span>
                    <div className="h-px bg-white/10 flex-1"></div>
                </div>
                <div className="relative">
                    <input
                        type="text"
                        value={homePort}
                        onChange={(e) => onHomePortChange(e.target.value)}
                        placeholder="e.g. Newport, RI"
                        className="w-full bg-white/5 border border-white/10 rounded-xl pl-4 pr-12 py-4 text-white focus:border-sky-500 outline-none text-lg font-medium transition-colors"
                    />
                    <div className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400">
                        <SearchIcon className="w-5 h-5" />
                    </div>
                </div>

                <div className="relative flex items-center gap-4 py-2">
                    <div className="h-px bg-white/10 flex-1"></div>
                    <span className="text-xs text-gray-400 font-bold uppercase">Or</span>
                    <div className="h-px bg-white/10 flex-1"></div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                    <button
                        aria-label="Find current location"
                        onClick={onLocate}
                        className="bg-sky-500/10 hover:bg-sky-500/20 border border-sky-500/30 text-sky-300 font-bold py-4 rounded-xl transition-all flex flex-col items-center justify-center gap-2 group"
                    >
                        {isLocating ? (
                            <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin"></div>
                        ) : (
                            <>
                                <CompassIcon
                                    rotation={0}
                                    className="w-5 h-5 group-hover:scale-110 transition-transform"
                                />
                                <span className="text-xs">Use GPS</span>
                            </>
                        )}
                    </button>
                    <button
                        aria-label="Show Map"
                        onClick={() => onShowMap(true)}
                        className="bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/30 text-purple-300 font-bold py-4 rounded-xl transition-all flex flex-col items-center justify-center gap-2 group"
                    >
                        <MapIcon className="w-5 h-5 group-hover:scale-110 transition-transform" />
                        <span className="text-xs">Pick on Map</span>
                    </button>
                </div>
            </div>

            <button
                aria-label="Proceed to next step"
                onClick={onNext}
                disabled={!homePort}
                className={`w-full mt-8 font-bold py-4 rounded-xl transition-all ${homePort ? 'bg-sky-500 hover:bg-sky-400 text-white shadow-lg' : 'bg-white/5 text-gray-400 cursor-not-allowed'}`}
            >
                Next
            </button>
        </div>
    </>
);
