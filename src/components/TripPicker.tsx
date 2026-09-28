/**
 * TripPicker — the public page's voyage shelf.
 *
 * The header chip is a real button that opens a centred modal listing the
 * boat's shared trips as cards: where each one went ('Hamilton Island →
 * Airlie Beach'), the boat-local day it started and its distance. It
 * replaced a native <select> whose options could only say '25 Sept 2026 ·
 * 17.2 nm', and whose dates were built in UTC.
 *
 * Choosing works exactly as the <select>'s onChange did: 'latest' is a mode
 * that keeps following the boat into new trips, a track id freezes that
 * voyage through polling, and the all-diary id is the whole journey. Picking
 * the option already showing just closes the dialog, as a <select> fires no
 * change for it.
 *
 * Place names are only ever the server's from_name / to_name. Missing or
 * null fields fall back to 'From X', 'To Y' or the local date, never to an
 * invented or geocoded name.
 */
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import type { PublicVoyageTrip } from '../voyageLogApi';
import { passageKeySummary, stripTrackPrefix, tripSummary, type TripSummary } from './voyageStory';

export const LATEST_TRIP = 'latest';
/** The whole-journey wire id (the catalogue's all-diary row). */
const ALL_DIARY = 'all-diary';

interface TripPickerProps {
    trips: PublicVoyageTrip[];
    /** The newest (or active) track, which the Latest mode currently shows. */
    latestTrip: PublicVoyageTrip | null;
    /** ThalassaDashboard's requestedTrip: 'latest', a track id, or the all-diary id. */
    value: string;
    /** Called only for a different choice, exactly like the old <select> onChange. */
    onSelect: (value: string) => void;
    /** A trip request is in flight: the chip is aria-disabled and its name ends 'loading'. */
    loading: boolean;
    /** 'hero' over the chart shows the eyebrow and a meta line; the docked phone bar does not. */
    layout: 'hero' | 'bar';
    vesselName?: string;
    nowMs?: number;
    /** Zone for a trip the server sent without time_zone; defaults to the diary's. */
    fallbackTimeZone?: string;
    /**
     * Where focus goes when the shelf closes and the chip cannot take it: a
     * choice that switches a short-landscape phone to its Map folds the
     * header (and the chip) away. The page passes its 'Restore page header'
     * button, the way back to the chip.
     */
    fallbackFocusRef?: React.RefObject<HTMLElement | null>;
}

type OptionKind = 'latest' | 'track' | 'all-diary';

interface PickerOption {
    value: string;
    kind: OptionKind;
    trip: PublicVoyageTrip | null;
    summary: TripSummary | null;
}

/** '17.2 nm' never breaks between the number and its unit. */
const keepUnits = (text: string): string => text.replace(/(\d) (?=nm\b)/g, '$1 ');

const startedMs = (trip: PublicVoyageTrip): number => {
    const at = trip.started_at ? Date.parse(trip.started_at) : Number.NaN;
    return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
};

/** Newest first; trips with no usable start keep their order at the end. */
function newestFirst(trips: PublicVoyageTrip[]): PublicVoyageTrip[] {
    return trips
        .map((trip, index) => ({ trip, index }))
        .sort((a, b) => startedMs(b.trip) - startedMs(a.trip) || a.index - b.index)
        .map(({ trip }) => trip);
}

/** 'Hamilton Island → Airlie Beach' with the arrow in the sea colour and read as 'to'. */
function Headline({ summary }: { summary: TripSummary }) {
    if (summary.from && summary.to) {
        return (
            <>
                {summary.from}
                <span className="pv-arrow" aria-hidden="true">
                    {' → '}
                </span>
                <span className="sr-only"> to </span>
                {summary.to}
            </>
        );
    }
    return <>{summary.headline}</>;
}

/** The date and distance, skipping the date when the headline already is it. */
function metaParts(summary: TripSummary): { date: string | null; rest: string[] } {
    return {
        date: summary.named ? summary.date : null,
        rest: summary.distance ? [summary.distance] : [],
    };
}

const Tag = ({ tone, id, children }: { tone: 'live' | 'latest' | 'route'; id?: string; children: React.ReactNode }) => (
    <span id={id} className="pv-tag" data-tone={tone}>
        {tone === 'live' && <span className="pv-dot" data-tone="live" aria-hidden="true" />}
        {children}
    </span>
);

