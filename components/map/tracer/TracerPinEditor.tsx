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
 * The selected point and its two neighbours define an explicit leave-side
 * choice. Generated curve vertices become user points only on an explicit edit.
 */

import React, { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { triggerHaptic } from '../../../utils/system';
import type { TracePoint } from '../../../services/routeTracer';
import { resolveRouteConstraints } from '../../../services/routing/routeConstraints';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../../../services/authIdentityScope';

export interface TracerPinEditorProps {
    /** Already guaranteed non-null by the guard at the call site. */
    selectedPin: number;
    setSelectedPin: (i: number | null) => void;
    /** capturedCoords.length; only the selected point and neighbours follow. */
    pinCount: number;
    point?: TracePoint;
    previous?: TracePoint;
    next?: TracePoint;
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
    point,
    previous,
    next,
    setCapturedCoords,
    legAnchor,
    insertAfter,
    setInsertAfter,
    insertAfterRef,
    flashTraceFeedback,
}) => {
    const owner = getAuthIdentityScope();
    const [offset, setOffset] = useState(String(point?.constraint?.standOffM ?? 50));
    useEffect(() => setOffset(String(point?.constraint?.standOffM ?? 50)), [selectedPin, point?.constraint?.standOffM]);
    const applyChoice = (side?: 'port' | 'starboard') => {
        if (!point || !previous || !next || !isAuthIdentityScopeCurrent(owner)) return;
        const mark = point.constraint ?? {
            lat: point.lat,
            lon: point.lon,
            ...(point.name ? { name: point.name } : {}),
        };
        let replacement: TracePoint = { lat: mark.lat, lon: mark.lon, ...(mark.name ? { name: mark.name } : {}) };
        if (side) {
            const choice = resolveRouteConstraints(
                previous,
                [{ ...mark, leaveSide: side, standOffM: Number(offset) }],
                next,
            );
            if (!choice) {
                flashTraceFeedback('Choose a passing offset from 5 to 2000 m with a clear route direction.');
                return;
            }
            replacement = { lat: choice.points[1].lat, lon: choice.points[1].lon, constraint: choice.canonicalVias[0] };
        }
        setCapturedCoords((current) =>
            current.map((p, i) =>
                i === selectedPin &&
                p.lat === point.lat &&
                p.lon === point.lon &&
                JSON.stringify(p.constraint) === JSON.stringify(point.constraint)
                    ? replacement
                    : p,
            ),
        );
        flashTraceFeedback(
            side
                ? `Leave this mark to ${side}; the numbered passing point is ${Number(offset)} m away. Check its charted clearance.`
                : 'This mark is now a must-pass point.',
        );
    };
    return (
        <div className="border-b border-sky-500/30 bg-sky-500/10 px-3 py-1.5">
            <div className="flex items-center gap-1.5">
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
                        className="hit-target-44 rounded-lg bg-sky-500/20 px-2 py-1.5 text-[11px] font-black uppercase text-sky-300 active:scale-95"
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
                    className="hit-target-44 rounded-lg bg-red-500/20 px-2 py-1.5 text-[11px] font-black uppercase text-red-300 active:scale-95"
                >
                    Delete
                </button>
                <button
                    onClick={() => {
                        setSelectedPin(null);
                        setInsertAfter(null);
                        insertAfterRef.current = null;
                    }}
                    aria-label="Close pin editor"
                    className="min-h-[44px] min-w-[44px] px-1 text-gray-400"
                >
                    ✕
                </button>
            </div>
            {selectedPin > 0 && selectedPin < pinCount - 1 && point && previous && next && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                    <span className="w-full text-gray-300">
                        {point.constraint
                            ? `Original mark ${point.constraint.lat.toFixed(5)}, ${point.constraint.lon.toFixed(5)}; numbered pin is its passing point.`
                            : point.shape || point.auto
                              ? 'Generated point — choosing a role makes it your required mark.'
                              : 'Hand-placed pin — must pass in this order.'}
                    </span>
                    <button
                        type="button"
                        aria-pressed={!point.constraint && !point.shape && !point.auto}
                        onClick={() => applyChoice()}
                        className="hit-target-44 rounded-lg bg-sky-500/20 px-2 font-bold text-sky-200"
                    >
                        Must pass
                    </button>
                    <button
                        type="button"
                        aria-pressed={point.constraint?.leaveSide === 'port'}
                        onClick={() => applyChoice('port')}
                        className="hit-target-44 rounded-lg bg-red-500/20 px-2 font-bold text-red-200"
                    >
                        Leave port
                    </button>
                    <button
                        type="button"
                        aria-pressed={point.constraint?.leaveSide === 'starboard'}
                        onClick={() => applyChoice('starboard')}
                        className="hit-target-44 rounded-lg bg-emerald-500/20 px-2 font-bold text-emerald-200"
                    >
                        Leave starboard
                    </button>
                    <label className="flex min-h-[44px] items-center gap-2 text-gray-200">
                        Passing offset (m)
                        <input
                            aria-label="Passing offset in metres"
                            type="number"
                            min={5}
                            max={2000}
                            value={offset}
                            onChange={(e) => setOffset(e.target.value)}
                            className="w-20 rounded border border-white/20 bg-slate-900 px-2 py-2 text-white"
                        />
                    </label>
                    <span className="w-full text-gray-400">
                        Offset is your choice, not verified water or obstacle clearance. Choose a side again to apply a
                        changed offset.
                    </span>
                </div>
            )}
        </div>
    );
};
