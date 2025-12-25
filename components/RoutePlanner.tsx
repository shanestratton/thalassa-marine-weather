
import React, { useState, useMemo, useEffect } from 'react';
import { VoyagePlan, VoyageHazard, Waypoint, DeepAnalysisReport } from '../types';
import { fetchVoyagePlan, fetchDeepVoyageAnalysis } from '../services/geminiService';
import { reverseGeocode } from '../services/weatherService';
import { formatLocationInput } from '../utils';
import { 
    ArrowRightIcon, SailBoatIcon, PowerBoatIcon, MapPinIcon, MapIcon, 
    RouteIcon, CheckIcon, XIcon, BellIcon, CompassIcon, 
    CalendarIcon, GearIcon, DiamondIcon, LockIcon, BugIcon, 
    RadioTowerIcon, WaveIcon, WindIcon, ClockIcon, CrosshairIcon, BoatIcon, AlertTriangleIcon, FlagIcon, PhoneIcon 
} from './Icons';
import { WeatherMap } from './WeatherMap';
import { useThalassa } from '../context/ThalassaContext';

const SEA_QUOTES = [
  { text: "The pessimist complains about the wind; the optimist expects it to change; the realist adjusts the sails.", author: "William Arthur Ward" },
  { text: "At sea, I learned how little a person needs, not how much.", author: "Robin Lee Graham" },
  { text: "The cure for anything is salt water: sweat, tears or the sea.", author: "Isak Dinesen" },
  { text: "Man cannot discover new oceans unless he has the courage to lose sight of the shore.", author: "André Gide" },
  { text: "There is nothing - absolutely nothing - half so much worth doing as simply messing about in boats.", author: "Kenneth Grahame" },
  { text: "The sea, once it casts its spell, holds one in its net of wonder forever.", author: "Jacques Cousteau" }
];

const LOADING_PHASES = [
    "Querying Bathymetric Charts...",
    "Analyzing Local Currents...",
    "Identifying Hazards...",
    "Plotting Waypoints...",
    "Simulating Voyage Duration...",
    "Optimizing Land Avoidance Algorithms...", 
    "Computing Keel Clearance...",
    "Complex Route Geometry Detected...",
    "Running Deep Water Physics Engine...",
    "Verifying Safety Protocols...",
    "Cross-referencing Pilot Charts...",
    "Generating Tactical Brief...",
    "Finalizing Mission Parameters...",
    "Still Computing (Deep Reasoning)..."
];

const CHECKLIST_DATA = [
    {
        category: "Systems & Propulsion",
        id: "systems",
        icon: <GearIcon className="w-4 h-4 text-orange-400" />,
        items: ["Engine Oil & Coolant", "Transmission Fluid", "Bilge Pumps Test", "Battery Voltage", "Fuel Filters", "Raw Water Strainer", "Steering Gear"]
    },
    {
        category: "Safety & Deck",
        id: "safety",
        icon: <BellIcon className="w-4 h-4 text-red-400" />,
        items: ["PFDs / Life Jackets", "VHF Radio Check", "Fire Extinguishers", "MOB Gear Ready", "EPIRB Test", "Flares & Signals", "Anchor Secure"]
    },
    {
        category: "Navigation & Comms",
        id: "nav",
        icon: <CompassIcon rotation={0} className="w-4 h-4 text-sky-400" />,
        items: ["Chart Plotter Update", "Radar Function Test", "AIS Transmit Check", "Depth Sounder Calib", "Paper Charts", "Nav Lights"]
    }
];

// --- MICRO COMPONENTS ---

const getStatusClasses = (status?: string) => {
    switch(status) {
        case 'SAFE': return 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400';
        case 'CAUTION': return 'bg-amber-500/10 border-amber-500/30 text-amber-400';
        case 'UNSAFE': return 'bg-red-500/10 border-red-500/30 text-red-400';
        default: return 'bg-slate-800 border-white/10 text-gray-400';
    }
};

const HazardAlert: React.FC<{ hazard: VoyageHazard }> = ({ hazard }) => (
    <div className="flex items-start gap-3 p-3 rounded-xl bg-red-500/5 border border-red-500/20 hover:bg-red-500/10 transition-colors group">
        <div className="mt-1 p-1.5 bg-red-500/20 rounded-lg text-red-400 group-hover:text-red-200 transition-colors"><BugIcon className="w-4 h-4" /></div>
        <div>
            <div className="flex justify-between items-center mb-1">
                <span className="text-xs font-bold text-red-200 uppercase tracking-wider">{hazard.name}</span>
                <span className="text-[9px] font-bold px-1.5 py-0.5 bg-red-500/20 text-red-300 rounded border border-red-500/20 shadow-sm">{hazard.severity}</span>
            </div>
            <p className="text-[11px] text-gray-400 leading-relaxed font-light">{hazard.description}</p>
        </div>
    </div>
);

