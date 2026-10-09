/**
 * TripSheet — your trips, one trip's legs, and the next leg to add (126-16a;
 * Shane 2026-10-09: "it is very difficult to add a leg from a previous trip or
 * route, we need to be able to do that easily not just the first leg. but the
 * 2nd and 3rd and 4th etc.").
 *
 * One centred card with three panes that slide inside it, never stacked:
 *  (a) Your trips: newest first, a single route as a one-leg trip, searchable.
 *  (b) A trip: its legs as cards, each saying whether its check holds and
 *      whether it is in the Log; the joints between them; "+ Add the Nth leg
 *      from <place>" and "⇄ Plan the return trip" in a fixed footer.
 *  (c) Add the Nth leg: saved routes and other trips' legs that START at the
 *      place, those that END there (sailed the other way), and the nearest of
 *      the rest with how far off they start. "✎ Plot it by hand" is the old
 *      empty locked leg.
 *
 * A pick only sends ids (services/deepLink 'add-leg') under the scope these
 * rows were built in. The chart opens a COPY locked to the previous arrival
 * and the tracer's own Save checks it and writes it (services/tripLegAdd.ts):
 * the route picked is never changed.
 *
 * Loaded lazily, from the Plan page's Trip · Legs tile and from the chart's
 * "Plot the next leg →" row, so neither carries it until it is opened.
 */
