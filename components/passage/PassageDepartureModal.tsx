import React, { useId, useRef, useState } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { PASSAGE_DEPARTURE_MAX_MS } from '../../services/passageDeparture';
import type { PassageDepartureSuggestionState } from '../../services/passageDepartureSuggestion';
import { OverlayPortal } from '../ui/OverlayPortal';

export interface PassageDepartureModalProps {
    visible: boolean;
    onClose: () => void;
    /** Null keeps departure tied to now; a number is a fixed departure. */
    onConfirm: (departureMs: number | null) => void;
    departureMs?: number | null;
    routeName?: string;
    cruiseKts?: number;
    suggestion?: PassageDepartureSuggestionState;
}

const pad = (value: number) => String(value).padStart(2, '0');
const dateValue = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const timeValue = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;

/** Native fields describe device-local wall time, not a UTC date string. */
export function parsePassageLocalDeparture(date: string, time: string): number | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
    const [year, month, day] = date.split('-').map(Number);
    const [hour, minute] = time.split(':').map(Number);
    const value = new Date(year, month - 1, day, hour, minute, 0, 0);
    // Reject overflow and nonexistent local times at a daylight-saving jump.
    if (
        value.getFullYear() !== year ||
        value.getMonth() !== month - 1 ||
        value.getDate() !== day ||
        value.getHours() !== hour ||
        value.getMinutes() !== minute
    ) {
        return null;
    }
    return value.getTime();
}

function deviceTimeZone(): string {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'device time zone';
    } catch {
        return 'device time zone';
    }
}

/** Mount the draft only while visible, so reopening never reuses an abandoned edit. */
export function PassageDepartureModal(props: PassageDepartureModalProps) {
    if (!props.visible) return null;
    return <DepartureDialog {...props} />;
}

