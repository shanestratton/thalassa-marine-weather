
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Card } from './shared/Card';
import { PowerBoatIcon, SailBoatIcon, TideCurveIcon, SearchIcon, ArrowUpIcon, ArrowDownIcon, MinusIcon, CloudIcon, GaugeIcon, ClockIcon, MoonIcon, SunIcon, EyeIcon, StarIcon } from '../Icons';
import { Tide, UnitPreferences, VesselProfile, WeatherMetrics, HourlyForecast, TidePoint } from '../../types';
import { TideGUIDetails } from '../../services/weather/api/tides';
import { calculateMCR, calculateCSF, calculateDLR, calculateHullSpeed, convertDistance, convertLength, convertMetersTo } from '../../utils';

/** Vessel safety status, derived from weather conditions vs vessel limits */
export interface VesselStatus {
    status?: 'safe' | 'unsafe';
}

/** CSS class overrides for vessel status display elements */
export type VesselStatusStyles = Record<string, string>;

// --- CELESTIAL COMPONENTS (Extracted for modularity) ---
import { MoonVisual, SolarArc, getMoonPhaseData } from './tide/CelestialComponents';
export { MoonVisual, SolarArc, getMoonPhaseData };


// SolarArc is now imported from CelestialComponents



// --- CANVAS-BASED TIDE CHART ---
// Replaces the old Recharts StaticTideBackground + ActiveTideOverlay with a single <canvas>.
// Canvas eliminates SVG DOM overhead and merges what were two stacked AreaCharts into one draw call.