const CheckIcon = () => (
    <svg
        aria-hidden="true"
        className="pv-voyage__check"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
    >
        <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
);

interface DialogProps {
    dialogId: string;
    options: PickerOption[];
    value: string;
    loading: boolean;
    latestTrip: PublicVoyageTrip | null;
    journeySummary: string | null;
    vesselName?: string;
    onChoose: (value: string) => void;
    onClose: () => void;
}

function TripPickerDialog({
    dialogId,
    options,
    value,
    loading,
    latestTrip,
    journeySummary,
    vesselName,
    onChoose,
    onClose,
}: DialogProps) {
    const titleId = useId();
    const idBase = useId();
    const initialValue = options.some((option) => option.value === value) ? value : (options[0]?.value ?? '');
    const [focusValue, setFocusValue] = useState(initialValue);
    const optionRefs = useRef(new Map<string, HTMLDivElement>());
    const initialRef = useRef<HTMLDivElement | null>(null);
    // Only a press that starts AND ends on the backdrop dismisses: dragging
    // off a card (or the list's scrollbar) to cancel releases over the
    // backdrop, and the click then lands on it as the common ancestor.
    const pressedBackdrop = useRef(false);
    // Focus lands on the option now showing; Tab stays inside, Escape closes.
    const dialogRef = useFocusTrap<HTMLDivElement>(true, { initialFocusRef: initialRef, onEscape: onClose });

    // The page behind stays put: no scroll, and (where supported) no
    // pointer or screen-reader wandering into it while the shelf is open.
    useEffect(() => {
        const html = document.documentElement;
        const body = document.body;
        const previous = [html.style.overflow, body.style.overflow];
        html.style.overflow = 'hidden';
        body.style.overflow = 'hidden';
        const app = document.querySelector('.pv-app');
        const wasInert = app?.hasAttribute('inert') ?? true;
        if (app && !wasInert) app.setAttribute('inert', '');
        return () => {
            html.style.overflow = previous[0];
            body.style.overflow = previous[1];
            if (app && !wasInert) app.removeAttribute('inert');
        };
    }, []);

    useEffect(() => {
        initialRef.current?.scrollIntoView?.({ block: 'nearest' });
    }, []);

    const moveFocus = (index: number) => {
        const next = options[Math.max(0, Math.min(options.length - 1, index))];
        if (!next) return;
        setFocusValue(next.value);
        const element = optionRefs.current.get(next.value);
        element?.focus();
        element?.scrollIntoView?.({ block: 'nearest' });
    };

    const handleOptionKey = (event: React.KeyboardEvent<HTMLDivElement>, index: number, option: PickerOption) => {
        switch (event.key) {
            case 'ArrowDown':
                event.preventDefault();
                moveFocus(index + 1);
                break;
            case 'ArrowUp':
                event.preventDefault();
                moveFocus(index - 1);
                break;
            case 'Home':
                event.preventDefault();
                moveFocus(0);
                break;
            case 'End':
                event.preventDefault();
                moveFocus(options.length - 1);
                break;
            case 'Enter':
            case ' ':
                event.preventDefault();
                onChoose(option.value);
                break;
            default:
        }
    };

    const optionProps = (option: PickerOption, index: number) => ({
        ref: (element: HTMLDivElement | null) => {
            if (element) optionRefs.current.set(option.value, element);
            else optionRefs.current.delete(option.value);
            if (option.value === initialValue) initialRef.current = element;
        },
        role: 'option' as const,
        'aria-selected': option.value === value,
        'aria-disabled': loading || undefined,
        'data-trip-id': option.value,
        'data-kind': option.kind,
        tabIndex: option.value === focusValue ? 0 : -1,
        onFocus: () => setFocusValue(option.value),
        onClick: () => onChoose(option.value),
        onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => handleOptionKey(event, index, option),
        // shrink-0: the scrolling list is a column flex box and would squash cards.
        className: 'pv-voyage flex w-full min-w-0 shrink-0 items-start gap-3 text-left',
    });

    const tracks = options.filter((option) => option.kind === 'track');
    const journeys = options.filter((option) => option.kind === 'all-diary');
    const indexOf = (option: PickerOption) => options.indexOf(option);

    const renderLatest = (option: PickerOption) => {
        const id = `${idBase}-latest`;
        const summary = option.summary;
        const meta = summary ? metaParts(summary) : null;
        const metaText = meta ? [meta.date, ...meta.rest].filter(Boolean).join(' · ') : '';
        return (
            <div
                key={option.value}
                {...optionProps(option, indexOf(option))}
                aria-labelledby={`${id}-kicker`}
                aria-describedby={[
                    latestTrip ? `${id}-tag` : null,
                    `${id}-title`,
                    `${id}-note`,
                    metaText ? `${id}-meta` : null,
                ]
                    .filter(Boolean)
                    .join(' ')}
            >
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-2">
                        <span id={`${id}-kicker`} className="pv-voyage__kicker">
                            Latest trip
                        </span>
                        {latestTrip &&
                            (latestTrip.active ? (
                                <Tag tone="live" id={`${id}-tag`}>
                                    Live
                                </Tag>
                            ) : (
                                <Tag tone="latest" id={`${id}-tag`}>
                                    Latest
                                </Tag>
                            ))}
                    </span>
                    <span id={`${id}-title`} className="pv-voyage__title">
                        {summary ? <Headline summary={summary} /> : 'No trip started yet'}
                    </span>
                    <span id={`${id}-note`} className="pv-voyage__note">
                        Follows the boat into each new trip
                    </span>
                    {metaText && (
                        <span id={`${id}-meta`} className="pv-voyage__meta">
                            {keepUnits(metaText)}
                        </span>
                    )}
                </span>
                {option.value === value && <CheckIcon />}
            </div>
        );
    };

    const renderTrack = (option: PickerOption) => {
        const summary = option.summary!;
        const trip = option.trip!;
        const id = `${idBase}-${indexOf(option)}`;
        const { date, rest } = metaParts(summary);
        const isLatest = trip.id === latestTrip?.id;
        const hasTags = trip.active || isLatest || trip.has_route;
        const hasMeta = !!date || rest.length > 0;
        return (
            <div
                key={option.value}
                {...optionProps(option, indexOf(option))}
                // The date is in the name; the description is only what the
                // name does not already say (distance, then the tags).
                aria-labelledby={[`${id}-title`, date ? `${id}-date` : null].filter(Boolean).join(' ')}
                aria-describedby={
                    [rest.length > 0 ? `${id}-rest` : null, hasTags ? `${id}-tags` : null].filter(Boolean).join(' ') ||
                    undefined
                }
            >
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span id={`${id}-title`} className="pv-voyage__title" data-named={summary.named}>
                        <Headline summary={summary} />
                    </span>
                    {hasMeta && (
                        <span className="pv-voyage__meta">
                            {date && <span id={`${id}-date`}>{date}</span>}
                            {date && rest.length > 0 && ' · '}
                            {rest.length > 0 && <span id={`${id}-rest`}>{keepUnits(rest.join(' · '))}</span>}
                        </span>
                    )}
                    {hasTags && (
                        <span id={`${id}-tags`} className="flex flex-wrap items-center gap-1.5">
                            {trip.active && <Tag tone="live">Live</Tag>}
                            {isLatest && !trip.active && <Tag tone="latest">Latest</Tag>}
                            {trip.has_route && <Tag tone="route">Route</Tag>}
                        </span>
                    )}
                </span>
                {option.value === value && <CheckIcon />}
            </div>
        );
    };

    const renderJourney = (option: PickerOption) => {
        const id = `${idBase}-${indexOf(option)}`;
        return (
            <div
                key={option.value}
                {...optionProps(option, indexOf(option))}
                aria-labelledby={`${id}-title`}
                aria-describedby={[`${id}-note`, journeySummary ? `${id}-meta` : null].filter(Boolean).join(' ')}
            >
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span id={`${id}-title`} className="pv-voyage__title">
                        All trips &amp; diary
                    </span>
                    <span id={`${id}-note`} className="pv-voyage__note">
                        Every shared track and public diary entry
                    </span>
                    {journeySummary && (
                        <span id={`${id}-meta`} className="pv-voyage__meta">
                            {keepUnits(journeySummary)}
                        </span>
                    )}
                </span>
                {option.value === value && <CheckIcon />}
            </div>
        );
    };

    const latest = options.find((option) => option.kind === 'latest');

    return createPortal(
        <div
            className="pv-picker-scrim fixed inset-0 flex items-center justify-center"
            onPointerDown={(event) => {
                pressedBackdrop.current = event.target === event.currentTarget;
            }}
            onClick={(event) => {
                const pressed = pressedBackdrop.current;
                pressedBackdrop.current = false;
                if (pressed && event.target === event.currentTarget) onClose();
            }}
        >
            {/* tabIndex -1: a click on the title, a group label or the gap
                between cards focuses the dialog itself rather than dropping
                focus to <body>, so Escape and the Tab trap keep working. It
                is never in the Tab order. */}
            <div
                ref={dialogRef}
                id={dialogId}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                tabIndex={-1}
                className="pv-picker pv-glass flex min-h-0 flex-col overflow-hidden"
            >
                <div className="pv-picker__head flex shrink-0 items-start gap-3">
                    <div className="flex min-w-0 flex-1 flex-col">
                        {vesselName && <p className="pv-eyebrow pv-eyebrow--sea">{vesselName}</p>}
                        <h2 id={titleId} className="pv-picker__title">
                            Choose a voyage
                        </h2>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close"
                        title="Close"
                        className="pv-picker__close flex shrink-0 items-center justify-center"
                    >
                        <svg
                            aria-hidden="true"
                            viewBox="0 0 24 24"
                            className="h-5 w-5"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.2"
                            strokeLinecap="round"
                        >
                            <path d="M6 6l12 12M18 6 6 18" />
                        </svg>
                    </button>
                </div>
                <div
                    role="listbox"
                    aria-labelledby={titleId}
                    aria-busy={loading}
                    className="pv-picker__list flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto"
                >
                    {latest && renderLatest(latest)}
                    {tracks.length > 0 && (
                        <div role="group" aria-labelledby={`${idBase}-tracks`} className="flex shrink-0 flex-col gap-2">
                            <div role="presentation" id={`${idBase}-tracks`} className="pv-picker__group pv-eyebrow">
                                Started trips
                            </div>
                            {tracks.map(renderTrack)}
                        </div>
                    )}
                    {journeys.length > 0 && (
                        <div
                            role="group"
                            aria-labelledby={`${idBase}-journey`}
                            className="flex shrink-0 flex-col gap-2"
                        >
                            <div role="presentation" id={`${idBase}-journey`} className="pv-picker__group pv-eyebrow">
                                Whole journey
                            </div>
                            {journeys.map(renderJourney)}
                        </div>
                    )}
                </div>
            </div>
        </div>,
        document.body,
    );
}

