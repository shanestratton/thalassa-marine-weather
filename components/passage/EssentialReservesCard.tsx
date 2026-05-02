/**
 * EssentialReservesCard — Pre-departure reserves checklist for Passage Planning.
 *
 * Tracks critical consumables that must be confirmed before departure:
 * fuel, water, gas, batteries, first aid, safety gear, etc.
 * Same red/green readiness pattern as other passage planning cards.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { triggerHaptic } from '../../utils/system';
import { useReadinessSync } from '../../hooks/useReadinessSync';

/* ────────────────────────────────────────────────────────────── */

interface EssentialReservesCardProps {
    voyageId?: string;
    /** Callback: (reviewed: boolean) */
    onReviewedChange?: (reviewed: boolean) => void;
}

const RESERVE_ITEMS = [
    { key: 'fuel', icon: '⛽', label: 'Fuel tanks topped off & reserve calculated', critical: true },
    { key: 'water', icon: '💧', label: 'Fresh water tanks full & watermaker serviced', critical: true },
    { key: 'gas', icon: '🔥', label: 'Gas bottles full for cooking (LPG/CNG)', critical: true },
    { key: 'batteries', icon: '🔋', label: 'Battery bank charged & solar/alternator functional', critical: true },
    { key: 'firstaid', icon: '🏥', label: 'First aid kit stocked & medications current', critical: true },
    { key: 'flares', icon: '🚨', label: 'Flares, EPIRB & safety gear in date', critical: true },
    { key: 'liferaft', icon: '🛟', label: 'Life raft service current & accessible', critical: true },
    { key: 'spares', icon: '🔧', label: 'Engine spares, filters & belts on board', critical: false },
    { key: 'anchoring', icon: '⚓', label: 'Anchor gear inspected & chain marked', critical: false },
    { key: 'comms', icon: '📡', label: 'VHF, HF/SSB & satellite comms tested', critical: false },
    { key: 'dinghy', icon: '🚤', label: 'Tender & outboard fuelled and operational', critical: false },
    { key: 'charts', icon: '🗺️', label: 'Charts updated & pilot books on board', critical: false },
];

const STORAGE_KEY = 'thalassa_essential_reserves';

export const EssentialReservesCard: React.FC<EssentialReservesCardProps> = ({ voyageId, onReviewedChange }) => {
    const [checkedItems, setCheckedItems] = useState<Record<string, boolean>>(() => {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            return stored ? JSON.parse(stored) : {};
        } catch {
            return {};
        }
    });

    const { syncCheck } = useReadinessSync(voyageId, 'essential_reserves', checkedItems, setCheckedItems, STORAGE_KEY);

    const criticalItems = RESERVE_ITEMS.filter((item) => item.critical);
    const optionalItems = RESERVE_ITEMS.filter((item) => !item.critical);
    const criticalChecked = criticalItems.filter((item) => checkedItems[item.key]).length;
    const totalChecked = RESERVE_ITEMS.filter((item) => checkedItems[item.key]).length;
    const allCriticalDone = criticalChecked === criticalItems.length;

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

    // Notify parent — all critical items must be checked
    useEffect(() => {
        onReviewedChange?.(allCriticalDone);
    }, [allCriticalDone, onReviewedChange]);

    return (
        <div className="space-y-4">
            {/* ── Critical Reserves ── */}
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
                <h4 className="text-xs font-bold text-white uppercase tracking-widest mb-3 flex items-center gap-2">
                    🚨 Critical Reserves
                    <span
                        className={`ml-auto px-2 py-0.5 rounded-full text-[11px] font-bold border ${
                            allCriticalDone
                                ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                                : 'bg-red-500/10 border-red-500/20 text-red-400'
                        }`}
                    >
                        {criticalChecked}/{criticalItems.length}
                    </span>
                </h4>
                <div className="space-y-1.5">
                    {criticalItems.map((item) => {
                        const isChecked = !!checkedItems[item.key];
                        return (
                            <button
                                key={item.key}
                                onClick={() => toggleItem(item.key)}
                                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all active:scale-[0.98] ${
                                    isChecked
                                        ? 'bg-emerald-500/10 border border-emerald-500/20'
                                        : 'bg-red-500/5 border border-red-500/15 hover:bg-red-500/10'
                                }`}
                            >
                                <div
                                    className={`w-[18px] h-[18px] rounded border-2 flex items-center justify-center shrink-0 transition-all ${
                                        isChecked
                                            ? 'bg-emerald-500 border-emerald-500'
                                            : 'border-red-500/50 bg-transparent'
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
                                        isChecked
                                            ? 'text-emerald-300 line-through opacity-70'
                                            : 'text-amber-200 font-semibold'
                                    }`}
                                >
                                    {item.label}
                                </span>
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* ── Additional Checks ── */}
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
                <h4 className="text-xs font-bold text-white uppercase tracking-widest mb-3 flex items-center gap-2">
                    📋 Additional Checks
                    <span className="ml-auto px-2 py-0.5 rounded-full text-[11px] font-bold bg-sky-500/10 border border-sky-500/20 text-sky-400">
                        {optionalItems.filter((i) => checkedItems[i.key]).length}/{optionalItems.length}
                    </span>
                </h4>
                <div className="space-y-1.5">
                    {optionalItems.map((item) => {
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

            {/* ── Summary ── */}
            <div
                className={`flex items-center gap-2 px-4 py-3 rounded-xl border transition-all ${
                    allCriticalDone ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-amber-500/5 border-amber-500/15'
                }`}
            >
                <span className="text-lg">{allCriticalDone ? '✅' : '⚠️'}</span>
                <div>
                    <p className={`text-xs font-bold ${allCriticalDone ? 'text-emerald-400' : 'text-amber-400'}`}>
                        {allCriticalDone
                            ? `All critical reserves confirmed (${totalChecked}/${RESERVE_ITEMS.length} total)`
                            : `${criticalItems.length - criticalChecked} critical items remaining`}
                    </p>
                    <p
                        className={`text-[11px] mt-0.5 ${allCriticalDone ? 'text-emerald-400/60' : 'text-amber-400/60'}`}
                    >
                        {allCriticalDone
                            ? 'Vessel reserves verified for departure'
                            : 'All critical reserves must be confirmed before departure'}
                    </p>
                </div>
            </div>
        </div>
    );
};