const TideCanvas = React.memo(({ dataPoints, currentHour, currentHeight, minHeight, maxHeight, domainBuffer }: {
    dataPoints: { time: number; height: number }[];
    currentHour: number;
    currentHeight: number;
    minHeight: number;
    maxHeight: number;
    domainBuffer: number;

}) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    const draw = useCallback(() => {
        const canvas = canvasRef.current;
        const container = containerRef.current;
        if (!canvas || !container || dataPoints.length < 2) return;

        const dpr = window.devicePixelRatio || 1;
        const rect = container.getBoundingClientRect();
        const w = rect.width;
        const h = rect.height;

        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.scale(dpr, dpr);

        // Chart area with margins matching old Recharts layout
        const marginTop = 20;
        const marginRight = 0;
        const marginLeft = 0;
        const marginBottom = 4;
        const plotW = w - marginLeft - marginRight;
        const plotH = h - marginTop - marginBottom;

        const yMin = minHeight - domainBuffer;
        const yMax = maxHeight + domainBuffer;

        // Coordinate mappers
        const toX = (time: number) => marginLeft + (time / 24) * plotW;
        const toY = (height: number) => marginTop + plotH - ((height - yMin) / (yMax - yMin)) * plotH;

        // Clear
        ctx.clearRect(0, 0, w, h);

        // --- Helper: get interpolated height at any time ---
        const getHeightAtTime = (t: number): number => {
            const idx = dataPoints.findIndex(p => p.time >= t);
            if (idx === -1) return dataPoints[dataPoints.length - 1].height;
            if (idx === 0) return dataPoints[0].height;
            const p1 = dataPoints[idx - 1];
            const p2 = dataPoints[idx];
            const frac = (t - p1.time) / (p2.time - p1.time);
            return p1.height + frac * (p2.height - p1.height);
        };

        // --- Height-to-color helper (neon gradient: cyan at high, orange at low) ---
        const getHeightColor = (height: number): { r: number; g: number; b: number } => {
            const t = (height - yMin) / (yMax - yMin); // 0 = bottom, 1 = top
            // Orange (warm) at low: rgb(251, 146, 60)
            // Cyan (cool) at high: rgb(34, 211, 238)
            return {
                r: Math.round(251 + (34 - 251) * t),
                g: Math.round(146 + (211 - 146) * t),
                b: Math.round(60 + (238 - 60) * t),
            };
        };

        // --- FILL: Professional area shading under the curve ---
        // Uses a smooth vertical gradient that's visible but not overpowering.
        // Blends cyan/teal to match the neon stroke palette.
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(toX(dataPoints[0].time), toY(dataPoints[0].height));
        for (let i = 1; i < dataPoints.length; i++) {
            ctx.lineTo(toX(dataPoints[i].time), toY(dataPoints[i].height));
        }
        ctx.lineTo(toX(dataPoints[dataPoints.length - 1].time), h);
        ctx.lineTo(toX(dataPoints[0].time), h);
        ctx.closePath();

        const fillGrad = ctx.createLinearGradient(0, marginTop, 0, h);
        fillGrad.addColorStop(0, 'rgba(34, 211, 238, 0.25)');   // Cyan at peaks — 25%
        fillGrad.addColorStop(0.3, 'rgba(20, 184, 166, 0.18)');   // Teal blend
        fillGrad.addColorStop(0.6, 'rgba(20, 184, 166, 0.08)');   // Gentle fade
        fillGrad.addColorStop(1, 'rgba(20, 184, 166, 0.0)');    // Transparent at bottom
        ctx.fillStyle = fillGrad;
        ctx.fill();
        ctx.restore();

        // --- NEON STROKE (Two-pass for performance) ---

        // Pass 1: Single glow underlay (one stroke call — fast)
        ctx.save();
        ctx.shadowColor = 'rgba(34, 211, 238, 0.4)';
        ctx.shadowBlur = 12;
        ctx.lineWidth = 5;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(34, 211, 238, 0.25)';
        ctx.beginPath();
        ctx.moveTo(toX(dataPoints[0].time), toY(dataPoints[0].height));
        for (let i = 1; i < dataPoints.length; i++) {
            ctx.lineTo(toX(dataPoints[i].time), toY(dataPoints[i].height));
        }
        ctx.stroke();
        ctx.restore();

        // Pass 2: Per-segment colored stroke (NO shadow — fast)
        ctx.save();
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        for (let i = 1; i < dataPoints.length; i++) {
            const p0 = dataPoints[i - 1];
            const p1 = dataPoints[i];
            const midHeight = (p0.height + p1.height) / 2;

            let segColor: string;
            {
                const c = getHeightColor(midHeight);
                segColor = `rgb(${c.r}, ${c.g}, ${c.b})`;
            }

            ctx.beginPath();
            ctx.moveTo(toX(p0.time), toY(p0.height));
            ctx.lineTo(toX(p1.time), toY(p1.height));
            ctx.strokeStyle = segColor;
            ctx.stroke();
        }
        ctx.restore();


        // --- CURRENT TIME: Hairline vertical + Glow Dot ---
        if (currentHour >= 0 && currentHour <= 24) {
            const cx = toX(currentHour);
            const cy = toY(currentHeight);

            // Hairline vertical line (30% opacity)
            ctx.save();
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
            ctx.lineWidth = 0.5;
            ctx.beginPath();
            ctx.moveTo(cx, marginTop);
            ctx.lineTo(cx, h - marginBottom);
            ctx.stroke();
            ctx.restore();

            // Determine dot color — red if below draft, else match the curve color
            const isDanger = false;
            const dotC = isDanger
                ? { r: 239, g: 68, b: 68 }
                : getHeightColor(currentHeight);

            // Outer halo glow (semi-transparent colored ring)
            ctx.save();
            ctx.beginPath();
            ctx.arc(cx, cy, 10, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(${dotC.r}, ${dotC.g}, ${dotC.b}, 0.2)`;
            ctx.fill();
            ctx.restore();

            // Mid ring
            ctx.beginPath();
            ctx.arc(cx, cy, 7, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(${dotC.r}, ${dotC.g}, ${dotC.b}, 0.35)`;
            ctx.fill();

            // Solid white center (4px)
            ctx.beginPath();
            ctx.arc(cx, cy, 4, 0, Math.PI * 2);
            ctx.fillStyle = '#ffffff';
            ctx.fill();
        }
    }, [dataPoints, currentHour, currentHeight, minHeight, maxHeight, domainBuffer]);

    useEffect(() => {
        draw();
        const container = containerRef.current;
        if (!container) return;

        const ro = new ResizeObserver(() => draw());
        ro.observe(container);
        return () => ro.disconnect();
    }, [draw]);

    return (
        <div ref={containerRef} className="absolute inset-0">
            <canvas ref={canvasRef} className="absolute inset-0" />
        </div>
    );
}, (prev, next) => {
    // Re-render when data, time position, scale, or draft changes
    return prev.dataPoints === next.dataPoints &&
        prev.currentHour === next.currentHour &&
        prev.currentHeight === next.currentHeight &&
        prev.minHeight === next.minHeight &&
        prev.maxHeight === next.maxHeight;
});