export function TripPicker({
    trips,
    latestTrip,
    value,
    onSelect,
    loading,
    layout,
    vesselName,
    nowMs,
    fallbackTimeZone,
    fallbackFocusRef,
}: TripPickerProps) {
    const [open, setOpen] = useState(false);
    const chipRef = useRef<HTMLButtonElement>(null);
    const wasOpen = useRef(false);
    const dialogId = useId();
    const dateOptions = useMemo(() => ({ fallbackZone: fallbackTimeZone, nowMs }), [fallbackTimeZone, nowMs]);

    const options = useMemo<PickerOption[]>(() => {
        const list: PickerOption[] = [
            {
                value: LATEST_TRIP,
                kind: 'latest',
                trip: latestTrip,
                summary: latestTrip ? tripSummary(latestTrip, dateOptions) : null,
            },
        ];
        for (const trip of newestFirst(trips.filter((item) => item.kind === 'track'))) {
            list.push({ value: trip.id, kind: 'track', trip, summary: tripSummary(trip, dateOptions) });
        }
        for (const trip of trips.filter((item) => item.kind === 'all-diary')) {
            list.push({ value: trip.id, kind: 'all-diary', trip, summary: null });
        }
        return list;
    }, [trips, latestTrip, dateOptions]);

    const journeySummary = useMemo(() => passageKeySummary({ trip: null, trips, journey: true }), [trips]);

    // The chip's face: FROM → TO when the server named either end, else the
    // local date and distance that it has always shown.
    const chipTrip =
        value === LATEST_TRIP
            ? latestTrip
            : (options.find((option) => option.kind === 'track' && option.value === value)?.trip ?? null);
    const isJourney =
        value === ALL_DIARY || options.some((option) => option.kind === 'all-diary' && option.value === value);
    const chipSummary = chipTrip ? tripSummary(chipTrip, dateOptions) : null;
    const eyebrow = value === LATEST_TRIP ? 'Latest trip' : isJourney ? 'Whole journey' : 'Trip';
    const plainValue = (summary: TripSummary, trip: PublicVoyageTrip): string =>
        [summary.date ?? (stripTrackPrefix(trip.label ?? '').trim() || 'Trip'), summary.distance]
            .concat(trip.has_route ? ['route'] : [])
            .filter(Boolean)
            .join(' · ');
    const chipValue = isJourney
        ? 'All trips & diary'
        : chipTrip && chipSummary
          ? chipSummary.named
              ? chipSummary.headline
              : plainValue(chipSummary, chipTrip)
          : 'No trip started yet';
    const chipMeta =
        chipSummary?.named && chipTrip
            ? [chipSummary.date, chipSummary.distance].filter(Boolean).join(' · ') || null
            : null;
    const spokenValue = chipSummary?.named ? chipSummary.spokenHeadline : chipValue;
    // 'loading' is in the name itself: aria-busy on a button is not announced,
    // and the diary's loading line is hidden in the phone Map view.
    const chipLabel = ['Choose a voyage to view', eyebrow, spokenValue, chipMeta, loading ? 'loading' : null]
        .filter(Boolean)
        .join(' · ');

    const close = useCallback(() => setOpen(false), []);
    const choose = useCallback(
        (next: string) => {
            if (loading) return;
            setOpen(false);
            // A <select> fires no change for the option it already shows.
            if (next !== value) onSelect(next);
        },
        [loading, onSelect, value],
    );

    // Back on the chip after the shelf closes, however it closed. WebKit
    // does not focus a clicked button, so the trap's own restore target can
    // be the body; say it explicitly. When the choice folded the header away
    // (the chip is display:none, so focus() is a no-op), fall back to the
    // page's way back to it rather than leaving focus on <body>.
    useEffect(() => {
        if (wasOpen.current && !open) {
            const chip = chipRef.current;
            chip?.focus({ preventScroll: true });
            if (chip && document.activeElement !== chip) fallbackFocusRef?.current?.focus({ preventScroll: true });
        }
        wasOpen.current = open;
    }, [open, fallbackFocusRef]);

    return (
        <>
            <button
                ref={chipRef}
                type="button"
                className="pv-trip relative flex w-full min-w-0 items-center gap-3 text-left"
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-controls={open ? dialogId : undefined}
                aria-busy={loading}
                aria-disabled={loading || undefined}
                aria-label={chipLabel}
                onClick={() => {
                    if (!loading) setOpen(true);
                }}
            >
                <span className="flex min-w-0 flex-1 flex-col">
                    {layout === 'hero' && <span className="pv-trip__eyebrow">{eyebrow}</span>}
                    <span className="pv-trip__value">
                        {chipSummary?.named ? <Headline summary={chipSummary} /> : keepUnits(chipValue)}
                    </span>
                    {layout === 'hero' && chipMeta && <span className="pv-trip__meta">{keepUnits(chipMeta)}</span>}
                </span>
                {loading ? (
                    <span className="pv-spinner" aria-hidden="true" />
                ) : (
                    <svg
                        aria-hidden="true"
                        className="pv-trip__icon"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                    >
                        <path strokeLinecap="round" strokeLinejoin="round" d="m7 10 5 5 5-5" />
                    </svg>
                )}
            </button>
            {open && (
                <TripPickerDialog
                    dialogId={dialogId}
                    options={options}
                    value={value}
                    loading={loading}
                    latestTrip={latestTrip}
                    journeySummary={journeySummary}
                    vesselName={vesselName}
                    onChoose={choose}
                    onClose={close}
                />
            )}
        </>
    );
}
