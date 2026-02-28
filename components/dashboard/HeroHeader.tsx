import React, { useMemo, useCallback, useRef, useEffect, useState } from 'react';
import { useEnvironment } from '../../context/ThemeContext';
import { ArrowUpIcon, ArrowDownIcon } from '../Icons';
import { WeatherMetrics, UnitPreferences } from '../../types';
import { convertTemp } from '../../utils';

/**
 * AutoFitCondition — auto-sizing text that shrinks/grows to fit one line.
 * Uses a binary search to find the largest font that fits without overflow.
 */
const AutoFitCondition: React.FC<{ text: string; maxFontPx: number; minFontPx: number }> = ({ text, maxFontPx, minFontPx }) => {
    const spanRef = useRef<HTMLSpanElement>(null);
    const [fontSize, setFontSize] = useState(maxFontPx);

    useEffect(() => {
        const el = spanRef.current;
        if (!el) return;

        const fit = () => {
            const parent = el.parentElement;
            if (!parent) return;

            // Available width (subtract siblings like icon, dot, gap)
            const parentWidth = parent.clientWidth;
            // Use a test span approach: start at max and shrink
            let lo = minFontPx, hi = maxFontPx, best = minFontPx;
            while (lo <= hi) {
                const mid = Math.floor((lo + hi) / 2);
                el.style.fontSize = `${mid}px`;
                if (el.scrollWidth <= parentWidth * 0.85) { // 85% to leave room for icon/dot
                    best = mid;
                    lo = mid + 1;
                } else {
                    hi = mid - 1;
                }
            }
            setFontSize(best);
            el.style.fontSize = `${best}px`;
        };

        // Fit on mount and resize
        fit();
        const ro = new ResizeObserver(fit);
        ro.observe(el.parentElement!);
        return () => ro.disconnect();
    }, [text, maxFontPx, minFontPx]);

    return (
        <span
            ref={spanRef}
            className="text-ivory font-mono font-bold tracking-tight leading-none whitespace-nowrap"
            style={{ fontSize: `${fontSize}px` }}
        >
            {text}
        </span>
    );
};

/** Chevron-down SVG icon */
const ChevronIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
        <polyline points="6 9 12 15 18 9" />
    </svg>
);

/** Condition-to-icon emoji (lightweight, no extra SVG assets needed) */
const getConditionIcon = (condition: string): string => {
    switch (condition) {
        case 'Sunny': return '☀️';
        case 'Clear': return '🌙';
        case 'Cloudy': return '☁️';
        case 'Partly': return '⛅';
        case 'Overcast': return '🌥️';
        case 'Rain': return '🌧️';
        case 'Pouring': return '🌊';
        case 'Storm': return '⛈️';
        case 'Snow': return '❄️';
        case 'Fog': return '🌫️';
        case 'Haze': return '🌫️';
        case 'Windy': return '💨';
        default: return '☁️';
    }
};

interface HeroHeaderProps {
    data: WeatherMetrics;
    units: UnitPreferences;
    isLive: boolean;
    isDay: boolean;
    dateLabel: string;
    timeLabel: string;
    timeZone?: string;
    sources?: Record<string, { source: string; sourceColor?: 'emerald' | 'amber' | 'sky' | 'white'; sourceName?: string }>;
    isExpanded?: boolean;
    onToggleExpand?: () => void;
}

