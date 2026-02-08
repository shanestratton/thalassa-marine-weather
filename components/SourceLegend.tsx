import React, { useState } from 'react';
import { t } from '../theme';

/**
 * SourceLegend - Educational tooltip explaining color-coded data sources
 * 
 * Displays a collapsible legend teaching users what the metric colors mean:
 * - Green: Real-time measured data from marine beacons
 * - Amber: Modeled/computed predictions from StormGlass
 * 
 * Solves the UX "learning curve" problem by making source transparency obvious.
 */
export const SourceLegend: React.FC<{ className?: string }> = ({ className = '' }) => {
    const [isOpen, setIsOpen] = useState(false);

    return (
        <div className={`relative ${className}`}>
            {/* Info Button */}
            <button
                onClick={() => setIsOpen(!isOpen)}
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded-lg bg-white/5 ${t.border.default} hover:bg-white/10 transition-colors duration-200`}
                aria-label="Data source information"
            >
                {/* Info Icon (inline SVG) */}
                <svg className="w-3 h-3 text-white/70" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="text-sm md:text-sm font-medium text-white/70 uppercase tracking-wider">Sources</span>
            </button>

            {/* Expandable Legend */}
            {isOpen && (
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-72 bg-black border border-white/30 rounded-xl shadow-2xl p-4 z-[200] animate-in fade-in slide-in-from-bottom-2 duration-200">
                    {/* Header */}
                    <div className="flex items-center justify-between mb-3 pb-2 border-b border-white/10">
                        <h3 className="text-sm font-bold text-white">Data Source Colors</h3>
                        <button
                            onClick={() => setIsOpen(false)}
                            className="text-white/50 hover:text-white/80 transition-colors"
                            aria-label="Close"
                        >
                            ✕
                        </button>
                    </div>

                    {/* Legend Items */}
                    <div className="space-y-3">
                        {/* Green: Beacon */}
                        <div className="flex items-start gap-3">
                            <div className="flex-shrink-0 w-3 h-3 rounded-full bg-emerald-400 mt-0.5 shadow-lg shadow-emerald-400/50" />
                            <div className="flex-1">
                                <div className="text-sm font-bold text-emerald-400 mb-0.5">Beacon (Measured)</div>
                                <div className="text-sm text-white/70 leading-relaxed">
                                    Real-time data from marine buoys and BOM weather stations. Direct measurements.
                                </div>
                            </div>
                        </div>

                        {/* Amber: StormGlass Model */}
                        <div className="flex items-start gap-3">
                            <div className="flex-shrink-0 w-3 h-3 rounded-full bg-amber-400 mt-0.5 shadow-lg shadow-amber-400/50" />
                            <div className="flex-1">
                                <div className="text-sm font-bold text-amber-400 mb-0.5">Model (SG)</div>
                                <div className="text-sm text-white/70 leading-relaxed">
                                    Predictions from StormGlass weather models. Computed from satellite and forecast data.
                                </div>
                            </div>
                        </div>

                        {/* White: Forecast */}
                        <div className="flex items-start gap-3">
                            <div className="flex-shrink-0 w-3 h-3 rounded-full bg-white mt-0.5 shadow-lg shadow-white/50" />
                            <div className="flex-1">
                                <div className="text-sm font-bold text-white mb-0.5">Forecast (Future)</div>
                                <div className="text-sm text-white/70 leading-relaxed">
                                    All future forecast data shown in white. These are predictions for upcoming hours and days.
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Footer Note */}
                    <div className="mt-3 pt-3 border-t border-white/10">
                        <p className="text-sm text-white/50 leading-relaxed">
                            Thalassa automatically selects the best available source for each metric based on proximity and data quality.
                        </p>
                    </div>
                </div>
            )}
        </div>
    );
};
