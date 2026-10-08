/**
 * DepartControl — the PLAN page's departure date/time row (Shane 2026-07-16
 * "morph the planner into the tracer front door… keep the departure"), the top
 * half of the page's plot settings card since 2026-10-05.
 *
 * Same semantics as the tracer card's inline Depart row: empty = leave now;
 * date/time edits apply immediately. The persistent Now action clears a
 * scheduled departure and dismisses any focused native picker.
 *
 * Sync: single source of truth is an account-scoped sessionStorage departure
 * (the tracer reads it on mount) + an identity-tagged window event so an
 * already-mounted MapHub re-anchors its tide windows / weather ETAs live.
 * Both live in services/planDeparture.ts since build 124, and this card
 * listens for the event too: Plan Your Day's "Plot on chart" sets the time
 * from somewhere else, and the card must show it.
 */
import React from 'react';
import { triggerHaptic } from '../../utils/system';
import { ClockIcon } from '../Icons';
import { daylightUiColor } from '../../utils/daylightUiColor';
import { TimePicker24, localDateStr } from './TimePicker24';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../../services/authIdentityScope';
import {
    PLAN_DEPARTURE_EVENT,
    planDepartureFromEvent,
    readPlanDeparture,
    setPlanDeparture,
} from '../../services/planDeparture';

const subscribeIdentity = (notify: () => void): (() => void) => subscribeAuthIdentityScope(() => notify());

function sameScope(left: AuthIdentityScope, right: AuthIdentityScope): boolean {
    return left.key === right.key && left.generation === right.generation;
}

const msToLocal = (ms: number): string => {
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

export const DepartControl: React.FC = () => {
    const identityScope = React.useSyncExternalStore(subscribeIdentity, getAuthIdentityScope, getAuthIdentityScope);
    const hydratedDeparture = React.useMemo(() => readPlanDeparture(identityScope), [identityScope]);
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

    // A departure set elsewhere (Plan Your Day's "Plot on chart") arrives as
    // the same identity-tagged event this card sends; another account's is
    // ignored.
    React.useEffect(() => {
        const onDeparture = (event: Event) => {
            const scope = getAuthIdentityScope();
            const next = planDepartureFromEvent(event, scope);
            if (next) setStoredDeparture({ scope, value: next.ms });
        };
        window.addEventListener(PLAN_DEPARTURE_EVENT, onDeparture);
        return () => window.removeEventListener(PLAN_DEPARTURE_EVENT, onDeparture);
    }, []);

    const setDeparture = (ms: number | null): void => {
        const scope = identityScope;
        if (!isAuthIdentityScopeCurrent(scope)) return;
        setStoredDeparture({ scope, value: ms });
        setPlanDeparture(ms, scope);
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
        // No card of its own: it is the top half of the Plan page's plot
        // settings card, which draws the glass (Shane 2026-10-05: "make it
        // pop. cleaner"); the card's tier sets the padding (styles/plan-page.css).
        <div role="group" aria-labelledby={titleId} className="plan-depart">
            <div className="plan-depart-head flex h-5 items-center justify-between">
                <span
                    id={titleId}
                    className="flex items-center gap-1.5 text-xs font-black uppercase tracking-widest"
                    style={{ color: daylightUiColor('#7dd3fc') }}
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
            {/* One row at every width, 320 pt included: the date takes what is
                left, the hour and minutes share one bordered pill, then a
                compact Now. The date used to clip ('05/10/202') beside two
                bordered selects, and below ~340 pt the time and Now wrapped
                under it into a 142 px card. */}
            <div className="plan-depart-controls flex items-center gap-2">
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
                    className="plan-depart-date h-11 min-w-0 flex-1 basis-0 rounded-xl border border-white/10 bg-slate-900/60 px-3 text-[13px] font-medium tabular-nums text-white scheme-dark focus:border-sky-500/50 focus:outline-hidden"
                />
                {/* 24-hour time (Shane 2026-07-17: the web time input's AM/PM
                    clipped in the card) — wheels on iOS, dropdowns on desktop.
                    The pill draws the border; the selects inside are bare and
                    fill it, border included, so a tap anywhere on the pill but
                    the ':' lands on the hour or the minutes (plan-page.css). */}
                <div className="plan-depart-time flex h-11 shrink-0 items-center rounded-xl border border-white/10 bg-slate-900/60 focus-within:border-sky-500/50">
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
                        selectClassName="min-w-0 appearance-none border-0 bg-transparent px-2 text-center text-[13px] font-medium tabular-nums text-white scheme-dark focus:outline-hidden"
                    />
                </div>
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
                    className={`plan-depart-now h-11 min-w-[3.25rem] shrink-0 rounded-xl px-2.5 text-xs font-black uppercase tracking-widest active:scale-95 ${
                        leavingNow
                            ? 'border border-white/20 bg-transparent text-slate-300'
                            : 'border border-white/10 bg-white/10 text-slate-200'
                    }`}
                >
                    Now
                </button>
            </div>
        </div>
    );
};