import React from 'react';
import { createPortal } from 'react-dom';
import { usePanePortalTarget } from '../../context/PanePortalContext';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import {
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../../services/authIdentityScope';
import { requestTracerOpen, type TracerOpenAction } from '../../services/deepLink';
import {
    legBadgeOrdinal,
    loadSavedTraces,
    nextLegSeed,
    ordinalLegLabel,
    stripLegBadge,
    type SavedTrace,
    type TripGroup,
} from '../../services/routeTracer';
import { routeNameParts, stripRouteBadges } from '../../services/routeNameParts';
import { REVERSE_JOIN_NM, findTripGroup, legInSlot, tripName } from '../../services/tripReverse';
import {
    addLegSections,
    libraryRoomNote,
    routeLengthNm,
    tripJoints,
    tripMatches,
    tripsByNewest,
    type AddLegRow,
} from '../../services/tripLegAdd';
import { savedTraceFollowStatusOf } from '../../services/traceDirectUseGate';
import { traceCheckDayLabel, type TraceFollowStatus } from '../../services/traceVerification';
import { triggerHaptic } from '../../utils/system';
import { ErrorBoundary } from '../ErrorBoundary';

/** Cyclone season along the trip (W1-12): the card and its IBTrACS JSON load only when a trip's legs open. */
const SeasonRiskCard = React.lazy(() => import('./SeasonRiskCard'));
/** The card is optional: if its chunk 404s after a web deploy, show nothing rather than
 *  crash the sheet. (ErrorBoundary treats a null fallback as "show the crash card".) */
const RENDER_NOTHING = <></>;

export type TripSheetStart = { pane: 'trips' } | { pane: 'trip'; tripKey: string } | { pane: 'add'; afterId: string };

type Pane = { kind: 'trips' } | { kind: 'trip'; tripKey: string } | { kind: 'add'; afterId: string };

export interface TripSheetProps {
    /** The account the sheet was opened under; its rows are that account's. */
    scope: AuthIdentityScope;
    start?: TripSheetStart;
    onClose: () => void;
    /** After a pick has been sent: the Plan page goes to the chart. */
    onOpenChart: () => void;
}

const nmText = (nm: number): string => (nm < 10 ? nm.toFixed(1) : String(Math.round(nm)));
const legsText = (n: number): string => `${n} leg${n === 1 ? '' : 's'}`;
const ordinalOf = (leg: SavedTrace, position: number): number =>
    leg.legOrdinal ?? legBadgeOrdinal(leg.name) ?? position;

/** "Return from Sandy Cove: legs 2 to 1 reversed" — what the ⇄ chip on card K
 *  starts. The destination comes from the leg itself (stored, or the last
 *  place in its name); a title with no places says which leg instead. */
function returnChipLabel(leg: Pick<SavedTrace, 'destName' | 'name'>, position: number): string {
    const from =
        leg.destName ?? routeNameParts(stripRouteBadges(leg.name))?.places.at(-1) ?? `the end of leg ${position}`;
    return `Return from ${from}: ${position > 1 ? `legs ${position} to 1 reversed` : 'leg 1 reversed'}`;
}

const TONE_RANK: Record<TraceFollowStatus['tone'], number> = { checked: 0, unchecked: 1, finding: 2 };
const CHECK_CHIP: Record<TraceFollowStatus['tone'], { text: string; words: string; className: string }> = {
    checked: { text: '✓ checked', words: 'checked', className: 'text-emerald-300' },
    unchecked: { text: 'check again', words: 'check again', className: 'text-amber-300' },
    finding: { text: '! danger', words: 'check found danger', className: 'text-red-300' },
};
const DOT: Record<TraceFollowStatus['tone'], { className: string; words: string }> = {
    checked: { className: 'bg-emerald-400', words: 'every leg checked' },
    unchecked: { className: 'bg-amber-400', words: 'a leg needs a check' },
    finding: { className: 'bg-red-400', words: 'a check found danger' },
};

const ROW_CLASS =
    'flex min-h-[44px] w-full items-center gap-2 rounded-xl border border-white/10 bg-slate-900/50 px-3 py-2 text-left active:scale-[0.99]';
const SEARCH_CLASS =
    'mt-2 block min-h-[44px] w-full rounded-xl border border-white/15 bg-slate-950 px-3 text-base text-gray-100 placeholder:text-gray-500 focus:border-amber-400/60 focus:outline-none';

const TripSheet: React.FC<TripSheetProps> = ({ scope, start, onClose, onOpenChart }) => {
    const portalTarget = usePanePortalTarget();
    const titleId = React.useId();
    const [traces, setTraces] = React.useState<SavedTrace[]>(() =>
        isAuthIdentityScopeCurrent(scope) ? loadSavedTraces(scope) : [],
    );
    const [pane, setPane] = React.useState<Pane>(() =>
        start?.pane === 'trip'
            ? { kind: 'trip', tripKey: start.tripKey }
            : start?.pane === 'add'
              ? { kind: 'add', afterId: start.afterId }
              : { kind: 'trips' },
    );
    const paneRef = React.useRef(pane);
    paneRef.current = pane;
    const [tripQuery, setTripQuery] = React.useState('');
    const [addQuery, setAddQuery] = React.useState('');
    const [showFurther, setShowFurther] = React.useState(false);
    const [notice, setNotice] = React.useState<string | null>(null);
    // An account change ends the sheet at the synchronous fence: its rows are
    // the previous skipper's, and a tap must never send them under the next.
    const [alive, setAlive] = React.useState(() => isAuthIdentityScopeCurrent(scope));
    const onCloseRef = React.useRef(onClose);
    onCloseRef.current = onClose;
    React.useEffect(
        () =>
            subscribeAuthIdentityScope(() => {
                setAlive(false);
                setTraces([]);
                onCloseRef.current();
            }),
        [],
    );

    const go = React.useCallback((next: Pane) => {
        setNotice(null);
        setShowFurther(false);
        setAddQuery('');
        setPane(next);
    }, []);
    const tripOfLeg = React.useCallback((legId: string) => findTripGroup(traces, legId), [traces]);
    const back = React.useCallback(() => {
        const current = paneRef.current;
        if (current.kind === 'add') {
            const group = tripOfLeg(current.afterId);
            go(group ? { kind: 'trip', tripKey: group.key } : { kind: 'trips' });
        } else {
            go({ kind: 'trips' });
        }
    }, [go, tripOfLeg]);
    const onEscape = React.useCallback(() => {
        if (paneRef.current.kind === 'trips') onCloseRef.current();
        else back();
    }, [back]);

    const closeRef = React.useRef<HTMLButtonElement>(null);
    const backRef = React.useRef<HTMLButtonElement>(null);
    const live = alive && isAuthIdentityScopeCurrent(scope);
    // The trap also takes the pane's modal lock (useFocusTrap → usePaneModalLock
    // on the portalled card): in split view the page behind goes inert, as
    // under the old legs modal. Pinned by TripSheet.test.tsx "split view".
    const dialogRef = useFocusTrap<HTMLDivElement>(live, { initialFocusRef: closeRef, onEscape });
    // Focus follows the pane: the control a tap left behind is gone with its
    // pane, and the trap's Escape only answers while focus is inside.
    const paneKey =
        pane.kind === 'trips' ? 'trips' : pane.kind === 'trip' ? `trip:${pane.tripKey}` : `add:${pane.afterId}`;
    const firstPane = React.useRef(true);
    React.useEffect(() => {
        if (firstPane.current) {
            firstPane.current = false;
            return;
        }
        (backRef.current ?? closeRef.current)?.focus({ preventScroll: true });
    }, [paneKey]);

    // A save, a delete or a cloud merge lands while the sheet is open: refresh
    // in place. If the trip on screen went with it, say so and start again.
    React.useEffect(() => {
        const onChanged = (event: Event): void => {
            const detail = (event as CustomEvent<{ scopeKey?: string; scopeGeneration?: number }>).detail;
            if (
                detail?.scopeKey &&
                (detail.scopeKey !== scope.key ||
                    (detail.scopeGeneration !== undefined && detail.scopeGeneration !== scope.generation))
            ) {
                return;
            }
            if (!isAuthIdentityScopeCurrent(scope)) return;
            const next = loadSavedTraces(scope);
            setTraces(next);
            const current = paneRef.current;
            const after = current.kind === 'add' ? next.find((t) => t.id === current.afterId) : null;
            const afterSeed = after ? nextLegSeed(after) : null;
            const vanished =
                current.kind === 'trip'
                    ? !findTripGroup(next, current.tripKey)
                    : current.kind === 'add'
                      ? !afterSeed || !!legInSlot(next, afterSeed)
                      : false;
            if (vanished) {
                setPane({ kind: 'trips' });
                setShowFurther(false);
                setNotice('That trip changed — pick it again');
            }
        };
        window.addEventListener('thalassa:saved-routes-changed', onChanged);
        return () => window.removeEventListener('thalassa:saved-routes-changed', onChanged);
    }, [scope]);

    const statusById = React.useMemo(() => {
        const nowMs = Date.now();
        const out = new Map<string, TraceFollowStatus['tone']>();
        for (const trace of traces) out.set(trace.id, savedTraceFollowStatusOf(trace, nowMs).tone);
        return out;
    }, [traces]);
    const toneOf = (id: string): TraceFollowStatus['tone'] => statusById.get(id) ?? 'unchecked';

    /** Send one request under the opening scope, then hand over to the chart. */
    const send = (action: TracerOpenAction, haptic: 'light' | 'medium' = 'light'): void => {
        if (!isAuthIdentityScopeCurrent(scope)) return;
        triggerHaptic(haptic);
        requestTracerOpen(action, scope);
        onOpenChart();
        onCloseRef.current();
    };

    const trips = React.useMemo(() => tripsByNewest(traces), [traces]);
    const group: TripGroup | null =
        pane.kind === 'trip'
            ? (trips.find((t) => t.key === pane.tripKey) ?? findTripGroup(traces, pane.tripKey))
            : null;
    const seasonLegs = React.useMemo(() => (group ? group.legs.map((leg) => ({ points: leg.points })) : []), [group]);
    const after = pane.kind === 'add' ? (traces.find((t) => t.id === pane.afterId) ?? null) : null;
    const afterSeed = after ? nextLegSeed(after) : null;
    const sections = React.useMemo(
        () => (after ? addLegSections(traces, after, addQuery) : null),
        [after, traces, addQuery],
    );

    if (!live || !portalTarget) return null;

    // ── Header: title, sub, Back and Close; the pane's search stays put. ──
    let title = 'Your trips';
    let sub: string | null = null;
    if (group) {
        title = tripName(group);
        sub = `${legsText(group.legs.length)} · ${nmText(group.legs.reduce((nm, leg) => nm + routeLengthNm(leg.points), 0))} NM`;
    } else if (pane.kind === 'add' && afterSeed) {
        title = `${ordinalLegLabel(afterSeed.ordinal).toLowerCase()} from ${afterSeed.fromName}`;
        sub = 'A copy goes in and is checked for this trip. The route you pick is unchanged.';
    }

    const visibleTrips = trips.filter((t) => tripMatches(t, tripQuery));

    const tripsPane = (
        <>
            {notice && (
                <p role="status" className="mb-2 text-[12px] font-bold text-amber-300">
                    {notice}
                </p>
            )}
            <ul aria-label="Trips" className="space-y-1">
                {visibleTrips.map((t) => {
                    const worst = t.legs
                        .map((leg) => toneOf(leg.id))
                        .reduce(
                            (a, b) => (TONE_RANK[b] > TONE_RANK[a] ? b : a),
                            'checked' as TraceFollowStatus['tone'],
                        );
                    const newest = t.legs.reduce((latest, leg) => {
                        const at = leg.updatedAt ?? leg.createdAt;
                        return Date.parse(at) > Date.parse(latest) ? at : latest;
                    }, t.legs[0].updatedAt ?? t.legs[0].createdAt);
                    const nm = t.legs.reduce((sum, leg) => sum + routeLengthNm(leg.points), 0);
                    return (
                        <li key={t.key}>
                            <button
                                type="button"
                                onClick={() => {
                                    triggerHaptic('light');
                                    go({ kind: 'trip', tripKey: t.key });
                                }}
                                className={ROW_CLASS}
                            >
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate text-[13px] font-bold text-gray-100">
                                        {tripName(t)}
                                    </span>
                                    <span className="block truncate text-[11px] font-bold text-gray-400">
                                        {` ${legsText(t.legs.length)} · ${nmText(nm)} NM · updated ${traceCheckDayLabel(newest)}`}
                                    </span>
                                </span>
                                <span
                                    aria-hidden="true"
                                    className={`h-2.5 w-2.5 shrink-0 rounded-full ${DOT[worst].className}`}
                                />
                                <span className="sr-only">{`, ${DOT[worst].words}`}</span>
                            </button>
                        </li>
                    );
                })}
            </ul>
            {visibleTrips.length === 0 && (
                <p className="px-1 py-3 text-[12px] font-bold text-gray-400">No trip or route matches that.</p>
            )}
        </>
    );

    const joints = group ? tripJoints(group) : [];
    const tripPane = group && (
        <>
            {notice && (
                <p role="status" className="mb-2 text-[12px] font-bold text-amber-300">
                    {notice}
                </p>
            )}
            <ul aria-label="Legs">
                {group.legs.map((leg, index) => {
                    const ordinal = ordinalOf(leg, index + 1);
                    const legTitle = stripLegBadge(leg.name) || leg.name;
                    const chip = CHECK_CHIP[toneOf(leg.id)];
                    const inLog = !!leg.plannedRouteId;
                    const nm = nmText(routeLengthNm(leg.points));
                    const joint = index + 1 < group.legs.length ? joints[index] : null;
                    return (
                        <li key={leg.id}>
                            {/* Two siblings, not a chip inside the card: a button may not hold another. */}
                            <div className="flex items-stretch gap-1.5">
                                <button
                                    type="button"
                                    aria-label={`Leg ${ordinal}: ${legTitle}, ${nm} NM, ${chip.words}, ${inLog ? 'in the Log' : 'Not in the log yet'}`}
                                    onClick={() => send({ kind: 'load-saved', id: leg.id })}
                                    className="flex min-h-[56px] min-w-0 flex-1 items-center gap-2 rounded-xl border border-white/10 bg-slate-900/50 px-3 py-1.5 text-left active:scale-[0.99]"
                                >
                                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/10 text-[11px] font-black text-gray-200">
                                        {ordinal}
                                    </span>
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-[13px] font-bold text-gray-100">
                                            {legTitle}
                                        </span>
                                        {/* Wraps rather than truncates: on a narrow phone
                                            "Not in the log yet" takes its own line, whole. */}
                                        <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[11px] font-bold leading-tight">
                                            <span className="whitespace-nowrap text-gray-400">{nm} NM</span>
                                            <span className={`whitespace-nowrap ${chip.className}`}>{chip.text}</span>
                                            <span
                                                className={`whitespace-nowrap ${inLog ? 'text-gray-400' : 'text-amber-300'}`}
                                            >
                                                {inLog ? 'in the Log' : 'Not in the log yet'}
                                            </span>
                                        </span>
                                    </span>
                                </button>
                                {/* ⇄ from here: a new trip home whose first leg is
                                    this one reversed (legs K..1). */}
                                <button
                                    type="button"
                                    onClick={() =>
                                        send(
                                            { kind: 'return-trip', tripId: group.key, fromOrdinal: index + 1 },
                                            'medium',
                                        )
                                    }
                                    aria-label={returnChipLabel(leg, index + 1)}
                                    title={returnChipLabel(leg, index + 1)}
                                    className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-xl border border-sky-400/25 bg-sky-500/10 text-[15px] font-black text-sky-300 active:scale-95"
                                >
                                    ⇄
                                </button>
                            </div>
                            {/* 12 px, and it never reaches into a card: a glyph from
                                a fallback font (⛓) is taller than its line. */}
                            {joint !== null && (
                                <p
                                    className={`pointer-events-none flex h-3 items-center overflow-hidden whitespace-nowrap pl-4 text-[10px] font-bold leading-3 ${
                                        joint <= REVERSE_JOIN_NM ? 'text-gray-500' : 'text-amber-300'
                                    }`}
                                >
                                    {joint <= REVERSE_JOIN_NM
                                        ? '⛓ joined'
                                        : `starts ${nmText(joint)} NM from leg ${ordinal}'s end`}
                                </p>
                            )}
                        </li>
                    );
                })}
            </ul>
            {/* After the legs, inside the scroll, never in front of them. */}
            <div className="pt-2">
                <ErrorBoundary boundaryName="SeasonRiskCard" fallback={RENDER_NOTHING}>
                    <React.Suspense fallback={null}>
                        <SeasonRiskCard routeLegs={seasonLegs} />
                    </React.Suspense>
                </ErrorBoundary>
            </div>
        </>
    );

    const lastLeg = group ? group.legs[group.legs.length - 1] : null;
    const nextSeed = lastLeg ? nextLegSeed(lastLeg) : null;
    const tripFooter = group && (
        <>
            {nextSeed && lastLeg && (
                <button
                    type="button"
                    onClick={() => {
                        triggerHaptic('medium');
                        go({ kind: 'add', afterId: lastLeg.id });
                    }}
                    className="flex min-h-[44px] w-full items-center rounded-xl border border-amber-500/40 bg-amber-500/15 px-3 py-2 text-left shadow-[0_0_14px_rgba(245,158,11,0.25)] active:scale-[0.99]"
                >
                    <span className="min-w-0 flex-1 truncate text-[13px] font-black text-amber-300">
                        {`+ Add the ${ordinalLegLabel(nextSeed.ordinal).toLowerCase()} from ${nextSeed.fromName}`}
                    </span>
                </button>
            )}
            {group.legs.length >= 2 && (
                <button
                    type="button"
                    onClick={() => send({ kind: 'return-trip', tripId: group.key }, 'medium')}
                    className="flex min-h-[44px] w-full items-center rounded-xl border border-sky-400/30 bg-sky-500/10 px-3 py-2 text-left active:scale-[0.99]"
                >
                    <span className="min-w-0 flex-1 truncate text-[13px] font-black text-sky-200">
                        {`⇄ Plan the return trip · legs ${group.legs.length} to 1`}
                    </span>
                </button>
            )}
        </>
    );

    const place = afterSeed?.fromName ?? '';
    const rowText = (row: AddLegRow): string => {
        const where = row.join
            ? row.join.kind === 'snap'
                ? 'at the pin'
                : `${nmText(row.gapNm)} NM joining run`
            : `${row.direction === 'forward' ? 'starts' : 'ends'} ${nmText(row.gapNm)} NM from ${place}`;
        return `${row.sourceText} · ${nmText(row.lengthNm)} NM · ${where}`;
    };
    const addRow = (row: AddLegRow) => (
        <li key={`${row.trace.id}:${row.direction}`}>
            <button
                type="button"
                disabled={!row.join}
                onClick={() =>
                    after &&
                    send(
                        { kind: 'add-leg', afterId: after.id, sourceId: row.trace.id, direction: row.direction },
                        'medium',
                    )
                }
                className={`${ROW_CLASS} disabled:active:scale-100`}
            >
                <span className="min-w-0 flex-1">
                    <span
                        className={`block truncate text-[13px] font-bold ${row.join ? 'text-gray-100' : 'text-gray-400'}`}
                    >
                        {stripLegBadge(row.trace.name) || row.trace.name}
                    </span>
                    {/* Wraps: the join ("0.6 NM joining run") is at its end. */}
                    <span
                        className={`block text-[11px] font-bold leading-snug ${row.join ? 'text-gray-400' : 'text-gray-500'}`}
                    >
                        {` ${rowText(row)}`}
                    </span>
                </span>
            </button>
        </li>
    );
    const section = (id: string, heading: string, rows: AddLegRow[]) =>
        rows.length > 0 && (
            <section className="pt-3">
                <h3 id={id} className="px-1 pb-1 text-[10px] font-black uppercase tracking-widest text-amber-300/90">
                    {heading}
                </h3>
                <ul aria-labelledby={id} className="space-y-1">
                    {rows.map(addRow)}
                </ul>
            </section>
        );
    const libraryNote = libraryRoomNote(traces.length);
    const addPane = after && afterSeed && sections && (
        <>
            {libraryNote && <p className="mb-2 px-1 text-[11px] font-bold text-amber-300">{libraryNote}</p>}
            <button
                type="button"
                onClick={() => send({ kind: 'new-leg', fromId: after.id }, 'medium')}
                className={ROW_CLASS}
            >
                <span className="min-w-0 flex-1 truncate text-[13px] font-black text-amber-300">✎ Plot it by hand</span>
            </button>
            {section(`${titleId}-starts`, `Starts at ${place}`, sections.startsHere)}
            {section(`${titleId}-ends`, `Ends at ${place} — sail it the other way`, sections.endsHere)}
            {sections.furtherAway.length > 0 && (
                <section className="pt-3">
                    <h3
                        id={`${titleId}-further`}
                        className="px-1 pb-1 text-[10px] font-black uppercase tracking-widest text-gray-400"
                    >
                        Further away
                    </h3>
                    {showFurther ? (
                        <ul aria-labelledby={`${titleId}-further`} className="space-y-1">
                            {sections.furtherAway.map(addRow)}
                        </ul>
                    ) : (
                        <button
                            type="button"
                            onClick={() => setShowFurther(true)}
                            className="min-h-[44px] w-full rounded-xl px-3 text-left text-[12px] font-bold text-sky-300 active:bg-white/5"
                        >
                            {`Show ${sections.furtherAway.length} more`}
                        </button>
                    )}
                </section>
            )}
            {sections.startsHere.length + sections.endsHere.length === 0 && (
                <p className="px-1 pt-3 text-[12px] font-bold text-gray-400">
                    {addQuery.trim()
                        ? 'Nothing that matches starts or ends here.'
                        : `No saved route starts or ends within 2 NM of ${place}. Plot it by hand.`}
                </p>
            )}
        </>
    );

    const body = pane.kind === 'trips' ? tripsPane : pane.kind === 'trip' ? tripPane : addPane;
    // A pane whose rows are gone (a stale start) shows the trips instead.
    const content = body || tripsPane;
    const footer = pane.kind === 'trip' ? tripFooter : null;
    const showingTrips = !body || pane.kind === 'trips';

    return createPortal(
        // Portalled: the PLAN page rides inside PageTransition, whose
        // translate3d makes it the containing block for `fixed` children.
        // Centred and clear of the tab bar (Plan Your Day's band); the card
        // lifts itself over the keyboard (.thalassa-keyboard-safe-sheet).
        <div
            role="presentation"
            onClick={(event) => {
                if (event.target === event.currentTarget) onCloseRef.current();
            }}
            className="fixed inset-0 z-10060 flex items-center justify-center bg-black/60 px-3 pt-[max(1rem,env(safe-area-inset-top))] pb-[calc(4rem+env(safe-area-inset-bottom)+1rem)] [html[data-keyboard-open='true']_&]:pb-4"
        >
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal={portalTarget.tagName === 'BODY' ? true : undefined}
                aria-labelledby={titleId}
                data-trip-sheet={showingTrips ? 'trips' : pane.kind}
                style={{ '--sheet-max-vh': '100%' } as React.CSSProperties}
                className="thalassa-keyboard-safe-sheet flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-3xl border border-amber-500/30 bg-slate-900 shadow-2xl"
            >
                <header className="shrink-0 border-b border-white/10 px-3 pb-2 pt-1.5">
                    <div className="flex items-center gap-1">
                        {!showingTrips && (
                            <button
                                ref={backRef}
                                type="button"
                                onClick={back}
                                aria-label="Back"
                                className="-ml-1 flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-xl text-lg font-black text-gray-300 active:bg-white/10"
                            >
                                <span aria-hidden="true">‹</span>
                            </button>
                        )}
                        <div className="min-w-0 flex-1 pl-1">
                            <h2
                                id={titleId}
                                className="line-clamp-2 break-words text-[15px] font-black leading-tight text-amber-300"
                            >
                                {showingTrips ? 'Your trips' : title}
                            </h2>
                            {!showingTrips && sub && (
                                <p className="mt-0.5 text-[11px] font-bold leading-snug text-gray-400">{sub}</p>
                            )}
                        </div>
                        <button
                            ref={closeRef}
                            type="button"
                            onClick={() => onCloseRef.current()}
                            className="-mr-1 min-h-[44px] shrink-0 px-3 text-sm font-bold text-gray-400"
                        >
                            Close
                        </button>
                    </div>
                    {showingTrips && (
                        <input
                            type="search"
                            value={tripQuery}
                            onChange={(event) => setTripQuery(event.target.value)}
                            aria-label="Search your trips"
                            placeholder="Search your trips"
                            enterKeyHint="search"
                            autoComplete="off"
                            className={SEARCH_CLASS}
                        />
                    )}
                    {!showingTrips && pane.kind === 'add' && (
                        <input
                            type="search"
                            value={addQuery}
                            onChange={(event) => setAddQuery(event.target.value)}
                            aria-label="Search routes and legs"
                            placeholder="Search routes and legs"
                            enterKeyHint="search"
                            autoComplete="off"
                            className={SEARCH_CLASS}
                        />
                    )}
                </header>
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-2">{content}</div>
                {footer && !showingTrips && (
                    <footer className="shrink-0 space-y-1.5 border-t border-white/10 px-3 pb-3 pt-2">{footer}</footer>
                )}
            </div>
        </div>,
        portalTarget,
    );
};

export default TripSheet;
