/**
 * TideGraph — Tide data computation and rendering.
 *
 * Computes tide data points from multiple sources (WorldTides, hourly,
 * SealLevel API) with cosine interpolation. Renders the computed data
 * using TideCanvas along with header overlays for current height,
 * trend direction, and upcoming high/low events.
 */
import React from 'react';
import { createLogger } from '../../../utils/createLogger';
import { ArrowUpIcon, ArrowDownIcon, MinusIcon, TideCurveIcon } from '../../Icons';
import { Tide, UnitPreferences, HourlyForecast, TidePoint } from '../../../types';
import { TideGUIDetails } from '../../../services/weather/api/tides';
import { convertMetersTo } from '../../../utils';
import { TideCanvas } from './TideCanvas';

const log = createLogger('TideGraph');

// Intl.DateTimeFormat construction is the expensive half of reading a
// wall-clock time in another zone — keep one instance per zone and reuse it
// across renders. Construction still throws on an unknown zone, so callers
// keep their try/catch fallbacks; a failed construction is never cached.
const hmFormatters = new Map<string, Intl.DateTimeFormat>();
const hmFormatter = (tz?: string): Intl.DateTimeFormat => {
    const key = tz ?? '';
    let fmt = hmFormatters.get(key);
    if (!fmt) {
        fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: 'numeric', hour12: false });
        hmFormatters.set(key, fmt);
    }
    return fmt;
};
const labelFormatters = new Map<string, Intl.DateTimeFormat>();
const labelFormatter = (tz?: string): Intl.DateTimeFormat => {
    const key = tz ?? '';
    let fmt = labelFormatters.get(key);
    if (!fmt) {
        fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true });
        labelFormatters.set(key, fmt);
    }
    return fmt;
};

