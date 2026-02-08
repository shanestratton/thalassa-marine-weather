import React from 'react';
import { t } from '../../../theme';
import { WindIcon, WaveIcon, CompassIcon, DropletIcon, GaugeIcon, CloudIcon, RainIcon, SunIcon, EyeIcon, ClockIcon, SunriseIcon, SunsetIcon, ThermometerIcon, MinusIcon, ArrowUpIcon, ArrowDownIcon } from '../../Icons';
import { UnitPreferences, WeatherMetrics } from '../../../types';

interface HeroWidgetProps {
    id: string;
    data: WeatherMetrics;
    values: any;
    units: UnitPreferences;
    isLive: boolean;
    trends?: Record<string, 'rising' | 'falling' | 'steady' | undefined>;
    align?: 'left' | 'center' | 'right';
    className?: string; // Allow passing external classes (height, width, generic borders)
}

export const getWidgetTheme = (wid: string) => {
    switch (wid) {
        case 'wind': return 'bg-gradient-to-br from-sky-900/40 via-blue-900/20 to-slate-900/10 border-sky-400/20 shadow-sky-900/5';
        case 'gust': return 'bg-gradient-to-br from-orange-900/40 via-amber-900/20 to-red-900/10 border-orange-400/20 shadow-orange-900/5';
        case 'wave': return 'bg-gradient-to-br from-blue-900/40 via-indigo-900/20 to-slate-900/10 border-blue-400/20 shadow-blue-900/5';
        case 'uv': return 'bg-gradient-to-br from-orange-900/40 via-amber-900/20 to-slate-900/10 border-orange-400/20 shadow-orange-900/5';
        case 'visibility': return 'bg-gradient-to-br from-emerald-900/40 via-green-900/20 to-slate-900/10 border-emerald-400/20 shadow-emerald-900/5';
        case 'humidity': return 'bg-gradient-to-br from-cyan-900/40 via-sky-900/20 to-slate-900/10 border-cyan-400/20 shadow-cyan-900/5';
        case 'pressure': return 'bg-gradient-to-br from-teal-900/40 via-emerald-900/20 to-slate-900/10 border-teal-400/20 shadow-teal-900/5';
        case 'waterTemp': return 'bg-gradient-to-br from-blue-900/40 via-cyan-900/20 to-slate-900/10 border-blue-400/20 shadow-blue-900/5';
        case 'currentSpeed': return 'bg-gradient-to-br from-emerald-900/40 via-teal-900/20 to-slate-900/10 border-emerald-400/20 shadow-emerald-900/5';
        case 'currentDirection': return 'bg-gradient-to-br from-teal-900/40 via-cyan-900/20 to-slate-900/10 border-teal-400/20 shadow-teal-900/5';
        case 'sunrise': return 'bg-gradient-to-br from-amber-900/40 via-orange-900/20 to-slate-900/10 border-amber-400/20 shadow-amber-900/5';
        case 'sunset': return 'bg-gradient-to-br from-indigo-900/40 via-purple-900/20 to-slate-900/10 border-indigo-400/20 shadow-indigo-900/5';
        case 'clouds': return 'bg-gradient-to-br from-slate-800/60 via-gray-900/40 to-black/30 border-slate-500/20 shadow-slate-900/5';
        default: return 'bg-black/10 border-white/5';
    }
};

