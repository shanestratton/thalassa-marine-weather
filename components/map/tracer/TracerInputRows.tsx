/**
 * TracerInputRows — the tracer card's two typed-entry rows: the 🕐 Depart
 * date/time picker and the "Add a GPS Fix" coordinate field.
 *
 * Extracted from MapHub verbatim. Both rows are direct children of the card's
 * scroller and are rendered unconditionally, side by side, which is what makes
 * them safe to move as a pair.
 *
 * RETURNS A FRAGMENT, NOT A WRAPPER DIV — and this is load-bearing, for a
 * reason worth spelling out because the obvious justifications are wrong.
 * The scroller (MapHub, `flex min-h-0 flex-1 flex-col overflow-y-auto`) makes
 * every direct child a flex item. A wrapper <div> would become that flex item
 * with the default flex-shrink:1 and swallow the shrink behaviour of the real
 * rows, re-opening the mid-glyph clipping the card was fixed for. It would
 * also be full-width with no padding, so the `border-t … px-3` rules would
 * stop meeting the card edges. A Fragment emits no DOM, so both properties
 * survive exactly.
 *
 * MUST STAY UNGATED AND UNKEYED in its slot. A remount here is not merely a
 * lost focus and a dismissed iOS keyboard on the coordinate field: TimePicker24
 * holds a MOUNT-SCOPED clock snapshot (`useMemo(() => new Date(), [])`) and an
 * effect that writes back through onChange. Re-snapshot that clock and a
 * departure which was in the future when picked, but has since passed, fires
 * onChange and SILENTLY REWRITES the skipper's departure time.
 *
 * The two render-time `Date.now()` reads in the date input are deliberate. It
 * is a knowingly "lying" controlled input — it displays today while
 * departureMs is null, and `min` blocks past dates because you cannot plan to
 * leave yesterday. Do not hoist them into useMemo, and do NOT wrap this
 * component in React.memo: memo would freeze those reads at the last render
 * that changed a prop, so the date shown would drift out of date across a
 * midnight rollover while nobody typed.
 *
 * The on-device input attributes (inputMode, autoCapitalize="characters",
 * autoCorrect, spellCheck) are the coordinate-entry behaviour on the native
 * iOS build, which is where this is actually used. They are not decoration.
 */

import React from 'react';
import { triggerHaptic } from '../../../utils/system';
import { msToLocalInput } from '../mapHubHelpers';
import { TimePicker24 } from '../../passage/TimePicker24';

export interface TracerInputRowsProps {
    /** null = "leave now", which the UI says out loud rather than implying. */
    departureMs: number | null;
    setDepartureMs: (ms: number | null) => void;
    coordEntry: string;
    setCoordEntry: (v: string) => void;
    /** Re-minted on every keystroke (it closes over coordEntry), so it must be
     *  passed through as-is — never re-derived, or Enter adds the PREVIOUS fix. */
    addCoordPin: () => void;
}

