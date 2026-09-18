/**
 * WindVsTideView — the in-place flip of the tide graph. Shows the wind-vs-tide
 * relationship a sailor cares about: is the wind WITH the stream (easy) or
 * OVER it (short, steep, dangerous chop), at the selected time.
 *
 * Stream direction comes from the user's flood-direction setting when set
 * (true tidal stream), else the modelled current (a proxy). All judgement is
 * the pure, tested services/tide/windOverTide engine.
 */
import React from 'react';
import type { TidePoint, UnitPreferences } from '../../../types';
import { convertSpeed } from '../../../utils/units';
import { degreesToCardinal, cardinalToDegrees } from '../../../utils/format';
import {
    windVsTide,
    streamDirection,
    tidePhase,
    type TidePhase,
    type WindTideResult,
} from '../../../services/tide/windOverTide';

interface NowSnapshot {
    windDeg?: number | null;
    windKts?: number | null;
    currentDir?: number | string | null;
    currentKts?: number | null;
}

interface WindVsTideViewProps {
    tideSeries?: TidePoint[];
    now: NowSnapshot;
    nowMs: number;
    floodDirection?: number;
    onSetFloodDirection: (deg: number | undefined) => void;
    units: UnitPreferences;
    onClose?: (event: React.MouseEvent<HTMLButtonElement>) => void;
}

/** Current direction can be a number (deg) or a cardinal string — normalise to degrees. */
function dirToDeg(v: number | string | null | undefined): number | null {
    if (v == null) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const d = cardinalToDegrees(v);
    return typeof d === 'number' && Number.isFinite(d) ? d : null;
}

/** Linear-interpolated tide height at a target time (ms) from the hourly series. */
function heightAt(series: TidePoint[], tMs: number): number | null {
    if (!series || series.length < 2) return null;
    const pts = series
        .map((p) => ({ t: new Date(p.time).getTime(), h: p.height }))
        .filter((p) => !Number.isNaN(p.t))
        .sort((a, b) => a.t - b.t);
    if (tMs <= pts[0].t) return pts[0].h;
    if (tMs >= pts[pts.length - 1].t) return pts[pts.length - 1].h;
    for (let i = 1; i < pts.length; i++) {
        if (tMs <= pts[i].t) {
            const a = pts[i - 1];
            const b = pts[i];
            const f = (tMs - a.t) / (b.t - a.t || 1);
            return a.h + (b.h - a.h) * f;
        }
    }
    return null;
}

function phaseAt(series: TidePoint[] | undefined, tMs: number): TidePhase | null {
    if (!series) return null;
    const cur = heightAt(series, tMs);
    const next = heightAt(series, tMs + 60 * 60 * 1000);
    if (cur == null || next == null) return null;
    return tidePhase(cur, next);
}

const PHASE_LABEL: Record<TidePhase, string> = { flood: 'Flooding', ebb: 'Ebbing', slack: 'Slack' };
const PHASE_ARROW: Record<TidePhase, string> = { flood: '▲', ebb: '▼', slack: '■' };

function relationColor(r: WindTideResult): string {
    if (r.windOverTide) return 'text-red-400';
    if (r.relation === 'against') return 'text-amber-300';
    if (r.relation === 'with') return 'text-emerald-300';
    return 'text-sky-200';
}

