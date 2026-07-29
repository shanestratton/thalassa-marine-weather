/**
 * TracerPinEditor — the toolbar that appears when you tap a numbered pin:
 * Insert-after, Delete, and dismiss.
 *
 * Extracted from MapHub verbatim. It is a single self-contained div with no
 * scroll or focus state, so it returns that div directly.
 *
 * THE GUARD STAYS IN MapHub. `{selectedPin !== null && selectedPin < pinCount
 * && (<TracerPinEditor …/>)}` remains at the call site, which is why
 * `selectedPin` is typed as a plain number here — inside this file it is
 * already known to be a real index.
 *
 * insertAfterRef IS THE POINT OF CARE. It mirrors the insertAfter state for
 * the map-tap closure, which lives ~1,700 lines away in MapHub and reads
 * `.current` at tap time rather than through React state. Every write to
 * setInsertAfter here is paired with a write to insertAfterRef.current, and
 * the pairing must stay — drop one half and the next chart tap inserts at the
 * wrong index, or refuses to insert at all. Nothing type-checks that pairing,
 * so a mistake here fails silently on the water rather than at the keyboard.
 *
 * The first pin is LOCKED when this trace is a chained leg: legs join by
 * position, not by name, so pin 0 is the previous leg's exact final fix.
 * Deleting it would break the chain, so the delete path refuses and says why
 * rather than silently doing nothing.
 *
 * Only the pin COUNT is passed, not the pin array — the toolbar reads nothing
 * else from it, and this way dragging a pin does not re-render the toolbar.
 */

import React from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { triggerHaptic } from '../../../utils/system';
import type { TracePoint } from '../../../services/routeTracer';

export interface TracerPinEditorProps {
    /** Already guaranteed non-null by the guard at the call site. */
    selectedPin: number;
    setSelectedPin: (i: number | null) => void;
    /** capturedCoords.length — the array itself is deliberately not passed. */
    pinCount: number;
    /** Functional update: delete filters the previous array. */
    setCapturedCoords: Dispatch<SetStateAction<TracePoint[]>>;
    /** Non-null when this trace is a chained leg, which LOCKS pin 0. */
    legAnchor: { fromName: string } | null;
    insertAfter: number | null;
    setInsertAfter: (i: number | null) => void;
    /** Mirrors insertAfter for the map-tap closure. Write both, always. */
    insertAfterRef: { current: number | null };
    flashTraceFeedback: (msg: string) => void;
}

export const TracerPinEditor: React.FC<TracerPinEditorProps> = ({
    selectedPin,
    setSelectedPin,
    pinCount,
    setCapturedCoords,
    legAnchor,
    insertAfter,
    setInsertAfter,
    insertAfterRef,
    flashTraceFeedback,
}) => {
    return (
        <div className="flex items-center gap-1.5 border-b border-sky-500/30 bg-sky-500/10 px-3 py-1.5">
            <span className="flex-1 text-[11px] font-bold text-sky-300">
                {selectedPin === 0
                    ? legAnchor
                        ? `Start — locked to ${legAnchor.fromName} 🔒`
                        : 'Start'
                    : selectedPin === pinCount - 1
                      ? 'Finish'
                      : `Pin ${selectedPin + 1}`}
                {insertAfter !== null ? ' — hold on the chart to insert after it' : ''}
            </span>
            {insertAfter === null && (
                <button
                    onClick={() => {
                        triggerHaptic('light');
                        setInsertAfter(selectedPin);
                        insertAfterRef.current = selectedPin;
                    }}
                    className="rounded-lg bg-sky-500/20 px-2 py-1.5 text-[11px] font-black uppercase text-sky-300 active:scale-95"
                >
                    + Insert
                </button>
            )}
            <button
                onClick={() => {
                    // The chained-leg start can't be deleted —
                    // it IS the previous leg's arrival.
                    if (selectedPin === 0 && legAnchor) {
                        flashTraceFeedback(
                            `First pin is locked to ${legAnchor.fromName} — edit the previous leg to move it`,
                        );
                        return;
                    }
                    triggerHaptic('medium');
                    const idx = selectedPin;
                    setSelectedPin(null);
                    setInsertAfter(null);
                    insertAfterRef.current = null;
                    setCapturedCoords((prev) => prev.filter((_, j) => j !== idx));
                }}
                className="rounded-lg bg-red-500/20 px-2 py-1.5 text-[11px] font-black uppercase text-red-300 active:scale-95"
            >
                Delete
            </button>
            <button
                onClick={() => {
                    setSelectedPin(null);
                    setInsertAfter(null);
                    insertAfterRef.current = null;
                }}
                className="px-1 text-gray-400"
            >
                ✕
            </button>
        </div>
    );
};
