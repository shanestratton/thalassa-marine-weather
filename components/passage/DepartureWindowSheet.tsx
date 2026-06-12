/**
 * DepartureWindowSheet — Modal sheet that surfaces the
 * planDepartureWindow() engine to the user.
 *
 * UX flow:
 *   1. User has filled origin + destination + departureDate
 *   2. User taps "Plan Window" button on the route summary overlay
 *   3. This sheet slides up from the bottom
 *   4. Engine runs ~14 isochrone scenarios across the next 7 days,
 *      streaming results via 'thalassa:departure-window-progress'
 *   5. Each scenario shows a verdict chip + key metrics
 *   6. User taps a scenario → sets departureDate, sheet closes
 *
 * The sheet stays open during compute so the user can watch results
 * populate live (~10-30s per scenario, ~3-5 min total). They can
 * cancel by tapping the backdrop or close button at any time.
 */

import React from 'react';
import type { DepartureScenario } from '../../services/departureWindow';
import { triggerHaptic } from '../../utils/system';

interface VerdictStyle {
    bg: string;
    border: string;
    text: string;
    label: string;
}

const VERDICT_STYLES: Record<DepartureScenario['verdict'], VerdictStyle> = {
    go: {
        bg: 'bg-emerald-500/15',
        border: 'border-emerald-500/30',
        text: 'text-emerald-400',
        label: 'GO',
    },
    maybe: {
        bg: 'bg-amber-500/10',
        border: 'border-amber-500/25',
        text: 'text-amber-400',
        label: 'MAYBE',
    },
    avoid: {
        bg: 'bg-orange-500/10',
        border: 'border-orange-500/25',
        text: 'text-orange-400',
        label: 'AVOID',
    },
    'no-go': {
        bg: 'bg-red-500/10',
        border: 'border-red-500/25',
        text: 'text-red-400',
        label: 'NO-GO',
    },
};

/**
 * Format a departure time for the row display: "Tue 7 May, 06:00 UTC".
 * Times are kept in UTC because they're forecast-anchored — the user
 * picks a wall-clock time of day they're willing to depart, and UTC
 * makes that unambiguous across time zones (the date picker localises
 * back to local for the form submission).
 */
function formatDepartureRow(iso: string): string {
    try {
        const d = new Date(iso);
        const dayName = d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
        const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
        const time = d.toLocaleTimeString('en-GB', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
            timeZone: 'UTC',
        });
        return `${dayName} ${date}, ${time} UTC`;
    } catch {
        return iso;
    }
}

/**
 * Format duration hours → "Xd Yh" or "Xh".
 */
