import React from 'react';
import { useSettings } from '../context/SettingsContext';
import { convertLength } from '../utils';
import { createLogger } from '../utils/createLogger';

const log = createLogger('VoyageResults');
import { toast } from './Toast';
import { VoyagePlan, DeepAnalysisReport, VesselProfile } from '../types';
import {
    SailBoatIcon,
    PowerBoatIcon,
    MapPinIcon,
    RouteIcon,
    CheckIcon,
    BellIcon,
    CompassIcon,
    GearIcon,
    DiamondIcon,
    BugIcon,
    WaveIcon,
    WindIcon,
    ClockIcon,
    AlertTriangleIcon,
    FlagIcon,
    PhoneIcon as _PhoneIcon,
    ServerIcon,
    ShareIcon,
} from './Icons';
import { calculateDistance } from '../utils/math';
import { fmtLat, fmtLon, fmtCoord } from '../utils/coords';
import { ResourceCalculator } from './passage/ResourceCalculator';
import { EmergencyPlan } from './passage/EmergencyPlan';
import { AccordionSection } from './passage/AccordionSection';
import { DepthSummaryCard } from './passage/DepthSummaryCard';
import { ModelComparisonCard } from './passage/ModelComparisonCard';
import { CustomsClearanceCard } from './passage/CustomsClearanceCard';
import type { MultiModelResult } from '../services/weather/MultiModelWeatherService';

// --- MICRO COMPONENTS ---

const getStatusClasses = (status?: string) => {
    switch (status) {
        case 'SAFE':
            return 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400';
        case 'CAUTION':
            return 'bg-amber-500/10 border-amber-500/30 text-amber-400';
        case 'UNSAFE':
            return 'bg-red-500/10 border-red-500/30 text-red-400';
        default:
            return 'bg-slate-800 border-white/10 text-gray-400';
    }
};

const _SystemSwitch = React.memo<{ label: string; checked: boolean; onChange: () => void }>(
    ({ label, checked, onChange }) => (
        <button
            onClick={onChange}
            aria-label={`Toggle ${label}`}
            className="flex items-center justify-between w-full p-2.5 group hover:bg-white/5 rounded-lg transition-colors border border-transparent hover:border-white/5"
        >
            <span
                className={`text-xs font-medium transition-colors ${checked ? 'text-white' : 'text-gray-400 group-hover:text-gray-300'}`}
            >
                {label}
            </span>
            <div
                className={`w-8 h-4 rounded-full relative transition-colors ${checked ? 'bg-sky-500' : 'bg-slate-700'} shadow-inner`}
            >
                <div
                    className={`absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full transition-transform shadow-sm ${checked ? 'translate-x-4' : 'translate-x-0'}`}
                ></div>
            </div>
        </button>
    ),
);

