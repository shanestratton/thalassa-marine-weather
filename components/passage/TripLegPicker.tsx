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
 */
import React from 'react';
import { createPortal } from 'react-dom';
import {
    loadSavedTraces,
    groupTracesByTrip,
    nextLegSeed,
    ordinalLegLabel,
    type TripGroup,
} from '../../services/routeTracer';
import { requestTracerOpen } from '../../services/deepLink';
import { triggerHaptic } from '../../utils/system';
import { useFocusTrap } from '../../hooks/useFocusTrap';

// Grouping is the SHARED helper (groupTracesByTrip) so this Trip box and the
// tracer card's "open a saved route" list can never drift (2026-07-17).
const buildTrips = (): TripGroup[] => groupTracesByTrip(loadSavedTraces());

export const TripLegPicker: React.FC<{ onOpenChart: () => void }> = ({ onOpenChart }) => {
    const [trips, setTrips] = React.useState<TripGroup[]>(() => buildTrips());
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
    const closeLegs = (): void => {
        setLegsOpen(false);
        setSelectedKey('');
    };
    const closeButtonRef = React.useRef<HTMLButtonElement>(null);
    const dialogRef = useFocusTrap<HTMLDivElement>(legsOpen, {
        initialFocusRef: closeButtonRef,
        onEscape: closeLegs,
    });
    // Saved routes land from the cloud merge after mount — refresh once the
    // punter actually opens the dropdown so the list is never stale.
    const refresh = (): void => setTrips(buildTrips());

    const selected = trips.find((t) => t.key === selectedKey) ?? null;
    const lastLeg = selected ? selected.legs[selected.legs.length - 1] : null;
    const seed = lastLeg ? nextLegSeed(lastLeg) : null;

    if (trips.length === 0) return null; // nothing saved yet — no empty furniture

    return (
        <div className="rounded-2xl border border-amber-500/20 bg-gradient-to-br from-amber-500/10 to-slate-900/40 p-3 shadow-[0_0_20px_rgba(245,158,11,0.08)]">
            <div className="mb-2 flex items-baseline justify-between">
                <span className="text-[11px] font-black uppercase tracking-widest text-amber-300">🧩 Trip · Legs</span>
                {/* Was "N legs" for the SELECTED trip, which is now dead furniture:
                    a selection exists only while the modal is open, so the badge
                    could only ever render behind it. The count of what is saved is
                    true whenever the card is on screen. */}
                <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-amber-300">
                    {trips.length} saved
                </span>
            </div>
            <select
                value={selectedKey}
                onFocus={refresh}
                onChange={(e) => {
                    triggerHaptic('light');
                    setSelectedKey(e.target.value);
                    setLegsOpen(e.target.value !== '');
                }}
                aria-label="Pick a trip or route to continue"
                className="h-11 w-full rounded-xl border border-white/10 bg-slate-900/60 px-3 text-[13px] font-medium text-white [color-scheme:dark] focus:border-amber-500/50 focus:outline-none"
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
                createPortal(
                    // Portalled to <body>: the PLAN page rides inside
                    // PageTransition, whose translate3d makes it the containing
                    // block for `fixed` children — so an un-portalled overlay
                    // would cover the page box, not the screen, and centring
                    // would land wherever that box happens to be.
                    <div
                        className="fixed inset-0 z-[10060] flex items-center justify-center bg-black/60 px-3 py-[max(1rem,env(safe-area-inset-bottom))]"
                        onClick={closeLegs}
                        role="presentation"
                    >
                        <div
                            ref={dialogRef}
                            role="dialog"
                            aria-modal="true"
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
                                        open it on the chart
                                    </span>
                                </span>
                                <button
                                    ref={closeButtonRef}
                                    onClick={closeLegs}
                                    className="shrink-0 text-sm font-bold text-gray-400"
                                >
                                    Close
                                </button>
                            </div>
                            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-3">
                                {selected.legs.map((leg, i) => (
                                    <button
                                        key={leg.id}
                                        onClick={() => {
                                            triggerHaptic('light');
                                            requestTracerOpen({ kind: 'load-saved', id: leg.id });
                                            onOpenChart();
                                        }}
                                        className="flex w-full items-center gap-2 rounded-xl border border-white/10 bg-slate-900/50 px-3 py-2 text-left active:scale-[0.99]"
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
                                ))}
                                {seed && (
                                    <button
                                        onClick={() => {
                                            triggerHaptic('medium');
                                            requestTracerOpen({ kind: 'new-leg', fromId: lastLeg!.id });
                                            onOpenChart();
                                        }}
                                        className="flex w-full items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/15 px-3 py-2.5 text-left shadow-[0_0_14px_rgba(245,158,11,0.25)] active:scale-[0.99]"
                                    >
                                        <span className="text-base leading-none">⚓</span>
                                        <span className="min-w-0 flex-1 truncate text-[13px] font-black text-amber-300">
                                            Plot the {ordinalLegLabel(seed.ordinal).toLowerCase()} from {seed.fromName}
                                        </span>
                                        <span className="shrink-0 text-[11px] font-black text-amber-400">🔒→</span>
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>,
                    document.body,
                )}
        </div>
    );
};