const SystemSwitch: React.FC<{ label: string, checked: boolean, onChange: () => void }> = ({ label, checked, onChange }) => (
    <button onClick={onChange} className="flex items-center justify-between w-full p-2.5 group hover:bg-white/5 rounded-lg transition-colors border border-transparent hover:border-white/5">
        <span className={`text-xs font-medium transition-colors ${checked ? 'text-white' : 'text-gray-400 group-hover:text-gray-300'}`}>{label}</span>
        <div className={`w-8 h-4 rounded-full relative transition-colors ${checked ? 'bg-sky-500' : 'bg-slate-700'} shadow-inner`}>
            <div className={`absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full transition-transform shadow-sm ${checked ? 'translate-x-4' : 'translate-x-0'}`}></div>
        </div>
    </button>
);

const WaypointNode: React.FC<{ wp: Waypoint, index: number, total: number, isLast: boolean, onClick: () => void }> = ({ wp, index, total, isLast, onClick }) => {
    return (
        <div className="flex gap-4 relative group cursor-pointer select-none" onClick={onClick}>
            {/* Continuous Timeline Line */}
            {!isLast && (
                <div className="absolute left-[11px] top-7 bottom-[-16px] w-[2px] bg-gradient-to-b from-sky-500/30 to-slate-800/30 group-hover:from-sky-500 group-hover:to-sky-500/50 transition-colors"></div>
            )}
            
            {/* Node Dot */}
            <div className="relative z-10 w-6 h-6 rounded-full bg-slate-900 border-2 border-sky-500/30 flex items-center justify-center shrink-0 group-hover:border-sky-400 group-hover:scale-110 transition-all mt-1.5 shadow-lg shadow-sky-900/20">
                <div className="w-2 h-2 bg-sky-500 rounded-full group-hover:bg-white transition-colors"></div>
            </div>

            {/* Content */}
            <div className="pb-6 flex-1 min-w-0">
                <div className="bg-slate-800/40 border border-white/5 rounded-xl p-3 group-hover:bg-slate-800/80 group-hover:border-sky-500/30 transition-all shadow-sm">
                    <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start mb-2 gap-1">
                        <h4 className="text-xs font-bold text-white tracking-wide break-words pr-2 leading-tight">{wp.name}</h4>
                        <span className="text-[9px] font-mono text-gray-500 opacity-60 shrink-0">WP-{String(index+1).padStart(2,'0')}</span>
                    </div>
                    
                    <div className="flex flex-wrap gap-2 text-[10px] font-mono text-gray-500 mb-2">
                        {wp.coordinates && <span>{wp.coordinates.lat.toFixed(3)}N {Math.abs(wp.coordinates.lon).toFixed(3)}W</span>}
                    </div>

                    {/* Conditions */}
                    <div className="flex items-center gap-3 bg-black/20 rounded p-1.5 px-2 w-fit">
                        {wp.windSpeed !== undefined && <div className="flex items-center gap-1.5 text-[10px] text-gray-300 font-medium"><WindIcon className="w-3 h-3 text-sky-400" /> {wp.windSpeed}kt</div>}
                        {wp.waveHeight !== undefined && <div className="flex items-center gap-1.5 text-[10px] text-gray-300 font-medium border-l border-white/10 pl-3"><WaveIcon className="w-3 h-3 text-blue-400" /> {wp.waveHeight}ft</div>}
                    </div>
                </div>
            </div>
        </div>
    );
};

interface InputFieldProps {
    icon: React.ReactNode;
    value: string;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    placeholder?: string;
    type?: string;
    min?: string;
    className?: string;
    subText?: string;
    onBlur?: (e: React.FocusEvent<HTMLInputElement>) => void;
}

const InputField: React.FC<InputFieldProps> = ({ icon, value, onChange, placeholder, type = "text", min, className, subText, onBlur }) => (
    <div className={`relative w-full ${className || ''}`}>
        <div className="relative group">
            <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none text-gray-500 group-focus-within:text-sky-400 transition-colors">
                {icon}
            </div>
            <input 
                type={type}
                min={min}
                value={value} 
                onChange={onChange}
                onBlur={onBlur} 
                placeholder={placeholder} 
                autoComplete="off"
                className="w-full h-14 bg-slate-900/50 border border-white/10 focus:border-sky-500/50 rounded-2xl pl-12 pr-4 text-sm text-white font-medium placeholder-gray-600 outline-none transition-all shadow-inner hover:bg-slate-900/80"
            />
        </div>
        {subText && <div className="absolute top-full left-4 mt-1 text-[10px] text-gray-400 font-medium truncate">{subText}</div>}
    </div>
);

// --- MAIN COMPONENT ---

