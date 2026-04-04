/**
 * CommsPlanCard — Communications & Position Reporting schedule for Passage Planning.
 *
 * Covers scheduled radio check-ins, position reports, emergency contacts,
 * and DSC/MMSI confirmation. Captain must confirm the comms plan is
 * briefed before departure.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { triggerHaptic } from '../../utils/system';
import { useReadinessSync } from '../../hooks/useReadinessSync';

/* ────────────────────────────────────────────────────────────── */

interface CommsPlanCardProps {
    voyageId?: string;
    onReviewedChange?: (reviewed: boolean) => void;
}

const COMMS_ITEMS = [
    {
        key: 'shore_contact',
        icon: '🏠',
        title: 'Shore Contact Nominated',
        description:
            'A responsible person ashore has my passage plan, expected ETA, crew list, and will raise the alarm if not contacted within the agreed overdue period.',
        critical: true,
    },
    {
        key: 'position_reports',
        icon: '📍',
        title: 'Position Report Schedule Set',
        description:
            'Agreed regular position reporting intervals (e.g. every 6 hours via VHF/SSB/sat phone/InReach) with shore contact.',
        critical: true,
    },
    {
        key: 'vhf_tested',
        icon: '📻',
        title: 'VHF Radio Tested (Ch 16)',
        description:
            'VHF radio operational on Channel 16 (distress/calling). Radio check completed with coast station or nearby vessel.',
        critical: true,
    },
    {
        key: 'dsc_mmsi',
        icon: '🆘',
        title: 'DSC / MMSI Confirmed',
        description:
            'Digital Selective Calling is enabled and MMSI number is correctly programmed. DSC distress button location briefed to all crew.',
        critical: true,
    },
    {
        key: 'epirb_registration',
        icon: '🛰️',
        title: 'EPIRB Registration Current',
        description:
            'EPIRB is registered with the national authority (e.g. AMSA), battery is in date, and crew details are current.',
        critical: true,
    },
    {
        key: 'weather_schedule',
        icon: '🌤️',
        title: 'Weather Update Schedule',
        description:
            'Scheduled times for receiving weather updates (BOM Coastal Waters, HF Weatherfax, Navtex, or satellite data).',
        critical: false,
    },
    {
        key: 'sat_comms',
        icon: '📡',
        title: 'Satellite Comms (if fitted)',
        description:
            'Satellite phone / InReach / Iridium GO tested and emergency contacts pre-loaded. Credit/subscription active.',
        critical: false,
    },
    {
        key: 'overdue_action',
        icon: '⏰',
        title: 'Overdue Action Plan',
        description:
            'Shore contact knows the overdue time trigger and the exact steps to take: who to call (coast guard/police), vessel details, last known position.',
        critical: true,
    },
];

const STORAGE_KEY = 'thalassa_comms_plan';

export const CommsPlanCard: React.FC<CommsPlanCardProps> = ({ voyageId, onReviewedChange }) => {
    const [checkedItems, setCheckedItems] = useState<Record<string, boolean>>(() => {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            return stored ? JSON.parse(stored) : {};
        } catch {
            return {};
        }
    });

    const { syncCheck } = useReadinessSync(voyageId, 'comms_plan', checkedItems, setCheckedItems, STORAGE_KEY);

    const criticalItems = COMMS_ITEMS.filter((i) => i.critical);
    const optionalItems = COMMS_ITEMS.filter((i) => !i.critical);
    const criticalChecked = criticalItems.filter((i) => checkedItems[i.key]).length;
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

    useEffect(() => {
        onReviewedChange?.(allCriticalDone);
    }, [allCriticalDone, onReviewedChange]);

    const renderItem = (item: (typeof COMMS_ITEMS)[0]) => {
        const isChecked = !!checkedItems[item.key];
        return (
            <button
                key={item.key}
                onClick={() => toggleItem(item.key)}
                className={`w-full flex items-start gap-3 px-3 py-3 rounded-xl text-left transition-all active:scale-[0.98] ${
                    isChecked
                        ? 'bg-emerald-500/10 border border-emerald-500/20'
                        : item.critical
                          ? 'bg-red-500/5 border border-red-500/15 hover:bg-red-500/10'
                          : 'bg-white/[0.02] border border-white/[0.06] hover:bg-white/[0.05]'
                }`}
            >
                <div
                    className={`w-[18px] h-[18px] mt-0.5 rounded border-2 flex items-center justify-center shrink-0 transition-all ${
                        isChecked
                            ? 'bg-emerald-500 border-emerald-500'
                            : item.critical
                              ? 'border-red-500/50 bg-transparent'
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
                            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                        </svg>
                    )}
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 mb-0.5">
                        <span className="text-sm">{item.icon}</span>
                        <span className={`text-xs font-bold ${isChecked ? 'text-emerald-300' : 'text-white'}`}>
                            {item.title}
                        </span>
                    </div>
                    <p
                        className={`text-[11px] leading-relaxed ${
                            isChecked ? 'text-emerald-400/50 line-through' : 'text-gray-400'
                        }`}
                    >
                        {item.description}
                    </p>
                </div>
            </button>
        );
    };

    return (
        <div className="space-y-4">
            {/* ── Critical Comms ── */}
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
                <h4 className="text-xs font-bold text-white uppercase tracking-widest mb-3 flex items-center gap-2">
                    🚨 Essential Communications
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
                <div className="space-y-2">{criticalItems.map(renderItem)}</div>
            </div>

            {/* ── Optional Comms ── */}
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
                <h4 className="text-xs font-bold text-white uppercase tracking-widest mb-3 flex items-center gap-2">
                    📋 Additional Communications
                    <span className="ml-auto px-2 py-0.5 rounded-full text-[11px] font-bold bg-sky-500/10 border border-sky-500/20 text-sky-400">
                        {optionalItems.filter((i) => checkedItems[i.key]).length}/{optionalItems.length}
                    </span>
                </h4>
                <div className="space-y-2">{optionalItems.map(renderItem)}</div>
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
                            ? 'Communications plan confirmed'
                            : `${criticalItems.length - criticalChecked} critical items remaining`}
                    </p>
                    <p
                        className={`text-[11px] mt-0.5 ${allCriticalDone ? 'text-emerald-400/60' : 'text-amber-400/60'}`}
                    >
                        {allCriticalDone
                            ? 'Shore contact nominated · Position reporting active'
                            : 'All critical comms items must be confirmed'}
                    </p>
                </div>
            </div>
        </div>
    );
};