export const HeroWidget: React.FC<HeroWidgetProps> = ({
    id,
    data,
    values,
    units,
    isLive,
    trends,
    align = 'left',
    className = ''
}) => {
    const hasWind = data.windSpeed !== null && data.windSpeed !== undefined;
    const trend = trends ? trends[id] : undefined;

    const justifyClass = align === 'center' ? 'justify-center' : align === 'right' ? 'justify-end' : 'justify-start';
    const textClass = align === 'center' ? 'text-center' : align === 'right' ? 'text-right' : 'text-left';
    const flexColAlign = align === 'center' ? 'items-center' : align === 'right' ? 'items-end' : 'items-start';

    // Helper to render trend arrow
    const renderTrend = (t?: string, inverse = false) => {
        if (!t || t === 'neutral') return null;
        if (t === 'steady') {
            return (
                <div className="flex items-center ml-1.5 opacity-60">
                    <MinusIcon className="w-2.5 h-2.5" />
                </div>
            );
        }
        const isUp = t === 'rising';
        return (
            <div className={`flex items-center ml-1.5 opacity-80 ${isUp ? '-mt-1' : '-mt-1'}`}>
                {isUp ? <ArrowUpIcon className="w-2.5 h-2.5" /> : <ArrowDownIcon className="w-2.5 h-2.5" />}
            </div>
        );
    };

    const themeClass = getWidgetTheme(id);
    const containerClass = `w-full rounded-xl p-2 md:p-3 relative flex flex-col justify-center shrink-0 shadow-lg border ${themeClass} ${justifyClass} ${className}`;

    const renderContent = () => {
        switch (id) {
            case 'wind':
                return (
                    <div className="flex flex-col h-full justify-between w-full">
                        <div className={`flex items-center gap-1.5 mb-0.5 opacity-70 ${justifyClass} w-full`}>
                            <WindIcon className={`w-3 h-3 ${isLive ? 'text-sky-400' : 'text-slate-400'} `} />
                            <span className={`text-sm md: text-sm font-bold uppercase tracking-widest ${isLive ? 'text-sky-200' : 'text-slate-300'} `}>Wind</span>
                        </div>
                        <div className={`flex items-baseline gap-0.5 ${justifyClass} w-full`}>
                            <span className="text-2xl md:text-5xl font-black tracking-tighter text-white">{values.windSpeed || '--'}</span>
                            <span className="text-sm md:text-sm font-medium text-gray-400">{units?.speed || 'kts'}</span>
                            {renderTrend(trend, true)}
                        </div>
                        <div className={`flex items-center gap-1 mt-auto pt-1 w-full ${justifyClass}`}>
                            <div className="flex items-center gap-1 bg-white/5 px-1 py-0.5 rounded text-sm md:text-sm font-mono text-sky-300 border border-white/5">
                                <CompassIcon rotation={data.windDegree || 0} className="w-2.5 h-2.5 md:w-3 md:h-3" />
                                {data.windDirection || 'VAR'}
                            </div>
                            {hasWind && isLive && (
                                <span className="text-sm md:text-sm text-orange-300 font-bold ml-auto hidden md:inline">G {values.gusts || '--'}</span>
                            )}
                        </div>
                    </div>
                );
            case 'gust':
                return (
                    <div className="flex flex-col h-full justify-between w-full">
                        <div className={`flex items-center gap-1.5 mb-0.5 opacity-70 ${justifyClass} w-full`}>
                            <WindIcon className={`w-3 h-3 ${isLive ? 'text-orange-400' : 'text-slate-400'} `} />
                            <span className={`text-sm md: text-sm font-bold uppercase tracking-widest ${isLive ? 'text-orange-200' : 'text-slate-300'} `}>Gusts</span>
                        </div>
                        <div className={`flex items-baseline gap-0.5 ${justifyClass} w-full`}>
                            <span className="text-2xl md:text-5xl font-black tracking-tighter text-white">{values.gusts || '--'}</span>
                            <span className="text-sm md:text-sm font-medium text-gray-400">{units?.speed || 'kts'}</span>
                            {renderTrend(trend, true)}
                        </div>
                        <div className={`flex items-center gap-1 mt-auto pt-1 w-full ${justifyClass}`}>
                            <span className="text-sm md:text-sm font-bold text-orange-300 opacity-80">Max</span>
                        </div>
                    </div>
                );
            case 'wave':
                return (
                    <div className="flex flex-col h-full justify-between w-full">
                        <div className={`flex items-center gap-1.5 mb-0.5 opacity-70 ${justifyClass} w-full`}>
                            <WaveIcon className={`w-3 h-3 ${isLive ? 'text-blue-400' : 'text-slate-400'} `} />
                            <span className={`text-sm md: text-sm font-bold uppercase tracking-widest ${isLive ? 'text-blue-200' : 'text-slate-300'} `}>Seas</span>
                        </div>
                        <div className={`flex items-baseline gap-0.5 ${justifyClass} w-full`}>
                            <span className="text-2xl md:text-5xl font-black tracking-tighter text-white">
                                {values.waveHeight || '--'}
                            </span>
                            <span className="text-sm md:text-sm font-medium text-gray-400">{units?.length || 'm'}</span>
                            {renderTrend(trend, true)}
                        </div>
                        <div className={`flex items-center gap-1 mt-auto pt-1 w-full ${justifyClass}`}>
                            <div className="flex items-center gap-1 bg-white/5 px-1 py-0.5 rounded text-sm md:text-sm font-mono text-blue-300 border border-white/5">
                                <ClockIcon className="w-2.5 h-2.5" />
                                {(data?.swellPeriod) ? `${Math.round(data.swellPeriod)} s` : '--'}
                            </div>
                        </div>
                    </div>
                );
            case 'pressure':
                return (
                    <div className={`flex flex-col h-full justify-between w-full ${flexColAlign}`}>
                        <div className={`flex items-center gap-1.5 mb-0.5 opacity-70 ${justifyClass} w-full`}>
                            <GaugeIcon className={`w-3 h-3 ${isLive ? 'text-teal-400' : 'text-slate-400'} `} />
                            <span className={`text-sm md: text-sm font-bold uppercase tracking-widest ${isLive ? 'text-teal-200' : 'text-slate-300'} `}>Barometer</span>
                        </div>
                        <div className={`flex items-baseline gap-0.5 ${justifyClass} w-full`}>
                            <span className="text-2xl md:text-5xl font-black tracking-tighter text-white">{values.pressure}</span>
                            <span className="text-sm md:text-sm font-medium text-gray-400">hPa</span>
                            {renderTrend(trend, false)}
                        </div>
                        <div className={`mt-auto pt-1 text-sm md:text-sm text-teal-300 font-bold opacity-70 ${textClass} w-full`}>
                            MSL
                        </div>
                    </div>
                );
            case 'visibility':
                return (
                    <div className={`flex flex-col h-full justify-between w-full ${flexColAlign}`}>
                        <div className={`flex items-center gap-1.5 mb-0.5 opacity-70 ${justifyClass} w-full`}>
                            <EyeIcon className={`w-3 h-3 ${isLive ? 'text-emerald-400' : 'text-slate-400'} `} />
                            <span className={`text-sm md: text-sm font-bold uppercase tracking-widest ${isLive ? 'text-emerald-200' : 'text-slate-300'} `}>Visibility</span>
                        </div>
                        <div className={`flex items-baseline gap-0.5 ${justifyClass} w-full`}>
                            <span className="text-2xl md:text-5xl font-black tracking-tighter text-white">{values.vis}</span>
                            <span className="text-sm md:text-sm font-medium text-gray-400">{units.visibility}</span>
                            {renderTrend(trend, false)}
                        </div>
                        <div className={`mt-auto pt-1 text-sm md:text-sm text-emerald-300 font-bold opacity-70 ${textClass} w-full`}>
                            --
                        </div>
                    </div>
                );
            case 'humidity':
                return (
                    <div className={`flex flex-col h-full justify-between w-full ${flexColAlign}`}>
                        <div className={`flex items-center gap-1.5 mb-0.5 opacity-70 ${justifyClass} w-full`}>
                            <DropletIcon className={`w-3 h-3 ${isLive ? 'text-cyan-400' : 'text-slate-400'} `} />
                            <span className={`text-sm md: text-sm font-bold uppercase tracking-widest ${isLive ? 'text-cyan-200' : 'text-slate-300'} `}>Humidity</span>
                        </div>
                        <div className={`flex items-baseline gap-0.5 ${justifyClass} w-full`}>
                            <span className="text-2xl md:text-5xl font-black tracking-tighter text-white">{values.humidity}</span>
                            <span className="text-sm md:text-sm font-medium text-gray-400">%</span>
                            {renderTrend(trend, true)}
                        </div>
                        <div className={`mt-auto pt-1 text-sm md:text-sm text-cyan-300 font-bold opacity-70 ${textClass} w-full`}>
                            --
                        </div>
                    </div>
                );
            case 'feels':
                return (
                    <div className="flex flex-col h-full justify-between">
                        <div className="flex items-center gap-1.5 mb-0.5 opacity-70">
                            <ThermometerIcon className={`w-3 h-3 ${isLive ? 'text-amber-400' : 'text-slate-400'} `} />
                            <span className={`text-sm md: text-sm font-bold uppercase tracking-widest ${isLive ? 'text-amber-200' : 'text-slate-300'} `}>Feels Like</span>
                        </div>
                        <div className="flex items-baseline gap-0.5">
                            <span className="text-2xl md:text-5xl font-black tracking-tighter text-white">{values.feelsLike}</span>
                            <span className="text-sm md:text-sm font-medium text-gray-400">°{units.temp}</span>
                            {renderTrend(trend, true)}
                        </div>
                    </div>
                );
            case 'clouds':
                return (
                    <div className={`flex flex-col h-full justify-between w-full ${flexColAlign}`}>
                        <div className={`flex items-center gap-1.5 mb-0.5 opacity-70 ${justifyClass} w-full`}>
                            <CloudIcon className={`w-3 h-3 ${isLive ? 'text-gray-400' : 'text-slate-400'} `} />
                            <span className={`text-sm md: text-sm font-bold uppercase tracking-widest ${isLive ? 'text-gray-200' : 'text-slate-300'} `}>Cover</span>
                        </div>
                        <div className={`flex items-baseline gap-0.5 ${justifyClass} w-full`}>
                            <span className="text-2xl md:text-5xl font-black tracking-tighter text-white">{values.cloudCover}</span>
                            <span className="text-sm md:text-sm font-medium text-gray-400">%</span>
                            {renderTrend(trend, true)}
                        </div>
                    </div>
                );
            case 'precip':
                return (
                    <div className="flex flex-col h-full justify-between">
                        <div className="flex items-center gap-1.5 mb-0.5 opacity-70">
                            <RainIcon className={`w-3 h-3 ${isLive ? 'text-blue-400' : 'text-slate-400'} `} />
                            <span className={`text-sm md: text-sm font-bold uppercase tracking-widest ${isLive ? 'text-blue-200' : 'text-slate-300'} `}>Precip</span>
                        </div>
                        <div className="flex items-baseline gap-0.5">
                            <span className="text-2xl md:text-5xl font-black tracking-tighter text-white">{values.precip}</span>
                            <span className="text-sm md:text-sm font-medium text-gray-400">{units.length === 'm' ? 'mm' : 'in'}</span>
                            {renderTrend(trend, true)}
                        </div>
                    </div>
                );
            case 'dew':
                return (
                    <div className="flex flex-col h-full justify-between">
                        <div className="flex items-center gap-1.5 mb-0.5 opacity-70">
                            <DropletIcon className={`w-3 h-3 ${isLive ? 'text-indigo-400' : 'text-slate-400'} `} />
                            <span className={`text-sm md: text-sm font-bold uppercase tracking-widest ${isLive ? 'text-indigo-200' : 'text-slate-300'} `}>Dew Pt</span>
                        </div>
                        <div className="flex items-baseline gap-0.5">
                            <span className="text-2xl md:text-5xl font-black tracking-tighter text-white">{values.dewPoint}</span>
                            <span className="text-sm md:text-sm font-medium text-gray-400">°{units.temp}</span>
                            {renderTrend(trend, true)}
                        </div>
                    </div>
                );
            case 'uv':
                return (
                    <div className={`flex flex-col h-full justify-between w-full ${flexColAlign}`}>
                        <div className={`flex items-center gap-1.5 mb-0.5 opacity-70 ${justifyClass} w-full`}>
                            <SunIcon className={`w-3 h-3 ${isLive ? 'text-orange-400' : 'text-slate-400'} `} />
                            <span className={`text-sm md: text-sm font-bold uppercase tracking-widest ${isLive ? 'text-orange-200' : 'text-slate-300'} `}>UV Index</span>
                        </div>
                        <div className={`flex items-baseline gap-0.5 ${justifyClass} w-full`}>
                            <span className="text-2xl md:text-5xl font-black tracking-tighter text-white">{values.uv}</span>
                            <span className="text-sm md:text-sm font-medium text-gray-400">/11</span>
                        </div>
                        <div className={`flex items-center gap-1 mt-auto pt-1 w-full ${justifyClass}`}>
                            <span className="text-sm md:text-sm font-bold text-orange-300 opacity-80">
                                {data.uvIndex && data.uvIndex > 8 ? 'Extreme' : data.uvIndex && data.uvIndex > 5 ? 'High' : 'Moderate'}
                            </span>
                        </div>
                    </div>
                );
            case 'sunrise':
                return (
                    <div className={`flex flex-col h-full justify-between w-full ${flexColAlign}`}>
                        <div className={`flex items-center gap-1.5 mb-0.5 opacity-70 ${justifyClass} w-full`}>
                            <SunriseIcon className={`w-3 h-3 ${isLive ? 'text-amber-400' : 'text-slate-400'} `} />
                            <span className={`text-sm md: text-sm font-bold uppercase tracking-widest ${isLive ? 'text-amber-200' : 'text-slate-300'} `}>Sunrise</span>
                        </div>
                        <div className={`flex items-baseline gap-0.5 ${justifyClass} w-full`}>
                            <span className="text-xl md:text-4xl font-black tracking-tighter text-white">{values.sunrise}</span>
                        </div>
                    </div>
                );
            case 'sunset':
                return (
                    <div className={`flex flex-col h-full justify-between w-full ${flexColAlign}`}>
                        <div className={`flex items-center gap-1.5 mb-0.5 opacity-70 ${justifyClass} w-full`}>
                            <SunsetIcon className={`w-3 h-3 ${isLive ? 'text-indigo-400' : 'text-slate-400'} `} />
                            <span className={`text-sm md: text-sm font-bold uppercase tracking-widest ${isLive ? 'text-indigo-200' : 'text-slate-300'} `}>Sunset</span>
                        </div>
                        <div className={`flex items-baseline gap-0.5 ${justifyClass} w-full`}>
                            <span className="text-xl md:text-4xl font-black tracking-tighter text-white">{values.sunset}</span>
                        </div>
                    </div>
                );
            case 'waterTemp':
                return (
                    <div className={`flex flex-col h-full justify-between w-full ${flexColAlign}`}>
                        <div className={`flex items-center gap-1.5 mb-0.5 opacity-70 ${justifyClass} w-full`}>
                            <ThermometerIcon className={`w-3 h-3 ${isLive ? 'text-cyan-400' : 'text-slate-400'} `} />
                            <span className={`text-sm md: text-sm font-bold uppercase tracking-widest ${isLive ? 'text-cyan-200' : 'text-slate-300'} `}>Sea Temp</span>
                        </div>
                        <div className={`flex items-baseline gap-0.5 ${justifyClass} w-full`}>
                            <span className="text-2xl md:text-5xl font-black tracking-tighter text-white">{values.waterTemperature}</span>
                            <span className="text-sm md:text-sm font-medium text-gray-400">°{units.temp}</span>
                            {renderTrend(trend, true)}
                        </div>
                        <div className={`mt-auto pt-1 text-sm md:text-sm text-cyan-300 font-bold opacity-70 ${textClass} w-full`}>
                            Surface
                        </div>
                    </div>
                );
            case 'currentSpeed':
                return (
                    <div className={`flex flex-col h-full justify-between w-full ${flexColAlign}`}>
                        <div className={`flex items-center gap-1.5 mb-0.5 opacity-70 ${justifyClass} w-full`}>
                            <WaveIcon className={`w-3 h-3 ${isLive ? 'text-emerald-400' : 'text-slate-400'} `} />
                            <span className={`text-sm md: text-sm font-bold uppercase tracking-widest ${isLive ? 'text-emerald-200' : 'text-slate-300'} `}>Drift</span>
                        </div>
                        <div className={`flex items-baseline gap-0.5 ${justifyClass} w-full`}>
                            <span className="text-2xl md:text-5xl font-black tracking-tighter text-white">{values.currentSpeed}</span>
                            <span className="text-sm md:text-sm font-medium text-gray-400">kts</span>
                            {renderTrend(trend, true)}
                        </div>
                        <div className={`mt-auto pt-1 text-sm md:text-sm text-emerald-300 font-bold opacity-70 ${textClass} w-full`}>
                            --
                        </div>
                    </div>
                );
            case 'currentDirection':
                return (
                    <div className={`flex flex-col h-full justify-between w-full ${flexColAlign}`}>
                        <div className={`flex items-center gap-1.5 mb-0.5 opacity-70 ${justifyClass} w-full`}>
                            <CompassIcon
                                className={`w-3 h-3 ${isLive ? 'text-teal-400' : 'text-slate-400'} `}
                                rotation={typeof data.currentDirection === 'number' ? data.currentDirection : 0}
                            />
                            <span className={`text-sm md: text-sm font-bold uppercase tracking-widest ${isLive ? 'text-teal-200' : 'text-slate-300'} `}>Set</span>
                        </div>
                        <div className={`flex items-baseline gap-0.5 ${justifyClass} w-full`}>
                            <span className="text-2xl md:text-5xl font-black tracking-tighter text-white">{values.currentDirection}</span>
                        </div>
                        <div className={`mt-auto pt-1 text-sm md:text-sm text-teal-300 font-bold opacity-70 ${textClass} w-full`}>
                            {typeof data.currentDirection === 'number' ? Math.round(data.currentDirection) + '°' : '--'} True
                        </div>
                    </div>
                );
            default:
                return null;
        }
    };

    return (
        <div className={containerClass}>
            {renderContent()}
        </div>
    );
};