export const WindVsTideView: React.FC<WindVsTideViewProps> = ({
    tideSeries,
    now,
    nowMs,
    floodDirection,
    onSetFloodDirection,
    units,
    onClose,
}) => {
    const verdictId = React.useId();
    const usingSetting = floodDirection != null && Number.isFinite(floodDirection);

    // NOW
    const phase = phaseAt(tideSeries, nowMs) ?? 'slack';
    const modelledCurDeg = dirToDeg(now.currentDir);
    const streamDeg = streamDirection(phase, usingSetting ? floodDirection : null, modelledCurDeg);
    const nowResult = windVsTide({
        windDeg: now.windDeg,
        windKts: now.windKts,
        streamDeg,
        currentKts: now.currentKts,
        streamFromSetting: usingSetting,
    });

    const windFrom = now.windDeg != null ? degreesToCardinal(now.windDeg) : '--';
    const windSpd = convertSpeed(now.windKts ?? null, units.speed);
    const curSpd = convertSpeed(now.currentKts ?? null, units.speed);
    const streamCardinal = streamDeg != null ? degreesToCardinal(streamDeg) : '--';

    const adjustFlood = (delta: number) => {
        const base = usingSetting ? floodDirection! : (modelledCurDeg ?? 0);
        onSetFloodDirection((((base + delta) % 360) + 360) % 360);
    };

    return (
        <div
            className="relative w-full h-full min-h-0 min-w-0 flex flex-col gap-1 px-2 py-1 text-white overflow-clip"
            onKeyDown={(event) => {
                // The surrounding Glass carousels use arrow keys to change
                // days/hours. This face has no scrolling; navigation keys must
                // not move an ancestor while reading it or adjusting a control.
                if (
                    ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End'].includes(
                        event.key,
                    )
                ) {
                    event.preventDefault();
                    event.stopPropagation();
                }
            }}
        >
            <div className="shrink-0 min-h-[44px] flex items-center justify-between gap-2">
                <div
                    id={verdictId}
                    data-testid="wind-tide-verdict"
                    className={`min-w-0 text-[16px] leading-[18px] font-black ${relationColor(nowResult)}`}
                >
                    {nowResult.label}
                </div>
                {onClose ? (
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            onClose(e);
                        }}
                        aria-label="Back to tide graph"
                        className="shrink-0 w-[44px] h-[44px] rounded-full bg-white/10 text-white/70 text-sm flex items-center justify-center active:scale-90"
                    >
                        ✕
                    </button>
                ) : null}
            </div>
            {/* Current conditions only: the forward-time strip is intentionally
                removed so this face fits without scrolling or moving the model
                strip. Keep full warning text and real 44px direction controls. */}
            <div
                role="region"
                aria-label="Wind versus tide details"
                aria-describedby={verdictId}
                tabIndex={0}
                className="min-h-0 min-w-0 flex-1 flex flex-col justify-between gap-1 overflow-clip focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-sky-400"
            >
                {/* Wind / Stream readout */}
                <div className="grid grid-cols-2 gap-2 shrink-0">
                    <div data-testid="wind-tide-wind" className="min-w-0 rounded-lg bg-white/4 px-1 py-0.5">
                        <div className="text-[12px] leading-[16px] text-white/60">Wind</div>
                        <div className="text-[14px] leading-[18px] font-bold tabular-nums">
                            {windSpd !== null ? `${windSpd} ${units.speed}` : '--'}{' '}
                            <span className="text-white/50 font-normal">from {windFrom}</span>
                        </div>
                    </div>
                    <div data-testid="wind-tide-stream" className="min-w-0 rounded-lg bg-white/4 px-1 py-0.5">
                        <div className="text-[12px] leading-[16px] text-white/60">
                            Stream {PHASE_ARROW[phase]} {PHASE_LABEL[phase]}
                        </div>
                        <div className="text-[14px] leading-[18px] font-bold tabular-nums">
                            {curSpd !== null ? `${curSpd} ${units.speed}` : '~'}{' '}
                            <span className="text-white/50 font-normal">to {streamCardinal}</span>
                        </div>
                    </div>
                </div>

                {/* Flood-direction control */}
                <div className="flex shrink-0 items-center justify-between gap-2">
                    <span data-testid="wind-tide-source" className="min-w-0 text-[12px] leading-[14px] text-white/60">
                        {usingSetting
                            ? `Stream from your flood ${Math.round(floodDirection!)}°`
                            : 'Stream from modelled current'}
                    </span>
                    <div className="flex shrink-0 items-center gap-1">
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                adjustFlood(-15);
                            }}
                            className="shrink-0 w-[44px] h-[44px] rounded-md bg-white/10 text-white/80 text-base active:scale-90"
                            aria-label="Flood direction minus 15 degrees"
                            type="button"
                        >
                            −
                        </button>
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                adjustFlood(15);
                            }}
                            className="shrink-0 w-[44px] h-[44px] rounded-md bg-white/10 text-white/80 text-base active:scale-90"
                            aria-label="Flood direction plus 15 degrees"
                            type="button"
                        >
                            +
                        </button>
                        {usingSetting ? (
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onSetFloodDirection(undefined);
                                }}
                                className="shrink-0 w-[44px] h-[44px] rounded-md bg-white/10 text-white/70 text-[12px] active:scale-90"
                                aria-label="Use modelled current instead"
                                type="button"
                            >
                                Auto
                            </button>
                        ) : null}
                    </div>
                </div>
            </div>
        </div>
    );
};

WindVsTideView.displayName = 'WindVsTideView';
