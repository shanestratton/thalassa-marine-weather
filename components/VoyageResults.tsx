import React from 'react';
import { VoyagePlan, VoyageHazard, Waypoint, DeepAnalysisReport, VesselProfile } from '../types';
import {
    ArrowRightIcon, SailBoatIcon, PowerBoatIcon, MapPinIcon, MapIcon,
    RouteIcon, CheckIcon, XIcon, BellIcon, CompassIcon,
    CalendarIcon, GearIcon, DiamondIcon, LockIcon, BugIcon,
    RadioTowerIcon, WaveIcon, WindIcon, ClockIcon, CrosshairIcon, BoatIcon, AlertTriangleIcon, FlagIcon, PhoneIcon, ServerIcon, ShareIcon
} from './Icons';
import { calculateDistance } from '../utils/math';
import { ResourceCalculator } from './passage/ResourceCalculator';
import { PassageTimeline } from './passage/PassageTimeline';
import { EmergencyPlan } from './passage/EmergencyPlan';
import { AccordionSection } from './passage/AccordionSection';
import { printPassageBrief } from '../utils/pdfExport';


// --- MICRO COMPONENTS ---

const getStatusClasses = (status?: string) => {
    switch (status) {
        case 'SAFE': return 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400';
        case 'CAUTION': return 'bg-amber-500/10 border-amber-500/30 text-amber-400';
        case 'UNSAFE': return 'bg-red-500/10 border-red-500/30 text-red-400';
        default: return 'bg-slate-800 border-white/10 text-gray-400';
    }
};

