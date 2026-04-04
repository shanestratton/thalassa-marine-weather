/**
 * WatchScheduleCard — Watch rotation planner for Passage Planning.
 *
 * Auto-generates a suggested watch schedule based on crew count
 * and passage duration. Captain confirms watches are briefed
 * before departure.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { triggerHaptic } from '../../utils/system';
import { useReadinessSync } from '../../hooks/useReadinessSync';

/* ────────────────────────────────────────────────────────────── */

interface WatchScheduleCardProps {
    voyageId?: string;
    crewCount: number;
    passageDurationHours?: number;
    onReviewedChange?: (reviewed: boolean) => void;
}

const STORAGE_KEY = 'thalassa_watch_schedule';

/** Generate a watch rotation based on crew count */
const generateWatchSchedule = (
    crewCount: number,
): { system: string; pattern: string; watches: { label: string; time: string; crew: string }[] } => {
    if (crewCount <= 1) {
        return {
            system: 'Single-Handed',
            pattern: 'Cat naps · 20-min alarm cycles · AIS guard zone',
            watches: [{ label: 'Continuous', time: '24h', crew: 'Skipper (solo)' }],
        };
    }
    if (crewCount === 2) {
        return {
            system: '2-Watch System (Swedish)',
            pattern: '4 on / 4 off with dog watches',
            watches: [
                { label: 'First Watch', time: '2000–0000', crew: 'Watch A' },
                { label: 'Middle Watch', time: '0000–0400', crew: 'Watch B' },
                { label: 'Morning Watch', time: '0400–0800', crew: 'Watch A' },
                { label: 'Forenoon Watch', time: '0800–1200', crew: 'Watch B' },
                { label: 'Afternoon Watch', time: '1200–1600', crew: 'Watch A' },
                { label: 'Dog Watch (1st)', time: '1600–1800', crew: 'Watch B' },
                { label: 'Dog Watch (2nd)', time: '1800–2000', crew: 'Watch A' },
            ],
        };
    }
    if (crewCount === 3) {
        return {
            system: '3-Watch System',
            pattern: '4 on / 8 off — best rest ratio',
            watches: [
                { label: 'First Watch', time: '2000–0000', crew: 'Watch A' },
                { label: 'Middle Watch', time: '0000–0400', crew: 'Watch B' },
                { label: 'Morning Watch', time: '0400–0800', crew: 'Watch C' },
                { label: 'Forenoon Watch', time: '0800–1200', crew: 'Watch A' },
                { label: 'Afternoon Watch', time: '1200–1600', crew: 'Watch B' },
                { label: 'First Dog', time: '1600–1800', crew: 'Watch C' },
                { label: 'Last Dog', time: '1800–2000', crew: 'Watch A' },
            ],
        };
    }
    // 4+ crew
    return {
        system: `${Math.ceil(crewCount / 2)}-Watch System`,
        pattern: `${crewCount >= 6 ? '4 on / 8 off' : '6 on / 6 off'} — ${Math.ceil(crewCount / 2)} per watch`,
        watches: [
            { label: 'Watch A (Port)', time: '0000–0600', crew: `${Math.ceil(crewCount / 2)} crew` },
            { label: 'Watch B (Starboard)', time: '0600–1200', crew: `${Math.floor(crewCount / 2)} crew` },
            { label: 'Watch A (Port)', time: '1200–1800', crew: `${Math.ceil(crewCount / 2)} crew` },
            { label: 'Watch B (Starboard)', time: '1800–0000', crew: `${Math.floor(crewCount / 2)} crew` },
        ],
    };
};

const CHECKLIST_ITEMS = [
    { key: 'schedule_briefed', icon: '📋', label: 'Watch schedule briefed to all crew' },
    { key: 'night_duties', icon: '🌙', label: 'Night watch duties & protocols explained' },
    { key: 'handover', icon: '🤝', label: 'Watch handover procedure agreed' },
    { key: 'fatigue', icon: '😴', label: 'Fatigue management plan discussed' },
];

export const WatchScheduleCard: React.FC<WatchScheduleCardProps> = ({
    voyageId,
    crewCount,
    passageDurationHours,
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

    const { syncCheck } = useReadinessSync(voyageId, 'watch_schedule', checkedItems, setCheckedItems, STORAGE_KEY);

    const schedule = useMemo(() => generateWatchSchedule(crewCount), [crewCount]);
    const allChecked = CHECKLIST_ITEMS.every((item) => checkedItems[item.key]);
    const checkedCount = CHECKLIST_ITEMS.filter((item) => checkedItems[item.key]).length;

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
        onReviewedChange?.(allChecked);
    }, [allChecked, onReviewedChange]);

    const durationDisplay = passageDurationHours
        ? passageDurationHours >= 24
            ? `${Math.floor(passageDurationHours / 24)}d ${passageDurationHours % 24}h`
            : `${passageDurationHours}h`
        : null;

    return (
        <div className="space-y-4">
            {/* ── Schedule Info ── */}
            <div className="bg-gradient-to-r from-indigo-500/[0.06] to-purple-500/[0.03] border border-indigo-500/15 rounded-xl p-4">
                <div className="flex items-center gap-3 mb-3">
                    <span className="text-2xl">⏰</span>
                    <div>
                        <h5 className="text-sm font-bold text-white">{schedule.system}</h5>
                        <p className="text-[11px] text-indigo-400/70">{schedule.pattern}</p>
                    </div>
                    <div className="ml-auto text-right">
                        <div className="text-[11px] text-gray-400 uppercase tracking-widest font-bold">Crew</div>
                        <div className="text-sm font-bold text-white">{crewCount}</div>
                    </div>
                    {durationDisplay && (
                        <div className="text-right">
                            <div className="text-[11px] text-gray-400 uppercase tracking-widest font-bold">
                                Duration
                            </div>
                            <div className="text-sm font-bold text-white font-mono">{durationDisplay}</div>
                        </div>
                    )}
                </div>

                {/* Watch rotation table */}
                <div className="space-y-1">
                    {schedule.watches.map((w, i) => (
                        <div
                            key={i}
                            className="flex items-center gap-3 px-3 py-2 rounded-lg bg-white/[0.03] border border-white/[0.04]"
                        >
                            <div className={`w-2 h-2 rounded-full ${i % 2 === 0 ? 'bg-sky-400' : 'bg-purple-400'}`} />
                            <span className="text-xs font-bold text-white flex-1">{w.label}</span>
                            <span className="text-xs text-gray-400 font-mono">{w.time}</span>
                            <span className="text-[11px] text-indigo-300 font-semibold">{w.crew}</span>
                        </div>
                    ))}
                </div>
            </div>

            {/* ── Briefing Checklist ── */}
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
                <h4 className="text-xs font-bold text-white uppercase tracking-widest mb-3 flex items-center gap-2">
                    ✅ Watch Briefing
                    <span
                        className={`ml-auto px-2 py-0.5 rounded-full text-[11px] font-bold border ${
                            allChecked
                                ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                                : 'bg-sky-500/10 border-sky-500/20 text-sky-400'
                        }`}
                    >
                        {checkedCount}/{CHECKLIST_ITEMS.length}
                    </span>
                </h4>
                <div className="space-y-1.5">
                    {CHECKLIST_ITEMS.map((item) => {
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
        </div>
    );
};
