import React from 'react';
import { t } from '../../../theme';
import { WindIcon, WaveIcon, CompassIcon, DropletIcon, GaugeIcon, ArrowUpIcon, ArrowDownIcon, CloudIcon, RainIcon, SunIcon, EyeIcon, ClockIcon, MoonIcon, SunriseIcon, SunsetIcon, ThermometerIcon } from '../../Icons';
import { UnitPreferences, WeatherMetrics } from '../../../types';
import { CardDisplayValues, SourceMap } from './types';

// --- HOISTED HELPERS ---
export const formatTemp = (t?: number | null) => Math.round(t || 0);
export const formatCondition = (c?: string) => c || 'Clear';
export const renderHighLow = (d: WeatherMetrics) => (
    <div className="flex gap-2 text-sm uppercase font-bold text-white/60">
        <span>H: {Math.round(d.highTemp || (d.airTemperature || 0) + 2)}°</span>
        <span>L: {Math.round(d.lowTemp || (d.airTemperature || 0) - 2)}°</span>
    </div>
);

// --- WIDGET RENDERER (Pure Function) ---
export const renderHeroWidget = (
    id: string,
    data: WeatherMetrics,
    values: CardDisplayValues,
    units: UnitPreferences,
    isLive: boolean,
    trends?: Record<string, 'rising' | 'falling' | 'steady' | undefined>,
    align: 'left' | 'center' | 'right' = 'left',
    sources?: SourceMap,
    compact?: boolean
) => {
    const valSize = compact ? 'text-lg' : 'text-2xl';
    const subSize = compact ? 'text-[10px]' : 'text-sm';
    const trend = trends ? trends[id] : undefined;

    // Alignment Classes
    const alignClass = align === 'center' ? 'items-center text-center' : align === 'right' ? 'items-end text-right' : 'items-start text-left';

    // Helper to get source text color for a metric value
    const getSourceTextColor = (metricKey: string): string => {
        // Only show source colors on live card - forecast cards should be white
        if (!isLive) return 'text-white';
        if (!sources || !sources[metricKey]) return 'text-white';
        const sourceColor = sources[metricKey]?.sourceColor;
        switch (sourceColor) {
            case 'emerald': return 'text-emerald-400';  // Buoy
            case 'amber': return 'text-amber-400';      // StormGlass
            default: return 'text-white';               // Fallback
        }
    };

    // Helper to render trend arrow
    const renderTrend = (t?: string, inverse = false) => {
        if (!t || t === 'steady' || t === 'neutral') return null;
        const isUp = t === 'rising';

        return (
            <div className={`flex items-center ml-1.5 opacity-80 ${isUp ? '-mt-1' : '-mt-1'}`}>
                {isUp
                    ? <ArrowUpIcon className="w-2.5 h-2.5" />
                    : <ArrowDownIcon className="w-2.5 h-2.5" />}
            </div>
        );
    };

    switch (id) {
        case 'wind':
            return (
                <div className={`flex flex-col h-full justify-end ${alignClass}`}>
                    {/* Header with trend arrow */}
                    <div className="flex items-center gap-1.5 mb-0.5 opacity-70">
                        <WindIcon className={`w-3 h-3 ${isLive ? 'text-sky-400' : 'text-slate-400'} `} />
                        <span className={`text-sm md:text-sm font-bold uppercase tracking-widest ${isLive ? 'text-sky-200' : 'text-slate-300'} `}>Wind</span>
                        {renderTrend(trend, true)}
                    </div>
                    {/* Main value + direction badge on same line */}
                    <div className="flex flex-wrap items-end gap-1">
                        <span className={`${valSize} md:text-5xl font-mono font-medium tracking-tight ${getSourceTextColor('windSpeed')}`}>{values.windSpeed}</span>
                        <span className={`${subSize} md:text-sm font-medium text-gray-400 pb-1`}>{units.speed}</span>
                        <div className={`flex items-center gap-0.5 bg-white/5 px-1 py-0.5 rounded ${subSize} font-bold text-sky-300 border border-white/5 ml-1`}>
                            <CompassIcon rotation={data.windDegree || 0} className="w-2.5 h-2.5" />
                            <span>{data.windDirection || 'VAR'}</span>
                        </div>
                    </div>
                </div>
            );
        case 'gust':
            return (
                <div className={`flex flex-col h-full justify-end ${alignClass}`}>
                    {/* Header with trend arrow */}
                    <div className="flex items-center gap-1.5 mb-0.5 opacity-70">
                        <WindIcon className={`w-3 h-3 ${isLive ? 'text-orange-400' : 'text-slate-400'} `} />
                        <span className={`text-sm md:text-sm font-bold uppercase tracking-widest ${isLive ? 'text-orange-200' : 'text-slate-300'} `}>Gusts</span>
                        {renderTrend(trend, true)}
                    </div>
                    {/* Main value + Max badge on same line */}
                    <div className="flex flex-wrap items-end gap-1">
                        <span className={`${valSize} md:text-5xl font-mono font-medium tracking-tight ${getSourceTextColor('windGust')}`}>{values.gusts}</span>
                        <span className={`${subSize} md:text-sm font-medium text-gray-400 pb-1`}>{units.speed}</span>
                        <div className={`flex items-center gap-0.5 bg-white/5 px-1 py-0.5 rounded ${subSize} font-bold text-orange-300 border border-white/5 ml-1`}>
                            <span>Max</span>
                        </div>
                    </div>
                </div>
            );
        case 'wave':
            return (
                <div className={`flex flex-col h-full justify-end ${alignClass}`}>
                    {/* Header with trend arrow */}
                    <div className="flex items-center gap-1.5 mb-0.5 opacity-70">
                        <WaveIcon className={`w-3 h-3 ${isLive ? 'text-blue-400' : 'text-slate-400'} `} />
                        <span className={`text-sm md:text-sm font-bold uppercase tracking-widest ${isLive ? 'text-blue-200' : 'text-slate-300'} `}>Wave</span>
                        {renderTrend(trend, true)}
                    </div>
                    {/* Main value + period badge on same line */}
                    <div className="flex flex-wrap items-end gap-1">
                        <span className={`${valSize} md:text-5xl font-mono font-medium tracking-tight ${getSourceTextColor('waveHeight')}`}>{values.waveHeight}</span>
                        <span className={`${subSize} md:text-sm font-medium text-gray-400 pb-1`}>{units.length}</span>
                        <div className={`flex items-center gap-0.5 bg-white/5 px-1 py-0.5 rounded ${subSize} font-bold text-blue-300 border border-white/5 ml-1`}>
                            <ClockIcon className="w-2.5 h-2.5" />
                            <span>{data.swellPeriod ? `${Math.round(data.swellPeriod)}s` : '--'}</span>
                        </div>
                    </div>
                </div>
            );
        case 'pressure':
            return (
                <div className={`flex flex-col h-full justify-between ${alignClass}`}>
                    <div className="flex items-center gap-1.5 mb-0.5 opacity-70">
                        <GaugeIcon className={`w-3 h-3 ${isLive ? 'text-teal-400' : 'text-slate-400'} `} />
                        <span className={`text-sm md: text-sm font-bold uppercase tracking-widest ${isLive ? 'text-teal-200' : 'text-slate-300'} `}>Barometer</span>
                    </div>
                    <div className="flex items-baseline gap-0.5">
                        <span className={`text-2xl md:text-5xl font-mono font-medium tracking-tight ${getSourceTextColor('pressure')}`}>{values.pressure}</span>
                        <span className="text-sm md:text-sm font-medium text-gray-400">hPa</span>
                        {renderTrend(trend, false)}
                    </div>
                    <div className="mt-auto pt-1 text-sm md:text-sm text-teal-300 font-bold opacity-70">
                        MSL
                    </div>
                </div>
            );
        case 'visibility':
            return (
                <div className={`flex flex-col h-full justify-between ${alignClass}`}>
                    <div className="flex items-center gap-1.5 mb-0.5 opacity-70">
                        <EyeIcon className={`w-3 h-3 ${isLive ? 'text-emerald-400' : 'text-slate-400'} `} />
                        <span className={`text-sm md: text-sm font-bold uppercase tracking-widest ${isLive ? 'text-emerald-200' : 'text-slate-300'} `}>Visibility</span>
                    </div>
                    <div className="flex items-baseline gap-0.5">
                        <span className={`text-2xl md:text-5xl font-mono font-medium tracking-tight ${getSourceTextColor('visibility')}`}>{values.vis}</span>
                        <span className="text-sm md:text-sm font-medium text-gray-400">{units.visibility}</span>
                        {renderTrend(trend, false)}
                    </div>
                    <div className="mt-auto pt-1 text-sm md:text-sm text-emerald-300 font-bold opacity-70">
                        --
                    </div>
                </div>
            );
        case 'humidity':
            return (
                <div className={`flex flex-col h-full justify-between ${alignClass}`}>
                    <div className="flex items-center gap-1.5 mb-0.5 opacity-70">
                        <DropletIcon className={`w-3 h-3 ${isLive ? 'text-cyan-400' : 'text-slate-400'} `} />
                        <span className={`text-sm md: text-sm font-bold uppercase tracking-widest ${isLive ? 'text-cyan-200' : 'text-slate-300'} `}>Humidity</span>
                    </div>
                    <div className="flex items-baseline gap-0.5">
                        <span className={`text-2xl md:text-5xl font-mono font-medium tracking-tight ${getSourceTextColor('humidity')}`}>{values.humidity}</span>
                        <span className="text-sm md:text-sm font-medium text-gray-400">%</span>
                        {renderTrend(trend, true)}
                    </div>
                    <div className="mt-auto pt-1 text-sm md:text-sm text-cyan-300 font-bold opacity-70">
                        --
                    </div>
                </div>
            );
        case 'feels':
            return (
                <div className={`flex flex-col h-full justify-between ${alignClass}`}>
                    <div className="flex items-center gap-1.5 mb-0.5 opacity-70">
                        <ThermometerIcon className={`w-3 h-3 ${isLive ? 'text-amber-400' : 'text-slate-400'} `} />
                        <span className={`text-sm md: text-sm font-bold uppercase tracking-widest ${isLive ? 'text-amber-200' : 'text-slate-300'} `}>Feels Like</span>
                    </div>
                    <div className="flex items-baseline gap-0.5">
                        <span className="text-2xl md:text-5xl font-mono font-medium tracking-tight text-ivory">{values.feelsLike}</span>
                        <span className="text-sm md:text-sm font-medium text-gray-400">°{units.temp}</span>
                        {renderTrend(trend, true)}
                    </div>
                </div>
            );
        case 'clouds':
            return (
                <div className={`flex flex-col h-full justify-between ${alignClass}`}>
                    <div className="flex items-center gap-1.5 mb-0.5 opacity-70">
                        <CloudIcon className={`w-3 h-3 ${isLive ? 'text-gray-400' : 'text-slate-400'} `} />
                        <span className={`text-sm md: text-sm font-bold uppercase tracking-widest ${isLive ? 'text-gray-200' : 'text-slate-300'} `}>Cover</span>
                    </div>
                    <div className="flex items-baseline gap-0.5">
                        <span className="text-2xl md:text-5xl font-mono font-medium tracking-tight text-ivory">{values.cloudCover}</span>
                        <span className="text-sm md:text-sm font-medium text-gray-400">%</span>
                        {renderTrend(trend, true)}
                    </div>
                </div>
            );
        case 'precip':
            const pVal = data.precipitation || 0;
            let pDesc = "None";
            if (pVal > 0) {
                if (pVal < 0.5) pDesc = "Trace";
                else if (data.condition?.toLowerCase().includes("shower")) pDesc = "Showers";
                else pDesc = "Rain";
            }
            if (pDesc === "Trace") {
                return (
                    <div className={`flex flex-col h-full justify-between ${alignClass}`}>
                        <div className="flex items-center gap-1.5 mb-0.5 opacity-70">
                            <RainIcon className={`w-3 h-3 ${isLive ? 'text-blue-400' : 'text-slate-400'} `} />
                            <span className={`text-sm md: text-sm font-bold uppercase tracking-widest ${isLive ? 'text-blue-200' : 'text-slate-300'} `}>Precip</span>
                        </div>
                        <div className="flex flex-col justify-center items-end flex-1">
                            <span className="text-sm md:text-lg font-bold text-gray-400 uppercase tracking-wider">{pDesc}</span>
                        </div>
                        <div className="mt-auto pt-1 text-sm md:text-sm text-blue-300 font-bold opacity-70">
                            --
                        </div>
                    </div>
                );
            }

            return (
                <div className={`flex flex-col h-full justify-between ${alignClass}`}>
                    <div className="flex items-center gap-1.5 mb-0.5 opacity-70">
                        <RainIcon className={`w-3 h-3 ${isLive ? 'text-blue-400' : 'text-slate-400'} `} />
                        <span className={`text-sm md: text-sm font-bold uppercase tracking-widest ${isLive ? 'text-blue-200' : 'text-slate-300'} `}>Precip</span>
                    </div>
                    {/* Middle: Value + Unit (Baseline) */}
                    <div className="flex items-baseline gap-0.5">
                        <span className="text-2xl md:text-5xl font-mono font-medium tracking-tight text-ivory">{values.precip}</span>
                        <span className="text-sm md:text-sm font-medium text-gray-400">{units.length === 'm' ? 'mm' : 'in'}</span>
                    </div>
                    {/* Bottom: Description */}
                    <div className="mt-auto pt-1 text-sm md:text-sm text-blue-300 font-bold opacity-70 uppercase tracking-wider">
                        {pDesc}
                    </div>
                </div>
            );
        case 'dew':
            return (
                <div className={`flex flex-col h-full justify-between ${alignClass}`}>
                    <div className="flex items-center gap-1.5 mb-0.5 opacity-70">
                        <DropletIcon className={`w-3 h-3 ${isLive ? 'text-indigo-400' : 'text-slate-400'} `} />
                        <span className={`text-sm md: text-sm font-bold uppercase tracking-widest ${isLive ? 'text-indigo-200' : 'text-slate-300'} `}>Dew Pt</span>
                    </div>
                    <div className="flex items-baseline gap-0.5">
                        <span className="text-2xl md:text-5xl font-mono font-medium tracking-tight text-ivory">{values.dewPoint}</span>
                        <span className="text-sm md:text-sm font-medium text-gray-400">°{units.temp}</span>
                        {renderTrend(trend, true)}
                    </div>
                </div>
            );
        case 'waterTemperature':
            return (
                <div className={`flex flex-col h-full justify-between ${alignClass}`}>
                    <div className="flex items-center gap-1.5 mb-0.5 opacity-70">
                        <ThermometerIcon className={`w-3 h-3 ${isLive ? 'text-cyan-400' : 'text-slate-400'} `} />
                        <span className={`text-sm md: text-sm font-bold uppercase tracking-widest ${isLive ? 'text-cyan-200' : 'text-slate-300'} `}>Sea Temp</span>
                    </div>
                    <div className="flex items-baseline gap-0.5">
                        <span className={`text-2xl md:text-5xl font-mono font-medium tracking-tight ${getSourceTextColor('waterTemperature')}`}>{values.waterTemperature}</span>
                        <span className="text-sm md:text-sm font-medium text-gray-400">°{units.temp}</span>
                        {renderTrend(trend, true)}
                    </div>
                    <div className="mt-auto pt-1 text-sm md:text-sm text-cyan-300 font-bold opacity-70">
                        Surface
                    </div>
                </div>
            );
        case 'currentSpeed':
            return (
                <div className={`flex flex-col h-full justify-between ${alignClass}`}>
                    <div className="flex items-center gap-1.5 mb-0.5 opacity-70">
                        <WaveIcon className={`w-3 h-3 ${isLive ? 'text-emerald-400' : 'text-slate-400'} `} />
                        <span className={`text-sm md: text-sm font-bold uppercase tracking-widest ${isLive ? 'text-emerald-200' : 'text-slate-300'} `}>Drift</span>
                    </div>
                    <div className="flex items-baseline gap-0.5">
                        <span className={`text-2xl md:text-5xl font-mono font-medium tracking-tight ${getSourceTextColor('currentSpeed')}`}>{values.currentSpeed}</span>
                        <span className="text-sm md:text-sm font-medium text-gray-400">kts</span>
                        {renderTrend(trend, true)}
                    </div>
                    <div className="mt-auto pt-1 text-sm md:text-sm text-emerald-300 font-bold opacity-70">
                        --
                    </div>
                </div>
            );
        case 'currentDirection':
            return (
                <div className={`flex flex-col h-full justify-between ${alignClass}`}>
                    <div className="flex items-center gap-1.5 mb-0.5 opacity-70">
                        {/* Fix: CompassIcon requires 'rotation' prop */}
                        <CompassIcon
                            className={`w-3 h-3 ${isLive ? 'text-teal-400' : 'text-slate-400'} `}
                            rotation={typeof data.currentDirection === 'number' ? data.currentDirection : 0}
                        />
                        <span className={`text-sm md: text-sm font-bold uppercase tracking-widest ${isLive ? 'text-teal-200' : 'text-slate-300'} `}>Set</span>
                    </div>
                    <div className="flex items-baseline gap-0.5">
                        {/* We want just the cardinal direction here, e.g. "NE" */}
                        <span className={`text-2xl md:text-5xl font-mono font-medium tracking-tight ${getSourceTextColor('currentDirection')}`}>{values.currentDirection}</span>
                    </div>
                    <div className="mt-auto pt-1 text-sm md:text-sm text-teal-300 font-bold opacity-70">
                        {/* Fix: Ensure currentDirection is a number before Math.round, handle string case */}
                        {typeof data.currentDirection === 'number' ? Math.round(data.currentDirection) + '°' : '--'} True
                    </div>
                </div>
            );
        case 'uv':
            return (
                <div className={`flex flex-col h-full justify-between ${alignClass}`}>
                    <div className="flex items-center gap-1.5 mb-0.5 opacity-70">
                        <SunIcon className={`w-3 h-3 ${isLive ? 'text-orange-400' : 'text-slate-400'} `} />
                        <span className={`text-sm md: text-sm font-bold uppercase tracking-widest ${isLive ? 'text-orange-200' : 'text-slate-300'} `}>UV Index</span>
                    </div>
                    <div className="flex items-baseline gap-0.5">
                        <span className="text-2xl md:text-5xl font-mono font-medium tracking-tight text-ivory">{values.uv}</span>
                    </div>
                    <div className="mt-auto pt-1 text-sm md:text-sm text-orange-300 font-bold opacity-70">
                        --
                    </div>
                </div>
            );
        case 'sunrise':
            return (
                <div className={`flex flex-col h-full justify-between ${alignClass}`}>
                    <div className="flex items-center gap-1.5 mb-0.5 opacity-70">
                        <SunriseIcon className={`w-3 h-3 ${isLive ? 'text-orange-400' : 'text-slate-400'} `} />
                        <span className={`text-sm md: text-sm font-bold uppercase tracking-widest ${isLive ? 'text-orange-200' : 'text-slate-300'} `}>Sunrise</span>
                    </div>
                    <div className="flex items-baseline gap-0.5">
                        <span className="text-xl md:text-3xl font-mono font-medium tracking-tight text-ivory">{values.sunrise}</span>
                    </div>
                </div>
            );
        case 'sunset':
            return (
                <div className={`flex flex-col h-full justify-between ${alignClass}`}>
                    <div className="flex items-center gap-1.5 mb-0.5 opacity-70">
                        <SunsetIcon className={`w-3 h-3 ${isLive ? 'text-purple-400' : 'text-slate-400'} `} />
                        <span className={`text-sm md: text-sm font-bold uppercase tracking-widest ${isLive ? 'text-purple-200' : 'text-slate-300'} `}>Sunset</span>
                    </div>
                    <div className="flex items-baseline gap-0.5">
                        <span className="text-xl md:text-3xl font-mono font-medium tracking-tight text-ivory">{values.sunset}</span>
                    </div>
                </div>
            );
        case 'moon':
            return (
                <div className={`flex flex-col h-full justify-between ${alignClass}`}>
                    <div className="flex items-center gap-1.5 mb-0.5 opacity-70">
                        <MoonIcon className={`w-3 h-3 ${isLive ? 'text-indigo-400' : 'text-slate-400'} `} />
                        <span className={`text-sm md: text-sm font-bold uppercase tracking-widest ${isLive ? 'text-indigo-200' : 'text-slate-300'} `}>Moon</span>
                    </div>
                    <div className="flex items-baseline gap-0.5">
                        <span className="text-sm md:text-lg font-bold text-white whitespace-nowrap">{values.moon || '--'}</span>
                    </div>
                </div>
            );
        default:
            return null;
    }
};

// --- STATIC WIDGET CLASS ---
export const STATIC_WIDGET_CLASS = "flex-1 min-w-[32%] md:min-w-[30%] bg-white/[0.06] backdrop-blur-sm border border-white/10 rounded-xl p-2 md:p-4 relative flex flex-col justify-center min-h-[90px] md:min-h-[100px] shrink-0";

// --- SOURCE COLOR HELPER ---
export const getSourceIndicatorColor = (sourceColor?: 'emerald' | 'amber' | 'sky' | 'white'): string => {
    switch (sourceColor) {
        case 'emerald': return 'bg-emerald-500';  // Buoy
        case 'sky': return 'bg-sky-500';          // Tomorrow.io
        case 'amber': return 'bg-amber-500';      // StormGlass
        default: return 'bg-gray-500';            // Fallback
    }
};