export const TideGraphOriginal = ({ tides, unit, timeZone, hourlyTides, tideSeries, modelUsed, unitPref, stationName, secondaryStationName, guiDetails, stationPosition = 'bottom', customTime, showAllDayEvents, className, style }: { tides: Tide[], unit: string, timeZone?: string, hourlyTides?: HourlyForecast[], tideSeries?: TidePoint[], modelUsed?: string, unitPref: UnitPreferences, stationName?: string, secondaryStationName?: string, guiDetails?: TideGUIDetails, stationPosition?: 'top' | 'bottom', customTime?: number, showAllDayEvents?: boolean, className?: string, style?: React.CSSProperties }) => {
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
            const h = parseInt(parts.find(p => p.type === 'hour')?.value || '0');
            const m = parseInt(parts.find(p => p.type === 'minute')?.value || '0');
            return h + (m / 60);
        } catch {
            /* Invalid timeZone or Intl unavailable — fall back to local device time */
            return date.getHours() + (date.getMinutes() / 60);
        }
    };

    // Derived immediately from props
    const currentHour = getDecimalHour(effectiveTime, timeZone);

    // Helper for Time Difference
    const getHourFromMidnight = (dateStr: string) => {
        const d = new Date(dateStr);
        // Use effectiveTime (prop) instead of local state
        const now = effectiveTime;
        const diffMs = d.getTime() - now.getTime();
        const diffHours = diffMs / (1000 * 60 * 60);
        return currentHour + diffHours;
    };

    // --- HELPER: EXACT COSINE INTERPOLATION ---
    // Extracting this logic allows us to use it for BOTH the graph generation AND the dot.
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
            const phase = Math.PI * (t - t1) / (t2 - t1);
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
    // Optimization: Only recalculate points when tides/hourly/tideSeries/customTime changes
    // FIX: All data building + sorting consolidated inside useMemo.
    // Previously, code outside the memo tried to .push() and .sort() on the frozen
    // memoized array, causing "Attempted to assign to readonly property" on iOS WebKit.
    const dataPoints = React.useMemo(() => {
        const points: { time: number, height: number }[] = [];

        // Priority 1: WorldTides (Authoritative Extremes) - Use Sine Interpolation
        if (tides && tides.length > 0) {
            const sortedTides = [...tides].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

            for (let t = 0; t <= 24; t += 0.1) { // 6min resolution
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
                    points.push({
                        time: t,
                        height: converted || 0
                    });
                }
            });
        }

        // Priority 3: Use TideSeries (Sea Level API) as last resort
        if (points.length < 12 && tideSeries && tideSeries.length > 0) {
            points.length = 0;
            tideSeries.forEach(p => {
                const h = getHourFromMidnight(p.time);
                if (h >= -2 && h <= 26) {
                    const converted = convertMetersTo(p.height, unitPref.tideHeight || 'm');
                    points.push({ time: Math.max(0, Math.min(24, h)), height: converted || 0 });
                }
            });
        }

        // Sort once before returning
        points.sort((a, b) => a.time - b.time);
        return points;
    }, [tides, currentHour, unitPref.tideHeight, hourlyTides, tideSeries]);

    // --- COMPREHENSIVE MARKERS (Next ~48h) ---
    // We need a broader range to find the "Next" high/low even if it's tomorrow (time > 24).
    const allMarkers = tides ? tides.map(t => {
        const time = getHourFromMidnight(t.time);
        // Allow broad range for "Next Event" lookup
        if (time >= -12 && time <= 48) {
            const hVal = convertMetersTo(t.height, unitPref.tideHeight || 'm') || 0;

            // FIX: Use Location Timezone for Label
            let labelTime = '';
            try {
                labelTime = new Date(t.time).toLocaleTimeString('en-US', {
                    timeZone: timeZone,
                    hour: 'numeric',
                    minute: '2-digit',
                    hour12: true
                });
            } catch (e) {
                // Fallback if timezone invalid
                labelTime = new Date(t.time).toLocaleTimeString('en-US', {
                    hour: 'numeric',
                    minute: '2-digit',
                    hour12: true
                });
            }

            return {
                time,
                height: hVal,
                type: t.type,
                labelTime
            };
        }
        return null;
    }).filter(Boolean) as { time: number, height: number, type: 'High' | 'Low', labelTime: string }[] : [];

    // --- VISIBLE MARKERS (Graph Only 0-24h) ---
    const visibleMarkers = allMarkers.filter(m => m.time >= 0 && m.time <= 24);

    // PERFORMANCE FIX: REMOVED VERTEX INJECTION
    // Injecting the currentHour into dataPoints caused the StaticTideBackground to re-render 
    // on every frame of the scroll, killing performance.
    // We rely on the High Resolution (6-min) data + Exact Cosine Math for the dot to ensure alignment.

    if (dataPoints.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center h-full opacity-60">
                <GaugeIcon className="w-8 h-8 text-gray-600 mb-2" />
                <span className="text-[10px] uppercase font-bold text-gray-500 tracking-widest">Awaiting Telemetry</span>
            </div>
        );
    }

    // FIX: DOT HEIGHT CALCULATION
    // Instead of looking up the "closest point" or linearly interpolating, we calculate the EXACT height
    // using the same cosine math used to generate the curve. This ensures 100% alignment.
    let currentHeight = 0;

    // FIX: VISUAL ALIGNMENT
    // The graph renders linear segments between dataPoints.
    // To ensure the DOT lies ON THE LINE, we must mathematically replicate that linear interpolation exactly.
    // We do NOT use the cosine helper here because the visual graph "cuts corners" at high/low tides.
    // We must match the visual corner-cutting to be pixel-perfect.

    // Find the interval [p1, p2] where p1.time <= currentHour <= p2.time
    const p2Index = dataPoints.findIndex(p => p.time >= currentHour);

    if (p2Index === -1) {
        // Time is after last point
        currentHeight = dataPoints[dataPoints.length - 1]?.height || 0;
    } else if (p2Index === 0) {
        // Time is before first point
        currentHeight = dataPoints[0]?.height || 0;
    } else {
        const p1 = dataPoints[p2Index - 1];
        const p2 = dataPoints[p2Index];

        const t1 = p1.time;
        const t2 = p2.time;
        const h1 = p1.height;
        const h2 = p2.height;

        // Linear Interpolation: y = y1 + (x - x1) * (y2 - y1) / (x2 - x1)
        if (t2 - t1 !== 0) {
            const fraction = (currentHour - t1) / (t2 - t1);
            currentHeight = h1 + fraction * (h2 - h1);
        } else {
            currentHeight = h1;
        }
    }

    // Find next event (inclusive of tomorrow)
    const nextEvent = allMarkers.find(m => m.time > currentHour);

    // Trend Logic
    // Check for "Slack / Stand" period (approx 20 mins either side of High/Low)
    const isSlack = visibleMarkers.some(m => Math.abs(m.time - currentHour) < 0.33);

    const nextHourVal = dataPoints.find(p => p.time > currentHour + 0.5 && p.time < currentHour + 1.5)?.height;
    const isRising = nextHourVal !== undefined ? nextHourVal > currentHeight : false;

    let TrendIcon = isRising ? ArrowUpIcon : ArrowDownIcon;
    let trendColor = isRising ? "text-emerald-400" : "text-red-400";

    if (isSlack) {
        TrendIcon = MinusIcon;
        trendColor = "text-blue-200"; // Neutral color for slack
    }

    // Scale Y-Axis based on GLOBAL markers (props.tides) to prevent "Zooming" on low-variance days.
    // If we only use dataPoints (0-24h), a day with small tides will auto-scale to fill the box, making it inconsistent.

    // Default to dataPoints if no global tides
    let minHeight = Math.min(...dataPoints.map(d => d.height));
    let maxHeight = Math.max(...dataPoints.map(d => d.height));

    if (tides && tides.length > 0) {
        // Use the full available dataset for scaling context
        const globalHeights = tides.map(t => convertMetersTo(t.height, unitPref.tideHeight || 'm') || 0);
        minHeight = Math.min(...globalHeights);
        maxHeight = Math.max(...globalHeights);
    }

    // Include visible markers in case they exceed the curve (rare but possible)
    if (visibleMarkers.length > 0) {
        minHeight = Math.min(minHeight, ...visibleMarkers.map(m => m.height));
        maxHeight = Math.max(maxHeight, ...visibleMarkers.map(m => m.height));
    }

    if (minHeight === maxHeight || minHeight === Infinity || maxHeight === -Infinity) {
        minHeight = 0;
        maxHeight = 2; // Fallback range
    }




    const domainBuffer = (maxHeight - minHeight) * 0.2;

    // Find next high and low for Hero Mode (using ALL markers)
    const nextHigh = allMarkers.find(m => m.time > currentHour && m.type === 'High');
    const nextLow = allMarkers.find(m => m.time > currentHour && m.type === 'Low');

    const heroLabelClass = "text-[9px] text-blue-300/80 font-bold uppercase tracking-widest";
    const heroValueClass = "text-xl font-bold text-white tracking-tight leading-none";

    return (
        <div className={`flex flex-col h-full relative group ${className || ''}`} style={{ ...style, transform: 'translateZ(0)', contain: 'layout style', willChange: 'transform' }}>
            {/* INTUITIVE HEADER OVERLAYS */}
            {stationPosition === 'bottom' ? (
                /* HERO MODE (Clean, Single Line) */
                <div className="absolute top-0 left-0 right-0 z-20 flex justify-between items-baseline px-2 pt-1.5 pointer-events-none">
                    {/* LEFT: Height (Only if NOT showing all day events) */}
                    {!showAllDayEvents ? (
                        <div className="flex items-baseline gap-1.5 pointer-events-auto">
                            <span className={heroLabelClass}>Height</span>
                            <div className="flex items-baseline gap-0.5">
                                <span className="text-sm font-bold text-white tracking-tight leading-none font-mono">{currentHeight.toFixed(1)}</span>
                                <span className="text-[10px] text-blue-200 font-medium">{unit}</span>
                            </div>
                            <TrendIcon className={`w-3 h-3 ${trendColor} ml-0.5`} />
                        </div>
                    ) : (
                        <div className="hidden"></div>
                    )}

                    {/* RIGHT: High / Low Events */}
                    <div className={`flex items-baseline gap-4 pointer-events-auto ${showAllDayEvents ? 'w-full justify-between px-2' : ''}`}>
                        {(showAllDayEvents ? visibleMarkers : [nextHigh, nextLow]).filter(Boolean).sort((a, b) => a!.time - b!.time).map((event, idx) => (
                            <div key={idx} className="flex items-start gap-1.5">
                                <span className={`${heroLabelClass} mt-[2px]`}>{event!.type}</span>
                                <div className="flex flex-col items-end">
                                    <span className="text-sm font-bold text-white tracking-tight leading-none font-mono">
                                        {(() => {
                                            const h = Math.floor(event!.time) % 24; // Modulo 24 for tomorrow times
                                            const m = Math.round((event!.time - Math.floor(event!.time)) * 60);
                                            return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
                                        })()}
                                    </span>
                                    <span className="text-sm font-medium text-blue-200/80 leading-none mt-1 font-mono">
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
                    <div className="bg-slate-900/80 backdrop-blur-md rounded-xl p-2.5 border border-white/10 shadow-xl flex flex-col items-start pointer-events-auto">
                        <span className="text-[9px] text-gray-400 uppercase font-bold tracking-widest mb-0.5 flex items-center gap-1">
                            Current Tide Level
                        </span>
                        <div className={`flex items-baseline gap-1.5 ${trendColor}`}>
                            <span className="text-2xl font-mono font-bold tracking-tight text-ivory">{currentHeight.toFixed(1)}</span>
                            <span className="text-xs font-bold">{unit}</span>
                            <TrendIcon className="w-4 h-4 translate-y-0.5" />
                        </div>
                    </div>

                    {/* Next Event Box */}
                    {nextEvent && (
                        <div className="bg-slate-900/80 backdrop-blur-md rounded-xl p-2.5 border border-white/10 shadow-xl flex flex-col items-end pointer-events-auto">
                            <span className="text-[9px] text-gray-400 uppercase font-bold tracking-widest mb-0.5 flex items-center gap-1">
                                Next {nextEvent.type === 'High' ? 'High' : 'Low'}
                            </span>
                            <div className="flex items-center gap-2">
                                <span className="text-2xl font-bold text-white tracking-tight">{nextEvent.labelTime.replace(/ [AP]M/, '')}</span>
                                <span className="text-xs text-gray-500 font-bold self-end mb-1">{nextEvent.labelTime.includes('PM') ? 'PM' : 'AM'}</span>
                            </div>
                            <span className="text-[10px] text-sky-400 font-mono font-bold">{nextEvent.height.toFixed(1)} {unit} Target</span>
                        </div>
                    )}
                </div>
            )}

            {/* CHART AREA */}
            {/* CHART AREA */}
            <div className="flex-1 w-full relative overflow-hidden rounded-xl bg-slate-950 border border-white/5 shadow-inner min-h-[120px]">
                {/* Canvas-based tide chart (replaces old Recharts split architecture) */}
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
                    <span className="absolute bottom-1.5 left-2 text-[9px] font-semibold text-white/50 tracking-wide pointer-events-none select-none">
                        {guiDetails?.stationName || stationName}
                    </span>
                )}
            </div>


        </div>
    );
};

