/**
 * TripLegPicker — the PLAN page's Trip box (Shane 2026-07-17: "we need to
 * get our LEGS functioning").
 *
 * Pick a trip (or any saved route — every route is a potential leg 1) and
 * the chain unrolls below it: each saved leg opens on the chart with one
 * tap, and the glowing last row — "⚓ Plot next leg from Woorim" — opens the
 * tracer with pin 1 pre-dropped and LOCKED at the previous leg's exact
 * final coordinates. Saving that plot names it "woorim - timbuktu (2nd
 * Leg)", stamps the chain, and retro-badges leg 1.
 *
 * Grouping is STRUCTURAL (SavedTrace.tripId — legs of one trip share leg
 * 1's id), with the "(Nth Leg)" name badge as the display fallback for
 * routes whose fields were shed by the cloud round-trip (the saved_routes
 * table doesn't carry the chain columns yet).
 *
 * The way home (Shane 2026-10-07: "i can reverse the first leg. but i cannot
 * reverse the 2nd leg and so on"): "⇄ Plan the return trip" and the ⇄ chip on
 * each leg open a NEW trip whose first leg is that leg reversed, built one
 * checked leg at a time in the tracer (components/map/useReturnTripFlow.ts).
 * The outbound trip is never edited.
 */
import React from 'react';
import { createPortal } from 'react-dom';
import { usePaneModalLock, usePanePortalTarget } from '../../context/PanePortalContext';
import {
    loadSavedTraces,
    groupTracesByTrip,
    nextLegSeed,
    ordinalLegLabel,
    type SavedTrace,
    type TripGroup,
} from '../../services/routeTracer';
import { routeNameParts, stripRouteBadges } from '../../services/routeNameParts';
import { requestTracerOpen } from '../../services/deepLink';
import { triggerHaptic } from '../../utils/system';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { FlagIcon } from '../Icons';
import { PLAN_TILE_CLASS, PLAN_TILE_STYLE, PlanTileFace } from './PlanTile';
import {
    getAuthIdentityScope,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../../services/authIdentityScope';
import { ErrorBoundary } from '../ErrorBoundary';

/** Cyclone season along the trip (W1-12): the card and its IBTrACS JSON load only when a trip's legs open. */
const SeasonRiskCard = React.lazy(() => import('./SeasonRiskCard'));
/** The card is optional: if its chunk 404s after a web deploy, show nothing rather than
 *  crash the Plan page. (ErrorBoundary treats a null fallback as "show the crash card".) */
const RENDER_NOTHING = <></>;

// Grouping is the SHARED helper (groupTracesByTrip) so this Trip box and the
// tracer card's "open a saved route" list can never drift (2026-07-17).
const buildTrips = (scope: AuthIdentityScope): TripGroup[] => groupTracesByTrip(loadSavedTraces(scope));

/** "Return from Sandy Cove: legs 2 to 1 reversed" — what the ⇄ chip on row K
 *  starts. The destination comes from the leg itself (stored, or the last
 *  place in its name); a title with no places says which leg instead. */
function returnChipLabel(leg: Pick<SavedTrace, 'destName' | 'name'>, position: number): string {
    const from =
        leg.destName ?? routeNameParts(stripRouteBadges(leg.name))?.places.at(-1) ?? `the end of leg ${position}`;
    return `Return from ${from}: ${position > 1 ? `legs ${position} to 1 reversed` : 'leg 1 reversed'}`;
}

export const TripLegPicker: React.FC<{ onOpenChart: () => void }> = ({ onOpenChart }) => {
    const portalTarget = usePanePortalTarget();
    const [tripSnapshot, setTripSnapshot] = React.useState(() => {
        const scope = getAuthIdentityScope();
        return { scope, trips: buildTrips(scope) };
    });
    const { trips } = tripSnapshot;
    const [selectedKey, setSelectedKey] = React.useState('');
    // The legs open in a MODAL, not inline (Shane 2026-07-19: "it pushes
    // everything down the page and makes stuff go under the cta button"). A
    // trip with several legs plus the next-leg CTA is easily taller than the
    // space under the select, so unrolling it in place shoved the "Slide to
    // Start Plotting" button off the bottom — the one control the page exists
    // to present.
    //
    // CLOSING CLEARS selectedKey as well as the flag: leave it set and the
    // <select> still shows that trip, so choosing it again fires no change
    // event and the modal never reopens. Resetting to '' puts the placeholder
    // back and keeps the control honest about what it does.
    const [legsOpen, setLegsOpen] = React.useState(false);
    usePaneModalLock(legsOpen);
    const closeLegs = (): void => {
        setLegsOpen(false);
        setSelectedKey('');
    };
    const closeButtonRef = React.useRef<HTMLButtonElement>(null);
    const dialogRef = useFocusTrap<HTMLDivElement>(legsOpen, {
        initialFocusRef: closeButtonRef,
        onEscape: closeLegs,
    });
    React.useEffect(
        () =>
            subscribeAuthIdentityScope((next) => {
                // The route ids and names in this snapshot are private. Replace
                // them at the synchronous fence; until React commits, click
                // closures retain the old scope and deepLink rejects them.
                setTripSnapshot({ scope: next, trips: buildTrips(next) });
                setLegsOpen(false);
                setSelectedKey('');
            }),
        [],
    );
    // Saved routes land from the cloud merge after mount — refresh once the
    // punter actually opens the dropdown so the list is never stale.
    const refresh = (): void => {
        const scope = getAuthIdentityScope();
        setTripSnapshot({ scope, trips: buildTrips(scope) });
    };

    // A deletion can promote leg 2 to leg 1 while this card remains mounted.
    // Refresh at the shared library boundary instead of making the skipper
    // close/reopen the picker to lose a stale "2nd Leg" row.
    React.useEffect(() => {
        const onSavedRoutesChanged = (event: Event): void => {
            const detail = (event as CustomEvent<{ scopeKey?: string; scopeGeneration?: number }>).detail;
            const scope = getAuthIdentityScope();
            if (
                detail?.scopeKey &&
                (detail.scopeKey !== scope.key ||
                    (detail.scopeGeneration !== undefined && detail.scopeGeneration !== scope.generation))
            ) {
                return;
            }
            setTripSnapshot({ scope, trips: buildTrips(scope) });
            setLegsOpen(false);
            setSelectedKey('');
        };
        window.addEventListener('thalassa:saved-routes-changed', onSavedRoutesChanged);
        return () => window.removeEventListener('thalassa:saved-routes-changed', onSavedRoutesChanged);
    }, []);

    const countId = React.useId();
    const selected = trips.find((t) => t.key === selectedKey) ?? null;
    const lastLeg = selected ? selected.legs[selected.legs.length - 1] : null;
    // Saved legs carry their own line (and no dates): the card shows the whole-year strip.
    const seasonLegs = React.useMemo(
        () => (selected ? selected.legs.map((leg) => ({ points: leg.points })) : []),
        [selected],
    );
    const seed = lastLeg ? nextLegSeed(lastLeg) : null;
    // The scope these rows were built under travels with the request, so a
    // tap that lands after a sign-out/sign-in is refused, not relabelled.
    const openReturnTrip = (trip: TripGroup, fromOrdinal?: number): void => {
        triggerHaptic('medium');
        requestTracerOpen(
            { kind: 'return-trip', tripId: trip.key, ...(fromOrdinal ? { fromOrdinal } : {}) },
            tripSnapshot.scope,
        );
        onOpenChart();
    };

    if (trips.length === 0) return null; // nothing saved yet — no empty furniture

    return (
        // The first of the Plan page's ways in (Shane 2026-10-05: "make it
        // pop. cleaner"): a tile like its three neighbours, with the native
        // <select> laid invisibly over the whole of it, so a tap anywhere on
        // the tile opens the wheel (iOS) or the list (desktop). The face is
        // hidden from VoiceOver; the select carries the name and, as its
        // description, the count of what is saved.
        <div className={`${PLAN_TILE_CLASS} plan-tile-trip`} style={PLAN_TILE_STYLE}>
            <PlanTileFace
                icon={<FlagIcon />}
                title="Trip · Legs"
                // Was a "N SAVED" chip beside an amber 🧩 eyebrow. The count of
                // what is saved is true whenever the tile is on screen (a
                // selection exists only while the legs modal is open).
                sub={`${trips.length} saved · pick one to continue`}
                short={`${trips.length} saved`}
                subId={countId}
                go="pick"
                hidden
            />
            {/* Its name starts with the tile's visible title (WCAG 2.5.3,
                Label in Name), so Voice Control's "Tap Trip Legs" finds it. */}
            <select
                value={selectedKey}
                onFocus={refresh}
                onChange={(e) => {
                    triggerHaptic('light');
                    setSelectedKey(e.target.value);
                    setLegsOpen(e.target.value !== '');
                }}
                aria-label="Trip · Legs: pick a trip or route to continue"
                aria-describedby={countId}
                className="plan-tile-select scheme-dark"
            >
                <option value="">New Trip or Route</option>
                {trips.map((t) => (
                    <option key={t.key} value={t.key}>
                        {t.label}
                    </option>
                ))}
            </select>
            {selected &&
                legsOpen &&
                portalTarget &&
                createPortal(
                    // Portalled to <body>: the PLAN page rides inside
                    // PageTransition, whose translate3d makes it the containing
                    // block for `fixed` children — so an un-portalled overlay
                    // would cover the page box, not the screen, and centring
                    // would land wherever that box happens to be.
                    <div
                        className="fixed inset-0 z-10060 flex items-center justify-center bg-black/60 px-3 py-[max(1rem,env(safe-area-inset-bottom))]"
                        onClick={closeLegs}
                        role="presentation"
                    >
                        <div
                            ref={dialogRef}
                            role="dialog"
                            aria-modal={portalTarget?.tagName === 'BODY' ? true : undefined}
                            aria-labelledby="trip-leg-picker-title"
                            className="flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-3xl border border-amber-500/30 bg-slate-900 shadow-2xl"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
                                <span className="min-w-0">
                                    <span
                                        id="trip-leg-picker-title"
                                        className="block truncate text-sm font-black uppercase tracking-widest text-amber-300"
                                    >
                                        🧩 {selected.label}
                                    </span>
                                    <span className="mt-0.5 block text-[11px] font-bold text-gray-400">
                                        {selected.legs.length} leg{selected.legs.length > 1 ? 's' : ''} — tap one to
                                        open it on the chart, ⇄ to plan the way back from it
                                    </span>
                                </span>
                                <button
                                    ref={closeButtonRef}
                                    onClick={closeLegs}
                                    className="shrink-0 min-h-[44px] px-3 -mr-3 text-sm font-bold text-gray-400"
                                >
                                    Close
                                </button>
                            </div>
                            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-3">
                                {selected.legs.map((leg, i) => (
                                    // Two siblings, not a chip inside the row button:
                                    // a button may not contain another one.
                                    <div key={leg.id} className="flex items-stretch gap-1.5">
                                        <button
                                            onClick={() => {
                                                triggerHaptic('light');
                                                requestTracerOpen(
                                                    { kind: 'load-saved', id: leg.id },
                                                    tripSnapshot.scope,
                                                );
                                                onOpenChart();
                                            }}
                                            className="flex min-h-[44px] min-w-0 flex-1 items-center gap-2 rounded-xl border border-white/10 bg-slate-900/50 px-3 py-2 text-left active:scale-[0.99]"
                                        >
                                            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/10 text-[11px] font-black text-gray-300">
                                                {i + 1}
                                            </span>
                                            <span className="min-w-0 flex-1 truncate text-[13px] font-bold text-gray-200">
                                                {leg.name}
                                            </span>
                                            <span className="shrink-0 text-[10px] font-bold text-gray-500">
                                                {leg.points.length} pins
                                            </span>
                                        </button>
                                        {/* ⇄ from here: a new trip home whose first leg is
                                            this one reversed (legs K..1). */}
                                        <button
                                            onClick={() => openReturnTrip(selected, i + 1)}
                                            aria-label={returnChipLabel(leg, i + 1)}
                                            title={returnChipLabel(leg, i + 1)}
                                            className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-xl border border-sky-400/25 bg-sky-500/10 text-[15px] font-black text-sky-300 active:scale-95"
                                        >
                                            ⇄
                                        </button>
                                    </div>
                                ))}
                                {seed && (
                                    <button
                                        onClick={() => {
                                            triggerHaptic('medium');
                                            requestTracerOpen(
                                                { kind: 'new-leg', fromId: lastLeg!.id },
                                                tripSnapshot.scope,
                                            );
                                            onOpenChart();
                                        }}
                                        className="flex min-h-[44px] w-full items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/15 px-3 py-2.5 text-left shadow-[0_0_14px_rgba(245,158,11,0.25)] active:scale-[0.99]"
                                    >
                                        <span className="text-base leading-none">⚓</span>
                                        <span className="min-w-0 flex-1 truncate text-[13px] font-black text-amber-300">
                                            Plot the {ordinalLegLabel(seed.ordinal).toLowerCase()} from {seed.fromName}
                                        </span>
                                        <span className="shrink-0 text-[11px] font-black text-amber-400">🔒→</span>
                                    </button>
                                )}
                                {selected.legs.length >= 2 && (
                                    <button
                                        onClick={() => openReturnTrip(selected)}
                                        className="flex min-h-[44px] w-full items-center gap-2 rounded-xl border border-sky-400/30 bg-sky-500/10 px-3 py-2.5 text-left active:scale-[0.99]"
                                    >
                                        <span aria-hidden="true" className="text-base leading-none text-sky-300">
                                            ⇄
                                        </span>
                                        <span className="min-w-0 flex-1 truncate text-[13px] font-black text-sky-200">
                                            Plan the return trip
                                        </span>
                                        <span className="shrink-0 text-[11px] font-bold text-sky-300/80">
                                            legs {selected.legs.length} to 1
                                        </span>
                                    </button>
                                )}
                                {/* After the legs and their actions, never in front of them. */}
                                <div className="pt-2">
                                    <ErrorBoundary boundaryName="SeasonRiskCard" fallback={RENDER_NOTHING}>
                                        <React.Suspense fallback={null}>
                                            <SeasonRiskCard routeLegs={seasonLegs} />
                                        </React.Suspense>
                                    </ErrorBoundary>
                                </div>
                            </div>
                        </div>
                    </div>,
                    portalTarget,
                )}
        </div>
    );
};