export const VoyagePlanner: React.FC<{ onTriggerUpgrade: () => void }> = ({ onTriggerUpgrade }) => {
    const { settings, weatherData, voyagePlan, saveVoyagePlan } = useThalassa();
    const { vessel, vesselUnits, units: generalUnits, isPro, mapboxToken } = settings;

    const [origin, setOrigin] = useState(voyagePlan?.origin || weatherData?.locationName || '');
    const [destination, setDestination] = useState(voyagePlan?.destination || '');
    const [via, setVia] = useState(''); // New "Via" state
    const [departureDate, setDepartureDate] = useState(voyagePlan?.departureDate || new Date().toISOString().split('T')[0]);
    
    const minDate = new Date().toISOString().split('T')[0];
    const [isMapOpen, setIsMapOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [analyzingDeep, setAnalyzingDeep] = useState(false);
    const [deepReport, setDeepReport] = useState<DeepAnalysisReport | null>(null);
    const [loadingStep, setLoadingStep] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [checklistState, setChecklistState] = useState<Record<string, boolean>>({});
    const [activeChecklistTab, setActiveChecklistTab] = useState('systems');
    const [quote, setQuote] = useState(SEA_QUOTES[0]);

    useEffect(() => { setQuote(SEA_QUOTES[Math.floor(Math.random() * SEA_QUOTES.length)]); }, []);

    useEffect(() => {
        if (voyagePlan?.origin !== origin || voyagePlan?.destination !== destination) {
            setDeepReport(null);
        }
    }, [voyagePlan]);

    useEffect(() => {
        let interval: any;
        if (loading) {
            setLoadingStep(0);
            interval = setInterval(() => {
                setLoadingStep(s => {
                    if (s >= LOADING_PHASES.length - 1) return LOADING_PHASES.length - 3 + ((s - (LOADING_PHASES.length - 3) + 1) % 3);
                    return s + 1;
                });
            }, 1800);
        }
        return () => clearInterval(interval);
    }, [loading]);

    const handleCalculate = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        
        // PAYWALL INTERCEPTION
        if (!isPro) { 
            onTriggerUpgrade(); 
            return; 
        }
        
        if (!origin || !destination) return;
        
        // SAFEGUARD: Ensure vessel profile exists before calculation
        if (!vessel) {
            setError("Vessel profile missing. Please configure in settings.");
            return;
        }
        
        // Auto-Format inputs before submission
        const fmtOrigin = formatLocationInput(origin);
        const fmtDest = formatLocationInput(destination);
        const fmtVia = via ? formatLocationInput(via) : '';
        
        setOrigin(fmtOrigin);
        setDestination(fmtDest);
        setVia(fmtVia);

        setLoading(true);
        setError(null);
        setDeepReport(null);
        try {
            const result = await fetchVoyagePlan(fmtOrigin, fmtDest, vessel, departureDate, vesselUnits, generalUnits, fmtVia);
            saveVoyagePlan(result);
        } catch (err: any) {
            setError(err.message || 'Calculation Systems Failure');
        } finally {
            setLoading(false);
        }
    };

    const handleDeepAnalysis = async () => {
        if (!voyagePlan || !vessel) return;
        setAnalyzingDeep(true);
        try {
            const report = await fetchDeepVoyageAnalysis(voyagePlan, vessel);
            setDeepReport(report);
        } catch (err: any) {
            setError('Deep analysis unavailable. Please retry.');
        } finally {
            setAnalyzingDeep(false);
        }
    };

    const handleOriginLocation = (e: React.MouseEvent<HTMLButtonElement>) => {
        e.preventDefault();
        if ('geolocation' in navigator) {
            navigator.geolocation.getCurrentPosition(async (position) => {
                const name = await reverseGeocode(position.coords.latitude, position.coords.longitude);
                setOrigin(name || `${position.coords.latitude.toFixed(4)}, ${position.coords.longitude.toFixed(4)}`);
            });
        }
    };

    const routeCoords = useMemo(() => {
        if (!voyagePlan) return [];
        const coords = [];
        if (voyagePlan.originCoordinates) coords.push(voyagePlan.originCoordinates);
        // CRITICAL FIX: Safe iteration for waypoints to prevent crash on invalid data
        if (voyagePlan.waypoints && Array.isArray(voyagePlan.waypoints)) {
            voyagePlan.waypoints.forEach(wp => {
                if (wp && wp.coordinates) coords.push(wp.coordinates);
            });
        }
        if (voyagePlan.destinationCoordinates) coords.push(voyagePlan.destinationCoordinates);
        return coords;
    }, [voyagePlan]);

    const toggleCheck = (item: string) => setChecklistState(p => ({...p, [item]: !p[item]}));

    // Safe distVal calculation to avoid crash if distanceApprox is undefined
    const distVal = (voyagePlan && typeof voyagePlan.distanceApprox === 'string') 
        ? parseInt(voyagePlan.distanceApprox.match(/(\d+)/)?.[0] || '0', 10) 
        : 0;
    const isShortTrip = distVal < 20;

    return (
        <div className="w-full max-w-[1600px] mx-auto pb-36 md:pb-40 px-2 md:px-6 flex flex-col min-h-full font-sans">
            
            {/* FULL SCREEN MAP MODAL */}
            {isMapOpen && (
                <div className="fixed inset-0 z-[120] bg-slate-900 animate-in fade-in zoom-in-95 duration-200">
                    <WeatherMap 
                        locationName={origin} 
                        lat={voyagePlan?.originCoordinates?.lat} 
                        lon={voyagePlan?.originCoordinates?.lon} 
                        routeCoordinates={routeCoords} 
                        waypoints={voyagePlan?.waypoints}
                        minimal={true} 
                        enableZoom={true} 
                        showWeather={false}
                        mapboxToken={mapboxToken}
                        showZoomControl={false}
                        restrictBounds={false}
                    />
                    <div className="absolute top-6 right-6 z-[130]">
                        <button onClick={() => setIsMapOpen(false)} className="bg-slate-900/90 hover:bg-slate-800 text-white p-3 rounded-full shadow-2xl border border-white/20 transition-all hover:scale-110 active:scale-95">
                            <XIcon className="w-6 h-6" />
                        </button>
                    </div>
                </div>
            )}

            {/* HEADER: MISSION PARAMETERS */}
            <div className="sticky top-0 z-40 pt-4 pb-4 -mx-2 md:-mx-6 px-4 md:px-8 bg-[#0f172a]/95 backdrop-blur-xl border-b border-white/5 shadow-2xl mb-8">
                <div className="max-w-7xl mx-auto space-y-4">
                    <div className="flex justify-between items-center">
                        <div className="flex items-center gap-3">
                            <div className="p-2 bg-sky-500/10 rounded-lg border border-sky-500/20">
                                {vessel?.type === 'power' ? <PowerBoatIcon className="w-5 h-5 text-sky-400" /> : <SailBoatIcon className="w-5 h-5 text-sky-400" />}
                            </div>
                            <div>
                                <h2 className="text-sm font-bold text-white uppercase tracking-widest flex items-center gap-2">
                                    Passage Planning
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
                                <span className="text-[10px] font-bold text-white uppercase tracking-widest">Premium Feature</span>
                            </div>
                        )}
                    </div>

                    <form onSubmit={handleCalculate} className="relative">
                        <div className="space-y-4">
                            {/* ROW 1: Origin & Destination - Clean 50/50 Split */}
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div className="relative">
                                    <InputField 
                                        icon={<MapPinIcon className="w-4 h-4 text-emerald-400"/>} 
                                        value={origin} 
                                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setOrigin(e.target.value)} 
                                        onBlur={() => setOrigin(formatLocationInput(origin))}
                                        placeholder="Start Port" 
                                    />
                                    <button type="button" onClick={handleOriginLocation} className="absolute right-3 top-1/2 -translate-y-1/2 p-2 text-gray-500 hover:text-white transition-colors hover:bg-white/5 rounded-lg"><CompassIcon rotation={0} className="w-4 h-4"/></button>
                                </div>
                                <InputField 
                                    icon={<MapPinIcon className="w-4 h-4 text-purple-400"/>} 
                                    value={destination} 
                                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDestination(e.target.value)} 
                                    onBlur={() => setDestination(formatLocationInput(destination))}
                                    placeholder="End Port" 
                                />
                            </div>

                            {/* ROW 2: Via, Date, Action - Consistent sizing */}
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 md:gap-4">
                                <InputField 
                                    icon={<RouteIcon className="w-4 h-4 text-sky-400"/>} 
                                    value={via} 
                                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setVia(e.target.value)} 
                                    onBlur={() => setVia(formatLocationInput(via))}
                                    placeholder="Via (Opt)" 
                                />
                                <InputField 
                                    icon={<CalendarIcon className="w-4 h-4"/>} 
                                    type="date"
                                    min={minDate}
                                    value={departureDate} 
                                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDepartureDate(e.target.value)}
                                />
                                <button 
                                    type="submit" 
                                    disabled={loading}
                                    className={`h-14 w-full rounded-2xl font-bold uppercase tracking-wider text-xs transition-all shadow-lg flex items-center justify-center gap-2 ${isPro ? 'bg-gradient-to-r from-sky-600 to-blue-600 hover:from-sky-500 hover:to-blue-500 text-white shadow-sky-900/20' : 'bg-slate-800 text-white hover:bg-slate-700'}`}
                                >
                                    {!isPro ? (
                                        <>
                                            <LockIcon className="w-4 h-4 text-sky-400" />
                                            Unlock Route Intelligence
                                        </>
                                    ) : loading ? (
                                        <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"/>
                                    ) : (
                                        "Chart Route"
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
                        <div className="p-2 bg-red-500/20 rounded-full"><BugIcon className="w-5 h-5"/></div>
                        <div><h4 className="font-bold text-sm uppercase">Calculation Error</h4><p className="text-xs opacity-80">{error}</p></div>
                    </div>
                </div>
            )}

            {/* --- RESULTS DASHBOARD --- */}
            {voyagePlan ? (
                <div className="max-w-7xl mx-auto w-full animate-in fade-in slide-in-from-bottom-8 duration-700 pb-12 flex-1 flex flex-col">
                    
                    {/* TOP SUMMARY STRIP - REVAMPED */}
                    <div className="grid grid-cols-1 md:grid-cols-12 gap-6 mb-8">
                        <div className="md:col-span-8 bg-[#0f172a] border border-white/10 rounded-3xl p-0 relative overflow-hidden shadow-2xl flex flex-col">
                            {/* Background Decorations */}
                            <div className="absolute top-0 right-0 w-96 h-96 bg-blue-500/5 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2 pointer-events-none"></div>
                            
                            {/* Header: Route Visualization */}
                            <div className="p-6 md:p-8 pb-0 flex flex-col md:flex-row justify-between items-start md:items-center gap-6 relative z-10">
                                {/* Origin */}
                                <div className="flex flex-col">
                                    <span className="text-[10px] text-gray-500 font-bold uppercase tracking-widest mb-1">Departing</span>
                                    <div className="flex items-baseline gap-2">
                                        <span className="text-2xl md:text-3xl font-bold text-white tracking-tight">{(voyagePlan.origin && typeof voyagePlan.origin === 'string') ? voyagePlan.origin.split(',')[0] : "Unknown"}</span>
                                    </div>
                                    <span className="text-xs text-gray-500 font-mono mt-1">{voyagePlan.originCoordinates?.lat.toFixed(2)}°N, {Math.abs(voyagePlan.originCoordinates?.lon || 0).toFixed(2)}°W</span>
                                </div>

                                {/* Visual Path */}
                                <div className="hidden md:flex flex-1 mx-8 flex-col items-center justify-center -mt-2">
                                    <div className="flex items-center gap-2 mb-2">
                                        <span className="text-xs font-bold text-sky-400">{voyagePlan.distanceApprox}</span>
                                    </div>
                                    <div className="w-full h-0.5 bg-gradient-to-r from-gray-700 via-sky-500 to-gray-700 relative">
                                        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 p-1.5 bg-[#0f172a] border border-sky-500 rounded-full">
                                            <BoatIcon className="w-4 h-4 text-white" />
                                        </div>
                                    </div>
                                    <div className="mt-2 text-[10px] text-gray-500 uppercase tracking-widest mb-1">{vessel?.type.toUpperCase()} VESSEL</div>
                                    <div className="text-xs font-medium text-white">{voyagePlan.departureDate}</div>
                                </div>

                                {/* Destination */}
                                <div className="flex flex-col text-right items-end">
                                    <span className="text-[10px] text-gray-500 font-bold uppercase tracking-widest mb-1">Arriving</span>
                                    <div className="flex items-baseline gap-2">
                                        <span className="text-2xl md:text-3xl font-bold text-white tracking-tight">{(voyagePlan.destination && typeof voyagePlan.destination === 'string') ? voyagePlan.destination.split(',')[0] : "Unknown"}</span>
                                    </div>
                                     <span className="text-xs text-gray-500 font-mono mt-1">{voyagePlan.destinationCoordinates?.lat.toFixed(2)}°N, {Math.abs(voyagePlan.destinationCoordinates?.lon || 0).toFixed(2)}°W</span>
                                </div>
                            </div>

                            {/* Mobile Route Line (visible only on small screens) */}
                            <div className="md:hidden px-6 py-4 flex flex-col items-center gap-2">
                                <div className="flex items-center gap-4 w-full">
                                    <div className="h-px bg-white/10 flex-1"></div>
                                    <div className="text-xs font-bold text-sky-400 bg-sky-500/10 px-2 py-1 rounded border border-sky-500/20">{voyagePlan.distanceApprox}</div>
                                    <div className="h-px bg-white/10 flex-1"></div>
                                </div>
                                <div className="text-xs text-gray-400 font-medium">{voyagePlan.departureDate}</div>
                            </div>

                            {/* Stats Grid */}
                            <div className="p-6 md:p-8 pt-6 grid grid-cols-2 md:grid-cols-4 gap-4 relative z-10">
                                
                                {/* Departure Date */}
                                <div className="bg-white/5 rounded-2xl p-3 md:p-4 border border-white/5 flex flex-col justify-between group hover:bg-white/10 transition-colors min-h-[100px]">
                                    <div className="flex items-center gap-2 mb-2 text-gray-400 group-hover:text-sky-300 transition-colors">
                                        <CalendarIcon className="w-3.5 h-3.5" />
                                        <span className="text-[10px] font-bold uppercase tracking-widest">Date</span>
                                    </div>
                                    <div>
                                        <span className="text-sm md:text-base font-bold text-white block truncate" title={voyagePlan.departureDate}>{voyagePlan.departureDate}</span>
                                        <span className="text-[10px] text-gray-500">Departure</span>
                                    </div>
                                </div>

                                {/* Duration */}
                                <div className="bg-white/5 rounded-2xl p-3 md:p-4 border border-white/5 flex flex-col justify-between group hover:bg-white/10 transition-colors min-h-[100px]">
                                    <div className="flex items-center gap-2 mb-2 text-gray-400 group-hover:text-sky-300 transition-colors">
                                        <ClockIcon className="w-3.5 h-3.5" />
                                        <span className="text-[10px] font-bold uppercase tracking-widest">Duration</span>
                                    </div>
                                    <div>
                                        <span className="text-sm md:text-base font-bold text-white block leading-tight">{voyagePlan.durationApprox}</span>
                                        <span className="text-[10px] text-gray-500">Estimated Time</span>
                                    </div>
                                </div>

                                {/* Peak Conditions (Merged Wind/Wave) */}
                                <div className="bg-white/5 rounded-2xl p-3 md:p-4 border border-white/5 flex flex-col justify-between group hover:bg-white/10 transition-colors min-h-[100px]">
                                    <div className="flex items-center gap-2 mb-2 text-gray-400 group-hover:text-orange-300 transition-colors">
                                        <WindIcon className="w-3.5 h-3.5" />
                                        <span className="text-[10px] font-bold uppercase tracking-widest">Max Conds</span>
                                    </div>
                                    <div>
                                        <div className="flex items-baseline gap-1">
                                            <span className="text-sm md:text-base font-bold text-white">{voyagePlan.suitability?.maxWindEncountered ?? '--'}</span>
                                            <span className="text-[10px] font-normal text-gray-500">kts</span>
                                        </div>
                                        <div className="text-[10px] md:text-xs text-blue-300 mt-0.5">
                                            {voyagePlan.suitability?.maxWaveEncountered ?? '--'} ft Seas
                                        </div>
                                    </div>
                                </div>

                                {/* Status */}
                                <div className={`rounded-2xl p-3 md:p-4 border flex flex-col justify-between min-h-[100px] ${getStatusClasses(voyagePlan.suitability?.status)}`}>
                                    <div className="flex items-center gap-2 mb-2 opacity-80">
                                        <DiamondIcon className="w-3.5 h-3.5" />
                                        <span className="text-[10px] font-bold uppercase tracking-widest">Viability</span>
                                    </div>
                                    <div>
                                        <span className="text-sm md:text-base font-black uppercase tracking-wide block">{voyagePlan.suitability?.status}</span>
                                        <span className="text-[10px] opacity-80 line-clamp-2 leading-tight mt-0.5">{voyagePlan.suitability?.reasoning || "Route analyzed."}</span>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* MAP TOGGLE CARD */}
                        <button onClick={() => setIsMapOpen(true)} className="md:col-span-4 bg-slate-800 border border-white/10 rounded-3xl overflow-hidden relative group cursor-pointer shadow-xl transition-all hover:border-sky-500/30">
                            <div className="absolute inset-0 bg-[url('https://images.unsplash.com/photo-1524661135-423995f22d0b?q=80&w=2074&auto=format&fit=crop')] bg-cover bg-center opacity-40 group-hover:opacity-50 group-hover:scale-105 transition-all duration-700"></div>
                            <div className="absolute inset-0 bg-gradient-to-t from-slate-900 via-slate-900/20 to-transparent"></div>
                            <div className="absolute bottom-6 left-6 right-6 z-10 flex justify-between items-end">
                                <div>
                                    <h3 className="text-xl font-bold text-white mb-1 shadow-black drop-shadow-md">Interactive Chart</h3>
                                    <p className="text-xs text-sky-300 font-medium uppercase tracking-widest shadow-black drop-shadow-md">
                                        {isShortTrip ? 'View Direct Route' : 'View Suggested Stops'}
                                    </p>
                                </div>
                                <div className="bg-sky-500 p-3 rounded-full text-white shadow-lg group-hover:scale-110 transition-transform"><MapIcon className="w-5 h-5"/></div>
                            </div>
                        </button>
                    </div>

                    {/* LIABILITY DISCLAIMER - UPDATED to full width */}
                    <div className="w-full p-4 bg-amber-950/20 border border-amber-900/30 rounded-xl flex items-start gap-4 shadow-lg backdrop-blur-sm mb-8">
                        <div className="p-2 bg-amber-900/30 rounded-full text-amber-500 shrink-0 mt-0.5">
                            <AlertTriangleIcon className="w-5 h-5" />
                        </div>
                        <div>
                            <h4 className="text-xs font-bold text-amber-500 uppercase tracking-widest mb-1">Warning: Not For Navigation</h4>
                            <p className="text-[10px] text-amber-200/80 leading-relaxed font-medium">
                                This automated voyage plan is generated by AI using weather model data. It does not account for real-time hazards, Notices to Mariners, or local regulations. 
                                <span className="block mt-1 text-amber-100 opacity-60">
                                    The captain is solely responsible for the safety of the vessel and crew. Do not rely on this tool for critical navigation decisions. Always verify with official charts.
                                </span>
                            </p>
                        </div>
                    </div>

                    {/* CUSTOMS & IMMIGRATION CARD (International Voyages Only) */}
                    {voyagePlan.customs?.required && (
                        <div className="bg-indigo-900/20 border border-indigo-500/30 rounded-2xl p-5 mb-8 animate-in fade-in slide-in-from-bottom-4 shadow-xl backdrop-blur-md">
                            
                            {/* Departure Section */}
                            {voyagePlan.customs.departureProcedures && (
                                <div className="mb-6 border-b border-indigo-500/20 pb-4">
                                    <div className="flex items-center gap-3 mb-2">
                                        <div className="p-2 bg-indigo-500/20 rounded-full text-indigo-300">
                                            <FlagIcon className="w-5 h-5" />
                                        </div>
                                        <h3 className="text-sm font-bold text-indigo-200 uppercase tracking-widest">
                                            Clearance Outbound: {voyagePlan.customs.departingCountry || "Origin"}
                                        </h3>
                                    </div>
                                    <p className="text-sm text-gray-300 leading-relaxed pl-1">
                                        {voyagePlan.customs.departureProcedures}
                                    </p>
                                </div>
                            )}

                            <div className="flex flex-col md:flex-row gap-6">
                                <div className="flex-1">
                                    <div className="flex items-center gap-3 mb-2">
                                        <div className="p-2 bg-indigo-500/20 rounded-full text-indigo-300">
                                            <FlagIcon className="w-5 h-5" />
                                        </div>
                                        <h3 className="text-sm font-bold text-indigo-200 uppercase tracking-widest">
                                            International Arrival: {voyagePlan.customs.destinationCountry || "Border Crossing"}
                                        </h3>
                                    </div>
                                    <p className="text-sm text-gray-300 leading-relaxed pl-1">
                                        {voyagePlan.customs.procedures}
                                    </p>
                                </div>
                                {voyagePlan.customs.contactPhone && (
                                    <div className="flex flex-col justify-center min-w-[200px] border-t md:border-t-0 md:border-l border-indigo-500/20 pt-4 md:pt-0 md:pl-6">
                                        <span className="text-[10px] text-gray-500 uppercase font-bold tracking-widest mb-1">Port Authority / Customs</span>
                                        <div className="flex items-center gap-2 text-white font-mono text-lg">
                                            <PhoneIcon className="w-4 h-4 text-emerald-400" />
                                            <a href={`tel:${voyagePlan.customs.contactPhone}`} className="hover:text-emerald-300 transition-colors">
                                                {voyagePlan.customs.contactPhone}
                                            </a>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {/* MAIN CONTENT GRID */}
                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 flex-1">
                        
                        {/* LEFT COL: WAYPOINTS - FIXED HEIGHT CONTAINER */}
                        <div className="flex flex-col lg:h-[750px] h-auto">
                            <div className="bg-slate-900/60 backdrop-blur-xl border border-white/10 rounded-3xl p-6 shadow-xl flex flex-col h-full overflow-hidden min-h-[400px]">
                                <div className="flex justify-between items-end mb-6 pb-4 border-b border-white/5 shrink-0">
                                    <h3 className="text-sm font-bold text-white uppercase tracking-widest flex items-center gap-2">
                                        <RouteIcon className="w-4 h-4 text-sky-400"/> Suggested Stops
                                    </h3>
                                    <span className="text-[10px] font-mono text-gray-500">{(voyagePlan.waypoints?.length || 0)} POINTS</span>
                                </div>
                                
                                {/* Added flex-1 to push footer down and fill space with list */}
                                <div className="relative flex-grow overflow-y-auto custom-scrollbar pr-2 flex-1">
                                    {(voyagePlan.waypoints && voyagePlan.waypoints.length > 0) ? (
                                        voyagePlan.waypoints.map((wp, i) => (
                                            <WaypointNode 
                                                key={i} 
                                                wp={wp} 
                                                index={i} 
                                                total={voyagePlan.waypoints?.length || 0} 
                                                isLast={i === (voyagePlan.waypoints?.length || 0) - 1} 
                                                onClick={() => setIsMapOpen(true)} 
                                            />
                                        ))
                                    ) : (
                                        <div className="flex flex-col items-center justify-center h-48 opacity-50 border-2 border-dashed border-white/10 rounded-xl">
                                            <RouteIcon className="w-8 h-8 text-gray-500 mb-2"/>
                                            <span className="text-xs font-bold text-gray-400 uppercase tracking-widest">Direct Route</span>
                                            <span className="text-[10px] text-gray-600 mt-1">No stops required</span>
                                        </div>
                                    )}
                                </div>
                                {/* Footer Fluff */}
                                <div className="mt-4 pt-3 border-t border-white/5 text-center">
                                    <span className="text-[10px] text-gray-600 font-mono uppercase tracking-widest">
                                        {voyagePlan.waypoints?.length} Waypoints Plotted
                                    </span>
                                </div>
                            </div>
                        </div>

                        {/* CENTER COL: ANALYSIS & HAZARDS - FIXED HEIGHT CONTAINER */}
                        <div className="flex flex-col gap-6 lg:col-span-2 lg:h-[750px] h-auto">
                            
                            {/* AI Deep Analysis Block - Fixed top height with scroll */}
                            <div className="bg-gradient-to-br from-indigo-900/20 to-slate-900/60 backdrop-blur-xl border border-indigo-500/20 rounded-3xl p-6 shadow-xl relative overflow-hidden shrink-0 lg:h-[220px] flex flex-col">
                                <div className="flex justify-between items-center mb-4 shrink-0">
                                    <h3 className="text-sm font-bold text-indigo-200 uppercase tracking-widest flex items-center gap-2">
                                        <DiamondIcon className="w-4 h-4 text-indigo-400"/> Strategic Intelligence
                                    </h3>
                                    {!deepReport && (
                                        <button 
                                            onClick={handleDeepAnalysis} 
                                            disabled={analyzingDeep} 
                                            className="text-[10px] font-bold uppercase tracking-wider text-indigo-400 hover:text-white border border-indigo-500/30 px-3 py-1.5 rounded-lg hover:bg-indigo-500/20 transition-all flex items-center gap-2"
                                        >
                                            {analyzingDeep ? <div className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin"/> : "Generate Report"}
                                        </button>
                                    )}
                                </div>

                                <div className="overflow-y-auto custom-scrollbar pr-2 flex-1">
                                    {deepReport ? (
                                        <div className="animate-in fade-in slide-in-from-bottom-4">
                                            <div className="mb-4">
                                                <h4 className="text-[10px] text-indigo-400 font-bold uppercase tracking-wider mb-1">Command Summary</h4>
                                                <p className="text-sm text-gray-200 leading-relaxed font-light">{deepReport.strategy}</p>
                                            </div>
                                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4 pt-4 border-t border-indigo-500/10">
                                                <div>
                                                    <h4 className="text-[10px] text-indigo-400 font-bold uppercase tracking-wider mb-1">Fuel Tactics</h4>
                                                    <p className="text-xs text-gray-400 leading-relaxed">{deepReport.fuelTactics}</p>
                                                </div>
                                                <div>
                                                    <h4 className="text-[10px] text-indigo-400 font-bold uppercase tracking-wider mb-1">Watch Rotation</h4>
                                                    <p className="text-xs text-gray-400 leading-relaxed">{deepReport.watchSchedule}</p>
                                                </div>
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="bg-black/20 rounded-xl p-4 border border-white/5">
                                            <p className="text-sm text-gray-300 leading-relaxed font-light">{voyagePlan.overview}</p>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Two Column Split: Hazards + Best Window - Flex-1 fill */}
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 flex-1 min-h-0">
                                
                                {/* Hazards - Card 2 - Uniform Height via flex-1 */}
                                <div className="bg-slate-900/60 backdrop-blur-xl border border-white/10 rounded-3xl p-6 shadow-xl flex flex-col h-full overflow-hidden min-h-[400px]">
                                    <h3 className="text-xs font-bold text-white uppercase tracking-widest flex items-center gap-2 mb-4 shrink-0">
                                        <BugIcon className="w-4 h-4 text-red-400"/> Threat Matrix
                                    </h3>
                                    {/* Flex-1 here ensures list pushes footer down */}
                                    <div className="space-y-3 flex-1 overflow-y-auto custom-scrollbar min-h-0 pr-2">
                                        {voyagePlan.hazards && voyagePlan.hazards.length > 0 ? (
                                            voyagePlan.hazards.map((h, i) => <HazardAlert key={i} hazard={h} />)
                                        ) : (
                                            <div className="flex flex-col items-center justify-center h-full border-2 border-dashed border-white/5 rounded-xl opacity-50 min-h-[100px]">
                                                <CheckIcon className="w-6 h-6 text-emerald-500 mb-2"/>
                                                <span className="text-xs text-gray-500">Sector Clear</span>
                                            </div>
                                        )}
                                    </div>
                                    {/* Footer Fluff */}
                                    <div className="mt-4 pt-2 border-t border-white/5 flex justify-between items-center opacity-60">
                                        <span className="text-[9px] text-gray-500 font-bold uppercase">Live Monitoring</span>
                                        <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse"></div>
                                    </div>
                                </div>

                                {/* Departure Window & Systems Check - Card 3 */}
                                <div className="flex flex-col gap-4 h-full min-h-[400px]">
                                    {voyagePlan.bestDepartureWindow && (
                                        <div className="bg-emerald-900/10 border border-emerald-500/20 rounded-3xl p-6 backdrop-blur-xl relative overflow-hidden shrink-0">
                                            <div className="absolute top-0 right-0 p-16 bg-emerald-500/5 rounded-full blur-2xl pointer-events-none -translate-y-1/2 translate-x-1/2"></div>
                                            <h3 className="text-xs font-bold text-emerald-400 uppercase tracking-widest flex items-center gap-2 mb-1">
                                                <ClockIcon className="w-4 h-4"/> Optimal Departure
                                            </h3>
                                            <div className="text-2xl font-bold text-white mb-2">{voyagePlan.bestDepartureWindow.timeRange}</div>
                                            <p className="text-xs text-gray-400 leading-relaxed relative z-10">{voyagePlan.bestDepartureWindow.reasoning}</p>
                                        </div>
                                    )}
                                    
                                    <div className="bg-slate-900/60 backdrop-blur-xl border border-white/10 rounded-3xl p-6 shadow-xl flex-1 flex flex-col min-h-0 overflow-hidden justify-between">
                                        <div>
                                            <h3 className="text-xs font-bold text-white uppercase tracking-widest flex items-center gap-2 mb-4 shrink-0">
                                                <GearIcon className="w-4 h-4 text-orange-400"/> Systems Check
                                            </h3>
                                            {/* Tabbed Checklist */}
                                            <div className="flex space-x-2 mb-4 bg-black/20 p-1 rounded-lg shrink-0">
                                                {CHECKLIST_DATA.map((cat) => (
                                                    <button
                                                        key={cat.id}
                                                        onClick={() => setActiveChecklistTab(cat.id)}
                                                        className={`flex-1 py-1 text-[10px] font-bold uppercase rounded-md transition-colors ${activeChecklistTab === cat.id ? 'bg-white/10 text-white shadow' : 'text-gray-500 hover:text-gray-300'}`}
                                                    >
                                                        {cat.category.split(' ')[0]}
                                                    </button>
                                                ))}
                                            </div>
                                            <div className="space-y-2 overflow-y-auto custom-scrollbar pr-1 max-h-[300px]">
                                                {CHECKLIST_DATA.find(c => c.id === activeChecklistTab)?.items.map((item, i) => (
                                                    <SystemSwitch key={i} label={item} checked={!!checklistState[item]} onChange={() => toggleCheck(item)} />
                                                ))}
                                            </div>
                                        </div>
                                        {/* Footer Fluff */}
                                        <div className="mt-4 pt-2 border-t border-white/5 flex justify-between items-center opacity-60">
                                            <span className="text-[9px] text-gray-500 font-bold uppercase">System Status</span>
                                            <span className="text-[9px] text-emerald-400 font-mono">ONLINE</span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                </div>
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
            )}
        </div>
    );
};