export const TideGraph = TideGraphOriginal;

export const TideWidget = ({ tides, hourlyTides, tideHourly, units, timeZone, modelUsed, stationName, guiDetails, customTime, showAllDayEvents }: { tides: Tide[], hourlyTides: HourlyForecast[], tideHourly?: TidePoint[], units: UnitPreferences, timeZone?: string, modelUsed?: string, stationName?: string, guiDetails?: TideGUIDetails, customTime?: number, showAllDayEvents?: boolean }) => {
    return (
        <Card key={guiDetails ? JSON.stringify(guiDetails) : 'tide-widget-loading'} className="bg-slate-900/60 border border-white/10 p-5 flex flex-col justify-between min-h-[220px] relative overflow-hidden gap-4" role="figure" aria-labelledby="tide-chart-title" aria-describedby="tide-chart-desc">
            {/* Header */}
            <div className="flex justify-between items-start border-b border-white/5 pb-2">
                <div className="flex items-center gap-2">
                    <TideCurveIcon className="w-5 h-5 text-sky-400" aria-hidden="true" />
                    <div className="flex flex-col">
                        <h3 id="tide-chart-title" className="text-sm font-bold text-white uppercase tracking-widest">
                            Tidal Forecast {guiDetails?.stationName ? <span className="text-sky-400">• {guiDetails.stationName}</span> : ''}
                        </h3>
                    </div>

                </div>
            </div>
            <span id="tide-chart-desc" className="sr-only">Interactive tidal forecast graph showing predicted tide heights over 24 hours. The moving indicator shows the current tide level.</span>

            {/* Graph Area */}
            <div className="flex-1 w-full min-h-[160px] relative z-10">
                <TideGraph tides={tides} unit={units.tideHeight || 'm'} timeZone={timeZone} hourlyTides={hourlyTides} tideSeries={tideHourly} modelUsed={modelUsed} unitPref={units} stationName={stationName} guiDetails={guiDetails} customTime={customTime} showAllDayEvents={showAllDayEvents} />
            </div>
        </Card>
    );
};

