/**
 * TracerSavedRoutePicker — the "📂 Open a saved route" toggle and the
 * trip-grouped list it reveals.
 *
 * Extracted from MapHub verbatim. This is the LIVE saved-routes path, and on
 * the standalone /plan web page it is the only way to reach a previous track
 * — there is no PLAN front door there. (MapHub still holds a near-identical
 * list behind TRACER_CARD_LIBRARY_VISIBLE, which is false. That dead copy was
 * deliberately NOT moved: extracting one of two near-duplicates while the
 * other stays inline is the fastest way to make them drift apart.)
 *
 * RETURNS A FRAGMENT holding both siblings — the toggle row and the gated
 * list. They share every identifier, so they are one component. A wrapper
 * <div> would become the flex item of the card's scroller in their place and
 * swallow the `shrink-0` on both, which is what the card's fixed-height
 * layout depends on.
 *
 * THE GATE STAYS INSIDE. Not for scroll reasons — the list already unmounts on
 * every collapse, so its scrollTop is discarded either way — but because the
 * toggle's onClick and the gate both read showSavedTraces, and splitting them
 * across the boundary would leave half of one behaviour in each file.
 *
 * The nested `max-h-40` list is a scroller inside the card's scroller. The
 * wheel/touch stopPropagation that stops Mapbox eating the gesture lives on an
 * ANCESTOR back in MapHub — do not duplicate it here, and do not remove it
 * there.
 *
 * STATE STAYS LIFTED. setSavedTraces is written from seven places in MapHub,
 * and showSavedTraces is shared with the dead list. The toggle also refreshes
 * from disk at click time (setSavedTraces(loadSavedTraces())), so the list is
 * not purely derived from its prop — both the value and the setter come from
 * above.
 *
 * loadSavedTraces takes an OPTIONAL scope argument and is called bare here.
 * Never shorten `onClick={() => …loadSavedTraces()}` to a direct reference:
 * the click event would be passed in as the scope.
 *
 * Keys are trip.key and leg.id — two different objects on purpose. Do not
 * unify them to index keys.
 */

import React from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { triggerHaptic } from '../../../utils/system';
import { loadSavedTraces, groupTracesByTrip, type SavedTrace } from '../../../services/routeTracer';

export interface TracerSavedRoutePickerProps {
    savedTraces: SavedTrace[];
    /** Plain setter — the toggle replaces the list wholesale from disk. */
    setSavedTraces: (t: SavedTrace[]) => void;
    showSavedTraces: boolean;
    /** Full dispatch: the toggle flips it functionally, `(v) => !v`. */
    setShowSavedTraces: Dispatch<SetStateAction<boolean>>;
    openSavedTrace: (t: SavedTrace) => void;
}

export const TracerSavedRoutePicker: React.FC<TracerSavedRoutePickerProps> = ({
    savedTraces,
    setSavedTraces,
    showSavedTraces,
    setShowSavedTraces,
    openSavedTrace,
}) => {
    return (
        <>
            {/* Open a saved route — the only path to previous
                tracks on the standalone /plan web page (no PLAN
                front door there). The "Key" toggle was removed
                (Shane 2026-07-17: "makes the card go haywire and
                gives no meaningful info"); the empty-state help
                still carries the colour key. */}
            <div className="flex shrink-0 border-b border-white/10 px-3 py-1.5">
                <button
                    onClick={() => {
                        triggerHaptic('light');
                        setSavedTraces(loadSavedTraces());
                        setShowSavedTraces((v) => !v);
                    }}
                    className={`min-h-[44px] flex-1 rounded-lg px-2.5 py-1 text-left text-[10px] font-black uppercase tracking-wide active:scale-95 ${showSavedTraces ? 'bg-white/10 text-gray-100' : 'bg-white/5 text-gray-400'}`}
                >
                    {showSavedTraces ? '▾ Saved routes' : '📂 Open a saved route'}
                </button>
            </div>
            {showSavedTraces && (
                <div className="max-h-40 shrink-0 space-y-1 overflow-y-auto border-b border-white/10 px-3 py-2">
                    {savedTraces.length === 0 ? (
                        <div className="text-[10px] text-gray-500">No saved routes yet — plot one and Save it.</div>
                    ) : (
                        // GROUPED by trip (Shane 2026-07-17), the same
                        // shared helper the PLAN Trip box uses: a
                        // multi-leg trip shows a header + indented
                        // legs; a standalone route is one row.
                        groupTracesByTrip(savedTraces).map((trip) =>
                            trip.legs.length === 1 ? (
                                <button
                                    key={trip.key}
                                    onClick={() => openSavedTrace(trip.legs[0])}
                                    className="block min-h-[44px] w-full truncate rounded-md px-1.5 py-1.5 text-left text-[11px] text-gray-200 active:bg-white/10"
                                >
                                    {trip.legs[0].name}{' '}
                                    <span className="text-gray-500">({trip.legs[0].points.length} pins)</span>
                                </button>
                            ) : (
                                <div key={trip.key}>
                                    <div className="truncate px-1.5 pt-1 text-[10px] font-black uppercase tracking-wide text-amber-300/90">
                                        🧩 {trip.label}
                                    </div>
                                    {trip.legs.map((leg) => (
                                        <button
                                            key={leg.id}
                                            onClick={() => openSavedTrace(leg)}
                                            className="block min-h-[44px] w-full truncate rounded-md py-1.5 pl-4 pr-1.5 text-left text-[11px] text-gray-200 active:bg-white/10"
                                        >
                                            {leg.name} <span className="text-gray-500">({leg.points.length} pins)</span>
                                        </button>
                                    ))}
                                </div>
                            ),
                        )
                    )}
                </div>
            )}
        </>
    );
};
