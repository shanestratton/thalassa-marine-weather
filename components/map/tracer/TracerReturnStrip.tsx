/**
 * TracerReturnStrip — the tracer card's lines for reversed legs and the trip
 * home (Shane 2026-10-07: "if i wanted to reverse the legs of a route…").
 *
 *  - The reversal note: what the grader cannot check for a line run the other
 *    way (traffic lanes, tidal gates, lights). Shown while the draft still is
 *    the reversed line.
 *  - The slot chooser: ⇄ in a locked-start leg found more than one saved leg
 *    arriving at that pin. One tap drops it in reversed.
 *  - The return-trip cursor: which leg home this is, "Next return leg →" once
 *    it is saved, and Stop at any time.
 *  - The next leg (126-16a): once the last leg of a trip is saved, "Plot the
 *    4th leg →" opens the Trip sheet at the add pane, and "Back to the trip"
 *    at the trip. It stays until the draft is no longer that saved leg, unlike
 *    the save flash, so leg after leg is three taps with no trip back to Plan.
 *
 * Presentational. Every decision is made in services/tripReverse.ts and
 * components/map/useReturnTripFlow.ts; MapHub only wires them here. Children
 * of the card's flex-column scroller are shrink-0, as TracerSavedRoutePicker
 * explains.
 */
import React from 'react';
import { displayRouteLabel, ordinalLegLabel, type SavedTrace } from '../../../services/routeTracer';
import type { ReturnTripProgress } from '../useReturnTripFlow';

export interface TracerReturnStripProps {
    note: string | null;
    slotChoices: SavedTrace[] | null;
    /** The locked start the chooser fills from ("Sandy Cove"). */
    slotFromName: string | null;
    onPickSlot: (trace: SavedTrace) => void;
    onCancelSlot: () => void;
    progress: ReturnTripProgress | null;
    nextReturnLeg: { j: number; k: number } | null;
    onNextReturnLeg: () => void;
    onStopReturnTrip: () => void;
    /** The saved last leg of a trip is on screen: the leg after it. */
    nextLeg?: { ordinal: number; fromName: string } | null;
    onNextLeg?: () => void;
    onBackToTrip?: () => void;
}

export const TracerReturnStrip: React.FC<TracerReturnStripProps> = ({
    note,
    slotChoices,
    slotFromName,
    onPickSlot,
    onCancelSlot,
    progress,
    nextReturnLeg,
    onNextReturnLeg,
    onStopReturnTrip,
    nextLeg = null,
    onNextLeg,
    onBackToTrip,
}) => (
    <>
        {note && (
            <div
                role="note"
                className="shrink-0 border-b border-white/10 px-3 py-1.5 text-[11px] font-bold leading-snug text-amber-200"
            >
                <span aria-hidden="true">⇄ </span>
                {note}
            </div>
        )}
        {slotChoices && slotChoices.length > 0 && (
            <div
                role="group"
                aria-labelledby="tracer-slot-choices-title"
                className="shrink-0 space-y-1 border-b border-white/10 px-3 py-2"
            >
                <div id="tracer-slot-choices-title" className="text-[11px] font-black text-sky-200">
                    Which saved leg arrives at {slotFromName ?? 'this start'}? It goes in reversed.
                </div>
                {slotChoices.map((trace) => (
                    <button
                        key={trace.id}
                        onClick={() => onPickSlot(trace)}
                        className="block min-h-[44px] w-full truncate rounded-md bg-white/5 px-2 py-1.5 text-left text-[11px] text-gray-200 active:bg-white/10"
                    >
                        {displayRouteLabel(trace)} <span className="text-gray-500">({trace.points.length} pins)</span>
                    </button>
                ))}
                <button
                    onClick={onCancelSlot}
                    className="min-h-[44px] w-full rounded-md px-2 text-left text-[11px] font-bold text-gray-400 active:bg-white/10"
                >
                    Cancel
                </button>
            </div>
        )}
        {progress && (
            <div className="flex shrink-0 items-center gap-1.5 border-b border-white/10 px-3 py-1.5">
                {nextReturnLeg ? (
                    <button
                        onClick={onNextReturnLeg}
                        className="min-h-[44px] min-w-0 flex-1 rounded-lg bg-sky-500/20 px-2 py-1.5 text-left text-[11px] font-black text-sky-200 active:scale-95"
                    >
                        Next return leg → ({nextReturnLeg.j} of {nextReturnLeg.k})
                    </button>
                ) : (
                    <span className="min-w-0 flex-1 text-[11px] font-bold leading-snug text-sky-200">
                        Return trip · leg {progress.leg} of {progress.of} — check it, then save
                    </span>
                )}
                <button
                    onClick={onStopReturnTrip}
                    aria-label="Stop planning the return trip"
                    className="min-h-[44px] shrink-0 rounded-lg bg-white/5 px-2.5 text-[11px] font-black uppercase tracking-wide text-gray-300 active:scale-95"
                >
                    Stop
                </button>
            </div>
        )}
        {nextLeg && (
            <div className="flex shrink-0 items-center gap-1.5 border-b border-white/10 px-3 py-1.5">
                <button
                    type="button"
                    onClick={onNextLeg}
                    title={`Plot the ${ordinalLegLabel(nextLeg.ordinal).toLowerCase()} from ${nextLeg.fromName}`}
                    className="min-h-[44px] min-w-0 flex-1 truncate rounded-lg bg-amber-500/20 px-2 py-1.5 text-left text-[11px] font-black text-amber-200 active:scale-95"
                >
                    {`Plot the ${ordinalLegLabel(nextLeg.ordinal).toLowerCase()} →`}
                </button>
                <button
                    type="button"
                    onClick={onBackToTrip}
                    className="min-h-[44px] shrink-0 rounded-lg bg-white/5 px-2.5 text-[11px] font-black text-gray-300 active:scale-95"
                >
                    Back to the trip
                </button>
            </div>
        )}
    </>
);