export const CHECKLIST_DATA = [
    {
        category: 'Systems & Propulsion',
        id: 'systems',
        icon: <GearIcon className="w-4 h-4 text-amber-400" />,
        items: [
            'Engine Oil & Coolant',
            'Transmission Fluid',
            'Bilge Pumps Test',
            'Battery Voltage',
            'Fuel Filters',
            'Raw Water Strainer',
            'Steering Gear',
        ],
    },
    {
        category: 'Safety & Deck',
        id: 'safety',
        icon: <BellIcon className="w-4 h-4 text-red-400" />,
        items: [
            'PFDs / Life Jackets',
            'VHF Radio Check',
            'Fire Extinguishers',
            'MOB Gear Ready',
            'EPIRB Test',
            'Flares & Signals',
            'Anchor Secure',
        ],
    },
    {
        category: 'Navigation & Comms',
        id: 'nav',
        icon: <CompassIcon rotation={0} className="w-4 h-4 text-sky-400" />,
        items: [
            'Chart Plotter Update',
            'Radar Function Test',
            'AIS Transmit Check',
            'Depth Sounder Calib',
            'Paper Charts',
            'Nav Lights',
        ],
    },
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

export const VoyageResults: React.FC<VoyageResultsProps> = React.memo(
    ({
        voyagePlan,
        vessel,
        checklistState,
        toggleCheck: _toggleCheck,
        deepReport,
        analyzingDeep,
        handleDeepAnalysis,
        activeChecklistTab: _activeChecklistTab,
        setActiveChecklistTab: _setActiveChecklistTab,
        setIsMapOpen,
        isShortTrip: _isShortTrip,
    }) => {
        // Count checked items for badge
        const _totalChecklistItems = CHECKLIST_DATA.reduce((sum, cat) => sum + cat.items.length, 0);
        const _checkedCount = Object.values(checklistState).filter(Boolean).length;

        // Wave height unit preference
        const { settings } = useSettings();
        const waveUnit = settings.units?.waveHeight || 'ft';
        const waveLabel = waveUnit === 'm' ? 'm' : 'ft';
        // All stored wave heights are in ft — convert at display time
        const displayWave = (ftVal: number | undefined): string => {
            if (ftVal === undefined || ftVal === null) return '--';
            if (waveUnit === 'm') return (ftVal / 3.281).toFixed(1);
            return String(Math.round(ftVal * 10) / 10);
        };

        // Detect if distance/duration are still Gemini AI crow-fly estimates
        // Weather routing & bathymetric routing set values like "123 NM" or "2 days 4h" / "18 hours"
        // Gemini crow-fly estimates look like "750 NM" with no routing reasoning
        // The safest heuristic: if routeReasoning contains 'Weather-optimized' or 'Weather-adjusted',
        // the route has been analyzed by the actual router
        const isRouteAnalyzed =
            voyagePlan.routeReasoning?.includes('Weather-') || voyagePlan.routeReasoning?.includes('mesh nodes');

        return (
            <div className="max-w-7xl mx-auto w-full animate-in fade-in slide-in-from-bottom-8 duration-700 pb-12 flex-1 flex flex-col gap-3">
                {/* ═══════════════════════════════════════════════════════════════════
                VOYAGE OVERVIEW CARD — Always visible hero card (not collapsible)
                ═══════════════════════════════════════════════════════════════════ */}
                <div className="w-full bg-slate-900 border border-white/10 rounded-2xl p-0 relative overflow-hidden shadow-2xl flex flex-col">
                    {/* Background Decorations */}
                    <div className="absolute top-0 right-0 w-96 h-96 bg-sky-500/5 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2 pointer-events-none"></div>

                    {/* Header: Route — Departing (left) → Arriving (right) */}
                    <div className="p-6 md:p-8 pb-0 flex items-center gap-4 relative z-10">
                        {/* Origin — Left */}
                        <div className="flex flex-col min-w-0 flex-1">
                            <span className="text-[11px] text-gray-400 font-bold uppercase tracking-widest mb-1">
                                Departing
                            </span>
                            <span className="text-xl md:text-3xl font-bold text-white tracking-tight truncate">
                                {voyagePlan.origin && typeof voyagePlan.origin === 'string'
                                    ? voyagePlan.origin.split(',')[0]
                                    : 'Unknown'}
                            </span>
                            <span className="text-[11px] text-gray-400 font-mono mt-1">
                                {fmtCoord(voyagePlan.originCoordinates?.lat, voyagePlan.originCoordinates?.lon, 2)}
                            </span>
                        </div>

                        {/* Nautical Route Connector */}
                        <div className="flex flex-col items-center justify-center shrink-0 gap-0.5 py-2 min-w-[80px] md:min-w-[140px]">
                            <div className="w-full flex items-center gap-0">
                                <div className="h-px flex-1 bg-gradient-to-r from-transparent via-sky-500/40 to-sky-500/60" />
                                <div className="p-1.5 bg-sky-500/10 border border-sky-500/30 rounded-full shadow-[0_0_8px_rgba(56,189,248,0.15)]">
                                    {vessel?.type === 'power' ? (
                                        <PowerBoatIcon className="w-3.5 h-3.5 text-sky-400" />
                                    ) : (
                                        <SailBoatIcon className="w-3.5 h-3.5 text-sky-400" />
                                    )}
                                </div>
                                <div className="h-px flex-1 bg-gradient-to-r from-sky-500/60 via-sky-500/40 to-transparent" />
                            </div>
                            <span className="text-[11px] text-sky-400/70 font-bold uppercase tracking-[0.15em] mt-0.5">
                                {voyagePlan.departureDate}
                            </span>
                        </div>

                        {/* Destination — Right */}
                        <div className="flex flex-col text-right items-end min-w-0 flex-1">
                            <span className="text-[11px] text-gray-400 font-bold uppercase tracking-widest mb-1">
                                Arriving
                            </span>
                            <span className="text-xl md:text-3xl font-bold text-white tracking-tight truncate">
                                {voyagePlan.destination && typeof voyagePlan.destination === 'string'
                                    ? voyagePlan.destination.split(',')[0]
                                    : 'Unknown'}
                            </span>
                            <span className="text-[11px] text-gray-400 font-mono mt-1">
                                {fmtCoord(
                                    voyagePlan.destinationCoordinates?.lat,
                                    voyagePlan.destinationCoordinates?.lon,
                                    2,
                                )}
                            </span>
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
                                <span className="text-xs font-bold uppercase tracking-widest text-gray-300">
                                    Distance
                                </span>
                            </div>
                            <div className="text-right">
                                {isRouteAnalyzed ? (
                                    <>
                                        <span className="text-lg font-bold text-white">
                                            {voyagePlan.distanceApprox}
                                        </span>
                                        <span className="text-[11px] text-gray-400 block">Nautical Miles</span>
                                    </>
                                ) : (
                                    <>
                                        <span className="text-lg font-bold text-amber-300/80 animate-pulse">
                                            Routing...
                                        </span>
                                        <span className="text-[11px] text-gray-400 block">Awaiting route analysis</span>
                                    </>
                                )}
                            </div>
                        </div>

                        {/* Duration */}
                        <div className="bg-white/5 rounded-xl px-4 py-3 border border-white/5 flex items-center justify-between group hover:bg-white/10 transition-colors">
                            <div className="flex items-center gap-3 text-gray-400 group-hover:text-sky-300 transition-colors">
                                <div className="p-1.5 bg-sky-500/10 rounded-lg">
                                    <ClockIcon className="w-4 h-4 text-sky-400" />
                                </div>
                                <span className="text-xs font-bold uppercase tracking-widest text-gray-300">
                                    Duration
                                </span>
                            </div>
                            <div className="text-right">
                                {isRouteAnalyzed ? (
                                    <>
                                        <span className="text-lg font-bold text-white">
                                            {voyagePlan.durationApprox}
                                        </span>
                                        <span className="text-[11px] text-gray-400 block">Estimated Time</span>
                                    </>
                                ) : (
                                    <>
                                        <span className="text-lg font-bold text-amber-300/80 animate-pulse">
                                            Routing...
                                        </span>
                                        <span className="text-[11px] text-gray-400 block">Awaiting route analysis</span>
                                    </>
                                )}
                            </div>
                        </div>

                        {/* Max Conditions */}
                        <div className="bg-white/5 rounded-xl px-4 py-3 border border-white/5 flex items-center justify-between group hover:bg-white/10 transition-colors">
                            <div className="flex items-center gap-3 text-gray-400 group-hover:text-amber-300 transition-colors">
                                <div className="p-1.5 bg-amber-500/10 rounded-lg">
                                    <WindIcon className="w-4 h-4 text-amber-400" />
                                </div>
                                <span className="text-xs font-bold uppercase tracking-widest text-gray-300">
                                    Max Conditions
                                </span>
                            </div>
                            <div className="text-right flex items-baseline gap-3">
                                <div>
                                    <span className="text-lg font-bold text-white">
                                        {voyagePlan.suitability?.maxWindEncountered ?? '--'}
                                    </span>
                                    <span className="text-[11px] text-gray-400 ml-0.5">kts</span>
                                </div>
                                <div className="text-[11px] text-sky-300 font-medium border-l border-white/10 pl-3">
                                    {displayWave(voyagePlan.suitability?.maxWaveEncountered)} {waveLabel} seas
                                </div>
                            </div>
                        </div>

                        {/* Viability Status */}
                        <div
                            className={`rounded-xl px-4 py-3 border flex items-center justify-between ${getStatusClasses(voyagePlan.suitability?.status)}`}
                        >
                            <div className="flex items-center gap-3 opacity-90">
                                <div className="p-1.5 bg-current/10 rounded-lg opacity-60">
                                    <DiamondIcon className="w-4 h-4" />
                                </div>
                                <div>
                                    <span className="text-lg font-black uppercase tracking-wide">
                                        {voyagePlan.suitability?.status}
                                    </span>
                                    <span className="text-[11px] opacity-70 block leading-tight">
                                        {voyagePlan.suitability?.reasoning || 'Route analyzed.'}
                                    </span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                {/* LIABILITY DISCLAIMER — Right under the passage plan card */}
                <div className="w-full p-4 bg-amber-950/20 border border-amber-900/30 rounded-xl flex items-start gap-4 shadow-lg">
                    <div className="p-2 bg-amber-900/30 rounded-full text-amber-500 shrink-0 mt-0.5">
                        <AlertTriangleIcon className="w-5 h-5" />
                    </div>
                    <div>
                        <h4 className="text-xs font-bold text-amber-500 uppercase tracking-widest mb-1">
                            Aid to Navigation Only
                        </h4>
                        <p className="text-[11px] text-amber-200/80 leading-relaxed font-medium">
                            This passage plan is generated using automated weather models and AI analysis. It is
                            intended as a navigational aid only and does not replace proper seamanship, official charts,
                            or local knowledge.
                            <span className="block mt-1.5 text-amber-100/90 font-bold">
                                The Master/Skipper is solely responsible for the safety of the vessel, crew, and all
                                souls on board. All navigation decisions remain the exclusive responsibility of the
                                person in command.
                            </span>
                        </p>
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
                        badge={voyagePlan.bestDepartureWindow?.timeRange || 'No Data'}
                    >
                        {voyagePlan.bestDepartureWindow ? (
                            (() => {
                                // Parse the AI's recommended departure datetime
                                const dw = voyagePlan.bestDepartureWindow;
                                const isoDate = dw.dateTimeISO;
                                let dateObj: Date | null = null;
                                let formattedDate = '';
                                let relativeDay = '';

                                if (isoDate) {
                                    dateObj = new Date(isoDate);
                                    if (!isNaN(dateObj.getTime())) {
                                        formattedDate = dateObj.toLocaleDateString('en-GB', {
                                            weekday: 'short',
                                            day: 'numeric',
                                            month: 'short',
                                            year: 'numeric',
                                        });
                                        // Relative context
                                        const now = new Date();
                                        const diffDays = Math.round((dateObj.getTime() - now.getTime()) / 86400000);
                                        if (diffDays === 0) relativeDay = 'Today';
                                        else if (diffDays === 1) relativeDay = 'Tomorrow';
                                        else if (diffDays > 1) relativeDay = `In ${diffDays} days`;
                                        else relativeDay = `${Math.abs(diffDays)} days ago`;
                                    }
                                }
                                // Fallback to departureDate if no ISO provided
                                if (!formattedDate && voyagePlan.departureDate) {
                                    const fallback = new Date(voyagePlan.departureDate);
                                    if (!isNaN(fallback.getTime())) {
                                        formattedDate = fallback.toLocaleDateString('en-GB', {
                                            weekday: 'short',
                                            day: 'numeric',
                                            month: 'short',
                                            year: 'numeric',
                                        });
                                    } else {
                                        formattedDate = voyagePlan.departureDate;
                                    }
                                }

                                return (
                                    <div className="flex flex-col md:flex-row gap-5 items-center">
                                        <div className="shrink-0 flex flex-col items-center md:items-start gap-2 min-w-[220px]">
                                            {/* Date — large and prominent */}
                                            {formattedDate && (
                                                <div className="flex items-baseline gap-2">
                                                    <span className="text-xl md:text-2xl font-bold text-white tracking-tight">
                                                        {formattedDate}
                                                    </span>
                                                    {relativeDay && (
                                                        <span
                                                            className={`text-xs font-bold uppercase tracking-widest px-2 py-0.5 rounded-full border ${
                                                                relativeDay === 'Today'
                                                                    ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
                                                                    : relativeDay === 'Tomorrow'
                                                                      ? 'text-sky-400 bg-sky-500/10 border-sky-500/20'
                                                                      : 'text-amber-400 bg-amber-500/10 border-amber-500/20'
                                                            }`}
                                                        >
                                                            {relativeDay}
                                                        </span>
                                                    )}
                                                </div>
                                            )}
                                            {/* Time range */}
                                            <div className="text-lg font-bold text-emerald-400 tracking-tight">
                                                🕐 {dw.timeRange}
                                            </div>
                                        </div>
                                        <div className="h-px w-full md:w-px md:h-20 bg-white/10 shrink-0"></div>
                                        <div className="flex-1">
                                            <p className="text-sm text-gray-300 leading-relaxed font-light text-center md:text-left">
                                                {dw.reasoning}
                                            </p>
                                        </div>
                                    </div>
                                );
                            })()
                        ) : (
                            <div className="text-center py-6">
                                <span className="text-xs text-gray-400 font-bold uppercase tracking-widest">
                                    No Departure Timing Data Available
                                </span>
                            </div>
                        )}
                    </AccordionSection>
                    {/* COMPREHENSIVE VOYAGE LOG */}
                    <AccordionSection
                        title="Comprehensive Voyage Log"
                        subtitle="Detailed Telemetry & Environmental Estimates"
                        icon={<ServerIcon className="w-5 h-5" />}
                        accent="sky"
                        defaultOpen={false}
                        badge={`${(voyagePlan.waypoints?.length || 0) + 2} waypoints`}
                    >
                        <div className="overflow-x-auto -mx-5 px-5">
                            <table className="w-full text-left border-collapse">
                                <thead>
                                    <tr className="text-[11px] text-gray-400 uppercase tracking-widest border-b border-white/10">
                                        <th className="pb-3 pl-2 font-bold">Waypoint / ETA</th>
                                        <th className="pb-3 font-bold">Position</th>
                                        <th className="pb-3 font-bold">Depth</th>
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
                                            <div className="text-[11px] text-gray-400">T+00:00</div>
                                        </td>
                                        <td className="py-3.5">
                                            <div className="text-white">
                                                {voyagePlan.origin && typeof voyagePlan.origin === 'string'
                                                    ? voyagePlan.origin.split(',')[0]
                                                    : 'Origin'}
                                            </div>
                                            <div className="text-[11px] text-gray-400 opacity-60">
                                                {fmtCoord(
                                                    voyagePlan.originCoordinates?.lat,
                                                    voyagePlan.originCoordinates?.lon,
                                                )}
                                            </div>
                                        </td>
                                        <td className="py-3.5 text-gray-400 italic">--</td>
                                        <td className="py-3.5 text-gray-400 italic">--</td>
                                        <td className="py-3.5 text-gray-400 italic">--</td>
                                        <td className="py-3.5 text-gray-400 max-w-[200px] truncate">
                                            Departure: {voyagePlan.departureDate}
                                        </td>
                                    </tr>

                                    {/* Waypoints */}
                                    {voyagePlan.waypoints.map((wp, i) => {
                                        const prevLat =
                                            i === 0
                                                ? voyagePlan.originCoordinates?.lat || 0
                                                : voyagePlan.waypoints[i - 1].coordinates?.lat || 0;
                                        const prevLon =
                                            i === 0
                                                ? voyagePlan.originCoordinates?.lon || 0
                                                : voyagePlan.waypoints[i - 1].coordinates?.lon || 0;
                                        const distKm =
                                            wp.coordinates && prevLat
                                                ? calculateDistance(
                                                      prevLat,
                                                      prevLon,
                                                      wp.coordinates.lat,
                                                      wp.coordinates.lon,
                                                  )
                                                : 0;
                                        const distNm = distKm * 0.539957;
                                        const _hours = distNm / (vessel.cruisingSpeed || 5);

                                        return (
                                            <tr
                                                key={i}
                                                className="border-b border-white/5 group hover:bg-white/5 transition-colors"
                                            >
                                                <td className="py-3.5 pl-2">
                                                    <div className="font-bold text-sky-400">
                                                        WP-{String(i + 1).padStart(2, '0')}
                                                    </div>
                                                    <div className="text-[11px] text-gray-400">{wp.name}</div>
                                                </td>
                                                <td className="py-3.5">
                                                    {wp.coordinates ? (
                                                        <>
                                                            <div>{fmtLat(wp.coordinates.lat)}</div>
                                                            <div className="opacity-60">
                                                                {fmtLon(wp.coordinates.lon)}
                                                            </div>
                                                        </>
                                                    ) : (
                                                        '--'
                                                    )}
                                                </td>
                                                <td className="py-3.5">
                                                    {wp.depth_m !== undefined ? (
                                                        <div
                                                            className={`flex items-center gap-1 font-mono text-xs ${wp.depth_m < 10 ? 'text-red-400' : wp.depth_m < 30 ? 'text-amber-400' : 'text-sky-400'}`}
                                                        >
                                                            ⚓ {wp.depth_m}m
                                                        </div>
                                                    ) : (
                                                        <span className="text-gray-400 italic">--</span>
                                                    )}
                                                </td>
                                                <td className="py-3.5">
                                                    <div className="flex items-center gap-1.5 text-sky-300">
                                                        <WindIcon className="w-3.5 h-3.5" /> {wp.windSpeed ?? '--'}kt
                                                    </div>
                                                </td>
                                                <td className="py-3.5">
                                                    <div className="flex items-center gap-1.5 text-sky-300">
                                                        <WaveIcon className="w-3.5 h-3.5" />{' '}
                                                        {displayWave(wp.waveHeight)}
                                                        {waveLabel}
                                                    </div>
                                                </td>
                                                <td className="py-3.5">
                                                    <div className="flex flex-col gap-1">
                                                        {(wp.windSpeed || 0) > 20 && (
                                                            <span className="text-[11px] font-bold text-amber-400 px-1.5 py-0.5 bg-amber-500/10 rounded w-fit border border-amber-500/20">
                                                                HIGH WIND
                                                            </span>
                                                        )}
                                                        {(wp.waveHeight || 0) > (waveUnit === 'm' ? 1.2 : 4) && (
                                                            <span className="text-[11px] font-bold text-sky-400 px-1.5 py-0.5 bg-sky-500/10 rounded w-fit border border-sky-500/20">
                                                                ROUGH SEAS
                                                            </span>
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
                                            <div className="text-[11px] text-gray-400">
                                                {isRouteAnalyzed
                                                    ? `Est. ${voyagePlan.durationApprox}`
                                                    : 'Duration pending...'}
                                            </div>
                                        </td>
                                        <td className="py-3.5">
                                            <div className="text-white">
                                                {voyagePlan.destination && typeof voyagePlan.destination === 'string'
                                                    ? voyagePlan.destination.split(',')[0]
                                                    : 'Destination'}
                                            </div>
                                            <div className="text-[11px] text-gray-400 opacity-60">
                                                {fmtCoord(
                                                    voyagePlan.destinationCoordinates?.lat,
                                                    voyagePlan.destinationCoordinates?.lon,
                                                )}
                                            </div>
                                        </td>
                                        <td className="py-3.5 text-gray-400 italic">--</td>
                                        <td className="py-3.5 text-gray-400 italic">--</td>
                                        <td className="py-3.5 text-gray-400 italic">--</td>
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
                        badge={isRouteAnalyzed ? `${voyagePlan.waypoints?.length || 0} nodes` : 'Computing...'}
                    >
                        {!isRouteAnalyzed ? (
                            <div className="flex flex-col items-center justify-center py-10 opacity-70 border-2 border-dashed border-amber-500/20 rounded-xl bg-amber-500/5">
                                <div className="animate-pulse flex flex-col items-center gap-3">
                                    <RouteIcon className="w-10 h-10 text-amber-400/60" />
                                    <span className="text-sm font-bold text-amber-300/80 uppercase tracking-widest">
                                        Computing Route...
                                    </span>
                                    <span className="text-xs text-gray-400 max-w-xs text-center">
                                        Waypoints will appear once weather routing analysis completes
                                    </span>
                                </div>
                            </div>
                        ) : voyagePlan.waypoints && voyagePlan.waypoints.length > 0 ? (
                            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                                {voyagePlan.waypoints.map((wp, i) => (
                                    <div
                                        key={i}
                                        className="flex gap-3 relative group cursor-pointer select-none bg-white/5 hover:bg-white/10 border border-white/5 hover:border-sky-500/30 rounded-xl p-4 transition-all"
                                        onClick={() => setIsMapOpen(true)}
                                    >
                                        {/* Node Number Badge */}
                                        <div className="absolute -top-2 -right-2 w-6 h-6 bg-slate-800 border border-white/10 rounded-full flex items-center justify-center text-[11px] font-mono text-gray-400 shadow-lg group-hover:border-sky-500/50 group-hover:text-sky-400 transition-colors">
                                            {i + 1}
                                        </div>

                                        {/* Serial Icon */}
                                        <div className="mt-1">
                                            <div className="w-8 h-8 rounded-full bg-slate-900 border-2 border-sky-500/30 flex items-center justify-center shrink-0 shadow-lg shadow-sky-900/10 group-hover:scale-110 transition-transform">
                                                <div className="w-2.5 h-2.5 bg-sky-500 rounded-full"></div>
                                            </div>
                                        </div>

                                        <div className="flex-1 min-w-0">
                                            <h4 className="text-sm font-bold text-white tracking-wide truncate mb-1 pr-4">
                                                {wp.name}
                                            </h4>
                                            <span className="text-[11px] font-mono text-gray-400 block mb-2">
                                                {fmtCoord(wp.coordinates?.lat, wp.coordinates?.lon)}
                                            </span>

                                            {/* Conditions Mini-Grid */}
                                            <div className="grid grid-cols-2 gap-2">
                                                {wp.windSpeed !== undefined && (
                                                    <div className="bg-black/20 rounded px-2 py-1 flex items-center gap-1.5">
                                                        <WindIcon className="w-3 h-3 text-sky-400" />
                                                        <span className="text-[11px] text-gray-300 font-medium">
                                                            {wp.windSpeed}kt
                                                        </span>
                                                    </div>
                                                )}
                                                {wp.waveHeight !== undefined && (
                                                    <div className="bg-black/20 rounded px-2 py-1 flex items-center gap-1.5">
                                                        <WaveIcon className="w-3 h-3 text-sky-400" />
                                                        <span className="text-[11px] text-gray-300 font-medium">
                                                            {displayWave(wp.waveHeight)}
                                                            {waveLabel}
                                                        </span>
                                                    </div>
                                                )}
                                                {wp.depth_m !== undefined && (
                                                    <div className="bg-black/20 rounded px-2 py-1 flex items-center gap-1.5">
                                                        <span
                                                            className={`text-[11px] font-mono font-bold ${wp.depth_m < 10 ? 'text-red-400' : wp.depth_m < 30 ? 'text-amber-400' : 'text-sky-400'}`}
                                                        >
                                                            ⚓ {wp.depth_m}m
                                                        </span>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="flex flex-col items-center justify-center py-10 opacity-50 border-2 border-dashed border-white/10 rounded-xl bg-white/5">
                                <RouteIcon className="w-10 h-10 text-gray-400 mb-3" />
                                <span className="text-sm font-bold text-gray-400 uppercase tracking-widest">
                                    Direct Route
                                </span>
                                <span className="text-xs text-gray-400 mt-1">No intermediate stops required</span>
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
                        badge={deepReport ? 'Complete' : 'Pending'}
                    >
                        {deepReport ? (
                            <div className="animate-in fade-in slide-in-from-bottom-4 space-y-6">
                                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                                    <div className="space-y-5">
                                        <div>
                                            <h4 className="text-xs text-sky-400 font-bold uppercase tracking-wider mb-2 flex items-center gap-2">
                                                <RouteIcon className="w-3 h-3" /> Strategic Overview
                                            </h4>
                                            <p className="text-sm text-gray-200 leading-relaxed font-light">
                                                {deepReport.strategy}
                                            </p>
                                        </div>
                                        <div>
                                            <h4 className="text-xs text-sky-400 font-bold uppercase tracking-wider mb-2 flex items-center gap-2">
                                                <WindIcon className="w-3 h-3" /> Weather Expectations
                                            </h4>
                                            <p className="text-sm text-gray-300 leading-relaxed font-light">
                                                {deepReport.weatherSummary}
                                            </p>
                                        </div>
                                    </div>

                                    <div className="space-y-5">
                                        {/* Hazards */}
                                        <div className="bg-black/20 rounded-xl p-4 border border-white/5">
                                            <h4 className="text-xs text-sky-400 font-bold uppercase tracking-wider mb-3 flex items-center gap-2">
                                                <AlertTriangleIcon className="w-3 h-3" /> Confirmed Hazards
                                            </h4>
                                            {deepReport.hazards && deepReport.hazards.length > 0 ? (
                                                <ul className="space-y-2">
                                                    {deepReport.hazards.map((h, i) => (
                                                        <li
                                                            key={i}
                                                            className="flex items-start gap-2 text-xs text-gray-300 leading-normal"
                                                        >
                                                            <span className="text-red-400 mt-0.5">•</span>
                                                            {h}
                                                        </li>
                                                    ))}
                                                </ul>
                                            ) : (
                                                <span className="text-xs text-gray-400 italic">
                                                    No specific navigational hazards flagged by AI.
                                                </span>
                                            )}
                                        </div>

                                        {/* Tactical Grid */}
                                        <div className="grid grid-cols-2 gap-4">
                                            <div>
                                                <h4 className="text-[11px] text-sky-400 font-bold uppercase tracking-wider mb-1">
                                                    Fuel & Engine
                                                </h4>
                                                <p className="text-xs text-gray-400 leading-relaxed">
                                                    {deepReport.fuelTactics}
                                                </p>
                                            </div>
                                            <div>
                                                <h4 className="text-[11px] text-sky-400 font-bold uppercase tracking-wider mb-1">
                                                    Watch System
                                                </h4>
                                                <p className="text-xs text-gray-400 leading-relaxed">
                                                    {deepReport.watchSchedule}
                                                </p>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ) : (
                            <div className="bg-black/20 rounded-xl p-8 border border-white/5 text-center flex flex-col items-center justify-center min-h-[160px]">
                                <DiamondIcon className="w-8 h-8 text-sky-500/40 mb-3" />
                                <p className="text-sm text-gray-400 mb-4 max-w-md">{voyagePlan.overview}</p>
                                <button
                                    onClick={handleDeepAnalysis}
                                    disabled={analyzingDeep}
                                    className="text-sky-400 hover:text-sky-300 bg-sky-500/10 hover:bg-sky-500/20 border border-sky-500/20 px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all flex items-center gap-2"
                                >
                                    {analyzingDeep ? (
                                        <div className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                                    ) : (
                                        'Run Deep Analysis'
                                    )}
                                </button>
                            </div>
                        )}
                    </AccordionSection>
                    {/* FUEL & PROVISIONS */}
                    <AccordionSection
                        title={
                            vessel.type === 'observer'
                                ? 'Resources Overview'
                                : vessel.type === 'sail'
                                  ? 'Provisions & Motor Reserve'
                                  : 'Fuel & Provisions'
                        }
                        subtitle={
                            vessel.type === 'observer'
                                ? 'Passage Distance & Duration'
                                : 'Resource Requirements Calculator'
                        }
                        icon={<GearIcon className="w-5 h-5" />}
                        accent={vessel.type === 'observer' ? 'sky' : 'amber'}
                        defaultOpen={false}
                        badge={vessel.type === 'observer' ? 'Observer' : `${vessel.crewCount || 2} crew`}
                    >
                        <ResourceCalculator voyagePlan={voyagePlan} vessel={vessel} crewCount={vessel.crewCount || 2} />
                    </AccordionSection>
                    {/* GEBCO DEPTH ANALYSIS */}
                    {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                    {(voyagePlan as any).__depthSummary && (
                        <AccordionSection
                            title="Depth Analysis"
                            subtitle="GEBCO Bathymetric Safety"
                            icon={<WaveIcon className="w-5 h-5" />}
                            accent={(() => {
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                const d = (voyagePlan as any).__depthSummary;
                                return d?.segments?.some(
                                    (s: { safety: string }) => s.safety === 'danger' || s.safety === 'land',
                                )
                                    ? 'red'
                                    : d?.shallowSegments > 0
                                      ? 'amber'
                                      : 'emerald';
                            })()}
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            defaultOpen={(voyagePlan as any).__depthSummary?.shallowSegments > 0}
                            badge={(() => {
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                const d = (voyagePlan as any).__depthSummary;
                                if (!d) return 'Pending';
                                return d.shallowSegments > 0 ? `${d.shallowSegments} shallow` : 'All Clear';
                            })()}
                        >
                            {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                            <DepthSummaryCard data={(voyagePlan as any).__depthSummary} vesselDraft={vessel.draft} />
                        </AccordionSection>
                    )}
                    {/* MULTI-MODEL WEATHER COMPARISON */}
                    {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                    {(voyagePlan as any).__multiModelComparison && (
                        <AccordionSection
                            title="Model Comparison"
                            subtitle="Multi-Model Weather Ensemble"
                            icon={<WindIcon className="w-5 h-5" />}
                            accent={(() => {
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                const m = (voyagePlan as any).__multiModelComparison as MultiModelResult;
                                const confidences = m.waypoints.map(
                                    (wp: { consensus: { confidence: string } }) => wp.consensus.confidence,
                                );
                                return (confidences as string[]).includes('low')
                                    ? 'red'
                                    : (confidences as string[]).includes('medium')
                                      ? 'amber'
                                      : 'emerald';
                            })()}
                            defaultOpen={true}
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            badge={`${((voyagePlan as any).__multiModelComparison as MultiModelResult).models.length} models`}
                        >
                            <ModelComparisonCard
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                data={(voyagePlan as any).__multiModelComparison as MultiModelResult}
                            />
                        </AccordionSection>
                    )}
                    {/* HAZARD IDENTIFICATION */}
                    <AccordionSection
                        title="Hazard Identification"
                        subtitle="Route Risk Assessment"
                        icon={<BugIcon className="w-5 h-5" />}
                        accent="red"
                        defaultOpen={false}
                        badge={
                            voyagePlan.hazards && voyagePlan.hazards.length > 0
                                ? `${voyagePlan.hazards.length} hazards`
                                : 'Clear'
                        }
                    >
                        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                            {voyagePlan.hazards && voyagePlan.hazards.length > 0 ? (
                                voyagePlan.hazards.map((h, i) => (
                                    <div
                                        key={i}
                                        className="flex items-start gap-3 p-4 rounded-xl bg-red-500/5 border border-red-500/10 hover:bg-red-500/10 hover:border-red-500/30 transition-all group h-full"
                                    >
                                        <div className="mt-1 p-2 bg-red-500/20 rounded-lg text-red-400 group-hover:text-red-200 transition-colors shrink-0">
                                            <BugIcon className="w-4 h-4" />
                                        </div>
                                        <div>
                                            <div className="flex justify-between items-center mb-2 gap-2">
                                                <span className="text-sm font-bold text-red-100 uppercase tracking-wider">
                                                    {h.name}
                                                </span>
                                                <span className="text-[11px] font-bold px-1.5 py-0.5 bg-red-500/20 text-red-300 rounded border border-red-500/20 shadow-sm whitespace-nowrap">
                                                    {h.severity}
                                                </span>
                                            </div>
                                            <p className="text-xs text-red-200/70 leading-relaxed font-light">
                                                {h.description}
                                            </p>
                                        </div>
                                    </div>
                                ))
                            ) : (
                                <div className="col-span-full py-10 flex flex-col items-center justify-center border-2 border-dashed border-white/5 rounded-xl bg-white/5 opacity-60">
                                    <CheckIcon className="w-10 h-10 text-emerald-500 mb-3" />
                                    <span className="text-sm text-gray-400 font-bold uppercase tracking-widest">
                                        Sector Clear
                                    </span>
                                    <span className="text-xs text-gray-400 mt-1">
                                        No significant hazards identified
                                    </span>
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
                            subtitle="Clearance Procedures, Contacts & Required Documents"
                            icon={<FlagIcon className="w-5 h-5" />}
                            accent="indigo"
                            defaultOpen={false}
                            badge={`${voyagePlan.customs.departingCountry || 'Origin'} → ${voyagePlan.customs.destinationCountry || 'Destination'}`}
                        >
                            <CustomsClearanceCard voyagePlan={voyagePlan} />
                        </AccordionSection>
                    )}
                    {/* EXPORT & SAVE BUTTONS */}
                    <div className="grid grid-cols-2 gap-3">
                        <button
                            onClick={async () => {
                                const { printPassageBrief } = await import('../utils/pdfExport');
                                printPassageBrief({ voyagePlan, vessel });
                            }}
                            className="bg-gradient-to-r from-sky-500/10 to-sky-600/10 border border-sky-500/20 rounded-2xl p-4 flex flex-col items-center justify-center gap-2 group hover:from-sky-500/20 hover:to-sky-600/20 transition-all"
                        >
                            <ShareIcon className="w-5 h-5 text-sky-400 group-hover:scale-110 transition-transform" />
                            <span className="text-[11px] font-bold text-sky-300 uppercase tracking-widest text-center">
                                Export Passage Brief
                            </span>
                        </button>
                        <button
                            onClick={async () => {
                                try {
                                    const { ShipLogService } = await import('../services/ShipLogService');
                                    const voyageId = await ShipLogService.savePassagePlanToLogbook(voyagePlan);
                                    if (voyageId) {
                                        // Show success via a brief visual cue (the button will flash)
                                        const btn = document.getElementById('save-route-btn');
                                        if (btn) {
                                            btn.textContent = '✓ Saved!';
                                            btn.classList.add('text-emerald-300');
                                            setTimeout(() => {
                                                btn.textContent = 'Save to Log';
                                                btn.classList.remove('text-emerald-300');
                                            }, 2000);
                                        }
                                    } else {
                                        toast.error('Failed to save route. Please ensure you are logged in.');
                                    }
                                } catch (err) {
                                    log.error('[SaveRoute]', err);
                                    toast.error('Error saving route to logbook.');
                                }
                            }}
                            className="bg-gradient-to-r from-purple-500/10 to-purple-600/10 border border-purple-500/20 rounded-2xl p-4 flex flex-col items-center justify-center gap-2 group hover:from-purple-500/20 hover:to-purple-600/20 transition-all"
                        >
                            <MapPinIcon className="w-5 h-5 text-purple-400 group-hover:scale-110 transition-transform" />
                            <span
                                id="save-route-btn"
                                className="text-[11px] font-bold text-purple-300 uppercase tracking-widest text-center"
                            >
                                Save to Log
                            </span>
                        </button>
                    </div>
                </div>
            </div>
        );
    },
);