const SystemSwitch = React.memo<{ label: string, checked: boolean, onChange: () => void }>(({ label, checked, onChange }) => (
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
));

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
    // Count checked items for badge
    const totalChecklistItems = CHECKLIST_DATA.reduce((sum, cat) => sum + cat.items.length, 0);
    const checkedCount = Object.values(checklistState).filter(Boolean).length;

    return (
        <div className="max-w-7xl mx-auto w-full animate-in fade-in slide-in-from-bottom-8 duration-700 pb-12 flex-1 flex flex-col">

            {/* ═══════════════════════════════════════════════════════════════════
                VOYAGE OVERVIEW CARD — Always visible hero card (not collapsible)
                ═══════════════════════════════════════════════════════════════════ */}
            <div className="w-full bg-[#0f172a] border border-white/10 rounded-3xl p-0 relative overflow-hidden shadow-2xl flex flex-col mb-4">
                {/* Background Decorations */}
                <div className="absolute top-0 right-0 w-96 h-96 bg-blue-500/5 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2 pointer-events-none"></div>

                {/* Header: Route — Departing (left) → Arriving (right) */}
                <div className="p-6 md:p-8 pb-0 flex items-center gap-4 relative z-10">
                    {/* Origin — Left */}
                    <div className="flex flex-col min-w-0 flex-1">
                        <span className="text-[10px] text-gray-500 font-bold uppercase tracking-widest mb-1">Departing</span>
                        <span className="text-xl md:text-3xl font-bold text-white tracking-tight truncate">{(voyagePlan.origin && typeof voyagePlan.origin === 'string') ? voyagePlan.origin.split(',')[0] : "Unknown"}</span>
                        <span className="text-[10px] text-gray-500 font-mono mt-1">{voyagePlan.originCoordinates?.lat.toFixed(2)}°N, {Math.abs(voyagePlan.originCoordinates?.lon || 0).toFixed(2)}°W</span>
                    </div>

                    {/* Connecting Route Line */}
                    <div className="flex flex-col items-center justify-center shrink-0 gap-1 py-2 min-w-[80px] md:min-w-[160px]">
                        <span className="text-[10px] font-bold text-sky-400">{voyagePlan.distanceApprox}</span>
                        <div className="w-full h-0.5 bg-gradient-to-r from-gray-700 via-sky-500 to-gray-700 relative">
                            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 p-1 bg-[#0f172a] border border-sky-500 rounded-full">
                                <BoatIcon className="w-3 h-3 md:w-4 md:h-4 text-white" />
                            </div>
                        </div>
                        <span className="text-[9px] text-gray-500 uppercase tracking-widest">{vessel?.type.toUpperCase()}</span>
                        <span className="text-[10px] text-gray-400 font-medium">{voyagePlan.departureDate}</span>
                    </div>

                    {/* Destination — Right */}
                    <div className="flex flex-col text-right items-end min-w-0 flex-1">
                        <span className="text-[10px] text-gray-500 font-bold uppercase tracking-widest mb-1">Arriving</span>
                        <span className="text-xl md:text-3xl font-bold text-white tracking-tight truncate">{(voyagePlan.destination && typeof voyagePlan.destination === 'string') ? voyagePlan.destination.split(',')[0] : "Unknown"}</span>
                        <span className="text-[10px] text-gray-500 font-mono mt-1">{voyagePlan.destinationCoordinates?.lat.toFixed(2)}°N, {Math.abs(voyagePlan.destinationCoordinates?.lon || 0).toFixed(2)}°W</span>
                    </div>
                </div>

                {/* Stats Stack — Vertical */}
                <div className="px-6 md:px-8 pb-6 flex flex-col gap-2.5 relative z-10">
                    {/* Distance */}
                    <div className="bg-white/5 rounded-xl px-4 py-3 border border-white/5 flex items-center justify-between group hover:bg-white/10 transition-colors">
                        <div className="flex items-center gap-3 text-gray-400 group-hover:text-sky-300 transition-colors">
                            <div className="p-1.5 bg-sky-500/10 rounded-lg">
                                <RouteIcon className="w-4 h-4 text-sky-400" />
                            </div>
                            <span className="text-xs font-bold uppercase tracking-widest text-gray-300">Distance</span>
                        </div>
                        <div className="text-right">
                            <span className="text-lg font-bold text-white">{voyagePlan.distanceApprox}</span>
                            <span className="text-[10px] text-gray-500 block">Great Circle</span>
                        </div>
                    </div>

                    {/* Duration */}
                    <div className="bg-white/5 rounded-xl px-4 py-3 border border-white/5 flex items-center justify-between group hover:bg-white/10 transition-colors">
                        <div className="flex items-center gap-3 text-gray-400 group-hover:text-sky-300 transition-colors">
                            <div className="p-1.5 bg-sky-500/10 rounded-lg">
                                <ClockIcon className="w-4 h-4 text-sky-400" />
                            </div>
                            <span className="text-xs font-bold uppercase tracking-widest text-gray-300">Duration</span>
                        </div>
                        <div className="text-right">
                            <span className="text-lg font-bold text-white">{voyagePlan.durationApprox}</span>
                            <span className="text-[10px] text-gray-500 block">Estimated Time</span>
                        </div>
                    </div>

                    {/* Max Conditions */}
                    <div className="bg-white/5 rounded-xl px-4 py-3 border border-white/5 flex items-center justify-between group hover:bg-white/10 transition-colors">
                        <div className="flex items-center gap-3 text-gray-400 group-hover:text-orange-300 transition-colors">
                            <div className="p-1.5 bg-orange-500/10 rounded-lg">
                                <WindIcon className="w-4 h-4 text-orange-400" />
                            </div>
                            <span className="text-xs font-bold uppercase tracking-widest text-gray-300">Max Conditions</span>
                        </div>
                        <div className="text-right flex items-baseline gap-3">
                            <div>
                                <span className="text-lg font-bold text-white">{voyagePlan.suitability?.maxWindEncountered ?? '--'}</span>
                                <span className="text-[10px] text-gray-500 ml-0.5">kts</span>
                            </div>
                            <div className="text-[10px] text-blue-300 font-medium border-l border-white/10 pl-3">
                                {voyagePlan.suitability?.maxWaveEncountered ?? '--'} ft seas
                            </div>
                        </div>
                    </div>

                    {/* Viability Status */}
                    <div className={`rounded-xl px-4 py-3 border flex items-center justify-between ${getStatusClasses(voyagePlan.suitability?.status)}`}>
                        <div className="flex items-center gap-3 opacity-90">
                            <div className="p-1.5 bg-current/10 rounded-lg opacity-60">
                                <DiamondIcon className="w-4 h-4" />
                            </div>
                            <div>
                                <span className="text-lg font-black uppercase tracking-wide">{voyagePlan.suitability?.status}</span>
                                <span className="text-[10px] opacity-70 block leading-tight">{voyagePlan.suitability?.reasoning || "Route analyzed."}</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* ═══════════════════════════════════════════════════════════════════
                COLLAPSIBLE ACCORDIONS — All sections below
                ═══════════════════════════════════════════════════════════════════ */}
            <div className="flex flex-col gap-3">

                {/* OPTIMAL DEPARTURE WINDOW */}
                <AccordionSection
                    title="Optimal Departure"
                    subtitle="Weather Window Analysis"
                    icon={<ClockIcon className="w-5 h-5" />}
                    accent="emerald"
                    defaultOpen={true}
                    badge={voyagePlan.bestDepartureWindow?.timeRange || "No Data"}
                >
                    {voyagePlan.bestDepartureWindow ? (
                        <div className="flex flex-col md:flex-row gap-6 items-center">
                            <div className="shrink-0 flex flex-col items-center md:items-start gap-2 min-w-[200px]">
                                <div className="text-2xl md:text-3xl font-bold text-white tracking-tight text-center md:text-left">{voyagePlan.bestDepartureWindow.timeRange}</div>
                            </div>
                            <div className="h-px w-full md:w-px md:h-16 bg-white/10 shrink-0"></div>
                            <div className="flex-1">
                                <p className="text-sm text-gray-300 leading-relaxed font-light text-center md:text-left">{voyagePlan.bestDepartureWindow.reasoning}</p>
                            </div>
                        </div>
                    ) : (
                        <div className="text-center py-6">
                            <span className="text-xs text-gray-500 font-bold uppercase tracking-widest">No Departure Timing Data Available</span>
                        </div>
                    )}
                </AccordionSection>

                {/* PASSAGE TIMELINE */}
                <AccordionSection
                    title="Passage Timeline"
                    subtitle="Hour-by-Hour Conditions"
                    icon={<CalendarIcon className="w-5 h-5" />}
                    accent="blue"
                    defaultOpen={false}
                    badge={voyagePlan.durationApprox}
                >
                    <PassageTimeline voyagePlan={voyagePlan} vessel={vessel} />
                </AccordionSection>

                {/* COMPREHENSIVE VOYAGE LOG */}
                <AccordionSection
                    title="Comprehensive Voyage Log"
                    subtitle="Detailed Telemetry & Environmental Estimates"
                    icon={<ServerIcon className="w-5 h-5" />}
                    accent="sky"
                    defaultOpen={false}
                    badge={`${(voyagePlan.waypoints?.length || 0) + 2} checkpoints`}
                >
                    <div className="overflow-x-auto -mx-5 px-5">
                        <table className="w-full text-left border-collapse">
                            <thead>
                                <tr className="text-[10px] text-gray-500 uppercase tracking-widest border-b border-white/10">
                                    <th className="pb-3 pl-2 font-bold">Checkpoint / ETA</th>
                                    <th className="pb-3 font-bold">Position</th>
                                    <th className="pb-3 font-bold">Wind</th>
                                    <th className="pb-3 font-bold">Sea State</th>
                                    <th className="pb-3 font-bold">Notes</th>
                                </tr>
                            </thead>
                            <tbody className="text-xs md:text-sm font-mono text-gray-300">
                                {/* Origin Row */}
                                <tr className="border-b border-white/5 group hover:bg-white/5 transition-colors">
                                    <td className="py-3.5 pl-2">
                                        <div className="font-bold text-white">DEPARTURE</div>
                                        <div className="text-[10px] text-gray-500">T+00:00</div>
                                    </td>
                                    <td className="py-3.5">
                                        <div className="text-white">{(voyagePlan.origin && typeof voyagePlan.origin === 'string') ? voyagePlan.origin.split(',')[0] : "Origin"}</div>
                                        <div className="text-[10px] text-gray-500 opacity-60">
                                            {voyagePlan.originCoordinates?.lat.toFixed(3)}N, {Math.abs(voyagePlan.originCoordinates?.lon || 0).toFixed(3)}W
                                        </div>
                                    </td>
                                    <td className="py-3.5 text-gray-500 italic">--</td>
                                    <td className="py-3.5 text-gray-500 italic">--</td>
                                    <td className="py-3.5 text-gray-400 max-w-[200px] truncate">
                                        Departure: {voyagePlan.departureDate}
                                    </td>
                                </tr>

                                {/* Waypoints */}
                                {voyagePlan.waypoints.map((wp, i) => {
                                    const prevLat = i === 0 ? (voyagePlan.originCoordinates?.lat || 0) : (voyagePlan.waypoints[i - 1].coordinates?.lat || 0);
                                    const prevLon = i === 0 ? (voyagePlan.originCoordinates?.lon || 0) : (voyagePlan.waypoints[i - 1].coordinates?.lon || 0);
                                    const distKm = (wp.coordinates && prevLat) ? calculateDistance(prevLat, prevLon, wp.coordinates.lat, wp.coordinates.lon) : 0;
                                    const distNm = distKm * 0.539957;
                                    const hours = (distNm / (vessel.cruisingSpeed || 5));

                                    return (
                                        <tr key={i} className="border-b border-white/5 group hover:bg-white/5 transition-colors">
                                            <td className="py-3.5 pl-2">
                                                <div className="font-bold text-sky-400">WP-{String(i + 1).padStart(2, '0')}</div>
                                                <div className="text-[10px] text-gray-500">{wp.name}</div>
                                            </td>
                                            <td className="py-3.5">
                                                {wp.coordinates ? (
                                                    <>
                                                        <div>{wp.coordinates.lat.toFixed(3)}N</div>
                                                        <div className="opacity-60">{Math.abs(wp.coordinates.lon).toFixed(3)}W</div>
                                                    </>
                                                ) : "--"}
                                            </td>
                                            <td className="py-3.5">
                                                <div className="flex items-center gap-1.5 text-sky-300">
                                                    <WindIcon className="w-3.5 h-3.5" /> {wp.windSpeed ?? '--'}kt
                                                </div>
                                            </td>
                                            <td className="py-3.5">
                                                <div className="flex items-center gap-1.5 text-blue-300">
                                                    <WaveIcon className="w-3.5 h-3.5" /> {wp.waveHeight ?? '--'}ft
                                                </div>
                                            </td>
                                            <td className="py-3.5">
                                                <div className="flex flex-col gap-1">
                                                    {(wp.windSpeed || 0) > 20 && (
                                                        <span className="text-[10px] font-bold text-orange-400 px-1.5 py-0.5 bg-orange-500/10 rounded w-fit border border-orange-500/20">HIGH WIND</span>
                                                    )}
                                                    {(wp.waveHeight || 0) > 4 && (
                                                        <span className="text-[10px] font-bold text-blue-400 px-1.5 py-0.5 bg-blue-500/10 rounded w-fit border border-blue-500/20">ROUGH SEAS</span>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })}

                                {/* Destination Row */}
                                <tr className="group hover:bg-white/5 transition-colors">
                                    <td className="py-3.5 pl-2">
                                        <div className="font-bold text-white">ARRIVAL</div>
                                        <div className="text-[10px] text-gray-500">Est. {voyagePlan.durationApprox}</div>
                                    </td>
                                    <td className="py-3.5">
                                        <div className="text-white">{(voyagePlan.destination && typeof voyagePlan.destination === 'string') ? voyagePlan.destination.split(',')[0] : "Destination"}</div>
                                        <div className="text-[10px] text-gray-500 opacity-60">
                                            {voyagePlan.destinationCoordinates?.lat.toFixed(3)}N, {Math.abs(voyagePlan.destinationCoordinates?.lon || 0).toFixed(3)}W
                                        </div>
                                    </td>
                                    <td className="py-3.5 text-gray-500 italic">--</td>
                                    <td className="py-3.5 text-gray-500 italic">--</td>
                                    <td className="py-3.5 text-emerald-400 font-bold text-xs uppercase tracking-wider">
                                        Destination Reach
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </AccordionSection>

                {/* SUGGESTED ROUTE PLAN */}
                <AccordionSection
                    title="Suggested Route Plan"
                    subtitle="Tactical Routing & Stops"
                    icon={<RouteIcon className="w-5 h-5" />}
                    accent="sky"
                    defaultOpen={false}
                    badge={`${(voyagePlan.waypoints?.length || 0)} nodes`}
                >
                    {(voyagePlan.waypoints && voyagePlan.waypoints.length > 0) ? (
                        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                            {voyagePlan.waypoints.map((wp, i) => (
                                <div key={i} className="flex gap-3 relative group cursor-pointer select-none bg-white/5 hover:bg-white/10 border border-white/5 hover:border-sky-500/30 rounded-xl p-4 transition-all" onClick={() => setIsMapOpen(true)}>
                                    {/* Node Number Badge */}
                                    <div className="absolute -top-2 -right-2 w-6 h-6 bg-slate-800 border border-white/10 rounded-full flex items-center justify-center text-[9px] font-mono text-gray-500 shadow-lg group-hover:border-sky-500/50 group-hover:text-sky-400 transition-colors">
                                        {i + 1}
                                    </div>

                                    {/* Serial Icon */}
                                    <div className="mt-1">
                                        <div className="w-8 h-8 rounded-full bg-slate-900 border-2 border-sky-500/30 flex items-center justify-center shrink-0 shadow-lg shadow-sky-900/10 group-hover:scale-110 transition-transform">
                                            <div className="w-2.5 h-2.5 bg-sky-500 rounded-full"></div>
                                        </div>
                                    </div>

                                    <div className="flex-1 min-w-0">
                                        <h4 className="text-sm font-bold text-white tracking-wide truncate mb-1 pr-4">{wp.name}</h4>
                                        <span className="text-[10px] font-mono text-gray-400 block mb-2">{wp.coordinates?.lat.toFixed(3)}N {Math.abs(wp.coordinates?.lon || 0).toFixed(3)}W</span>

                                        {/* Conditions Mini-Grid */}
                                        <div className="grid grid-cols-2 gap-2">
                                            {wp.windSpeed !== undefined && (
                                                <div className="bg-black/20 rounded px-2 py-1 flex items-center gap-1.5">
                                                    <WindIcon className="w-3 h-3 text-sky-400" />
                                                    <span className="text-[10px] text-gray-300 font-medium">{wp.windSpeed}kt</span>
                                                </div>
                                            )}
                                            {wp.waveHeight !== undefined && (
                                                <div className="bg-black/20 rounded px-2 py-1 flex items-center gap-1.5">
                                                    <WaveIcon className="w-3 h-3 text-blue-400" />
                                                    <span className="text-[10px] text-gray-300 font-medium">{wp.waveHeight}ft</span>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="flex flex-col items-center justify-center py-10 opacity-50 border-2 border-dashed border-white/10 rounded-xl bg-white/5">
                            <RouteIcon className="w-10 h-10 text-gray-500 mb-3" />
                            <span className="text-sm font-bold text-gray-400 uppercase tracking-widest">Direct Route</span>
                            <span className="text-xs text-gray-600 mt-1">No intermediate stops required</span>
                        </div>
                    )}
                </AccordionSection>

                {/* DEEP VOYAGE ANALYSIS */}
                <AccordionSection
                    title="Deep Voyage Analysis"
                    subtitle="AI-Generated Strategy & Safety Assessment"
                    icon={<DiamondIcon className="w-5 h-5" />}
                    accent="indigo"
                    defaultOpen={true}
                    badge={deepReport ? "Complete" : "Pending"}
                >
                    {deepReport ? (
                        <div className="animate-in fade-in slide-in-from-bottom-4 space-y-6">
                            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                                <div className="space-y-5">
                                    <div>
                                        <h4 className="text-xs text-indigo-400 font-bold uppercase tracking-wider mb-2 flex items-center gap-2">
                                            <RouteIcon className="w-3 h-3" /> Strategic Overview
                                        </h4>
                                        <p className="text-sm text-gray-200 leading-relaxed font-light">{deepReport.strategy}</p>
                                    </div>
                                    <div>
                                        <h4 className="text-xs text-indigo-400 font-bold uppercase tracking-wider mb-2 flex items-center gap-2">
                                            <WindIcon className="w-3 h-3" /> Weather Expectations
                                        </h4>
                                        <p className="text-sm text-gray-300 leading-relaxed font-light">{deepReport.weatherSummary}</p>
                                    </div>
                                </div>

                                <div className="space-y-5">
                                    {/* Hazards */}
                                    <div className="bg-black/20 rounded-xl p-4 border border-white/5">
                                        <h4 className="text-xs text-indigo-400 font-bold uppercase tracking-wider mb-3 flex items-center gap-2">
                                            <AlertTriangleIcon className="w-3 h-3" /> Confirmed Hazards
                                        </h4>
                                        {deepReport.hazards && deepReport.hazards.length > 0 ? (
                                            <ul className="space-y-2">
                                                {deepReport.hazards.map((h, i) => (
                                                    <li key={i} className="flex items-start gap-2 text-xs text-gray-300 leading-normal">
                                                        <span className="text-red-400 mt-0.5">•</span>
                                                        {h}
                                                    </li>
                                                ))}
                                            </ul>
                                        ) : (
                                            <span className="text-xs text-gray-500 italic">No specific navigational hazards flagged by AI.</span>
                                        )}
                                    </div>

                                    {/* Tactical Grid */}
                                    <div className="grid grid-cols-2 gap-4">
                                        <div>
                                            <h4 className="text-[10px] text-indigo-400 font-bold uppercase tracking-wider mb-1">Fuel & Engine</h4>
                                            <p className="text-xs text-gray-400 leading-relaxed">{deepReport.fuelTactics}</p>
                                        </div>
                                        <div>
                                            <h4 className="text-[10px] text-indigo-400 font-bold uppercase tracking-wider mb-1">Watch System</h4>
                                            <p className="text-xs text-gray-400 leading-relaxed">{deepReport.watchSchedule}</p>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div className="bg-black/20 rounded-xl p-8 border border-white/5 text-center flex flex-col items-center justify-center min-h-[160px]">
                            <DiamondIcon className="w-8 h-8 text-indigo-500/40 mb-3" />
                            <p className="text-sm text-gray-400 mb-4 max-w-md">{voyagePlan.overview}</p>
                            <button onClick={handleDeepAnalysis} disabled={analyzingDeep} className="text-indigo-400 hover:text-indigo-300 bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/20 px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all flex items-center gap-2">
                                {analyzingDeep ? <div className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" /> : "Run Deep Analysis"}
                            </button>
                        </div>
                    )}
                </AccordionSection>

                {/* FUEL & PROVISIONS */}
                <AccordionSection
                    title={vessel.type === 'observer' ? 'Resources Overview' : vessel.type === 'sail' ? 'Provisions & Motor Reserve' : 'Fuel & Provisions'}
                    subtitle={vessel.type === 'observer' ? 'Passage Distance & Duration' : 'Resource Requirements Calculator'}
                    icon={<GearIcon className="w-5 h-5" />}
                    accent={vessel.type === 'observer' ? 'sky' : 'amber'}
                    defaultOpen={false}
                    badge={vessel.type === 'observer' ? 'Observer' : `${vessel.crewCount || 2} crew`}
                >
                    <ResourceCalculator voyagePlan={voyagePlan} vessel={vessel} crewCount={vessel.crewCount || 2} />
                </AccordionSection>

                {/* HAZARD IDENTIFICATION */}
                <AccordionSection
                    title="Hazard Identification"
                    subtitle="Route Risk Assessment"
                    icon={<BugIcon className="w-5 h-5" />}
                    accent="red"
                    defaultOpen={false}
                    badge={voyagePlan.hazards && voyagePlan.hazards.length > 0 ? `${voyagePlan.hazards.length} hazards` : "Clear"}
                >
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                        {voyagePlan.hazards && voyagePlan.hazards.length > 0 ? (
                            voyagePlan.hazards.map((h, i) => (
                                <div key={i} className="flex items-start gap-3 p-4 rounded-xl bg-red-500/5 border border-red-500/10 hover:bg-red-500/10 hover:border-red-500/30 transition-all group h-full">
                                    <div className="mt-1 p-2 bg-red-500/20 rounded-lg text-red-400 group-hover:text-red-200 transition-colors shrink-0">
                                        <BugIcon className="w-4 h-4" />
                                    </div>
                                    <div>
                                        <div className="flex justify-between items-center mb-2 gap-2">
                                            <span className="text-sm font-bold text-red-100 uppercase tracking-wider">{h.name}</span>
                                            <span className="text-[9px] font-bold px-1.5 py-0.5 bg-red-500/20 text-red-300 rounded border border-red-500/20 shadow-sm whitespace-nowrap">{h.severity}</span>
                                        </div>
                                        <p className="text-xs text-red-200/70 leading-relaxed font-light">{h.description}</p>
                                    </div>
                                </div>
                            ))
                        ) : (
                            <div className="col-span-full py-10 flex flex-col items-center justify-center border-2 border-dashed border-white/5 rounded-xl bg-white/5 opacity-60">
                                <CheckIcon className="w-10 h-10 text-emerald-500 mb-3" />
                                <span className="text-sm text-gray-400 font-bold uppercase tracking-widest">Sector Clear</span>
                                <span className="text-xs text-gray-600 mt-1">No significant hazards identified</span>
                            </div>
                        )}
                    </div>
                </AccordionSection>

                {/* EMERGENCY & CONTINGENCY */}
                <AccordionSection
                    title="Emergency & Contingency"
                    subtitle="Safe Harbors & Emergency Procedures"
                    icon={<AlertTriangleIcon className="w-5 h-5" />}
                    accent="red"
                    defaultOpen={false}
                    badge="Safety Plan"
                >
                    <EmergencyPlan voyagePlan={voyagePlan} vessel={vessel} />
                </AccordionSection>

                {/* CUSTOMS & IMMIGRATION (if applicable) */}
                {voyagePlan.customs?.required && (
                    <AccordionSection
                        title="Customs & Immigration"
                        subtitle="International Clearance Requirements"
                        icon={<FlagIcon className="w-5 h-5" />}
                        accent="indigo"
                        defaultOpen={false}
                        badge={`${voyagePlan.customs.departingCountry || 'Origin'} → ${voyagePlan.customs.destinationCountry || 'Destination'}`}
                    >
                        <div className="space-y-5">
                            {/* Departure Section */}
                            {voyagePlan.customs.departureProcedures && (
                                <div className="border-b border-indigo-500/20 pb-4">
                                    <div className="flex items-center gap-3 mb-2">
                                        <div className="p-2 bg-indigo-500/20 rounded-full text-indigo-300">
                                            <FlagIcon className="w-4 h-4" />
                                        </div>
                                        <h4 className="text-sm font-bold text-indigo-200 uppercase tracking-widest">
                                            Clearance Outbound: {voyagePlan.customs.departingCountry || "Origin"}
                                        </h4>
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
                                            <FlagIcon className="w-4 h-4" />
                                        </div>
                                        <h4 className="text-sm font-bold text-indigo-200 uppercase tracking-widest">
                                            International Arrival: {voyagePlan.customs.destinationCountry || "Border Crossing"}
                                        </h4>
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
                    </AccordionSection>
                )}

                {/* PRE-DEPARTURE SYSTEMS CHECK */}
                <AccordionSection
                    title="Pre-Departure Systems"
                    subtitle="Internal Vessel Integrity"
                    icon={<GearIcon className="w-5 h-5" />}
                    accent="orange"
                    defaultOpen={false}
                    badge={`${checkedCount}/${totalChecklistItems} checked`}
                >
                    <div className="space-y-4">
                        {/* Tab Bar */}
                        <div className="flex bg-black/40 p-1.5 rounded-xl border border-white/5">
                            {CHECKLIST_DATA.map((cat) => (
                                <button
                                    key={cat.id}
                                    onClick={() => setActiveChecklistTab(cat.id)}
                                    className={`px-4 py-2 text-[10px] md:text-xs font-bold uppercase rounded-lg transition-all flex-1 ${activeChecklistTab === cat.id ? 'bg-white/10 text-white shadow-lg border border-white/10' : 'text-gray-500 hover:text-gray-300 hover:bg-white/5'}`}
                                >
                                    {cat.category}
                                </button>
                            ))}
                        </div>

                        {/* Checklist Grid */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                            {CHECKLIST_DATA.find(c => c.id === activeChecklistTab)?.items.map((item, i) => (
                                <button
                                    key={i}
                                    onClick={() => toggleCheck(item)}
                                    className={`group flex items-center justify-between p-4 rounded-xl border transition-all duration-300 ${checklistState[item]
                                        ? 'bg-emerald-500/10 border-emerald-500/30 hover:bg-emerald-500/20'
                                        : 'bg-white/5 border-white/5 hover:bg-white/10 hover:border-white/10'
                                        }`}
                                >
                                    <span className={`text-xs font-medium transition-colors ${checklistState[item] ? 'text-emerald-300' : 'text-gray-400 group-hover:text-gray-200'}`}>
                                        {item}
                                    </span>

                                    <div className={`w-5 h-5 rounded-md flex items-center justify-center transition-all ${checklistState[item]
                                        ? 'bg-emerald-500 text-slate-900 shadow-lg shadow-emerald-500/20'
                                        : 'bg-black/40 border border-white/10 group-hover:border-white/20'
                                        }`}>
                                        {checklistState[item] && <CheckIcon className="w-3.5 h-3.5 stroke-[3]" />}
                                    </div>
                                </button>
                            ))}
                        </div>
                    </div>
                </AccordionSection>

                {/* INTERACTIVE CHART BUTTON — Not an accordion */}
                <button
                    onClick={() => setIsMapOpen(true)}
                    aria-label="Open Interactive Chart"
                    className="w-full h-[100px] bg-slate-800 border border-white/10 rounded-2xl overflow-hidden relative group cursor-pointer shadow-xl transition-all hover:border-sky-500/30 flex items-center justify-between px-6 md:px-10"
                >
                    <div className="absolute inset-0 bg-[url('https://images.unsplash.com/photo-1524661135-423995f22d0b?q=80&w=2074&fm=jpg&fit=crop')] bg-cover bg-center opacity-30 group-hover:opacity-40 group-hover:scale-105 transition-all duration-700"></div>
                    <div className="absolute inset-0 bg-gradient-to-r from-slate-900 via-slate-900/40 to-slate-900/10"></div>

                    <div className="relative z-10 flex flex-col items-start gap-1">
                        <h3 className="text-lg md:text-xl font-bold text-white shadow-black drop-shadow-md">Interactive Chart</h3>
                        <p className="text-xs text-sky-300 font-medium uppercase tracking-widest shadow-black drop-shadow-md">
                            {isShortTrip ? 'View Detailed Route & Waypoints' : 'View Full Passage Plan & Waypoints'}
                        </p>
                    </div>

                    <div className="relative z-10 bg-sky-500/90 p-3.5 rounded-full text-white shadow-lg group-hover:scale-110 transition-transform group-hover:bg-sky-500 border border-white/20">
                        <MapIcon className="w-5 h-5" />
                    </div>
                </button>

                {/* PDF EXPORT */}
                <button
                    onClick={() => printPassageBrief({ voyagePlan, vessel })}
                    className="w-full bg-gradient-to-r from-sky-500/10 to-blue-600/10 border border-sky-500/20 rounded-2xl p-4 flex items-center justify-center gap-3 group hover:from-sky-500/20 hover:to-blue-600/20 transition-all"
                >
                    <ShareIcon className="w-5 h-5 text-sky-400 group-hover:scale-110 transition-transform" />
                    <span className="text-sm font-bold text-sky-300 uppercase tracking-widest">Export Passage Brief (PDF)</span>
                </button>
            </div>

            {/* LIABILITY DISCLAIMER */}
            <div className="w-full p-4 bg-amber-950/20 border border-amber-900/30 rounded-xl flex items-start gap-4 shadow-lg backdrop-blur-sm mt-4">
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

        </div>
    );
};
