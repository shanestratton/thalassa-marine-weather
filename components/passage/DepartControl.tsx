/**
 * DepartControl — the PLAN page's departure date/time card (Shane 2026-07-16
 * "morph the planner into the tracer front door… keep the departure").
 *
 * Same semantics as the tracer card's inline Depart row: empty = leave now;
 * date/time edits apply immediately. The persistent Now action clears a
 * scheduled departure and dismisses any focused native picker.
 *
 * Sync: single source of truth is an account-scoped sessionStorage departure
 * (the tracer reads it on mount) + an identity-tagged window event so an
 * already-mounted MapHub re-anchors its tide windows / weather ETAs live.
 */
import React from 'react';
import { triggerHaptic } from '../../utils/system';
import { ClockIcon } from '../Icons';
import { TimePicker24, localDateStr } from './TimePicker24';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../../services/authIdentityScope';

const STORAGE_KEY = 'thalassa_trace_departure_ms';
const subscribeIdentity = (notify: () => void): (() => void) => subscribeAuthIdentityScope(() => notify());

function sameScope(left: AuthIdentityScope, right: AuthIdentityScope): boolean {
    return left.key === right.key && left.generation === right.generation;
}

function readDeparture(scope: AuthIdentityScope): number | null {
    try {
        const scoped = sessionStorage.getItem(authScopedStorageKey(STORAGE_KEY, scope));
        const raw = scoped ?? (scope.userId ? null : sessionStorage.getItem(STORAGE_KEY));
        const value = raw ? Number(raw) : Number.NaN;
        return Number.isFinite(value) && value > Date.now() - 3_600_000 ? value : null;
    } catch {
        return null;
    }
}

const msToLocal = (ms: number): string => {
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

export const DepartControl: React.FC = () => {
    const identityScope = React.useSyncExternalStore(subscribeIdentity, getAuthIdentityScope, getAuthIdentityScope);
    const hydratedDeparture = React.useMemo(() => readDeparture(identityScope), [identityScope]);
    const [storedDeparture, setStoredDeparture] = React.useState(() => ({
        scope: identityScope,
        value: hydratedDeparture,
    }));
    const departureMs = sameScope(storedDeparture.scope, identityScope) ? storedDeparture.value : hydratedDeparture;

    React.useLayoutEffect(() => {
        setStoredDeparture((current) =>
            sameScope(current.scope, identityScope) ? current : { scope: identityScope, value: hydratedDeparture },
        );
    }, [hydratedDeparture, identityScope]);

    const setDeparture = (ms: number | null): void => {
        const scope = identityScope;
        if (!isAuthIdentityScopeCurrent(scope)) return;
        setStoredDeparture({ scope, value: ms });
        try {
            const key = authScopedStorageKey(STORAGE_KEY, scope);
            if (ms === null) sessionStorage.removeItem(key);
            else sessionStorage.setItem(key, String(ms));
        } catch {
            /* private mode — MapHub still hears the event below */
        }
        try {
            window.dispatchEvent(
                new CustomEvent('thalassa:departure-changed', {
                    detail: { ms, scopeKey: scope.key, scopeGeneration: scope.generation },
                }),
            );
        } catch {
            /* sessionStorage alone covers the next mount */
        }
    };

    const dateStr = departureMs !== null ? msToLocal(departureMs).slice(0, 10) : '';
    const timeStr = departureMs !== null ? msToLocal(departureMs).slice(11, 16) : '';
    // Default the pickers to RIGHT NOW (Shane 2026-07-17) — display-only:
    // the "leaving now" state stays null until the punter actually picks.
    const todayStr = localDateStr();
    const leavingNow = departureMs === null;
    const titleId = React.useId();
    return (
        // A named group, so VoiceOver hears "Departure" before the date, time
        // and Now controls rather than a flat run of text (UX scorecard run 7).
        <div
            role="group"
            aria-labelledby={titleId}
            className="rounded-2xl border border-sky-500/20 bg-linear-to-br from-sky-500/10 to-slate-900/40 p-3 shadow-[0_0_20px_rgba(14,165,233,0.08)]"
        >
            <div className="mb-2 flex items-center justify-between [@media(orientation:landscape)_and_(max-height:500px)]:mb-1.5">
                <span
                    id={titleId}
                    className="flex items-center gap-1.5 text-xs font-black uppercase tracking-widest text-sky-300"
                >
                    <ClockIcon className="h-3.5 w-3.5 shrink-0" />
                    Departure
                </span>
                {leavingNow && (
                    <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-black uppercase tracking-wide text-emerald-300">
                        leaving now
                    </span>
                )}
            </div>
            {/* One row in every orientation: date, time, then a compact Now.
                It used to be a full-width emerald bar under the row in
                portrait, a third green element repeating the LEAVING NOW chip
                and the Start plotting CTA (UX scorecard run 7). Below ~340 pt
                the time and Now wrap under the date as a pair. */}
            <div className="flex flex-wrap items-center gap-2">
                <input
                    type="date"
                    value={dateStr || todayStr}
                    min={todayStr} // the past is greyed out — can't plan to leave yesterday
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
                    className="h-11 min-w-[6.5rem] flex-1 basis-0 rounded-xl border border-white/10 bg-slate-900/60 px-3 text-[13px] font-medium text-white scheme-dark focus:border-sky-500/50 focus:outline-hidden"
                />
                <div className="flex shrink-0 items-center gap-2">
                    {/* 24-hour time (Shane 2026-07-17: the web time input's AM/PM
                    clipped in the card) — wheels on iOS, dropdowns on desktop. */}
                    <TimePicker24
                        value={timeStr ? { h: Number(timeStr.slice(0, 2)), m: Number(timeStr.slice(3, 5)) } : null}
                        dateStr={dateStr}
                        onChange={(h, m) => {
                            triggerHaptic('light');
                            const date = dateStr || todayStr;
                            const p = (n: number) => String(n).padStart(2, '0');
                            const t = new Date(`${date}T${p(h)}:${p(m)}`).getTime();
                            if (Number.isFinite(t)) setDeparture(t);
                        }}
                        selectClassName="h-11 min-w-0 rounded-xl border border-white/10 bg-slate-900/60 px-2 text-[13px] font-medium text-white scheme-dark focus:border-sky-500/50 focus:outline-hidden"
                    />
                    {/* Now stays ENABLED even when already leaving now (Shane
                    2026-09-09, cee90a53: it replaced OK, so it must still
                    dismiss an open native picker; the e2e spec pins this).
                    Pressed, it is a quiet neutral outline: the LEAVING NOW
                    chip already says so in emerald (UX scorecard run 7). */}
                    <button
                        type="button"
                        aria-pressed={leavingNow}
                        onClick={() => {
                            triggerHaptic('light');
                            (document.activeElement as HTMLElement | null)?.blur?.();
                            setDeparture(null);
                        }}
                        className={`h-11 min-w-[3.5rem] shrink-0 rounded-xl px-3 text-xs font-black uppercase tracking-widest active:scale-95 ${
                            leavingNow
                                ? 'border border-white/20 bg-transparent text-slate-300'
                                : 'border border-white/10 bg-white/10 text-slate-200'
                        }`}
                    >
                        Now
                    </button>
                </div>
            </div>
        </div>
    );
};
