/**
 * DeepAnalysisSection — AI deep voyage analysis content.
 */

import React from 'react';
import type { DeepAnalysisReport, VoyagePlan, VesselProfile } from '../../types';
import { RouteIcon, WindIcon, AlertTriangleIcon, DiamondIcon, ShareIcon, MapPinIcon } from '../Icons';
import { toast } from '../Toast';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('DeepAnalysis');

interface DeepAnalysisSectionProps {
    deepReport: DeepAnalysisReport | null;
    analyzingDeep: boolean;
    handleDeepAnalysis: () => void;
    voyagePlan: VoyagePlan;
    vesselType: string;
}

export const DeepAnalysisSection: React.FC<DeepAnalysisSectionProps> = React.memo(
    ({ deepReport, analyzingDeep, handleDeepAnalysis, voyagePlan, vesselType: _vesselType }) => {
        if (deepReport) {
            return (
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
                                    <p className="text-xs text-gray-400 leading-relaxed">{deepReport.fuelTactics}</p>
                                </div>
                                <div>
                                    <h4 className="text-[11px] text-sky-400 font-bold uppercase tracking-wider mb-1">
                                        Watch System
                                    </h4>
                                    <p className="text-xs text-gray-400 leading-relaxed">{deepReport.watchSchedule}</p>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            );
        }

        return (
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
        );
    },
);

/**
 * ExportButtons — Passage brief export and save-to-log buttons.
 */
interface ExportButtonsProps {
    voyagePlan: VoyagePlan;
    vessel: VesselProfile;
}

export const ExportButtons: React.FC<ExportButtonsProps> = React.memo(({ voyagePlan, vessel }) => (
    <div className="grid grid-cols-2 gap-3">
        <button
            aria-label="Passage Brief"
            onClick={async () => {
                const { printPassageBrief } = await import('../../utils/pdfExport');
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
            aria-label="Ship Log Service"
            onClick={async () => {
                try {
                    const { ShipLogService } = await import('../../services/ShipLogService');
                    const voyageId = await ShipLogService.savePassagePlanToLogbook(voyagePlan);
                    if (voyageId) {
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
));