export const SunMoonWidget = ({ current, units, timeZone, lat }: { current: WeatherMetrics, units: UnitPreferences, timeZone?: string, lat?: number }) => {
    return (
        <Card className="bg-slate-900/60 border border-white/10 p-5 flex flex-col gap-4">
            {/* Header */}
            <div className="flex items-center gap-2 mb-2">
                <StarIcon className="w-5 h-5 text-indigo-300" />
                <h3 className="text-sm font-bold text-indigo-300 uppercase tracking-widest">Celestial</h3>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-center">
                {/* Moon Side */}
                <div className="flex items-center justify-center p-2 border-b md:border-b-0 md:border-r border-white/5">
                    <MoonVisual
                        cloudCover={current.cloudCover || 0}
                        apiPhase={current.moonPhase}
                        apiIllumination={current.moonIllumination}
                        apiPhaseValue={current.moonPhaseValue}
                        lat={lat}
                    />
                </div>

                {/* Sun Side */}
                <div className="flex items-center justify-center p-2 w-full">
                    {current.sunrise && current.sunset && (
                        <div className="w-full">
                            <div className="text-[10px] text-gray-400 font-bold uppercase tracking-wider mb-2 text-center">Solar Cycle</div>
                            <SolarArc sunrise={current.sunrise} sunset={current.sunset} size="normal" showTimes={true} timeZone={timeZone} />
                        </div>
                    )}
                </div>
            </div>
        </Card>
    );
};