export const TideGraphOriginal = ({
    tides,
    unit,
    timeZone,
    hourlyTides,
    tideSeries,
    modelUsed: _modelUsed,
    unitPref,
    stationName,
    secondaryStationName: _secondaryStationName,
    guiDetails,
    stationPosition = 'bottom',
    customTime,
    showAllDayEvents,
    reserveRightPx = 0,
    className,
    style,
}: {
    tides: Tide[];
    unit: string;
    timeZone?: string;
    hourlyTides?: HourlyForecast[];
    tideSeries?: TidePoint[];
    modelUsed?: string;
    unitPref: UnitPreferences;
    stationName?: string;
    secondaryStationName?: string;
    guiDetails?: TideGUIDetails;
    stationPosition?: 'top' | 'bottom';
    customTime?: number;
    showAllDayEvents?: boolean;
    /** Keep this strip along the right edge clear of captions and curve — the
     *  Glass draws its day pager rail there. */
    reserveRightPx?: number;
    className?: string;
    style?: React.CSSProperties;
}) => {
    // FIX: Remove local state sync to eliminate 1-frame lag. Use props directly.
    const effectiveTime = customTime ? new Date(customTime) : new Date();

    const getDecimalHour = (date: Date, tz?: string) => {
        try {
            const parts = hmFormatter(tz).formatToParts(date);
            const h = parseInt(parts.find((p) => p.type === 'hour')?.value || '0');
            const m = parseInt(parts.find((p) => p.type === 'minute')?.value || '0');
            return h + m / 60;
        } catch (e) {
            log.warn(e);
            return date.getHours() + date.getMinutes() / 60;
        }
    };

    const currentHour = getDecimalHour(effectiveTime, timeZone);

    const getHourFromMidnight = (dateStr: string) => {
        const d = new Date(dateStr);
        const now = effectiveTime;
        const diffMs = d.getTime() - now.getTime();
        const diffHours = diffMs / (1000 * 60 * 60);
        return currentHour + diffHours;
    };

    // --- HELPER: EXACT COSINE INTERPOLATION ---
    // Takes the extremes with hour + converted height already resolved: the
    // 241-sample sweep below used to re-parse every extreme's date and
    // re-convert its height on every sample.
    const calculateTideHeightAt = (t: number, sortedTides: { hour: number; height: number }[]) => {
        let t1 = -999;
        let t2 = 999;
        let h1 = 0;
        let h2 = 0;

        for (let i = 0; i < sortedTides.length - 1; i++) {
            const timeA = sortedTides[i].hour;
            const timeB = sortedTides[i + 1].hour;

            if (t >= timeA && t <= timeB) {
                t1 = timeA;
                t2 = timeB;
                h1 = sortedTides[i].height;
                h2 = sortedTides[i + 1].height;
                break;
            }
        }

        if (t1 !== -999) {
            const phase = (Math.PI * (t - t1)) / (t2 - t1);
            const amp = (h1 - h2) / 2;
            const mid = (h1 + h2) / 2;
            return mid + amp * Math.cos(phase);
        }

        // Fallback: Nearest Neighbor
        const nearest = sortedTides.reduce((prev, curr) =>
            Math.abs(curr.hour - t) < Math.abs(prev.hour - t) ? curr : prev,
        );
        return nearest.height;
    };

    // --- SMART DATA GENERATION (MEMOIZED) ---
    const dataPoints = React.useMemo(() => {
        const points: { time: number; height: number }[] = [];

        // Priority 1: WorldTides (Authoritative Extremes) - Use Sine Interpolation
        if (tides && tides.length > 0) {
            const sortedTides = [...tides]
                .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime())
                .map((tide) => ({
                    hour: getHourFromMidnight(tide.time),
                    height: convertMetersTo(tide.height, unitPref.tideHeight || 'm') || 0,
                }));
            for (let t = 0; t <= 24; t += 0.1) {
                const h = calculateTideHeightAt(t, sortedTides);
                points.push({ time: t, height: h });
            }
        }

        // Priority 2: Use hourlyTides from Dashboard if WorldTides missing
        if (points.length < 12 && hourlyTides && hourlyTides.length > 0 && hourlyTides[0].tideHeight !== undefined) {
            hourlyTides.slice(0, 24).forEach((h, i) => {
                const t = currentHour + i;
                if (t <= 24 && h.tideHeight !== undefined) {
                    const converted = convertMetersTo(h.tideHeight, unitPref.tideHeight || 'm');
                    points.push({ time: t, height: converted || 0 });
                }
            });
        }

        // Priority 3: Use TideSeries (Sea Level API) as last resort
        if (points.length < 12 && tideSeries && tideSeries.length > 0) {
            points.length = 0;
            tideSeries.forEach((p) => {
                const h = getHourFromMidnight(p.time);
                if (h >= -2 && h <= 26) {
                    const converted = convertMetersTo(p.height, unitPref.tideHeight || 'm');
                    points.push({ time: Math.max(0, Math.min(24, h)), height: converted || 0 });
                }
            });
        }

        points.sort((a, b) => a.time - b.time);
        return points;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tides, currentHour, unitPref.tideHeight, hourlyTides, tideSeries]);

    // --- COMPREHENSIVE MARKERS (Next ~48h) ---
    // Memoised on the same minute-granular clock as dataPoints: re-formatting
    // every extreme's label on each render was the other per-render Intl cost.
    const allMarkers = React.useMemo(() => {
        if (!tides) return [] as { time: number; height: number; type: 'High' | 'Low'; labelTime: string }[];
        return tides
            .map((t) => {
                const time = getHourFromMidnight(t.time);
                if (time >= -12 && time <= 48) {
                    const hVal = convertMetersTo(t.height, unitPref.tideHeight || 'm') || 0;

                    let labelTime = '';
                    try {
                        labelTime = labelFormatter(timeZone).format(new Date(t.time));
                    } catch (_e) {
                        labelTime = labelFormatter(undefined).format(new Date(t.time));
                    }

                    return { time, height: hVal, type: t.type, labelTime };
                }
                return null;
            })
            .filter(Boolean) as { time: number; height: number; type: 'High' | 'Low'; labelTime: string }[];
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tides, timeZone, unitPref.tideHeight, currentHour, customTime]);

    const visibleMarkers = React.useMemo(() => allMarkers.filter((m) => m.time >= 0 && m.time <= 24), [allMarkers]);

    // The hero caption band's rendered height, so the chart can keep the
    // curve's crest below it rather than drawing through the values — and the
    // chart area's own height, which says when the card is short.
    const heroHeaderRef = React.useRef<HTMLDivElement | null>(null);
    const chartAreaRef = React.useRef<HTMLDivElement | null>(null);
    const [heroHeaderPx, setHeroHeaderPx] = React.useState(0);
    const [chartAreaPx, setChartAreaPx] = React.useState(0);
    const hasPoints = dataPoints.length > 0;
    React.useLayoutEffect(() => {
        const header = heroHeaderRef.current;
        const area = chartAreaRef.current;
        if (!header && !area) return;
        const measure = () => {
            if (header) setHeroHeaderPx(Math.ceil(header.getBoundingClientRect().height));
            if (area) setChartAreaPx(Math.floor(area.clientHeight));
        };
        measure();
        if (typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(measure);
        if (header) ro.observe(header);
        if (area) ro.observe(area);
        return () => ro.disconnect();
    }, [stationPosition, hasPoints]);

    if (dataPoints.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center h-full opacity-60">
                <TideCurveIcon className="w-8 h-8 text-gray-400 mb-2" />
                <span className="text-[11px] uppercase font-bold text-gray-400 tracking-widest">No tide data</span>
            </div>
        );
    }

    // --- DOT HEIGHT CALCULATION ---
    let currentHeight = 0;
    const p2Index = dataPoints.findIndex((p) => p.time >= currentHour);

    if (p2Index === -1) {
        currentHeight = dataPoints[dataPoints.length - 1]?.height || 0;
    } else if (p2Index === 0) {
        currentHeight = dataPoints[0]?.height || 0;
    } else {
        const p1 = dataPoints[p2Index - 1];
        const p2 = dataPoints[p2Index];
        const t1 = p1.time;
        const t2 = p2.time;
        const h1 = p1.height;
        const h2 = p2.height;

        if (t2 - t1 !== 0) {
            const fraction = (currentHour - t1) / (t2 - t1);
            currentHeight = h1 + fraction * (h2 - h1);
        } else {
            currentHeight = h1;
        }
    }

    const nextEvent = allMarkers.find((m) => m.time > currentHour);

    // Trend Logic
    const isSlack = visibleMarkers.some((m) => Math.abs(m.time - currentHour) < 0.33);
    const nextHourVal = dataPoints.find((p) => p.time > currentHour + 0.5 && p.time < currentHour + 1.5)?.height;
    // Past 23:00 the curve ends before the next hour: the next extreme says
    // which way the water is going, as the card's accessible name does. A
    // bare `false` drew a falling arrow on a tide rising to tomorrow's high.
    const isRising = nextHourVal !== undefined ? nextHourVal > currentHeight : nextEvent?.type === 'High';

    let TrendIcon = isRising ? ArrowUpIcon : ArrowDownIcon;
    // The card's own sky tone either way: a falling tide is not the grid's
    // red 'worsening', nor a rising one its green (UX scorecard run 9). The
    // arrow's direction carries the trend.
    let trendColor = 'text-sky-300';

    if (isSlack) {
        TrendIcon = MinusIcon;
        trendColor = 'text-sky-200';
    }

    // Scale Y-Axis
    let minHeight = Math.min(...dataPoints.map((d) => d.height));
    let maxHeight = Math.max(...dataPoints.map((d) => d.height));

    if (tides && tides.length > 0) {
        const globalHeights = tides.map((t) => convertMetersTo(t.height, unitPref.tideHeight || 'm') || 0);
        minHeight = Math.min(...globalHeights);
        maxHeight = Math.max(...globalHeights);
    }

    if (visibleMarkers.length > 0) {
        minHeight = Math.min(minHeight, ...visibleMarkers.map((m) => m.height));
        maxHeight = Math.max(maxHeight, ...visibleMarkers.map((m) => m.height));
    }

    if (minHeight === maxHeight || minHeight === Infinity || maxHeight === -Infinity) {
        minHeight = 0;
        maxHeight = 2;
    }

    const domainBuffer = (maxHeight - minHeight) * 0.2;

    // The chart's vertical range. On a short card (a 667 pt phone gives the
    // tide card about 85 pt) TideCanvas keeps 48 px of plot, so the caption
    // band's second line sat on the crest and the now-dot's halo met a height
    // (UX scorecard run 9). Here the range gains headroom instead: the crest
    // stays under the captions, and the now-dot's ring 8 px clear of them.
    // The tall card is untouched — its crest already sits below the band.
    const chartMin = minHeight - domainBuffer;
    let chartMax = maxHeight + domainBuffer;
    // Whether the canvas draws inside the caption band (its grid lines and
    // the now hairline start above the band's foot), so the band needs the
    // chart's own surface behind it.
    let bandNeedsBacking = false;
    if (stationPosition === 'bottom' && heroHeaderPx > 0 && chartAreaPx > 0) {
        // TideCanvas's own geometry: a 14 px hour-axis band, a 48 px plot
        // floor, and a 20 px least top margin, its caption band plus 4 px.
        const marginTop = Math.max(20, Math.min(heroHeaderPx + 4, chartAreaPx - 14 - 48));
        const plotH = chartAreaPx - marginTop - 14;
        // The band's foot in the chart area's own pixels (1 px of border).
        const bandFoot = heroHeaderPx - 1;
        bandNeedsBacking = marginTop < heroHeaderPx + 4;
        if (plotH > 0) {
            // A value sits `f` of the plot below its top when the range tops
            // out at (v - f·min) / (1 - f). At most three quarters: the curve
            // always keeps a quarter of the plot to draw its swing in.
            const fractionFor = (y: number) => Math.min(0.75, Math.max(0, (y - marginTop) / plotH));
            const topFor = (v: number, f: number) => (v - f * chartMin) / (1 - f);
            chartMax = Math.max(
                chartMax,
                // The crest's 3 px stroke, clear of the band's foot.
                topFor(maxHeight, fractionFor(bandFoot + 4)),
                // The now-dot's 7 px ring, 8 px under the lowest caption.
                topFor(currentHeight, fractionFor(bandFoot + 7 + 8)),
            );
        }
    }
    // A short card: its station name moves up beside the height, out of the
    // trough the curve swings through along the bottom (UX scorecard run 9).
    const shortCard = stationPosition === 'bottom' && !showAllDayEvents && chartAreaPx > 0 && chartAreaPx < 130;
    const stationLabel = guiDetails?.stationName || stationName;

    const nextHigh = allMarkers.find((m) => m.time > currentHour && m.type === 'High');
    const nextLow = allMarkers.find((m) => m.time > currentHour && m.type === 'Low');
    const nextEvents = [nextHigh, nextLow]
        .filter((e): e is NonNullable<typeof e> => Boolean(e))
        .sort((a, b) => a.time - b.time);

    const heroLabelClass = 'glass-tide-caption text-[11px] text-sky-300/80 font-bold uppercase tracking-widest';
    // One unit convention for every value in the band: a thin space, then the
    // unit in this one style ('3.3m' in bold sat beside '4.1 m' in light mono).
    const unitClass = 'text-xs font-sans font-medium text-sky-200/80 glass-tide-caption';
    // A card-coloured backing for the second line (event heights and day
    // cues) — the one line a short card's crest can still reach — so it
    // stays legible over the curve (UX scorecard run 7).
    // Arbitrary colours on purpose: daylight.css turns bg-slate-950/70 white.
    const scrimClass = 'rounded-md px-1 -mx-1 bg-[rgb(2_6_23/0.7)] [.display-light_&]:bg-[rgb(226_232_240/0.7)]';

    // An event after midnight is the next day's, on a chart whose axis ends
    // at midnight: at 18:56, 'LOW 03:13' read as this morning's low.
    const dayCue = (() => {
        const dayKey = (d: Date) => {
            try {
                return d.toLocaleDateString('en-CA', { timeZone });
            } catch {
                return d.toLocaleDateString('en-CA');
            }
        };
        const cardIsToday = dayKey(effectiveTime) === dayKey(new Date());
        return (eventHour: number): { shown: string; spoken: string } | null => {
            if (eventHour < 24) return null;
            if (cardIsToday) return { shown: 'tmrw', spoken: 'tomorrow' };
            const at = new Date(effectiveTime.getTime() + (eventHour - currentHour) * 3_600_000);
            let weekday: string;
            try {
                weekday = at.toLocaleDateString('en-GB', { weekday: 'short', timeZone });
            } catch {
                weekday = at.toLocaleDateString('en-GB', { weekday: 'short' });
            }
            return { shown: weekday, spoken: weekday };
        };
    })();
    // The cue column exists only while an event has a cue.
    const nextHasCue = nextEvents.some((e) => dayCue(e.time) !== null);

    // Round to whole minutes FIRST, then split — rounding the fraction alone
    // produced "HH:60" (audit 2026-09-02).
    const eventClock = (eventHour: number) => {
        const total = Math.round(eventHour * 60);
        const h = Math.floor(total / 60) % 24;
        const m = total % 60;
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
    };

    return (
        <div
            className={`flex flex-col h-full relative group ${className || ''}`}
            style={{ ...style, transform: 'translateZ(0)', contain: 'layout style', willChange: 'transform' }}
        >
            {/* On a short card the canvas's grid lines and now hairline start
                inside the caption band and ran through its words: the band
                takes the chart's own surface, as the tall card's band has. */}
            {stationPosition === 'bottom' && bandNeedsBacking && (
                <div
                    aria-hidden="true"
                    className="absolute left-px right-px top-px z-10 rounded-t-[11px] bg-slate-950 pointer-events-none"
                    style={{ height: heroHeaderPx + 1 }}
                />
            )}
            {/* INTUITIVE HEADER OVERLAYS */}
            {stationPosition === 'bottom' ? (
                /* HERO MODE (Clean, Single Line) */
                <div
                    ref={heroHeaderRef}
                    className="absolute top-0 left-0 right-0 z-20 flex justify-between items-baseline pl-2 pt-1.5 pointer-events-none"
                    style={{ paddingRight: 8 + reserveRightPx }}
                >
                    {/* LEFT: Height — and, on a short card, the station under it */}
                    {!showAllDayEvents ? (
                        <div className="flex flex-col min-w-0 gap-1 pointer-events-auto">
                            <div className="flex items-baseline gap-1">
                                <span className={heroLabelClass}>Height</span>
                                <span className="whitespace-nowrap leading-none">
                                    <span className="text-xl font-bold text-white tracking-tight leading-none font-mono">
                                        {currentHeight.toFixed(1)}
                                    </span>
                                    {'\u2009'}
                                    <span className={unitClass}>{unit}</span>
                                </span>
                                <TrendIcon className={`w-3 h-3 ${trendColor} ml-0.5`} />
                            </div>
                            {shortCard && stationLabel && (
                                <span
                                    className="truncate text-xs leading-4 font-semibold text-white/60 tracking-wide select-none"
                                    data-testid="tide-station-name"
                                >
                                    {stationLabel}
                                </span>
                            )}
                        </div>
                    ) : (
                        <div className="hidden"></div>
                    )}

                    {/* RIGHT: High / Low Events */}
                    {showAllDayEvents ? (
                        <div className="flex items-baseline gap-3 pointer-events-auto w-full justify-between px-2">
                            {[...visibleMarkers]
                                .sort((a, b) => a.time - b.time)
                                .map((event, idx) => {
                                    const cue = dayCue(event.time);
                                    return (
                                        // Label over its day cue, value over its height: baselines
                                        // pair across each row.
                                        <div
                                            key={idx}
                                            className="grid grid-cols-[auto_auto] items-baseline gap-x-1 gap-y-1"
                                        >
                                            <span className={`${heroLabelClass} justify-self-end`}>{event.type}</span>
                                            <span className="justify-self-end text-base font-bold text-white tracking-tight leading-none font-mono">
                                                {eventClock(event.time)}
                                            </span>
                                            {cue ? (
                                                <span
                                                    className={`${heroLabelClass} tracking-normal! justify-self-end ${scrimClass}`}
                                                    data-testid="tide-day-cue"
                                                >
                                                    <span aria-hidden="true">{cue.shown}</span>
                                                    <span className="sr-only">{cue.spoken}</span>
                                                </span>
                                            ) : (
                                                <span aria-hidden="true" />
                                            )}
                                            <span
                                                className={`justify-self-end whitespace-nowrap leading-none ${scrimClass}`}
                                            >
                                                <span className="glass-tide-caption text-sm font-medium text-sky-200/80 leading-none font-mono">
                                                    {event.height.toFixed(1)}
                                                </span>
                                                {'\u2009'}
                                                <span className={unitClass}>{unit}</span>
                                            </span>
                                        </div>
                                    );
                                })}
                        </div>
                    ) : (
                        // One line per event, soonest first: 'LOW 03:47 tmrw · 0.5 m'.
                        // The day cue follows the time it qualifies: under the
                        // label, 'TMRW 0.5m' read as tomorrow's height, and that
                        // row of chips sat on the crest of a short card (UX
                        // scorecard run 9). Columns keep times and heights aligned.
                        <div
                            className={`grid shrink-0 ${nextHasCue ? 'grid-cols-[auto_auto_auto_auto]' : 'grid-cols-[auto_auto_auto]'} items-baseline gap-x-1 gap-y-1 pointer-events-auto`}
                        >
                            {nextEvents.map((event, idx) => {
                                const cue = dayCue(event.time);
                                return (
                                    <React.Fragment key={idx}>
                                        <span className={heroLabelClass}>{event.type}</span>
                                        <span className="justify-self-end text-base font-bold text-white tracking-tight leading-none font-mono">
                                            {eventClock(event.time)}
                                        </span>
                                        {cue ? (
                                            <span
                                                className="glass-tide-caption text-xs font-semibold leading-none text-sky-200/80"
                                                data-testid="tide-day-cue"
                                            >
                                                <span aria-hidden="true">{cue.shown}</span>
                                                <span className="sr-only">{cue.spoken}</span>
                                            </span>
                                        ) : (
                                            nextHasCue && <span aria-hidden="true" />
                                        )}
                                        <span className="justify-self-end whitespace-nowrap leading-none">
                                            <span aria-hidden="true" className={unitClass}>
                                                {'· '}
                                            </span>
                                            <span className="glass-tide-caption text-sm font-medium text-sky-200/80 leading-none font-mono">
                                                {event.height.toFixed(1)}
                                            </span>
                                            {'\u2009'}
                                            <span className={unitClass}>{unit}</span>
                                        </span>
                                    </React.Fragment>
                                );
                            })}
                        </div>
                    )}
                </div>
            ) : (
                /* ORIGINAL MODE (Boxed Labels) */
                <div className="absolute top-0 left-0 right-0 z-20 flex justify-between items-start pointer-events-none">
                    {/* Current Status Box */}
                    <div className="bg-slate-900/80 rounded-xl p-2.5 border border-white/10 shadow-xl flex flex-col items-start pointer-events-auto">
                        <span className="text-[11px] text-gray-400 uppercase font-bold tracking-widest mb-0.5 flex items-center gap-1">
                            Current Tide Level
                        </span>
                        <div className={`flex items-baseline gap-1.5 ${trendColor}`}>
                            <span className="text-2xl font-mono font-bold tracking-tight text-ivory">
                                {currentHeight.toFixed(1)}
                            </span>
                            <span className="text-xs font-bold">{unit}</span>
                            <TrendIcon className="w-4 h-4 translate-y-0.5" />
                        </div>
                    </div>

                    {/* Next Event Box */}
                    {nextEvent && (
                        <div className="bg-slate-900/80 rounded-xl p-2.5 border border-white/10 shadow-xl flex flex-col items-end pointer-events-auto">
                            <span className="text-[11px] text-gray-400 uppercase font-bold tracking-widest mb-0.5 flex items-center gap-1">
                                Next {nextEvent.type === 'High' ? 'High' : 'Low'}
                            </span>
                            <div className="flex items-center gap-2">
                                <span className="text-2xl font-bold text-white tracking-tight">
                                    {nextEvent.labelTime.replace(/ [AP]M/, '')}
                                </span>
                                <span className="text-xs text-gray-400 font-bold self-end mb-1">
                                    {nextEvent.labelTime.includes('PM') ? 'PM' : 'AM'}
                                </span>
                            </div>
                            <span className="text-[11px] text-sky-400 font-mono font-bold">
                                {nextEvent.height.toFixed(1)} {unit} Target
                            </span>
                        </div>
                    )}
                </div>
            )}

            {/* CHART AREA — min-h-0, not a fixed floor: the Glass tide card
                can be shorter than 120 px on a 667 pt phone, and a floor just
                pushed the axis and the now-dot out under the card's clip
                (UX scorecard run 6). The other hosts give it 160 px anyway. */}
            <div
                ref={chartAreaRef}
                className="flex-1 w-full relative overflow-hidden rounded-xl bg-slate-950 border border-white/5 shadow-inner min-h-0"
            >
                <TideCanvas
                    dataPoints={dataPoints}
                    currentHour={currentHour}
                    currentHeight={currentHeight}
                    minHeight={chartMin}
                    maxHeight={chartMax}
                    domainBuffer={0}
                    topBandPx={stationPosition === 'bottom' ? heroHeaderPx : 0}
                    rightInsetPx={reserveRightPx}
                />
                {/* Station name — bottom left, lifted clear of the 14 px hour
                    axis band TideCanvas draws along the bottom edge. On the
                    heights' backing pill: bare, it sat on the curve with
                    nothing behind it (UX scorecard run 8). A short card
                    carries it in the caption band instead. */}
                {stationLabel && !shortCard && (
                    <span
                        className={`absolute bottom-4 left-2 text-xs leading-4 font-semibold text-white/60 tracking-wide pointer-events-none select-none ${scrimClass}`}
                        data-testid="tide-station-name"
                    >
                        {stationLabel}
                    </span>
                )}
            </div>
        </div>
    );
};

export const TideGraph = TideGraphOriginal;
