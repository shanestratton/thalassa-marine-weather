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
import { ArrowUpIcon, ArrowDownIcon, MinusIcon, GaugeIcon } from '../../Icons';
import { Tide, UnitPreferences, HourlyForecast, TidePoint } from '../../../types';
import { TideGUIDetails } from '../../../services/weather/api/tides';
import { convertMetersTo } from '../../../utils';
import { TideCanvas } from './TideCanvas';

const log = createLogger('TideGraph');

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
    className?: string;
    style?: React.CSSProperties;
}) => {
    // FIX: Remove local state sync to eliminate 1-frame lag. Use props directly.
    const effectiveTime = customTime ? new Date(customTime) : new Date();

    const getDecimalHour = (date: Date, tz?: string) => {
        try {
            const parts = new Intl.DateTimeFormat('en-US', {
                timeZone: tz,
                hour: 'numeric',
                minute: 'numeric',
                hour12: false,
            }).formatToParts(date);
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
    const calculateTideHeightAt = (t: number, sortedTides: Tide[]) => {
        let t1 = -999;
        let t2 = 999;
        let h1 = 0;
        let h2 = 0;

        for (let i = 0; i < sortedTides.length - 1; i++) {
            const timeA = getHourFromMidnight(sortedTides[i].time);
            const timeB = getHourFromMidnight(sortedTides[i + 1].time);

            if (t >= timeA && t <= timeB) {
                t1 = timeA;
                t2 = timeB;
                h1 = convertMetersTo(sortedTides[i].height, unitPref.tideHeight || 'm') || 0;
                h2 = convertMetersTo(sortedTides[i + 1].height, unitPref.tideHeight || 'm') || 0;
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
        const nearest = sortedTides.reduce((prev, curr) => {
            const timeC = getHourFromMidnight(curr.time);
            const timeP = getHourFromMidnight(prev.time);
            return Math.abs(timeC - t) < Math.abs(timeP - t) ? curr : prev;
        });
        return convertMetersTo(nearest.height, unitPref.tideHeight || 'm') || 0;
    };

    // --- SMART DATA GENERATION (MEMOIZED) ---
    const dataPoints = React.useMemo(() => {
        const points: { time: number; height: number }[] = [];

        // Priority 1: WorldTides (Authoritative Extremes) - Use Sine Interpolation
        if (tides && tides.length > 0) {
            const sortedTides = [...tides].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
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
    const allMarkers = tides
        ? (tides
              .map((t) => {
                  const time = getHourFromMidnight(t.time);
                  if (time >= -12 && time <= 48) {
                      const hVal = convertMetersTo(t.height, unitPref.tideHeight || 'm') || 0;

                      let labelTime = '';
                      try {
                          labelTime = new Date(t.time).toLocaleTimeString('en-US', {
                              timeZone: timeZone,
                              hour: 'numeric',
                              minute: '2-digit',
                              hour12: true,
                          });
                      } catch (_e) {
                          labelTime = new Date(t.time).toLocaleTimeString('en-US', {
                              hour: 'numeric',
                              minute: '2-digit',
                              hour12: true,
                          });
                      }

                      return { time, height: hVal, type: t.type, labelTime };
                  }
                  return null;
              })
              .filter(Boolean) as { time: number; height: number; type: 'High' | 'Low'; labelTime: string }[])
        : [];

    const visibleMarkers = allMarkers.filter((m) => m.time >= 0 && m.time <= 24);

    if (dataPoints.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center h-full opacity-60">
                <GaugeIcon className="w-8 h-8 text-gray-400 mb-2" />
                <span className="text-[11px] uppercase font-bold text-gray-400 tracking-widest">
                    Awaiting Telemetry
                </span>
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
    const isRising = nextHourVal !== undefined ? nextHourVal > currentHeight : false;

    let TrendIcon = isRising ? ArrowUpIcon : ArrowDownIcon;
    let trendColor = isRising ? 'text-emerald-400' : 'text-red-400';

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

    const nextHigh = allMarkers.find((m) => m.time > currentHour && m.type === 'High');
    const nextLow = allMarkers.find((m) => m.time > currentHour && m.type === 'Low');

    const heroLabelClass = 'text-[11px] text-sky-300/80 font-bold uppercase tracking-widest';

    return (
        <div
            className={`flex flex-col h-full relative group ${className || ''}`}
            style={{ ...style, transform: 'translateZ(0)', contain: 'layout style', willChange: 'transform' }}
        >
            {/* INTUITIVE HEADER OVERLAYS */}
            {stationPosition === 'bottom' ? (
                /* HERO MODE (Clean, Single Line) */
                <div className="absolute top-0 left-0 right-0 z-20 flex justify-between items-baseline px-2 pt-1.5 pointer-events-none">
                    {/* LEFT: Height */}
                    {!showAllDayEvents ? (
                        <div className="flex items-baseline gap-1.5 pointer-events-auto">
                            <span className={heroLabelClass}>Height</span>
                            <div className="flex items-baseline gap-0.5">
                                <span className="text-sm font-bold text-white tracking-tight leading-none font-mono">
                                    {currentHeight.toFixed(1)}
                                </span>
                                <span className="text-[11px] text-sky-200 font-medium">{unit}</span>
                            </div>
                            <TrendIcon className={`w-3 h-3 ${trendColor} ml-0.5`} />
                        </div>
                    ) : (
                        <div className="hidden"></div>
                    )}

                    {/* RIGHT: High / Low Events */}
                    <div
                        className={`flex items-baseline gap-4 pointer-events-auto ${showAllDayEvents ? 'w-full justify-between px-2' : ''}`}
                    >
                        {(showAllDayEvents ? visibleMarkers : [nextHigh, nextLow])
                            .filter(Boolean)
                            .sort((a, b) => a!.time - b!.time)
                            .map((event, idx) => (
                                <div key={idx} className="flex items-start gap-1.5">
                                    <span className={`${heroLabelClass} mt-[2px]`}>{event!.type}</span>
                                    <div className="flex flex-col items-end">
                                        <span className="text-sm font-bold text-white tracking-tight leading-none font-mono">
                                            {(() => {
                                                const h = Math.floor(event!.time) % 24;
                                                const m = Math.round((event!.time - Math.floor(event!.time)) * 60);
                                                return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
                                            })()}
                                        </span>
                                        <span className="text-sm font-medium text-sky-200/80 leading-none mt-1 font-mono">
                                            {event!.height.toFixed(1)} {unit}
                                        </span>
                                    </div>
                                </div>
                            ))}
                    </div>
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

            {/* CHART AREA */}
            <div className="flex-1 w-full relative overflow-hidden rounded-xl bg-slate-950 border border-white/5 shadow-inner min-h-[120px]">
                <TideCanvas
                    dataPoints={dataPoints}
                    currentHour={currentHour}
                    currentHeight={currentHeight}
                    minHeight={minHeight}
                    maxHeight={maxHeight}
                    domainBuffer={domainBuffer}
                />
                {/* Station name — bottom left */}
                {(guiDetails?.stationName || stationName) && (
                    <span className="absolute bottom-1.5 left-2 text-[11px] font-semibold text-white/60 tracking-wide pointer-events-none select-none">
                        {guiDetails?.stationName || stationName}
                    </span>
                )}
            </div>
        </div>
    );
};

export const TideGraph = TideGraphOriginal;