export const VesselWidget = ({ vessel, vesselStatus }: { vessel: VesselProfile, vesselStatus: VesselStatus }) => {
    // --- MARINE CALCULATIONS ---
    const hullSpeed = vessel && vessel.type !== 'observer' ? calculateHullSpeed(vessel.length) : null;
    const mcr = vessel && vessel.type === 'sail' ? calculateMCR(vessel.displacement, vessel.length, vessel.beam) : null;
    const csf = vessel && vessel.type === 'sail' ? calculateCSF(vessel.displacement, vessel.beam) : null;
    const dlr = vessel && vessel.type === 'sail' ? calculateDLR(vessel.displacement, vessel.length) : null;

    if (!vessel || vessel.type === 'observer') {
        return (
            <Card className="bg-slate-900/60 border border-white/10 p-5 flex flex-col justify-center items-center h-full text-center min-h-[220px]">
                <SearchIcon className="w-12 h-12 text-gray-600 mb-3" />
                <h3 className="text-lg font-medium text-white mb-1">Observer Mode</h3>
                <p className="text-xs text-gray-400 max-w-[200px]">Configure a vessel profile to see hydrostatics.</p>
            </Card>
        );
    }

    return (
        <Card className="bg-slate-900/60 border border-white/10 p-5 flex flex-col justify-between min-h-[220px]">
            <div className="flex justify-between items-start mb-2">
                <div className="flex items-center gap-2 text-orange-300">
                    {vessel.type === 'power' ? <PowerBoatIcon className="w-5 h-5" /> : <SailBoatIcon className="w-5 h-5" />}
                    <span className="text-sm font-bold uppercase tracking-widest truncate max-w-[150px]">{vessel.name}</span>
                </div>
                <div className={`px-2 py-1 rounded border text-[10px] font-bold uppercase ${vesselStatus?.status === 'unsafe' ? 'bg-red-500/20 border-red-500/50 text-red-300' : 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300'}`}>
                    {vesselStatus?.status === 'unsafe' ? 'Limits Exceeded' : 'Within Limits'}
                </div>
            </div>

            <div className="grid grid-cols-2 gap-4 mt-2">
                <div className="bg-white/5 rounded-xl p-3 border border-white/5">
                    <span className="text-[10px] text-gray-400 uppercase font-bold block mb-1">Hull Speed</span>
                    <span className="text-xl font-mono font-bold text-white">{hullSpeed?.toFixed(1)} <span className="text-xs text-gray-500">kts</span></span>
                </div>
                <div className="bg-white/5 rounded-xl p-3 border border-white/5">
                    <span className="text-[10px] text-gray-400 uppercase font-bold block mb-1">Displacement</span>
                    <span className="text-xl font-mono font-bold text-white">{(vessel.displacement / 2204.62).toFixed(1)} <span className="text-xs text-gray-500">t</span></span>
                </div>
                {vessel.type === 'sail' && (
                    <>
                        {mcr && (
                            <div className="bg-white/5 rounded-xl p-3 border border-white/5">
                                <span className="text-[10px] text-gray-400 uppercase font-bold block mb-1">Comfort</span>
                                <span className={`text-xl font-mono font-bold ${mcr > 30 ? 'text-emerald-300' : mcr > 20 ? 'text-yellow-300' : 'text-orange-300'}`}>{Math.round(mcr)}</span>
                            </div>
                        )}
                        {csf && (
                            <div className="bg-white/5 rounded-xl p-3 border border-white/5">
                                <span className="text-[10px] text-gray-400 uppercase font-bold block mb-1">Capsize</span>
                                <span className={`text-xl font-mono font-bold ${csf < 2 ? 'text-emerald-300' : 'text-red-300'}`}>{csf.toFixed(2)}</span>
                            </div>
                        )}
                    </>
                )}
            </div>
        </Card>
    );
};

