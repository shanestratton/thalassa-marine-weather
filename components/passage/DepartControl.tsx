/**
 * DepartControl — the PLAN page's departure date/time card (Shane 2026-07-16
 * "morph the planner into the tracer front door… keep the departure").
 *
 * Same semantics as the tracer card's inline Depart row: empty = leave now;
 * two lines (date, then time) so neither is squeezed; OK blurs the native
 * picker closed (iOS keeps the wheel up until the input blurs).
 *
 * Sync: single source of truth is sessionStorage 'thalassa_trace_departure_ms'
 * (the tracer reads it on mount) + a 'thalassa:departure-changed' window event
 * so an already-mounted MapHub re-anchors its tide windows / weather ETAs live.
 */
import React from 'react';
import { triggerHaptic } from '../../utils/system';

const STORAGE_KEY = 'thalassa_trace_departure_ms';

const msToLocal = (ms: number): string => {
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

export const DepartControl: React.FC = () => {
    const [departureMs, setDepartureMsState] = React.useState<number | null>(() => {
        try {
            const raw = sessionStorage.getItem(STORAGE_KEY);
            const v = raw ? Number(raw) : NaN;
            return Number.isFinite(v) && v > Date.now() - 3_600_000 ? v : null;
        } catch {
            return null;
        }
    });
    const setDeparture = (ms: number | null): void => {
        setDepartureMsState(ms);
        try {
            if (ms === null) sessionStorage.removeItem(STORAGE_KEY);
            else sessionStorage.setItem(STORAGE_KEY, String(ms));
        } catch {
            /* private mode — MapHub still hears the event below */
        }
        try {
            window.dispatchEvent(new CustomEvent('thalassa:departure-changed', { detail: { ms } }));
        } catch {
            /* sessionStorage alone covers the next mount */
        }
    };

    const dateStr = departureMs !== null ? msToLocal(departureMs).slice(0, 10) : '';
    const timeStr = departureMs !== null ? msToLocal(departureMs).slice(11, 16) : '';
    return (
        <div className="rounded-2xl border border-sky-500/20 bg-gradient-to-br from-sky-500/10 to-slate-900/40 p-3 shadow-[0_0_20px_rgba(14,165,233,0.08)]">
            <div className="mb-2 flex items-baseline justify-between">
                <span className="text-[11px] font-black uppercase tracking-widest text-sky-300">🕐 Departure</span>
                {departureMs === null && (
                    <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-emerald-300">
                        leaving now
                    </span>
                )}
            </div>
            <div className="flex gap-2">
                <input
                    type="date"
                    value={dateStr}
                    onChange={(e) => {
                        triggerHaptic('light');
                        if (!e.target.value) {
                            setDeparture(null);
                            return;
                        }
                        const time = timeStr || msToLocal(Date.now()).slice(11, 16);
                        const t = new Date(`${e.target.value}T${time}`).getTime();
                        if (Number.isFinite(t)) setDeparture(t);
                    }}
                    aria-label="Departure date"
                    className="h-11 min-w-0 flex-[3] rounded-xl border border-white/10 bg-slate-900/60 px-3 text-sm font-medium text-white [color-scheme:dark] focus:border-sky-500/50 focus:outline-none"
                />
                <input
                    type="time"
                    value={timeStr}
                    onChange={(e) => {
                        if (!e.target.value) return;
                        triggerHaptic('light');
                        const date = dateStr || msToLocal(Date.now()).slice(0, 10);
                        const t = new Date(`${date}T${e.target.value}`).getTime();
                        if (Number.isFinite(t)) setDeparture(t);
                    }}
                    aria-label="Departure time"
                    className="h-11 min-w-0 flex-[2] rounded-xl border border-white/10 bg-slate-900/60 px-3 text-sm font-medium text-white [color-scheme:dark] focus:border-sky-500/50 focus:outline-none"
                />
            </div>
            <div className="mt-2 flex gap-2">
                <button
                    onClick={() => {
                        triggerHaptic('light');
                        (document.activeElement as HTMLElement | null)?.blur?.();
                    }}
                    className="h-9 flex-1 rounded-xl bg-sky-500/20 text-[11px] font-black uppercase tracking-widest text-sky-300 active:scale-95"
                >
                    OK
                </button>
                {departureMs !== null && (
                    <button
                        onClick={() => {
                            triggerHaptic('light');
                            (document.activeElement as HTMLElement | null)?.blur?.();
                            setDeparture(null);
                        }}
                        className="h-9 flex-1 rounded-xl bg-white/10 text-[11px] font-black uppercase tracking-widest text-gray-300 active:scale-95"
                    >
                        Now
                    </button>
                )}
            </div>
        </div>
    );
};
