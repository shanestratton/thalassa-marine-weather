/**
 * VesselCheckCard — Pre-departure vessel systems checklist for Passage Planning.
 *
 * Single card with an integrated checklist covering all physical vessel
 * systems that must be verified before departure. The checklist is displayed
 * directly inside the card — no separate checklist card needed.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { triggerHaptic } from '../../utils/system';
import { useReadinessSync } from '../../hooks/useReadinessSync';

/* ────────────────────────────────────────────────────────────── */

interface VesselCheckCardProps {
    voyageId?: string;
    onReviewedChange?: (reviewed: boolean) => void;
}

const STORAGE_KEY = 'thalassa_vessel_precheck';

interface CheckSection {
    section: string;
    icon: string;
    items: { key: string; label: string; detail: string }[];
}

const CHECK_SECTIONS: CheckSection[] = [
    {
        section: 'Engine & Propulsion',
        icon: '⚙️',
        items: [
            { key: 'engine_oil', label: 'Engine oil level checked', detail: 'Dipstick at operating level · No leaks' },
            {
                key: 'engine_coolant',
                label: 'Coolant level checked',
                detail: 'Header tank topped up · No overheating signs',
            },
            {
                key: 'fuel_filters',
                label: 'Fuel filters & water separator',
                detail: 'Filters clear · Water separator drained',
            },
            { key: 'belt_tension', label: 'Drive belt tension', detail: 'Alternator & raw water pump belts firm' },
            { key: 'prop_shaft', label: 'Prop shaft & stern gland', detail: 'No excessive drip · Shaft turns freely' },
        ],
    },
    {
        section: 'Electrical & Navigation',
        icon: '🔋',
        items: [
            { key: 'battery_charge', label: 'Battery banks charged', detail: 'House & start batteries above 12.6V' },
            {
                key: 'nav_lights',
                label: 'Navigation lights tested',
                detail: 'Steaming, port, starboard, stern, anchor — all operational',
            },
            {
                key: 'instruments',
                label: 'Navigation instruments',
                detail: 'Compass, GPS, depth sounder, AIS — all showing correctly',
            },
            { key: 'bilge_alarm', label: 'Bilge alarm tested', detail: 'High water alarm sounds when triggered' },
        ],
    },
    {
        section: 'Hull & Deck',
        icon: '🚢',
        items: [
            {
                key: 'through_hulls',
                label: 'Through-hulls & seacocks',
                detail: 'All seacocks operational · Non-essential closed',
            },
            {
                key: 'bilge_pumps',
                label: 'Bilge pumps tested',
                detail: 'Electric & manual pump both working · Strainers clear',
            },
            {
                key: 'deck_fittings',
                label: 'Deck gear secured',
                detail: 'Hatches dogged, anchors secured, loose items stowed',
            },
            {
                key: 'rudder_steering',
                label: 'Steering gear checked',
                detail: 'Full lock-to-lock · No excessive play · Cables/hydraulics tight',
            },
            {
                key: 'emergency_tiller',
                label: 'Emergency tiller tested',
                detail: 'Located · Fits correctly · Crew knows how to deploy',
            },
        ],
    },
    {
        section: 'Safety Equipment',
        icon: '🛟',
        items: [
            {
                key: 'lifejackets',
                label: 'Lifejackets & harnesses',
                detail: 'One per crew · Cylinders armed · Crotch straps fitted',
            },
            { key: 'flares', label: 'Flares in date', detail: 'Hand flares, parachute flares, smoke — expiry checked' },
            {
                key: 'fire_extinguishers',
                label: 'Fire extinguishers',
                detail: 'Charged · Accessible · Crew knows locations',
            },
            {
                key: 'first_aid',
                label: 'First aid kit stocked',
                detail: 'Medications current · Seasickness tablets · Trauma supplies',
            },
            {
                key: 'mob_gear',
                label: 'MOB equipment ready',
                detail: 'Dan buoy, horseshoe, throwing line — accessible on deck',
            },
            {
                key: 'jacklines',
                label: 'Jacklines & tether points',
                detail: 'Rigged if offshore · Tethers accessible at companionway',
            },
        ],
    },
];

const ALL_ITEMS = CHECK_SECTIONS.flatMap((s) => s.items);