function DepartureDialog({
    onClose,
    onConfirm,
    departureMs,
    routeName,
    cruiseKts,
    suggestion,
}: PassageDepartureModalProps) {
    const id = useId();
    const closeRef = useRef<HTMLButtonElement>(null);
    const dialogRef = useFocusTrap<HTMLDivElement>(true, { onEscape: onClose, initialFocusRef: closeRef });
    const [openedAt] = useState(() => Date.now());
    const [scheduled, setScheduled] = useState(departureMs != null);
    const [initialDate] = useState(() => new Date(departureMs ?? openedAt + 3_600_000));
    const [date, setDate] = useState(() => (Number.isFinite(initialDate.getTime()) ? dateValue(initialDate) : ''));
    const [time, setTime] = useState(() => (Number.isFinite(initialDate.getTime()) ? timeValue(initialDate) : ''));
    // Preserve an existing exact selection until the skipper changes a field.
    const [uneditedDeparture, setUneditedDeparture] = useState(departureMs);
    const [error, setError] = useState<string | null>(null);
    const now = Date.now();
    const latest = new Date(now + PASSAGE_DEPARTURE_MAX_MS);
    const selected = uneditedDeparture ?? parsePassageLocalDeparture(date, time);

    const chooseDay = (days: number) => {
        const next = new Date(Date.now());
        next.setDate(next.getDate() + days);
        setDate(dateValue(next));
        setTime(timeValue(next));
        setUneditedDeparture(null);
        setScheduled(true);
        setError(null);
    };

    const useSuggestion = (value: number) => {
        const next = new Date(value);
        setDate(dateValue(next));
        setTime(timeValue(next));
        setUneditedDeparture(value);
        setScheduled(true);
        setError(null);
    };

    const submit = (event: React.FormEvent) => {
        event.preventDefault();
        if (!scheduled) {
            onConfirm(null);
            return;
        }
        const submitNow = Date.now();
        if (selected == null || !Number.isFinite(selected)) {
            setError('Choose a valid local date and time.');
        } else if (selected < submitNow) {
            setError('That departure has passed. Choose a later time or Leave now.');
        } else if (selected > submitNow + PASSAGE_DEPARTURE_MAX_MS) {
            setError('Choose a departure within the next five days (120 hours).');
        } else {
            onConfirm(selected);
        }
    };

    return (
        <OverlayPortal
            role="presentation"
            className="pointer-events-auto flex items-center justify-center bg-slate-950/75 p-4 pb-[calc(4rem+env(safe-area-inset-bottom)+1rem)] pt-[max(1rem,env(safe-area-inset-top))] backdrop-blur-sm"
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
            onClick={(event) => {
                event.stopPropagation();
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={`${id}-title`}
                aria-describedby={`${id}-description`}
                data-testid="passage-departure-modal"
                data-pane-dialog-panel
                tabIndex={-1}
                className="flex max-h-full w-full max-w-sm flex-col overflow-hidden rounded-3xl border border-teal-200/15 bg-slate-950 text-white shadow-2xl shadow-black/60"
            >
                <div className="relative shrink-0 border-b border-white/10 bg-gradient-to-br from-teal-500/10 via-slate-900 to-slate-950 px-5 pb-4 pt-5">
                    <div className="mb-3 flex items-center gap-2.5 pr-10">
                        <span
                            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-teal-200/20 bg-teal-300/10 text-teal-200"
                            aria-hidden="true"
                        >
                            <svg
                                width="20"
                                height="20"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.7"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <circle cx="12" cy="12" r="8.5" />
                                <path d="M12 7v5l3 2M8 2h8" />
                            </svg>
                        </span>
                        <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-amber-200">
                            Passage preview
                        </p>
                    </div>
                    <button
                        ref={closeRef}
                        type="button"
                        aria-label="Close departure picker"
                        onClick={onClose}
                        className="absolute right-2 top-2 flex min-h-11 min-w-11 items-center justify-center rounded-full text-slate-400 hover:bg-white/5 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-300"
                    >
                        <svg
                            width="20"
                            height="20"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            aria-hidden="true"
                        >
                            <path d="m6 6 12 12M6 18 18 6" />
                        </svg>
                    </button>
                    <h2 id={`${id}-title`} className="text-xl font-bold tracking-tight">
                        When will you leave?
                    </h2>
                    <p id={`${id}-description`} className="mt-1 text-sm leading-relaxed text-slate-400">
                        Choose a departure within the next five days.
                    </p>
                    {(routeName || (cruiseKts != null && Number.isFinite(cruiseKts) && cruiseKts > 0)) && (
                        <div className="mt-3 flex min-w-0 items-center gap-2 text-xs text-slate-300">
                            {routeName && (
                                <span className="min-w-0 truncate" title={routeName}>
                                    {routeName}
                                </span>
                            )}
                            {cruiseKts != null && Number.isFinite(cruiseKts) && cruiseKts > 0 && (
                                <span className="shrink-0 rounded-md bg-white/5 px-2 py-1 font-semibold text-teal-100">
                                    {cruiseKts.toFixed(1)} kn cruise
                                </span>
                            )}
                        </div>
                    )}
                </div>
                <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
                    <div className="min-h-0 overflow-y-auto overscroll-contain px-5 py-4">
                        <div
                            className="grid grid-cols-2 gap-2 rounded-2xl bg-white/[0.03] p-1"
                            aria-label="Departure mode"
                        >
                            {[
                                { value: false, label: 'Leave now' },
                                { value: true, label: 'Choose a time' },
                            ].map((option) => (
                                <button
                                    key={option.label}
                                    type="button"
                                    aria-pressed={scheduled === option.value}
                                    onClick={() => {
                                        setScheduled(option.value);
                                        setError(null);
                                    }}
                                    className={`min-h-11 rounded-xl border px-2 text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-300 ${scheduled === option.value ? 'border-teal-300/40 bg-teal-300/10 text-teal-100' : 'border-transparent text-slate-400 hover:text-white'}`}
                                >
                                    {option.label}
                                </button>
                            ))}
                        </div>
                        {scheduled ? (
                            <div className="mt-4 space-y-3">
                                <div className="grid grid-cols-3 gap-2" aria-label="Quick departure dates">
                                    {[1, 2, 3].map((days) => (
                                        <button
                                            key={days}
                                            type="button"
                                            onClick={() => chooseDay(days)}
                                            className="min-h-11 rounded-xl border border-white/10 bg-white/[0.03] px-1 text-xs font-semibold text-slate-300 hover:border-teal-300/40 hover:text-teal-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-300"
                                        >
                                            {days === 1 ? 'Tomorrow' : `+${days} days`}
                                        </button>
                                    ))}
                                </div>
                                <div className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] gap-3">
                                    <label
                                        className="min-w-0 text-xs font-semibold text-slate-300"
                                        htmlFor={`${id}-date`}
                                    >
                                        Departure date
                                        <input
                                            id={`${id}-date`}
                                            type="date"
                                            value={date}
                                            min={dateValue(new Date(now))}
                                            max={dateValue(latest)}
                                            aria-invalid={!!error}
                                            aria-describedby={`${id}-zone${error ? ` ${id}-error` : ''}`}
                                            onChange={(event) => {
                                                setDate(event.target.value);
                                                setUneditedDeparture(null);
                                                setError(null);
                                            }}
                                            className="mt-1.5 block min-h-12 w-full min-w-0 rounded-xl border border-white/15 bg-slate-900 px-2 text-base font-medium text-white focus:border-teal-300 focus:outline-none"
                                            style={{ colorScheme: 'dark' }}
                                        />
                                    </label>
                                    <label
                                        className="min-w-0 text-xs font-semibold text-slate-300"
                                        htmlFor={`${id}-time`}
                                    >
                                        Departure time
                                        <input
                                            id={`${id}-time`}
                                            type="time"
                                            step={60}
                                            value={time}
                                            aria-invalid={!!error}
                                            aria-describedby={`${id}-zone${error ? ` ${id}-error` : ''}`}
                                            onChange={(event) => {
                                                setTime(event.target.value);
                                                setUneditedDeparture(null);
                                                setError(null);
                                            }}
                                            className="mt-1.5 block min-h-12 w-full min-w-0 rounded-xl border border-white/15 bg-slate-900 px-2 text-base font-medium text-white focus:border-teal-300 focus:outline-none"
                                            style={{ colorScheme: 'dark' }}
                                        />
                                    </label>
                                </div>
                                <p className="text-xs leading-relaxed text-slate-500">
                                    Latest:{' '}
                                    {latest.toLocaleString(undefined, {
                                        month: 'short',
                                        day: 'numeric',
                                        hour: 'numeric',
                                        minute: '2-digit',
                                    })}
                                    . The limit moves with the current time.
                                </p>
                            </div>
                        ) : (
                            <div className="my-4 rounded-2xl border border-teal-200/10 bg-teal-300/[0.04] p-4">
                                <p className="text-sm font-semibold text-teal-100">Start from the current time</p>
                                <p className="mt-1 text-sm leading-relaxed text-slate-400">
                                    Move along your route to preview the forecast for each point in the passage.
                                </p>
                            </div>
                        )}
                        <p id={`${id}-zone`} className="mt-3 break-words text-xs leading-relaxed text-slate-400">
                            Device local time · {deviceTimeZone()}
                        </p>
                        {error && (
                            <p
                                id={`${id}-error`}
                                role="alert"
                                className="mt-3 rounded-xl border border-amber-300/20 bg-amber-300/10 px-3 py-2.5 text-sm leading-relaxed text-amber-100"
                            >
                                {error}
                            </p>
                        )}
                        {suggestion && <DepartureSuggestionCard state={suggestion} onUse={useSuggestion} />}
                    </div>
                    <div className="grid shrink-0 grid-cols-[auto_minmax(0,1fr)] gap-3 border-t border-white/10 px-5 py-4">
                        <button
                            type="button"
                            onClick={onClose}
                            className="min-h-12 rounded-xl border border-white/10 px-4 text-sm font-semibold text-slate-300 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-300"
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            className="min-h-12 rounded-xl bg-teal-300 px-3 text-sm font-bold text-slate-950 shadow-lg shadow-teal-950/30 hover:bg-teal-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-200"
                        >
                            Preview passage{' '}
                            <span className="ml-1" aria-hidden="true">
                                →
                            </span>
                        </button>
                    </div>
                </form>
            </div>
        </OverlayPortal>
    );
}

function DepartureSuggestionCard({
    state,
    onUse,
}: {
    state: PassageDepartureSuggestionState;
    onUse: (value: number) => void;
}) {
    const suggestion = state.status === 'ready' ? state.suggestion : null;
    const formatMoment = (value: number) =>
        new Date(value).toLocaleString(undefined, {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
        });
    const limits = suggestion
        ? [
              suggestion.limits.maxWindKts != null ? `wind ${suggestion.limits.maxWindKts} kn` : null,
              suggestion.limits.maxGustKts != null ? `gust ${suggestion.limits.maxGustKts} kn` : null,
              suggestion.limits.maxWaveM != null ? `waves ${suggestion.limits.maxWaveM} m` : null,
          ]
              .filter(Boolean)
              .join(' · ')
        : '';
    return (
        <section
            aria-label="Suggested forecast window"
            className="mt-3 rounded-2xl border border-amber-200/15 bg-amber-200/[0.04] p-3.5"
        >
            <p className="text-xs font-bold text-amber-100">Suggested forecast window</p>
            {state.status === 'loading' && (
                <p role="status" className="mt-2 text-xs leading-relaxed text-slate-400">
                    Comparing departure forecasts…
                </p>
            )}
            {state.status === 'unavailable' && (
                <p role="status" className="mt-2 text-xs leading-relaxed text-slate-400">
                    {state.message}
                </p>
            )}
            {suggestion && (
                <>
                    <p className="mt-2 text-base font-semibold text-white">
                        {formatMoment(suggestion.windowStartMs)}
                        {suggestion.windowEndMs > suggestion.windowStartMs
                            ? ` – ${new Date(suggestion.windowStartMs).toDateString() === new Date(suggestion.windowEndMs).toDateString() ? new Date(suggestion.windowEndMs).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : formatMoment(suggestion.windowEndMs)}`
                            : ''}
                    </p>
                    <p className="mt-1 text-xs text-amber-100/80">
                        {suggestion.modelLabel} · {suggestion.cruiseKts.toFixed(1)} kn cruise
                    </p>
                    <p className="mt-2 text-xs leading-relaxed text-slate-300">
                        Sampled max wind {suggestion.maxWindKts.toFixed(1)} kn
                        {suggestion.maxGustKts != null
                            ? ` · gust ${suggestion.maxGustKts.toFixed(1)} kn`
                            : ' · gusts incomplete'}
                        {suggestion.maxWaveM != null ? ` · waves ${suggestion.maxWaveM.toFixed(1)} m` : ''}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs font-semibold text-amber-200">
                        {suggestion.windOnly && <span>Wind-only comparison</span>}
                        {suggestion.spreadLevel === 'some' || suggestion.spreadLevel === 'split' ? (
                            <span>Models disagree</span>
                        ) : null}
                    </div>
                    <button
                        type="button"
                        onClick={() => onUse(suggestion.departureMs)}
                        className="mt-3 min-h-11 w-full rounded-xl border border-amber-200/25 bg-amber-200/10 px-3 text-sm font-semibold text-amber-100 hover:bg-amber-200/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-200"
                    >
                        Use this time
                    </button>
                    <details className="mt-1 text-xs leading-relaxed text-slate-400">
                        <summary
                            tabIndex={0}
                            className="min-h-11 cursor-pointer rounded-lg py-3 font-semibold text-slate-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-200"
                        >
                            Forecast comparison details
                        </summary>
                        <div className="space-y-2 pb-2">
                            {suggestion.windowDepartures > 1 && (
                                <p>
                                    {suggestion.windowDepartures} evaluated hourly departures · best time{' '}
                                    {new Date(suggestion.departureMs).toLocaleTimeString(undefined, {
                                        hour: 'numeric',
                                        minute: '2-digit',
                                    })}
                                </p>
                            )}
                            <p>
                                {suggestion.windOnly
                                    ? 'Wave coverage is incomplete across departure times, so waves are not ranked.'
                                    : 'Wind and wave comparison.'}
                                {!suggestion.gustsRanked && suggestion.gustComplete
                                    ? ' Gusts not ranked: other times have gaps.'
                                    : ''}
                            </p>
                            {suggestion.approximateStart && (
                                <p className="text-amber-200">
                                    Approximate start · ~{Math.max(1, Math.round(suggestion.uncheckedJoinNm * 1852))} m
                                    unchecked joining leg; travel time included.
                                </p>
                            )}
                            <p>{limits ? `Your limits: ${limits}.` : 'No wind, gust or wave limits set.'}</p>
                            <p>
                                {suggestion.comparedDepartures} hourly departures ranked by wind and headwind
                                {suggestion.gustsRanked ? ', gusts' : ''}
                                {!suggestion.windOnly ? ', waves' : ''}. Hourly samples, not continuous coverage.
                            </p>
                        </div>
                    </details>
                    <p className="text-[11px] leading-relaxed text-slate-500">
                        Forecast comparison, not a safety clearance.
                    </p>
                </>
            )}
        </section>
    );
}