function formatDuration(hours: number): string {
    if (hours <= 0) return '—';
    if (hours < 24) return `${Math.round(hours)}h`;
    const d = Math.floor(hours / 24);
    const h = Math.round(hours % 24);
    return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

interface DepartureWindowSheetProps {
    open: boolean;
    onClose: () => void;
    planning: boolean;
    scenarios: DepartureScenario[];
    progressLabel?: string;
    onAccept: (scenario: DepartureScenario) => void;
    /** Origin/destination labels for the sheet header. */
    origin?: string;
    destination?: string;
}

export const DepartureWindowSheet: React.FC<DepartureWindowSheetProps> = ({
    open,
    onClose,
    planning,
    scenarios,
    progressLabel,
    onAccept,
    origin,
    destination,
}) => {
    if (!open) return null;

    // Best scenario (lowest score, route-found). Already sorted by
    // planDepartureWindow once the run completes; while streaming, the
    // raw insertion order is whatever's been computed so far. We
    // re-sort in the UI for live ranking.
    const sorted = [...scenarios].sort((a, b) => a.score - b.score);
    const best = sorted.find((s) => s.routeFound) ?? null;

    return (
        <div className="fixed inset-0 z-50 flex items-end justify-center" role="dialog" aria-modal="true">
            {/* Backdrop */}
            <button
                type="button"
                aria-label="Close departure window panel"
                onClick={onClose}
                className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            />

            {/* Sheet */}
            <div className="relative w-full max-w-2xl max-h-[90vh] flex flex-col bg-slate-950 border-t border-x border-white/10 rounded-t-3xl shadow-2xl animate-in slide-in-from-bottom duration-300">
                {/* Drag handle */}
                <div className="flex-shrink-0 pt-2 pb-1 flex justify-center">
                    <div className="w-12 h-1 rounded-full bg-white/20" />
                </div>

                {/* Header */}
                <div className="flex-shrink-0 px-5 pt-2 pb-4 border-b border-white/5">
                    <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                            <h2 className="text-base font-bold text-white">Departure Window</h2>
                            <p className="text-[11px] text-slate-400 mt-0.5 truncate">
                                {origin && destination ? `${origin} → ${destination}` : 'Optimal departure analysis'}
                            </p>
                        </div>
                        <button
                            onClick={onClose}
                            type="button"
                            aria-label="Close"
                            className="shrink-0 p-3 -m-1 text-slate-400 hover:text-white"
                        >
                            <svg
                                className="w-5 h-5"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2}
                            >
                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    </div>

                    {/* Progress */}
                    {planning && (
                        <div className="mt-3 flex items-center gap-2 text-[11px] text-sky-400">
                            <div className="w-1.5 h-1.5 bg-sky-400 rounded-full animate-pulse" />
                            <span className="font-mono tabular-nums tracking-wide">
                                {progressLabel ?? `Computing… ${scenarios.length} of 14`}
                            </span>
                        </div>
                    )}
                </div>

                {/* Best-pick callout */}
                {best && !planning && (
                    <div className="flex-shrink-0 px-5 pt-3 pb-2">
                        <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/30 p-3">
                            <div className="flex items-center justify-between gap-2 mb-1">
                                <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-400">
                                    Best Pick
                                </span>
                                <span className="text-[10px] text-emerald-300/70">
                                    {best.galeHours > 0 ? `${best.galeHours}h gale` : 'no gale'}
                                </span>
                            </div>
                            <div className="text-sm font-bold text-white">{formatDepartureRow(best.departureTime)}</div>
                            <div className="text-xs text-slate-300 mt-0.5">
                                {formatDuration(best.durationHours)} • {Math.round(best.distanceNM)} NM • avg{' '}
                                {best.avgWindKts} kt
                            </div>
                        </div>
                    </div>
                )}

                {/* Scenarios list */}
                <div
                    className="flex-1 min-h-0 overflow-y-auto px-3 pt-2"
                    style={{ paddingBottom: 'max(20px, env(safe-area-inset-bottom))' }}
                >
                    {sorted.length === 0 && planning && (
                        <>
                            {/* Skeleton rows mirroring scenario row geometry while the first scenario computes */}
                            <div className="space-y-2" aria-hidden="true">
                                {Array.from({ length: 3 }).map((_, i) => (
                                    <div
                                        key={i}
                                        className="rounded-xl border border-white/[0.06] bg-white/[0.03] h-[64px] animate-pulse"
                                    />
                                ))}
                            </div>
                            <div className="px-3 py-6 text-center text-xs text-slate-500">
                                Running first scenario… results will populate live as each completes.
                            </div>
                        </>
                    )}
                    {sorted.length === 0 && !planning && (
                        <div className="px-3 py-12 text-center text-xs text-slate-500">No scenarios available.</div>
                    )}
                    <ul className="space-y-2">
                        {sorted.map((s, idx) => {
                            const style = VERDICT_STYLES[s.verdict];
                            const isBest = best && s.departureTime === best.departureTime && !planning;
                            return (
                                <li key={s.departureTime}>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            if (!s.routeFound) return;
                                            triggerHaptic('light');
                                            onAccept(s);
                                        }}
                                        disabled={!s.routeFound}
                                        aria-label={`Select departure ${formatDepartureRow(s.departureTime)}`}
                                        className={`w-full text-left rounded-xl border ${style.border} ${style.bg} px-3 py-3 transition-all ${
                                            s.routeFound
                                                ? 'hover:bg-white/5 active:scale-[0.98]'
                                                : 'opacity-50 cursor-not-allowed'
                                        } ${isBest ? 'ring-1 ring-emerald-400/40' : ''}`}
                                    >
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-[10px] font-mono text-slate-500">
                                                        #{idx + 1}
                                                    </span>
                                                    <span className="text-sm font-bold text-white truncate">
                                                        {formatDepartureRow(s.departureTime)}
                                                    </span>
                                                </div>
                                                {s.routeFound ? (
                                                    <div className="mt-1 grid grid-cols-3 gap-x-3 gap-y-0.5 text-[11px] tabular-nums">
                                                        <span className="text-slate-300">
                                                            <span className="text-slate-500">ETA</span>{' '}
                                                            {formatDuration(s.durationHours)}
                                                        </span>
                                                        <span className="text-slate-300">
                                                            <span className="text-slate-500">Wind</span> {s.avgWindKts}/
                                                            {s.maxWindKts} kt
                                                        </span>
                                                        <span className="text-slate-300">
                                                            <span className="text-slate-500">Gale</span> {s.galeHours}h
                                                        </span>
                                                    </div>
                                                ) : (
                                                    <p className="mt-1 text-[11px] text-slate-500">
                                                        No safe route found at this departure.
                                                    </p>
                                                )}
                                            </div>
                                            <div
                                                className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-bold ${style.bg} ${style.text} border ${style.border}`}
                                            >
                                                {style.label}
                                            </div>
                                        </div>
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                </div>
            </div>
        </div>
    );
};
