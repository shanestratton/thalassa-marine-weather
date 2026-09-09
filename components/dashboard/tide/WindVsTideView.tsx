/**
 * WindVsTideView — the in-place flip of the tide graph. Shows the wind-vs-tide
 * relationship a sailor cares about: is the wind WITH the stream (easy) or
 * OVER it (short, steep, dangerous chop), now and over the next few hours.
 *
 * Stream direction comes from the user's flood-direction setting when set
 * (true tidal stream), else the modelled current (a proxy). All judgement is
 * the pure, tested services/tide/windOverTide engine.
 */
import React from 'react';
import type { HourlyForecast, TidePoint, UnitPreferences } from '../../../types';
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
    hourly?: HourlyForecast[];
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

/** Nearest hourly sample to a time. */
function hourAt(hourly: HourlyForecast[] | undefined, tMs: number): HourlyForecast | null {
    if (!hourly || !hourly.length) return null;
    let best: HourlyForecast | null = null;
    let bestD = Infinity;
    for (const h of hourly) {
        const t = new Date(h.time).getTime();
        const d = Math.abs(t - tMs);
        if (!Number.isNaN(t) && d < bestD) {
            bestD = d;
            best = h;
        }
    }
    return best;
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
    hourly,
    now,
    nowMs,
    floodDirection,
    onSetFloodDirection,
    units,
    onClose,
}) => {
    const scrollRef = React.useRef<HTMLDivElement>(null);
    const contentRef = React.useRef<HTMLDivElement>(null);
    const [scrollHint, setScrollHint] = React.useState('');
    const updateScrollHint = React.useCallback(() => {
        const element = scrollRef.current;
        if (!element) return;
        const overflow = element.scrollHeight > element.clientHeight + 1;
        const atEnd = element.scrollTop + element.clientHeight >= element.scrollHeight - 2;
        setScrollHint(overflow ? (atEnd ? 'Scroll up ↑' : 'More below ↓') : '');
    }, []);

    React.useEffect(() => {
        updateScrollHint();
        const observer = new ResizeObserver(updateScrollHint);
        if (scrollRef.current) observer.observe(scrollRef.current);
        if (contentRef.current) observer.observe(contentRef.current);
        return () => observer.disconnect();
    }, [updateScrollHint]);

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

    // Outlook: +3/+6/+9/+12h
    const outlook = [3, 6, 9, 12].map((h) => {
        const t = nowMs + h * 3600_000;
        const ph = phaseAt(tideSeries, t) ?? 'slack';
        const hr = hourAt(hourly, t);
        const curDeg = dirToDeg(hr?.currentDirection ?? now.currentDir);
        const sDeg = streamDirection(ph, usingSetting ? floodDirection : null, curDeg);
        const res = windVsTide({
            windDeg: hr?.windDegree ?? now.windDeg,
            windKts: hr?.windSpeed ?? now.windKts,
            streamDeg: sDeg,
            currentKts: hr?.currentSpeed ?? now.currentKts,
            streamFromSetting: usingSetting,
        });
        return { h, ph, res };
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
            className="relative w-full h-full min-h-0 min-w-0 flex flex-col text-white overflow-hidden"
            onKeyDown={(event) => {
                // The surrounding Glass carousels use arrow keys to change
                // days/hours. Inside these details, let native keys scroll this
                // region instead, including when a flood control has focus.
                if (
                    ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End'].includes(
                        event.key,
                    )
                ) {
                    event.stopPropagation();
                }
            }}
        >
            <div className="shrink-0 min-h-12 flex items-center justify-between gap-2 px-3 py-1">
                <span className="text-xs uppercase tracking-[0.2em] text-white/60">Wind vs Tide</span>
                <span className="ml-auto text-xs text-white/60" aria-hidden="true">
                    {scrollHint}
                </span>
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
            {/* The Glass card is deliberately height-constrained. Scroll only
                its details, never shrink text or grow the surrounding carousel. */}
            <div
                ref={scrollRef}
                role="region"
                aria-label="Wind versus tide details"
                tabIndex={0}
                onScroll={updateScrollHint}
                className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-y-contain px-3 pb-3 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-sky-400"
                style={{ WebkitOverflowScrolling: 'touch' }}
            >
                <div ref={contentRef} className="min-w-0">
                    {/* Verdict */}
                    <div className={`mt-1 text-lg font-black leading-tight ${relationColor(nowResult)}`}>
                        {nowResult.label}
                    </div>

                    {/* Wind / Stream readout */}
                    <div className="mt-2 grid grid-cols-2 gap-2">
                        <div className="min-w-0 rounded-lg bg-white/4 px-2 py-2">
                            <div className="text-[10px] uppercase tracking-wider text-white/40">Wind</div>
                            <div className="text-sm font-bold tabular-nums">
                                {windSpd !== null ? `${windSpd} ${units.speed}` : '--'}{' '}
                                <span className="text-white/50 font-normal">from {windFrom}</span>
                            </div>
                        </div>
                        <div className="min-w-0 rounded-lg bg-white/4 px-2 py-2">
                            <div className="text-[10px] uppercase tracking-wider text-white/40">
                                Stream {PHASE_ARROW[phase]} {PHASE_LABEL[phase]}
                            </div>
                            <div className="text-sm font-bold tabular-nums">
                                {curSpd !== null ? `${curSpd} ${units.speed}` : '~'}{' '}
                                <span className="text-white/50 font-normal">to {streamCardinal}</span>
                            </div>
                        </div>
                    </div>

                    {/* Outlook strip */}
                    <div className="mt-3 grid grid-cols-4 items-stretch gap-1.5">
                        {outlook.map(({ h, ph, res }) => (
                            <div
                                key={h}
                                data-testid={`wind-tide-outlook-${h}`}
                                className={`min-w-0 rounded-md px-1 py-1.5 text-center ${res.windOverTide ? 'bg-red-500/20 border border-red-500/40' : 'bg-white/4'}`}
                            >
                                <div className="text-[10px] text-white/45">+{h}h</div>
                                <div
                                    className={`text-[13px] leading-none ${res.windOverTide ? 'text-red-300' : 'text-white/70'}`}
                                >
                                    {PHASE_ARROW[ph]}
                                </div>
                                <div className="text-xs mt-0.5 text-white/60 break-words">
                                    {res.relation === 'against'
                                        ? 'against'
                                        : res.relation === 'with'
                                          ? 'with'
                                          : res.relation === 'cross'
                                            ? 'cross'
                                            : '—'}
                                </div>
                            </div>
                        ))}
                    </div>

                    {/* Flood-direction control */}
                    <div className="pt-3 flex flex-wrap items-center justify-between gap-2">
                        <span className="min-w-0 text-xs text-white/60">
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
                                    className="shrink-0 min-w-[44px] px-3 h-[44px] rounded-md bg-white/10 text-white/70 text-xs active:scale-90"
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
        </div>
    );
};

WindVsTideView.displayName = 'WindVsTideView';