const HeroHeaderComponent: React.FC<HeroHeaderProps> = ({
    data,
    units,
    isLive,
    isDay,
    dateLabel,
    timeLabel,
    timeZone,
    sources,
    isExpanded = true,
    onToggleExpand
}) => {
    // PERF: Memoize helper to get source text color for temperature
    const getTempColor = useCallback((): string => {
        if (!isLive) return 'text-white';
        if (!sources || !sources['airTemperature']) return 'text-white';
        const sourceColor = sources['airTemperature']?.sourceColor;
        switch (sourceColor) {
            case 'emerald': return 'text-emerald-400';
            case 'amber': return 'text-amber-400';
            default: return 'text-white';
        }
    }, [isLive, sources]);

    // Map weather condition to category for icon selection
    const conditionCategory = useMemo(() => {
        const c = (data.condition || '').toLowerCase();
        if (c.includes('thunder') || c.includes('storm')) return 'Storm';
        if (c.includes('pour') || c.includes('heavy rain')) return 'Pouring';
        if (c.includes('rain') || c.includes('shower') || c.includes('drizzle')) return 'Rain';
        if (c.includes('snow') || c.includes('sleet') || c.includes('ice')) return 'Snow';
        if (c.includes('fog') || c.includes('mist')) return 'Fog';
        if (c.includes('haze')) return 'Haze';
        if (c.includes('overcast')) return 'Overcast';
        if (c.includes('cloud') || c.includes('mostly cloudy')) return 'Cloudy';
        if (c.includes('partly') || c.includes('scattered')) return 'Partly';
        if (!isDay && (c.includes('clear') || c.includes('sunny') || c === '')) return 'Clear';
        if (c.includes('clear') || c.includes('sunny') || c === '') return 'Sunny';
        if (c.includes('wind')) return 'Windy';
        return 'Cloudy';
    }, [data.condition, isDay]);

    // Use exact WeatherKit condition text for display, icon from category
    const displayCondition = data.condition || 'Cloudy';
    const conditionIcon = getConditionIcon(conditionCategory);

    return (
        <div
            className="relative w-full rounded-2xl overflow-hidden border bg-white/[0.08] backdrop-blur-xl shadow-[0_0_30px_-5px_rgba(0,0,0,0.3)] border-white/[0.15]"
        >
            {/* Pulsing dot keyframe — injected once */}
            <style>{`@keyframes hh-pulse{0%,100%{opacity:1}50%{opacity:.35}}`}</style>

            <div className="flex flex-row w-full items-center min-h-[70px]">
                {/* LEFT: Temperature only */}
                <div className="flex-[1] px-3 py-2 flex flex-col justify-center items-start min-w-0">
                    {(() => {
                        const tempStr = (data.airTemperature !== null ? convertTemp(data.airTemperature, units.temp) : '--').toString();
                        const len = tempStr.length;
                        const sizeClass = len > 3 ? 'text-3xl' : len > 2 ? 'text-4xl' : 'text-5xl';
                        return (
                            <span
                                className={`${sizeClass} font-mono font-bold tracking-tighter ${getTempColor()} leading-none`}
                                aria-label={`Temperature ${tempStr} degrees`}
                            >
                                {tempStr}°
                            </span>
                        );
                    })()}
                </div>

                {/* CENTER: Status dot + icon + condition */}
                <div className="flex-[2] flex flex-col justify-center items-center min-w-0 py-2 px-1">
                    {isLive ? (
                        <>
                            <div className="flex items-center gap-2 max-w-full">
                                {/* Pulsing green live dot */}
                                <div
                                    className="w-[7px] h-[7px] rounded-full bg-emerald-400 shrink-0"
                                    style={{ animation: 'hh-pulse 2s ease-in-out infinite' }}
                                />
                                <span className="text-2xl leading-none shrink-0">{conditionIcon}</span>
                                <AutoFitCondition text={displayCondition} maxFontPx={24} minFontPx={12} />
                            </div>
                        </>
                    ) : (
                        <>
                            <span className="text-blue-400 font-extrabold text-[11px] tracking-[0.2em] uppercase leading-none mb-1" style={{ paddingLeft: '0.2em' }}>
                                {dateLabel}
                            </span>
                            <div className="flex items-center gap-2 max-w-full">
                                <span className="text-xl leading-none shrink-0">{conditionIcon}</span>
                                <AutoFitCondition text={displayCondition} maxFontPx={20} minFontPx={11} />
                            </div>
                            {timeLabel && (
                                <span className="text-blue-400/70 text-[11px] font-bold font-mono leading-none mt-1">
                                    {timeLabel}
                                </span>
                            )}
                        </>
                    )}
                </div>

                {/* RIGHT: Hi/Lo + Chevron */}
                <div
                    onClick={onToggleExpand}
                    className={`flex-[1] flex items-center justify-end gap-2 pr-3 touch-none select-none ${onToggleExpand ? 'cursor-pointer' : ''}`}
                    style={{ WebkitTapHighlightColor: 'transparent' }}
                    role={onToggleExpand ? 'button' : undefined}
                    aria-label={onToggleExpand ? (isExpanded ? 'Collapse instrument grid' : 'Expand instrument grid') : undefined}
                >
                    {/* Hi/Lo temps stacked */}
                    <div className="flex flex-col items-end gap-0.5">
                        <div className="flex items-center gap-0.5">
                            <ArrowUpIcon className="w-2.5 h-2.5 text-orange-400 opacity-70" />
                            <span className="text-xs font-mono font-bold text-white/80">
                                {data.highTemp !== undefined ? convertTemp(data.highTemp, units.temp) : '--'}°
                            </span>
                        </div>
                        <div className="flex items-center gap-0.5">
                            <ArrowDownIcon className="w-2.5 h-2.5 text-cyan-400 opacity-70" />
                            <span className="text-xs font-mono font-bold text-white/80">
                                {data.lowTemp !== undefined ? convertTemp(data.lowTemp, units.temp) : '--'}°
                            </span>
                        </div>
                    </div>
                    {/* Ghostly chevron — hidden for inland (no expand available) */}
                    {onToggleExpand && (
                        <div className="w-7 h-7 rounded-full bg-white/[0.05] flex items-center justify-center">
                            <ChevronIcon
                                className={`w-3.5 h-3.5 text-white/40 transition-transform duration-300 ${isExpanded ? 'rotate-180' : ''}`}
                            />
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

// PERF: Wrap with React.memo to prevent re-renders when props haven't changed
export const HeroHeader = React.memo(HeroHeaderComponent);