export const TracerInputRows: React.FC<TracerInputRowsProps> = ({
    departureMs,
    setDepartureMs,
    coordEntry,
    setCoordEntry,
    addCoordPin,
}) => {
    return (
        <>
            {/* Departure date/time (Shane 2026-07-16): anchors the
                tide windows at each leg's ETA, the departure-window
                headline, and the report's per-waypoint weather.
                Empty = leave now. Two lines (date, then 24-hour
                selects) so neither is squeezed. */}
            <div className="space-y-1.5 border-t border-white/10 px-3 py-2">
                <div className="flex items-baseline justify-between">
                    <span className="text-[10px] font-black uppercase tracking-widest text-gray-400">🕐 Depart</span>
                    {departureMs === null && <span className="text-[10px] font-bold text-emerald-300/80">now</span>}
                </div>
                {/* The native date input renders 31/07/2026 in a grey
                    system control — legible, but nothing your eye
                    lands on, and every tide row below is read against
                    it. Spell the chosen departure out in medium form,
                    weekday included, because "is that Thursday or
                    Friday" is the question that actually gets asked. */}
                {departureMs !== null && (
                    <p
                        data-testid="tracer-depart-when"
                        className="text-sm font-black uppercase tracking-wide text-amber-200"
                    >
                        {new Date(departureMs).toLocaleString([], {
                            weekday: 'short',
                            day: 'numeric',
                            month: 'short',
                            year: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                            hour12: false,
                        })}
                    </p>
                )}
                <div className="flex gap-1.5">
                    <input
                        type="date"
                        value={
                            departureMs !== null
                                ? msToLocalInput(departureMs).slice(0, 10)
                                : msToLocalInput(Date.now()).slice(0, 10)
                        }
                        // Past dates greyed out (Shane 2026-07-17) —
                        // can't plan to leave yesterday.
                        min={msToLocalInput(Date.now()).slice(0, 10)}
                        onChange={(e) => {
                            triggerHaptic('light');
                            if (!e.target.value) {
                                setDepartureMs(null);
                                return;
                            }
                            const time =
                                departureMs !== null
                                    ? msToLocalInput(departureMs).slice(11, 16)
                                    : msToLocalInput(Date.now()).slice(11, 16);
                            const t = new Date(`${e.target.value}T${time}`).getTime();
                            if (Number.isFinite(t)) setDepartureMs(t);
                        }}
                        aria-label="Departure date"
                        className="min-w-0 flex-3 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-[11px] text-gray-200 scheme-dark focus:border-sky-500/50 focus:outline-hidden"
                    />
                    {/* 24-hour time (Shane 2026-07-17: the web time
                        input's AM/PM clipped in the card). */}
                    <TimePicker24
                        value={
                            departureMs !== null
                                ? {
                                      h: Number(msToLocalInput(departureMs).slice(11, 13)),
                                      m: Number(msToLocalInput(departureMs).slice(14, 16)),
                                  }
                                : null
                        }
                        dateStr={departureMs !== null ? msToLocalInput(departureMs).slice(0, 10) : ''}
                        onChange={(h, m) => {
                            triggerHaptic('light');
                            const date =
                                departureMs !== null
                                    ? msToLocalInput(departureMs).slice(0, 10)
                                    : msToLocalInput(Date.now()).slice(0, 10);
                            const p = (n: number) => String(n).padStart(2, '0');
                            const t = new Date(`${date}T${p(h)}:${p(m)}`).getTime();
                            if (Number.isFinite(t)) setDepartureMs(t);
                        }}
                        selectClassName="min-w-0 rounded-lg border border-white/10 bg-white/5 px-1.5 py-1.5 text-[11px] text-gray-200 scheme-dark focus:border-sky-500/50 focus:outline-hidden"
                    />
                </div>
                {/* OK button REMOVED (Shane 2026-07-17): it only
                    existed to blur the native time wheel closed,
                    and the 24-hour selects dismiss themselves. */}
                {departureMs !== null && (
                    <button
                        onClick={() => {
                            triggerHaptic('light');
                            (document.activeElement as HTMLElement | null)?.blur?.();
                            setDepartureMs(null);
                        }}
                        className="min-h-[44px] w-full rounded-lg bg-white/10 py-1.5 text-[11px] font-black uppercase tracking-wide text-gray-300 active:scale-95"
                    >
                        Now
                    </button>
                )}
            </div>
            {/* Build a route by keying GPS fixes — decimal, DMM
                ("27 08.5S 153 09.2E"), DMS or hemisphere-suffixed.
                Each Add drops the next pin (Shane 2026-07-16). */}
            <div className="flex gap-1.5 border-t border-white/10 px-3 py-2">
                <input
                    value={coordEntry}
                    onChange={(e) => setCoordEntry(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            addCoordPin();
                        }
                    }}
                    inputMode="text"
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder="Add a GPS Fix"
                    className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 font-mono text-[11px] text-gray-200 placeholder:text-gray-500 focus:border-emerald-500/50 focus:outline-hidden"
                />
                <button
                    onClick={addCoordPin}
                    disabled={!coordEntry.trim()}
                    className="hit-target-44 shrink-0 rounded-lg bg-emerald-500/20 px-3 py-1.5 text-[11px] font-black uppercase tracking-wide text-emerald-300 active:scale-95 disabled:opacity-40"
                >
                    ＋ Add
                </button>
            </div>
        </>
    );
};
