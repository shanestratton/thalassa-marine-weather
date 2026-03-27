/**
 * WeatherBriefingCard — Pre-departure weather review for Passage Planning.
 *
 * Displays a weather briefing checklist that the captain must review
 * before departure. Includes a confirmation checkbox that turns the card
 * from red (unreviewed) to green (reviewed & accepted).
 *
 * When MultiModelResult data is available from the route planner,
 * it embeds the full ModelComparisonCard heat map.
 */

import React, { useState, useEffect, useCallback } from 'react';
import type { MultiModelResult } from '../../services/weather/MultiModelWeatherService';
import { ModelComparisonCard } from './ModelComparisonCard';
import { triggerHaptic } from '../../utils/system';
import { useReadinessSync } from '../../hooks/useReadinessSync';

/* ────────────────────────────────────────────────────────────── */

interface WeatherBriefingCardProps {
    voyageId?: string;
    departPort?: string;
    destPort?: string;
    multiModelData?: MultiModelResult | null;
    /** Callback: (reviewed: boolean) */
    onReviewedChange?: (reviewed: boolean) => void;
}

const BRIEFING_ITEMS = [
    { key: 'forecast', icon: '🌤️', label: 'Reviewed latest forecast for passage area' },
    { key: 'models', icon: '🔬', label: 'Compared available weather models (GFS, ECMWF, etc.)' },
    { key: 'wind', icon: '💨', label: 'Checked wind conditions are within vessel limits' },
    { key: 'swell', icon: '🌊', label: 'Assessed sea state and swell heights for comfort' },
    { key: 'systems', icon: '🌀', label: 'Checked for approaching weather systems or fronts' },
    { key: 'window', icon: '⏰', label: 'Identified optimal departure weather window' },
];

const STORAGE_KEY = 'thalassa_weather_briefing';

export const WeatherBriefingCard: React.FC<WeatherBriefingCardProps> = ({
    voyageId,
    departPort,
    destPort,
    multiModelData,
    onReviewedChange,
}) => {
    const [checkedItems, setCheckedItems] = useState<Record<string, boolean>>(() => {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            return stored ? JSON.parse(stored) : {};
        } catch {
            return {};
        }
    });

    const { syncCheck } = useReadinessSync(voyageId, 'weather_briefing', checkedItems, setCheckedItems, STORAGE_KEY);

    const totalItems = BRIEFING_ITEMS.length;
    const checkedCount = BRIEFING_ITEMS.filter((item) => checkedItems[item.key]).length;
    const allReviewed = checkedCount === totalItems;

    const toggleItem = useCallback(
        (key: string) => {
            setCheckedItems((prev) => {
                const next = { ...prev, [key]: !prev[key] };
                try {
                    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
                } catch {
                    /* ignore */
                }
                syncCheck(key, next[key]);
                return next;
            });
            triggerHaptic('light');
        },
        [syncCheck],
    );

    // Notify parent of review state
    useEffect(() => {
        onReviewedChange?.(allReviewed);
    }, [allReviewed, onReviewedChange]);

    return (
        <div className="space-y-4">
            {/* Route context */}
            {departPort && destPort && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-white/[0.03] border border-white/[0.06]">
                    <span className="text-[11px] text-gray-400 uppercase tracking-widest font-bold">Passage</span>
                    <span className="text-sm text-white font-semibold">
                        {departPort} → {destPort}
                    </span>
                </div>
            )}

            {/* ── Model Comparison (if data available) ── */}
            {multiModelData && (
                <div>
                    <h4 className="text-xs font-bold text-white uppercase tracking-widest mb-3 flex items-center gap-2">
                        🔬 Multi-Model Ensemble Comparison
                    </h4>
                    <ModelComparisonCard data={multiModelData} />
                </div>
            )}

            {/* ── If no model data, show prompt ── */}
            {!multiModelData && (
                <div className="bg-white/[0.02] border border-white/[0.06] rounded-xl p-4 text-center">
                    <span className="text-2xl">🛰️</span>
                    <p className="text-xs text-gray-400 mt-2 font-semibold">
                        Run a Route Plan to see multi-model comparison data here.
                    </p>
                    <p className="text-[11px] text-gray-500 mt-1">GFS · ECMWF · ICON · ACCESS-G ensemble analysis</p>
                </div>
            )}

            {/* ── Weather Briefing Checklist ── */}
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
                <h4 className="text-xs font-bold text-white uppercase tracking-widest mb-3 flex items-center gap-2">
                    📋 Pre-Departure Weather Briefing
                    <span
                        className={`ml-auto px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                            allReviewed
                                ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                                : 'bg-sky-500/10 border-sky-500/20 text-sky-400'
                        }`}
                    >
                        {checkedCount}/{totalItems}
                    </span>
                </h4>
                <div className="space-y-1.5">
                    {BRIEFING_ITEMS.map((item) => {
                        const isChecked = !!checkedItems[item.key];
                        return (
                            <button
                                key={item.key}
                                onClick={() => toggleItem(item.key)}
                                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all active:scale-[0.98] ${
                                    isChecked
                                        ? 'bg-emerald-500/10 border border-emerald-500/20'
                                        : 'bg-white/[0.02] border border-white/[0.06] hover:bg-white/[0.05]'
                                }`}
                            >
                                <div
                                    className={`w-[18px] h-[18px] rounded border-2 flex items-center justify-center shrink-0 transition-all ${
                                        isChecked
                                            ? 'bg-emerald-500 border-emerald-500'
                                            : 'border-gray-500 bg-transparent'
                                    }`}
                                >
                                    {isChecked && (
                                        <svg
                                            className="w-3 h-3 text-white"
                                            fill="none"
                                            viewBox="0 0 24 24"
                                            stroke="currentColor"
                                            strokeWidth={3}
                                        >
                                            <path
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                d="M4.5 12.75l6 6 9-13.5"
                                            />
                                        </svg>
                                    )}
                                </div>
                                <span className="text-sm mr-1">{item.icon}</span>
                                <span
                                    className={`text-xs flex-1 ${
                                        isChecked ? 'text-emerald-300 line-through opacity-70' : 'text-gray-300'
                                    }`}
                                >
                                    {item.label}
                                </span>
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* ── All Reviewed Confirmation ── */}
            {allReviewed && (
                <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 animate-in fade-in slide-in-from-bottom-2 duration-300">
                    <span className="text-lg">✅</span>
                    <div>
                        <p className="text-xs font-bold text-emerald-400">Weather Briefing Complete</p>
                        <p className="text-[11px] text-emerald-400/60 mt-0.5">
                            Passage weather conditions reviewed and assessed
                        </p>
                    </div>
                </div>
            )}
        </div>
    );
};
