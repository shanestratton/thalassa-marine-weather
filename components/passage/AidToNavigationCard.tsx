/**
 * AidToNavigationCard — Legal disclaimer & acknowledgment for Passage Planning.
 *
 * The captain must tick all legal acknowledgments before the "Cast Off" button
 * can be pressed. This is the final gate in the pre-departure readiness flow.
 *
 * Covers: aid to navigation disclaimer, skipper responsibility, weather limitations,
 * safety equipment, and passage plan communication.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { triggerHaptic } from '../../utils/system';
import { useReadinessSync } from '../../hooks/useReadinessSync';

/* ────────────────────────────────────────────────────────────── */

interface AidToNavigationCardProps {
    voyageId?: string;
    /** Callback: true when all acknowledgments are ticked */
    onAcknowledgedChange?: (acknowledged: boolean) => void;
    /** Lock card if any readiness cards are not green */
    allOtherCardsReady?: boolean;
}

const LEGAL_ITEMS = [
    {
        key: 'aid_only',
        icon: '⚠️',
        title: 'Aid to Navigation Only',
        description:
            'I understand that Thalassa is an electronic aid to navigation only and does not replace proper seamanship, watchkeeping, or official nautical charts and publications.',
        critical: true,
    },
    {
        key: 'skipper_responsibility',
        icon: '👨‍✈️',
        title: 'Skipper Responsibility',
        description:
            'I, as skipper, accept full responsibility for the safety of the vessel, crew, and all navigation decisions made during this passage.',
        critical: true,
    },
    {
        key: 'weather_limitations',
        icon: '🌦️',
        title: 'Weather Forecast Limitations',
        description:
            'I understand that weather forecasts are predictions only. Conditions may differ significantly from forecasts, and I will monitor conditions continuously and adjust plans as necessary.',
        critical: true,
    },
    {
        key: 'safety_equipment',
        icon: '🛟',
        title: 'Safety Equipment & Crew Brief',
        description:
            'I confirm that all safety equipment has been inspected, the crew has been briefed on emergency procedures, and MOB drills have been discussed.',
        critical: true,
    },
    {
        key: 'passage_plan_shared',
        icon: '📡',
        title: 'Passage Plan Filed',
        description:
            'I have communicated my passage plan (route, ETA, crew count) to a responsible person ashore and/or the relevant maritime authority.',
        critical: true,
    },
    {
        key: 'colregs',
        icon: '🚢',
        title: 'COLREGs Compliance',
        description:
            'I will maintain a proper lookout and comply with the International Regulations for Preventing Collisions at Sea (COLREGs) at all times during this passage.',
        critical: true,
    },
];

const STORAGE_KEY = 'thalassa_nav_acknowledgments';

export const AidToNavigationCard: React.FC<AidToNavigationCardProps> = ({
    voyageId,
    onAcknowledgedChange,
    allOtherCardsReady,
}) => {
    const [checkedItems, setCheckedItems] = useState<Record<string, boolean>>(() => {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            return stored ? JSON.parse(stored) : {};
        } catch {
            return {};
        }
    });

    const { syncCheck } = useReadinessSync(voyageId, 'aid_to_navigation', checkedItems, setCheckedItems, STORAGE_KEY);

    const totalItems = LEGAL_ITEMS.length;
    const checkedCount = LEGAL_ITEMS.filter((item) => checkedItems[item.key]).length;
    const allAcknowledged = checkedCount === totalItems;

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
        onAcknowledgedChange?.(allAcknowledged);
    }, [allAcknowledged, onAcknowledgedChange]);

    return (
        <div className="space-y-4">
            {/* ── Header Warning ──
                Legal text — bumped from text-xs to text-sm and base
                section header from text-sm to text-base. The previous
                11–12px sizing was too small for important legal text
                that the skipper has to actually read and understand. */}
            <div className="bg-amber-500/5 border border-amber-500/15 rounded-xl p-4">
                <div className="flex items-start gap-3">
                    <span className="text-2xl mt-0.5">⚓</span>
                    <div>
                        <h5 className="text-base font-bold text-amber-300 mb-1.5">
                            Aid to Navigation — Legal Acknowledgment
                        </h5>
                        <p className="text-sm text-gray-300 leading-relaxed">
                            Thalassa provides weather data, route suggestions, and passage planning tools as an{' '}
                            <strong className="text-amber-200">aid to navigation only</strong>. The skipper retains full
                            responsibility for all decisions. By acknowledging the items below, you confirm
                            understanding of these limitations.
                        </p>
                    </div>
                </div>
            </div>

            {/* ── Acknowledgment Checklist ── */}
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
                <h4 className="text-sm font-bold text-white uppercase tracking-widest mb-3 flex items-center gap-2">
                    ✍️ Skipper's Acknowledgments
                    <span
                        className={`ml-auto px-2 py-0.5 rounded-full text-xs font-bold border ${
                            allAcknowledged
                                ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                                : 'bg-amber-500/10 border-amber-500/20 text-amber-400'
                        }`}
                    >
                        {checkedCount}/{totalItems}
                    </span>
                </h4>
                <div className="space-y-2">
                    {LEGAL_ITEMS.map((item) => {
                        const isChecked = !!checkedItems[item.key];
                        return (
                            <button
                                key={item.key}
                                onClick={() => toggleItem(item.key)}
                                className={`w-full flex items-start gap-3 px-3 py-3 rounded-xl text-left transition-all active:scale-[0.98] ${
                                    isChecked
                                        ? 'bg-emerald-500/10 border border-emerald-500/20'
                                        : 'bg-amber-500/[0.03] border border-amber-500/10 hover:bg-amber-500/[0.06]'
                                }`}
                            >
                                <div
                                    className={`w-[18px] h-[18px] mt-0.5 rounded border-2 flex items-center justify-center shrink-0 transition-all ${
                                        isChecked
                                            ? 'bg-emerald-500 border-emerald-500'
                                            : 'border-amber-500/50 bg-transparent'
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
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-1.5 mb-1">
                                        <span className="text-base">{item.icon}</span>
                                        <span
                                            className={`text-sm font-bold ${
                                                isChecked ? 'text-emerald-300' : 'text-white'
                                            }`}
                                        >
                                            {item.title}
                                        </span>
                                    </div>
                                    <p
                                        className={`text-sm leading-relaxed ${
                                            isChecked ? 'text-emerald-400/60 line-through' : 'text-gray-300'
                                        }`}
                                    >
                                        {item.description}
                                    </p>
                                </div>
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* ── Status ── */}
            {allAcknowledged && !allOtherCardsReady && (
                <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-amber-500/5 border border-amber-500/15">
                    <span className="text-lg">⚠️</span>
                    <div>
                        <p className="text-sm font-bold text-amber-400">Acknowledgments complete</p>
                        <p className="text-xs text-amber-400/70 mt-0.5">
                            Complete all other readiness checks to enable Cast Off
                        </p>
                    </div>
                </div>
            )}

            {allAcknowledged && allOtherCardsReady && (
                <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 animate-in fade-in slide-in-from-bottom-2 duration-300">
                    <span className="text-lg">✅</span>
                    <div>
                        <p className="text-sm font-bold text-emerald-400">Ready to Cast Off</p>
                        <p className="text-xs text-emerald-400/70 mt-0.5">
                            All acknowledgments accepted — vessel cleared for departure
                        </p>
                    </div>
                </div>
            )}
        </div>
    );
};
