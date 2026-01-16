import React from 'react';
import { VoyagePlan, VoyageHazard, Waypoint, DeepAnalysisReport, VesselProfile } from '../types';
import {
    ArrowRightIcon, SailBoatIcon, PowerBoatIcon, MapPinIcon, MapIcon,
    RouteIcon, CheckIcon, XIcon, BellIcon, CompassIcon,
    CalendarIcon, GearIcon, DiamondIcon, LockIcon, BugIcon,
    RadioTowerIcon, WaveIcon, WindIcon, ClockIcon, CrosshairIcon, BoatIcon, AlertTriangleIcon, FlagIcon, PhoneIcon
} from './Icons';


// --- MICRO COMPONENTS ---

const getStatusClasses = (status?: string) => {
    switch (status) {
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
    <button
        onClick={onChange}
        aria-label={`Toggle ${label}`}
        className="flex items-center justify-between w-full p-2.5 group hover:bg-white/5 rounded-lg transition-colors border border-transparent hover:border-white/5"
    >
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
                        <span className="text-[9px] font-mono text-gray-500 opacity-60 shrink-0">WP-{String(index + 1).padStart(2, '0')}</span>
                    </div>

                    <div className="flex flex-wrap gap-2 text-[10px] font-mono text-gray-400 mb-2">
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

export const CHECKLIST_DATA = [
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

interface VoyageResultsProps {
    voyagePlan: VoyagePlan;
    vessel: VesselProfile;
    checklistState: Record<string, boolean>;
    toggleCheck: (id: string) => void;
    deepReport: DeepAnalysisReport | null;
    analyzingDeep: boolean;
    handleDeepAnalysis: () => void;
    activeChecklistTab: string;
    setActiveChecklistTab: (id: string) => void;
    setIsMapOpen: (open: boolean) => void;
    isShortTrip: boolean;
}

export const VoyageResults: React.FC<VoyageResultsProps> = ({
    voyagePlan,
    vessel,
    checklistState,
    toggleCheck,
    deepReport,
    analyzingDeep,
    handleDeepAnalysis,
    activeChecklistTab,
    setActiveChecklistTab,
    setIsMapOpen,
    isShortTrip
}) => {
    return (
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
                <button
                    onClick={() => setIsMapOpen(true)}
                    aria-label="Open Interactive Chart"
                    className="md:col-span-4 bg-slate-800 border border-white/10 rounded-3xl overflow-hidden relative group cursor-pointer shadow-xl transition-all hover:border-sky-500/30"
                >
                    <div className="absolute inset-0 bg-[url('https://images.unsplash.com/photo-1524661135-423995f22d0b?q=80&w=2074&fm=jpg&fit=crop')] bg-cover bg-center opacity-40 group-hover:opacity-50 group-hover:scale-105 transition-all duration-700"></div>
                    <div className="absolute inset-0 bg-gradient-to-t from-slate-900 via-slate-900/20 to-transparent"></div>
                    <div className="absolute bottom-6 left-6 right-6 z-10 flex justify-between items-end">
                        <div>
                            <h3 className="text-xl font-bold text-white mb-1 shadow-black drop-shadow-md">Interactive Chart</h3>
                            <p className="text-xs text-sky-300 font-medium uppercase tracking-widest shadow-black drop-shadow-md">
                                {isShortTrip ? 'View Route' : 'View Waypoints'}
                            </p>
                        </div>
                        <div className="bg-sky-500 p-3 rounded-full text-white shadow-lg group-hover:scale-110 transition-transform"><MapIcon className="w-5 h-5" /></div>
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
            {/* INTELLIGENCE ROW - TOP */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">

                {/* AI Deep Analysis Block */}
                <div className="bg-gradient-to-br from-indigo-900/40 to-slate-900/95 border border-indigo-500/20 rounded-3xl p-5 shadow-xl relative overflow-hidden flex flex-col h-[200px]">
                    <div className="flex justify-between items-center mb-3 shrink-0">
                        <h3 className="text-sm font-bold text-indigo-200 uppercase tracking-widest flex items-center gap-2">
                            <DiamondIcon className="w-4 h-4 text-indigo-400" /> Voyage Analysis
                        </h3>
                        {!deepReport && (
                            <button
                                onClick={handleDeepAnalysis}
                                disabled={analyzingDeep}
                                aria-label="Run Deep Analysis"
                                className="text-[10px] font-bold uppercase tracking-wider text-indigo-400 hover:text-white border border-indigo-500/30 px-3 py-1.5 rounded-lg hover:bg-indigo-500/20 transition-all flex items-center gap-2"
                            >
                                {analyzingDeep ? <div className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" /> : "Analyze"}
                            </button>
                        )}
                    </div>

                    <div className="overflow-y-auto custom-scrollbar pr-2 flex-1">
                        {deepReport ? (
                            <div className="animate-in fade-in slide-in-from-bottom-4">
                                <div className="mb-4">
                                    <h4 className="text-[10px] text-indigo-400 font-bold uppercase tracking-wider mb-1">Strategy</h4>
                                    <p className="text-sm text-gray-200 leading-relaxed font-light">{deepReport.strategy}</p>
                                </div>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4 pt-4 border-t border-indigo-500/10">
                                    <div>
                                        <h4 className="text-[10px] text-indigo-400 font-bold uppercase tracking-wider mb-1">Fuel Planning</h4>
                                        <p className="text-xs text-gray-400 leading-relaxed">{deepReport.fuelTactics}</p>
                                    </div>
                                    <div>
                                        <h4 className="text-[10px] text-indigo-400 font-bold uppercase tracking-wider mb-1">Watch Schedule</h4>
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

                {/* Departure Window (or Placeholder if null) */}
                <div className="h-[200px]">
                    {voyagePlan.bestDepartureWindow ? (
                        <div className="bg-emerald-900/20 border border-emerald-500/20 rounded-3xl p-5 relative overflow-hidden h-full flex flex-col">
                            <div className="absolute top-0 right-0 p-16 bg-emerald-500/5 rounded-full blur-2xl pointer-events-none -translate-y-1/2 translate-x-1/2"></div>
                            <h3 className="text-xs font-bold text-emerald-400 uppercase tracking-widest flex items-center gap-2 mb-2 shrink-0">
                                <ClockIcon className="w-4 h-4" /> Optimal Departure
                            </h3>
                            <div className="flex-1 flex flex-col justify-center">
                                <div className="text-2xl font-bold text-white mb-2">{voyagePlan.bestDepartureWindow.timeRange}</div>
                                <p className="text-xs text-gray-400 leading-relaxed relative z-10 line-clamp-4">{voyagePlan.bestDepartureWindow.reasoning}</p>
                            </div>
                        </div>
                    ) : (
                        <div className="bg-slate-900/40 border border-white/5 rounded-3xl p-5 h-full flex items-center justify-center">
                            <span className="text-xs text-gray-500 font-bold uppercase tracking-widest">No Timing Data</span>
                        </div>
                    )}
                </div>
            </div>

            {/* MAIN CONTENT GRID - 3 EQUAL COLUMNS */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 flex-1">

                {/* COL 1: SUGGESTED STOPS */}
                <div className="flex flex-col h-[600px]">
                    <div className="bg-slate-900/80 border border-white/10 rounded-3xl p-5 shadow-xl flex flex-col h-full overflow-hidden">
                        <div className="flex justify-between items-end mb-4 pb-2 border-b border-white/5 shrink-0">
                            <h3 className="text-sm font-bold text-white uppercase tracking-widest flex items-center gap-2">
                                <RouteIcon className="w-4 h-4 text-sky-400" /> Suggested Stops
                            </h3>
                            <span className="text-[10px] font-mono text-gray-500">{(voyagePlan.waypoints?.length || 0)} POINTS</span>
                        </div>
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
                                    <RouteIcon className="w-8 h-8 text-gray-500 mb-2" />
                                    <span className="text-xs font-bold text-gray-400 uppercase tracking-widest">Direct Route</span>
                                    <span className="text-[10px] text-gray-600 mt-1">No stops required</span>
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                {/* COL 2: THREAT MATRIX */}
                <div className="flex flex-col h-[600px]">
                    <div className="bg-slate-900/80 border border-white/10 rounded-3xl p-5 shadow-xl flex flex-col h-full overflow-hidden">
                        <h3 className="text-xs font-bold text-white uppercase tracking-widest flex items-center gap-2 mb-4 shrink-0">
                            <BugIcon className="w-4 h-4 text-red-400" /> Hazards
                        </h3>
                        <div className="space-y-3 flex-1 overflow-y-auto custom-scrollbar min-h-0 pr-2">
                            {voyagePlan.hazards && voyagePlan.hazards.length > 0 ? (
                                voyagePlan.hazards.map((h, i) => <HazardAlert key={i} hazard={h} />)
                            ) : (
                                <div className="flex flex-col items-center justify-center h-full border-2 border-dashed border-white/5 rounded-xl opacity-50 min-h-[100px]">
                                    <CheckIcon className="w-6 h-6 text-emerald-500 mb-2" />
                                    <span className="text-xs text-gray-500">Sector Clear</span>
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                {/* COL 3: SYSTEMS CHECK */}
                <div className="flex flex-col h-[600px]">
                    <div className="bg-slate-900/80 border border-white/10 rounded-3xl p-5 shadow-xl flex-1 flex flex-col min-h-0 overflow-hidden">
                        <h3 className="text-xs font-bold text-white uppercase tracking-widest flex items-center gap-2 mb-4 shrink-0">
                            <GearIcon className="w-4 h-4 text-orange-400" /> Systems Check
                        </h3>
                        {/* Tabbed Checklist */}
                        <div className="flex space-x-2 mb-4 bg-black/20 p-1 rounded-lg shrink-0">
                            {CHECKLIST_DATA.map((cat) => (
                                <button
                                    key={cat.id}
                                    onClick={() => setActiveChecklistTab(cat.id)}
                                    aria-label={`Show ${cat.category} checklist`}
                                    className={`flex-1 py-1 text-[10px] font-bold uppercase rounded-md transition-colors ${activeChecklistTab === cat.id ? 'bg-white/10 text-white shadow' : 'text-gray-500 hover:text-gray-300'}`}
                                >
                                    {cat.category.split(' ')[0]}
                                </button>
                            ))}
                        </div>
                        <div className="space-y-2 overflow-y-auto custom-scrollbar pr-1 flex-1">
                            {CHECKLIST_DATA.find(c => c.id === activeChecklistTab)?.items.map((item, i) => (
                                <SystemSwitch key={i} label={item} checked={!!checklistState[item]} onChange={() => toggleCheck(item)} />
                            ))}
                        </div>
                    </div>
                </div>

            </div>
        </div>
    );
};
