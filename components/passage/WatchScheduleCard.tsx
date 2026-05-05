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
import { WatchAssignmentService, type WatchAssignment } from '../../services/WatchAssignmentService';
import { getMyCrew, type CrewMember } from '../../services/CrewService';
import { WatchAssignSheet } from './WatchAssignSheet';
import { supabase } from '../../services/supabase';

/* ────────────────────────────────────────────────────────────── */

interface WatchScheduleCardProps {
    voyageId?: string;
    crewCount: number;
    passageDurationHours?: number;
    /** ISO timestamp — anchors the watch rotation in real time so
     *  pre-watch alarms can fire at the correct moment. Without this,
     *  the schedule is just a display table with no alarm support. */
    departureTimeIso?: string | null;
    onReviewedChange?: (reviewed: boolean) => void;
}

/** Default minutes-before for the pre-watch alarm. Stored per-user in
 *  localStorage so the choice persists across voyages. */
const ALARM_LEAD_KEY = 'thalassa_watch_alarm_lead_min';
const DEFAULT_ALARM_MIN = 15;
const ALARM_LEAD_OPTIONS = [5, 10, 15, 30] as const;

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
    departureTimeIso,
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

    // ── Watch assignments ──
    // Each watch slot can be assigned to a specific crew member.
    // Assignments persist per voyage in Supabase (table:
    // watch_assignments) with localStorage mirror for offline use.
    // The skipper taps a watch row to open the assignment sheet,
    // picks a crew member, and the slot updates immediately.
    const [assignments, setAssignments] = useState<Map<number, WatchAssignment>>(new Map());
    const [crew, setCrew] = useState<CrewMember[]>([]);
    const [skipperEmail, setSkipperEmail] = useState<string | undefined>(undefined);
    const [assignSheetIndex, setAssignSheetIndex] = useState<number | null>(null);

    // Load assignments + crew on mount / voyage change
    useEffect(() => {
        if (!voyageId) {
            setAssignments(new Map());
            setCrew([]);
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                const [list, myCrew, userResp] = await Promise.all([
                    WatchAssignmentService.list(voyageId),
                    getMyCrew(voyageId),
                    supabase ? supabase.auth.getUser() : Promise.resolve({ data: { user: null } }),
                ]);
                if (cancelled) return;
                const map = new Map<number, WatchAssignment>();
                for (const a of list) map.set(a.watch_index, a);
                setAssignments(map);
                setCrew(myCrew);
                setSkipperEmail(userResp.data.user?.email ?? undefined);
            } catch {
                /* non-critical — UI shows generic placeholders */
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [voyageId]);

    // ── Pre-watch alarm scheduling ──
    // Each crew member's device runs WatchAlarmService independently —
    // it reads assignments where assigned_crew_email === this user's
    // email and schedules iOS LocalNotifications for `alarmLeadMin`
    // minutes before each watch starts. Re-runs whenever the
    // assignment Map changes so a freshly-assigned watch gets its
    // alarm set immediately.
    const [alarmEnabled, setAlarmEnabled] = useState(true);
    const [alarmLeadMin, setAlarmLeadMin] = useState<number>(() => {
        try {
            const stored = localStorage.getItem(ALARM_LEAD_KEY);
            if (stored) {
                const n = parseInt(stored, 10);
                if (ALARM_LEAD_OPTIONS.includes(n as (typeof ALARM_LEAD_OPTIONS)[number])) return n;
            }
        } catch {
            /* ignore */
        }
        return DEFAULT_ALARM_MIN;
    });
    const [alarmCount, setAlarmCount] = useState(0);

    // Persist user's chosen lead time
    useEffect(() => {
        try {
            localStorage.setItem(ALARM_LEAD_KEY, String(alarmLeadMin));
        } catch {
            /* ignore */
        }
    }, [alarmLeadMin]);

    useEffect(() => {
        if (!voyageId || !departureTimeIso || !alarmEnabled) {
            setAlarmCount(0);
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                const { WatchAlarmService } = await import('../../services/WatchAlarmService');
                // Request permission first (no-op if already granted).
                // iOS shows the system prompt only the first time.
                const granted = await WatchAlarmService.requestPermissions();
                if (!granted || cancelled) return;
                const count = await WatchAlarmService.scheduleForVoyage(voyageId, departureTimeIso, alarmLeadMin);
                if (!cancelled) setAlarmCount(count);
            } catch {
                /* non-critical — alarm is a nice-to-have */
            }
        })();
        return () => {
            cancelled = true;
        };
        // assignments-as-map dep — rebuild alarms when slots change
    }, [voyageId, departureTimeIso, alarmEnabled, alarmLeadMin, assignments]);

    // Cancel alarms when component unmounts (e.g., user navigates away
    // from Crew Management) — keeps stale alarms from firing if the
    // voyage gets deleted later
    useEffect(() => {
        return () => {
            if (!voyageId) return;
            // Fire-and-forget cancel
            (async () => {
                try {
                    const { WatchAlarmService } = await import('../../services/WatchAlarmService');
                    await WatchAlarmService.cancelForVoyage(voyageId);
                } catch {
                    /* ignore */
                }
            })();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [voyageId]);

    const handleAssign = useCallback(
        async (email: string | null, name: string | null) => {
            if (!voyageId || assignSheetIndex == null) return;
            const slot = schedule.watches[assignSheetIndex];
            if (!slot) return;

            if (email == null) {
                // Clear assignment
                await WatchAssignmentService.clear(voyageId, assignSheetIndex);
                setAssignments((prev) => {
                    const next = new Map(prev);
                    next.delete(assignSheetIndex);
                    return next;
                });
            } else {
                const updated = await WatchAssignmentService.assign(
                    voyageId,
                    assignSheetIndex,
                    slot.label,
                    slot.time,
                    email,
                    name,
                );
                if (updated) {
                    setAssignments((prev) => {
                        const next = new Map(prev);
                        next.set(assignSheetIndex, updated);
                        return next;
                    });
                }
            }
            triggerHaptic('medium');
        },
        [voyageId, assignSheetIndex, schedule.watches],
    );
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

                {/* Pre-watch alarm controls — only render when we
                    have a voyage + departure time anchor. Toggles
                    iOS LocalNotifications scheduled by
                    WatchAlarmService for the current user's
                    assigned watches. */}
                {voyageId && departureTimeIso && (
                    <div className="mb-3 px-3 py-2.5 rounded-lg bg-amber-500/[0.06] border border-amber-500/20 flex items-center gap-3 flex-wrap">
                        <button
                            type="button"
                            role="switch"
                            aria-checked={alarmEnabled}
                            onClick={() => {
                                setAlarmEnabled((v) => !v);
                                triggerHaptic('light');
                            }}
                            className={`shrink-0 relative inline-flex h-5 w-9 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                                alarmEnabled ? 'bg-amber-500' : 'bg-slate-700'
                            }`}
                            aria-label="Enable pre-watch alarm"
                        >
                            <span
                                aria-hidden="true"
                                className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition-transform ${
                                    alarmEnabled ? 'translate-x-4' : 'translate-x-0'
                                }`}
                            />
                        </button>
                        <div className="flex-1 min-w-0">
                            <p className="text-xs font-bold text-white">⏰ Pre-watch alarm</p>
                            <p className="text-[10px] text-amber-200/70">
                                {alarmEnabled
                                    ? alarmCount > 0
                                        ? `${alarmCount} alarm${alarmCount > 1 ? 's' : ''} scheduled — fires ${alarmLeadMin} min before your watch`
                                        : 'Assign yourself to a watch to schedule alarms'
                                    : 'Off — you won’t be woken up'}
                            </p>
                        </div>
                        {alarmEnabled && (
                            <select
                                value={alarmLeadMin}
                                onChange={(e) => setAlarmLeadMin(parseInt(e.target.value, 10))}
                                aria-label="Alarm lead time in minutes"
                                className="shrink-0 bg-slate-900/60 border border-amber-500/20 rounded-md px-2 py-1 text-[11px] font-bold text-amber-200 outline-none focus:border-amber-500"
                            >
                                {ALARM_LEAD_OPTIONS.map((m) => (
                                    <option key={m} value={m}>
                                        {m} min
                                    </option>
                                ))}
                            </select>
                        )}
                    </div>
                )}

                {/* Watch rotation table — each row tappable to open
                    the crew assignment sheet. Assigned slots show the
                    crew member's display name; unassigned slots fall
                    back to the auto-generated placeholder ("Watch A"
                    etc) with a subtle "Tap to assign" hint. */}
                <div className="space-y-1">
                    {schedule.watches.map((w, i) => {
                        const assignment = assignments.get(i);
                        const isAssigned = !!assignment?.assigned_crew_email;
                        return (
                            <button
                                key={i}
                                type="button"
                                onClick={() => setAssignSheetIndex(i)}
                                disabled={!voyageId}
                                aria-label={`Assign ${w.label} (${w.time})`}
                                className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg border text-left transition-all ${
                                    isAssigned
                                        ? 'bg-indigo-500/15 border-indigo-500/30 hover:bg-indigo-500/20 active:scale-[0.98]'
                                        : 'bg-white/[0.03] border-white/[0.04] hover:bg-white/[0.05] active:scale-[0.98]'
                                } ${!voyageId ? 'opacity-50 cursor-default' : ''}`}
                            >
                                <div
                                    className={`w-2 h-2 rounded-full ${i % 2 === 0 ? 'bg-sky-400' : 'bg-purple-400'}`}
                                />
                                <span className="text-xs font-bold text-white flex-1 truncate">{w.label}</span>
                                <span className="text-xs text-gray-400 font-mono">{w.time}</span>
                                {isAssigned ? (
                                    <span className="text-[11px] text-indigo-200 font-bold truncate max-w-[100px]">
                                        👤 {assignment!.assigned_crew_name ?? assignment!.assigned_crew_email}
                                    </span>
                                ) : (
                                    <span className="text-[11px] text-gray-500 italic">
                                        {voyageId ? 'Tap to assign' : w.crew}
                                    </span>
                                )}
                            </button>
                        );
                    })}
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

            {/* ── Watch Assignment Sheet ──
                Triggered by tapping a watch row above. Lists the
                voyage's accepted crew + skipper; selection upserts
                an assignment and refreshes the row in-place. */}
            {assignSheetIndex != null && schedule.watches[assignSheetIndex] && (
                <WatchAssignSheet
                    open={assignSheetIndex != null}
                    onClose={() => setAssignSheetIndex(null)}
                    watchLabel={schedule.watches[assignSheetIndex].label}
                    watchTimeLabel={schedule.watches[assignSheetIndex].time}
                    currentEmail={assignments.get(assignSheetIndex)?.assigned_crew_email ?? null}
                    crew={crew}
                    skipperEmail={skipperEmail}
                    onAssign={handleAssign}
                />
            )}
        </div>
    );
};
