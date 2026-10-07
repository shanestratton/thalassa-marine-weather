import { useEffect, useState } from 'react';
import { CREDITS_STRIP_POSITION_CLASS } from './creditsStrip';
import { SAT_IR_CREDIT, satIrAgeLabel, satIrCoverageNote } from './satelliteImagery';
import type { SatIrState } from './useSatelliteLayer';

interface SatelliteIrCreditProps {
    state: SatIrState;
    /** creditsStripTop(…) for this credit's slot. */
    top: string;
    onTogglePlay: () => void;
    /** Fixed clock for tests; live it ticks once a minute so the age stays true. */
    nowMs?: number;
}

function useMinuteClock(fixed: number | undefined): number {
    const [now, setNow] = useState(() => fixed ?? Date.now());
    useEffect(() => {
        if (fixed !== undefined) return;
        const timer = setInterval(() => setNow(Date.now()), 60_000);
        return () => clearInterval(timer);
    }, [fixed]);
    return fixed ?? now;
}

/**
 * The satellite cloud's line on the credits strip: which frame is painted and
 * how old it is (the imagery is 1–3 h behind, so the age is the first thing to
 * read), why there is nothing when there is nothing, the loop control, and the
 * credit NOAA asks for, naming every agency whose satellite is in the mosaic.
 * An image source cannot carry a Mapbox attribution, so this IS the credit.
 */
export function SatelliteIrCredit({ state, top, onTogglePlay, nowMs }: SatelliteIrCreditProps) {
    const now = useMinuteClock(nowMs);
    if (state.status === 'off') return null;

    // Past the edge nothing is drawn, and empty chart reads like clear sky:
    // whenever the view reaches it, the chip says so in the warning colour.
    const note = satIrCoverageNote(state.coverage);
    let line: string;
    let warn = true;
    if (state.status === 'blocked') line = 'Satellite cloud paused in Satellite Mode';
    else if (state.status === 'unavailable') line = 'Satellite imagery unavailable · retrying';
    else if (state.coverage.outside && note) line = note;
    else if (state.frameTimeMs === null) {
        line = 'Satellite IR loading…';
        warn = false;
    } else {
        line = satIrAgeLabel(state.frameTimeMs, now);
        if (note) line += ` · ${note}`;
        else warn = false;
    }
    const canPlay = state.status === 'ready' && !state.following && state.frameCount > 1;

    return (
        <div
            className={`${CREDITS_STRIP_POSITION_CLASS} z-509 max-w-[calc(100%-120px)] rounded-md bg-slate-950/70 px-2 py-1 backdrop-blur-xs`}
            style={{ top }}
            data-testid="sat-ir-credit"
            // Cut out of the layer menu's scrim, like every licence credit.
            data-map-credit
        >
            <div className="flex items-center gap-1.5">
                <span className={`text-[11px] font-bold leading-tight ${warn ? 'text-amber-200' : 'text-sky-100'}`}>
                    {/* "1 h old", "15:00 UTC" and "60°N" never break across lines. */}
                    {line.replace(/ (?:UTC|h old|min old)|past \d+°/g, (m) => m.replace(/ /g, '\u00a0'))}
                </span>
                {canPlay && (
                    <button
                        type="button"
                        onClick={onTogglePlay}
                        aria-label={state.playing ? 'Pause satellite loop' : 'Play satellite loop'}
                        aria-pressed={state.playing}
                        className="hit-target-44 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-sky-200 active:text-white"
                    >
                        <svg viewBox="0 0 12 12" className="h-3 w-3" fill="currentColor" aria-hidden="true">
                            {state.playing ? <path d="M2 1h3v10H2zM7 1h3v10H7z" /> : <path d="M2 1l9 5-9 5z" />}
                        </svg>
                    </button>
                )}
            </div>
            <div className="text-[10px] leading-tight text-slate-300/80">{SAT_IR_CREDIT}</div>
        </div>
    );
}