// --- LEGACY EXPORT FOR BACKWARD COMPAT (DEPRECATED) ---
export const VesselStatusWidget = ({ vessel, current, vesselStatus, statusStyles, tides, hourlyTides, tideHourly, units, timeZone, modelUsed, isLandlocked, lat }: { vessel: VesselProfile, current: WeatherMetrics, vesselStatus: VesselStatus, statusStyles: VesselStatusStyles, tides: Tide[], hourlyTides: HourlyForecast[], tideHourly?: TidePoint[], units: UnitPreferences, timeZone?: string, modelUsed?: string, isLandlocked?: boolean, lat?: number }) => {

    // --- MARINE CALCULATIONS ---
    const hullSpeed = vessel && vessel.type !== 'observer' ? calculateHullSpeed(vessel.length) : null;
    const mcr = vessel && vessel.type === 'sail' ? calculateMCR(vessel.displacement, vessel.length, vessel.beam) : null;
    const csf = vessel && vessel.type === 'sail' ? calculateCSF(vessel.displacement, vessel.length) : null;
    const dlr = vessel && vessel.type === 'sail' ? calculateDLR(vessel.displacement, vessel.length) : null;

    if (isLandlocked) {
        // --- INLAND VIEW (Solar Cycle & Atmosphere) ---
        return (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
                {/* Card 1: Solar Cycle (Replaces Tides) */}
                <Card className="bg-slate-900/60 border border-white/10 p-5 flex flex-col justify-start relative overflow-hidden gap-4">
                    <div className="flex items-center gap-2 mb-2">
                        <SunIcon className="w-5 h-5 text-orange-400" />
                        <span className="text-sm font-bold text-orange-300 uppercase tracking-widest">Solar Cycle</span>
                    </div>

                    <div className="flex-1 flex flex-col justify-center items-center py-4">
                        <SolarArc sunrise={current.sunrise || '06:00'} sunset={current.sunset || '18:00'} showTimes={true} size="large" />
                    </div>

                    <div className="bg-white/5 rounded-xl p-3 border border-white/5 mt-auto">
                        <div className="flex justify-between items-center text-xs">
                            <span className="text-gray-400 font-bold uppercase tracking-wider">Daylight Remaining</span>
                            <span className="text-white font-mono">{current.uvIndex > 0 ? "High Visibility" : "Night Mode"}</span>
                        </div>
                    </div>
                </Card>

                {/* Card 2: Lunar & Atmosphere (Replaces Vessel Physics) */}
                <Card className="bg-slate-900/60 border border-white/10 p-5 flex flex-col justify-start">
                    <div className="flex justify-between items-start mb-2">
                        <div className="flex items-center gap-2 text-indigo-300">
                            <MoonIcon className="w-5 h-5" />
                            <span className="text-sm font-bold uppercase tracking-widest">Lunar & Atmosphere</span>
                        </div>
                    </div>

                    <div className="flex flex-col gap-4 mt-2">
                        {/* Moon Section */}
                        <div className="bg-white/5 rounded-xl p-4 border border-white/5 flex items-center justify-between">
                            <MoonVisual
                                cloudCover={current.cloudCover || 0}
                                apiPhase={current.moonPhase}
                                apiIllumination={current.moonIllumination}
                                apiPhaseValue={current.moonPhaseValue}
                                lat={lat}
                            />
                        </div>

                        {/* Atmospherics Grid */}
                        <div className="grid grid-cols-2 gap-4">
                            <div className="bg-white/5 rounded-xl p-3 border border-white/5 flex flex-col justify-between">
                                <span className="text-[10px] text-gray-400 uppercase font-bold block mb-1 flex items-center gap-1"><EyeIcon className="w-3 h-3" /> Visibility</span>
                                <span className="text-xl font-mono font-bold text-white">
                                    {current.visibility ? convertDistance(current.visibility, units.visibility || 'mi') : '--'}
                                    <span className="text-xs text-gray-500 ml-1">{units.visibility || 'mi'}</span>
                                </span>
                            </div>
                            <div className="bg-white/5 rounded-xl p-3 border border-white/5 flex flex-col justify-between">
                                <span className="text-[10px] text-gray-400 uppercase font-bold block mb-1 flex items-center gap-1"><GaugeIcon className="w-3 h-3" /> Pressure</span>
                                <span className="text-xl font-mono font-bold text-white">
                                    {current.pressure ? Math.round(current.pressure) : '--'}
                                    <span className="text-xs text-gray-500 ml-1">hPa</span>
                                </span>
                            </div>
                        </div>
                    </div>
                </Card>
            </div>
        );
    }

    // --- MARINE VIEW (Original) ---
    return (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
            {/* Card 1: Tides & Astro - REMOVED OLD HEADER for cleaner look with new overlays */}
            <Card className="bg-slate-900/60 border border-white/10 p-5 flex flex-col justify-between min-h-[220px] relative overflow-hidden gap-4">

                {/* Header: Moon & Phase */}
                <div className="flex justify-between items-start mb-2">
                    <div className="flex items-center gap-2">
                        <TideCurveIcon className="w-5 h-5 text-sky-400" />
                        <span className="text-sm font-bold text-sky-300 uppercase tracking-widest">Tidal Cycle</span>
                    </div>
                    {/* Explicitly Restored Moon Info */}
                    <MoonVisual
                        cloudCover={current.cloudCover || 0}
                        apiPhase={current.moonPhase}
                        apiIllumination={current.moonIllumination}
                        apiPhaseValue={current.moonPhaseValue}
                    />
                </div>

                {/* Graph Area */}
                <div className="flex-1 w-full min-h-[160px] relative z-10">
                    <TideGraph tides={tides} unit={units.tideHeight || 'm'} timeZone={timeZone} hourlyTides={hourlyTides} tideSeries={tideHourly} modelUsed={modelUsed} unitPref={units} />
                </div>

                {/* Solar Arc Footer */}
                {current.sunrise && current.sunset && current.sunrise !== '--:--' && (
                    <div className="mt-1 pt-2 border-t border-white/5">
                        <SolarArc sunrise={current.sunrise} sunset={current.sunset} />
                    </div>
                )}
            </Card>

            {/* Card 2: Vessel Physics & Status */}
            {vessel && vessel.type !== 'observer' ? (
                <Card className="bg-slate-900/60 border border-white/10 p-5 flex flex-col justify-between min-h-[220px]">
                    <div className="flex justify-between items-start mb-2">
                        <div className="flex items-center gap-2 text-orange-300">
                            {vessel.type === 'power' ? <PowerBoatIcon className="w-5 h-5" /> : <SailBoatIcon className="w-5 h-5" />}
                            <span className="text-sm font-bold uppercase tracking-widest truncate max-w-[150px]">{vessel.name}</span>
                        </div>
                        <div className={`px-2 py-1 rounded border text-[10px] font-bold uppercase ${vesselStatus?.status === 'unsafe' ? 'bg-red-500/20 border-red-500/50 text-red-300' : 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300'}`}>
                            {vesselStatus?.status === 'unsafe' ? 'Limits Exceeded' : 'Within Limits'}
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4 mt-2">
                        <div className="bg-white/5 rounded-xl p-3 border border-white/5">
                            <span className="text-[10px] text-gray-400 uppercase font-bold block mb-1">Theoretical Hull Speed</span>
                            <span className="text-xl font-mono font-bold text-white">{hullSpeed?.toFixed(1)} <span className="text-xs text-gray-500">kts</span></span>
                        </div>
                        <div className="bg-white/5 rounded-xl p-3 border border-white/5">
                            <span className="text-[10px] text-gray-400 uppercase font-bold block mb-1">Displacement</span>
                            <span className="text-xl font-mono font-bold text-white">{(vessel.displacement / 2204.62).toFixed(1)} <span className="text-xs text-gray-500">t</span></span>
                        </div>
                        {vessel.type === 'sail' && (
                            <>
                                {mcr && (
                                    <div className="bg-white/5 rounded-xl p-3 border border-white/5">
                                        <span className="text-[10px] text-gray-400 uppercase font-bold block mb-1">Motion Comfort</span>
                                        <span className={`text-xl font-mono font-bold ${mcr > 30 ? 'text-emerald-300' : mcr > 20 ? 'text-yellow-300' : 'text-orange-300'}`}>{Math.round(mcr)}</span>
                                    </div>
                                )}
                                {csf && (
                                    <div className="bg-white/5 rounded-xl p-3 border border-white/5">
                                        <span className="text-[10px] text-gray-400 uppercase font-bold block mb-1">Capsize Risk</span>
                                        <span className={`text-xl font-mono font-bold ${csf < 2 ? 'text-emerald-300' : 'text-red-300'}`}>{csf.toFixed(2)}</span>
                                    </div>
                                )}
                                {dlr && (
                                    <div className="bg-white/5 rounded-xl p-3 border border-white/5">
                                        <span className="text-[10px] text-gray-400 uppercase font-bold block mb-1">D/L Ratio</span>
                                        <span className="text-xl font-mono font-bold text-white">{Math.round(dlr)}</span>
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                </Card>
            ) : (
                <Card className="bg-slate-900/60 border border-white/10 p-5 flex flex-col justify-center items-center h-full text-center min-h-[220px]">
                    <SearchIcon className="w-12 h-12 text-gray-600 mb-3" />
                    <h3 className="text-lg font-medium text-white mb-1">Observer Mode</h3>
                    <p className="text-xs text-gray-400 max-w-[200px]">Configure a vessel profile to see hydrostatics.</p>
                </Card>
            )}
        </div>
    );
};
