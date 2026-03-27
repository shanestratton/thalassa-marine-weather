import React from 'react';
import { useSettings } from '../context/SettingsContext';
import { createLogger } from '../utils/createLogger';

const _log = createLogger('VoyageResults');
import { toast as _toast } from './Toast';
import { VoyagePlan, DeepAnalysisReport, VesselProfile } from '../types';
import {
    RouteIcon,
    CheckIcon,
    BellIcon,
    CompassIcon,
    GearIcon,
    DiamondIcon,
    BugIcon,
    WaveIcon,
    WindIcon,
    ClockIcon as _ClockIcon,
    AlertTriangleIcon,
    FlagIcon as _FlagIcon,
    ServerIcon,
    MapPinIcon as _MapPinIcon,
    ShareIcon as _ShareIcon,
} from './Icons';
import { ResourceCalculator } from './passage/ResourceCalculator';
import { EmergencyPlan } from './passage/EmergencyPlan';
import { AccordionSection } from './passage/AccordionSection';
import { DepthSummaryCard } from './passage/DepthSummaryCard';
import { ModelComparisonCard } from './passage/ModelComparisonCard';
import type { MultiModelResult } from '../services/weather/MultiModelWeatherService';

// --- Extracted sub-components ---
import { VoyageOverviewCard } from './voyage-results/VoyageOverviewCard';
import { VoyageLogTable } from './voyage-results/VoyageLogTable';
import { RouteNodeGrid } from './voyage-results/RouteNodeGrid';
import { DeepAnalysisSection as _DeepAnalysisSection } from './voyage-results/DeepAnalysisSection';
import { ExportButtons } from './voyage-results/DeepAnalysisSection';

// getStatusClasses() moved to voyage-results/VoyageOverviewCard.tsx

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
        const isRouteAnalyzed = !!(
            voyagePlan.routeReasoning?.includes('Weather-') || voyagePlan.routeReasoning?.includes('mesh nodes')
        );

        return (
            <div className="max-w-7xl mx-auto w-full animate-in fade-in slide-in-from-bottom-8 duration-700 pb-12 flex-1 flex flex-col gap-3">
                {/* VOYAGE OVERVIEW CARD */}
                <VoyageOverviewCard
                    voyagePlan={voyagePlan}
                    vessel={vessel}
                    isRouteAnalyzed={isRouteAnalyzed}
                    displayWave={displayWave}
                    waveLabel={waveLabel}
                />

                {/* ═══════════════════════════════════════════════════════════════════
                COLLAPSIBLE ACCORDIONS — Route analysis sections
                ═══════════════════════════════════════════════════════════════════ */}
                <div className="flex flex-col gap-3">
                    {/* COMPREHENSIVE VOYAGE LOG */}
                    <AccordionSection
                        title="Comprehensive Voyage Log"
                        subtitle="Detailed Telemetry & Environmental Estimates"
                        icon={<ServerIcon className="w-5 h-5" />}
                        accent="sky"
                        defaultOpen={false}
                        badge={`${(voyagePlan.waypoints?.length || 0) + 2} waypoints`}
                    >
                        <VoyageLogTable
                            voyagePlan={voyagePlan}
                            vessel={vessel}
                            isRouteAnalyzed={isRouteAnalyzed}
                            displayWave={displayWave}
                            waveLabel={waveLabel}
                        />
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
                        <RouteNodeGrid
                            voyagePlan={voyagePlan}
                            isRouteAnalyzed={isRouteAnalyzed}
                            setIsMapOpen={setIsMapOpen}
                            displayWave={displayWave}
                            waveLabel={waveLabel}
                        />
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
                                    aria-label="Deep Analysis"
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
                        badge={vessel.type === 'observer' ? 'Crew' : `${vessel.crewCount || 2} crew`}
                    >
                        <ResourceCalculator voyagePlan={voyagePlan} vessel={vessel} crewCount={vessel.crewCount || 2} />
                    </AccordionSection>
                    {/* GEBCO DEPTH ANALYSIS */}
                    {voyagePlan.__depthSummary && (
                        <AccordionSection
                            title="Depth Analysis"
                            subtitle="GEBCO Bathymetric Safety"
                            icon={<WaveIcon className="w-5 h-5" />}
                            accent={(() => {
                                const d = voyagePlan.__depthSummary;
                                return d?.segments?.some(
                                    (s: { safety: string }) => s.safety === 'danger' || s.safety === 'land',
                                )
                                    ? 'red'
                                    : d?.shallowSegments > 0
                                      ? 'amber'
                                      : 'emerald';
                            })()}
                            defaultOpen={voyagePlan.__depthSummary?.shallowSegments > 0}
                            badge={(() => {
                                const d = voyagePlan.__depthSummary;
                                if (!d) return 'Pending';
                                return d.shallowSegments > 0 ? `${d.shallowSegments} shallow` : 'All Clear';
                            })()}
                        >
                            <DepthSummaryCard data={voyagePlan.__depthSummary} vesselDraft={vessel.draft} />
                        </AccordionSection>
                    )}
                    {/* MULTI-MODEL WEATHER COMPARISON */}
                    {voyagePlan.__multiModelComparison && (
                        <AccordionSection
                            title="Model Comparison"
                            subtitle="Multi-Model Weather Ensemble"
                            icon={<WindIcon className="w-5 h-5" />}
                            accent={(() => {
                                const m = voyagePlan.__multiModelComparison as MultiModelResult;
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
                            badge={`${(voyagePlan.__multiModelComparison as MultiModelResult).models.length} models`}
                        >
                            <ModelComparisonCard data={voyagePlan.__multiModelComparison as MultiModelResult} />
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
                    {/* EXPORT & SAVE BUTTONS */}
                    <ExportButtons voyagePlan={voyagePlan} vessel={vessel} />
                </div>
            </div>
        );
    },
);