export const VesselCheckCard: React.FC<VesselCheckCardProps> = ({ voyageId, onReviewedChange }) => {
    const [checkedItems, setCheckedItems] = useState<Record<string, boolean>>(() => {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            return stored ? JSON.parse(stored) : {};
        } catch {
            return {};
        }
    });

    const { syncCheck } = useReadinessSync(voyageId, 'vessel_check', checkedItems, setCheckedItems, STORAGE_KEY);

    const totalItems = ALL_ITEMS.length;
    const checkedCount = ALL_ITEMS.filter((i) => checkedItems[i.key]).length;
    const allChecked = checkedCount === totalItems;
    const progress = totalItems > 0 ? (checkedCount / totalItems) * 100 : 0;

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

    const resetAll = useCallback(() => {
        setCheckedItems({});
        try {
            localStorage.removeItem(STORAGE_KEY);
        } catch {
            /* ignore */
        }
        triggerHaptic('medium');
    }, []);

    useEffect(() => {
        onReviewedChange?.(allChecked);
    }, [allChecked, onReviewedChange]);

    return (
        <div className="space-y-3">
            {/* ── Progress Bar ── */}
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-3">
                <div className="flex items-center justify-between mb-2">
                    <span className="text-[11px] text-gray-400 font-bold uppercase tracking-widest">
                        Vessel Pre-Check
                    </span>
                    <div className="flex items-center gap-2">
                        <span className={`text-xs font-bold ${allChecked ? 'text-emerald-400' : 'text-gray-400'}`}>
                            {checkedCount}/{totalItems}
                        </span>
                        {checkedCount > 0 && !allChecked && (
                            <button
                                onClick={resetAll}
                                className="text-[11px] text-red-400/60 hover:text-red-400 uppercase tracking-wider font-bold transition-colors"
                            >
                                Reset
                            </button>
                        )}
                    </div>
                </div>
                <div className="w-full h-2 bg-white/[0.06] rounded-full overflow-hidden">
                    <div
                        className={`h-full rounded-full transition-all duration-500 ${
                            allChecked
                                ? 'bg-gradient-to-r from-emerald-500 to-teal-400'
                                : progress > 50
                                  ? 'bg-gradient-to-r from-amber-500 to-yellow-400'
                                  : 'bg-gradient-to-r from-red-500 to-orange-400'
                        }`}
                        style={{ width: `${progress}%` }}
                    />
                </div>
            </div>

            {/* ── Checklist Sections ── */}
            {CHECK_SECTIONS.map((section) => {
                const sectionChecked = section.items.filter((i) => checkedItems[i.key]).length;
                const sectionDone = sectionChecked === section.items.length;

                return (
                    <details key={section.section} className="group" open={!sectionDone}>
                        <summary
                            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border cursor-pointer list-none transition-all ${
                                sectionDone
                                    ? 'bg-emerald-500/[0.06] border-emerald-500/15'
                                    : 'bg-white/[0.03] border-white/[0.06] hover:bg-white/[0.05]'
                            }`}
                        >
                            <span className="text-lg">{section.icon}</span>
                            <span
                                className={`text-xs font-bold flex-1 uppercase tracking-widest ${
                                    sectionDone ? 'text-emerald-400' : 'text-white'
                                }`}
                            >
                                {section.section}
                            </span>
                            <span
                                className={`px-2 py-0.5 rounded-full text-[11px] font-bold border ${
                                    sectionDone
                                        ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                                        : 'bg-sky-500/10 border-sky-500/20 text-sky-400'
                                }`}
                            >
                                {sectionChecked}/{section.items.length}
                            </span>
                            <svg
                                className="w-3.5 h-3.5 text-gray-500 transition-transform group-open:rotate-180"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2}
                            >
                                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                            </svg>
                        </summary>
                        <div className="mt-1.5 space-y-1 pl-1">
                            {section.items.map((item) => {
                                const isChecked = !!checkedItems[item.key];
                                return (
                                    <button
                                        key={item.key}
                                        onClick={() => toggleItem(item.key)}
                                        className={`w-full flex items-start gap-3 px-3 py-2.5 rounded-xl text-left transition-all active:scale-[0.98] ${
                                            isChecked
                                                ? 'bg-emerald-500/10 border border-emerald-500/20'
                                                : 'bg-white/[0.02] border border-white/[0.06] hover:bg-white/[0.05]'
                                        }`}
                                    >
                                        <div
                                            className={`w-[18px] h-[18px] mt-0.5 rounded border-2 flex items-center justify-center shrink-0 transition-all ${
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
                                        <div className="flex-1 min-w-0">
                                            <span
                                                className={`text-xs font-bold block ${
                                                    isChecked
                                                        ? 'text-emerald-300 line-through opacity-70'
                                                        : 'text-white'
                                                }`}
                                            >
                                                {item.label}
                                            </span>
                                            <span
                                                className={`text-[11px] block mt-0.5 leading-relaxed ${
                                                    isChecked ? 'text-emerald-400/40 line-through' : 'text-gray-500'
                                                }`}
                                            >
                                                {item.detail}
                                            </span>
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    </details>
                );
            })}

            {/* ── Summary ── */}
            <div
                className={`flex items-center gap-2 px-4 py-3 rounded-xl border transition-all ${
                    allChecked ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-amber-500/5 border-amber-500/15'
                }`}
            >
                <span className="text-lg">{allChecked ? '✅' : '🔧'}</span>
                <div>
                    <p className={`text-xs font-bold ${allChecked ? 'text-emerald-400' : 'text-amber-400'}`}>
                        {allChecked ? 'All vessel systems verified' : `${totalItems - checkedCount} checks remaining`}
                    </p>
                    <p className={`text-[11px] mt-0.5 ${allChecked ? 'text-emerald-400/60' : 'text-amber-400/60'}`}>
                        {allChecked
                            ? 'Vessel is seaworthy and ready for departure'
                            : 'Complete all sections before departure'}
                    </p>
                </div>
            </div>
        </div>
    );
};
