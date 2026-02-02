import React from 'react';
import { ArrowUpIcon, ArrowDownIcon } from '../Icons';
import { WeatherMetrics, UnitPreferences } from '../../types';
import { convertTemp } from '../../utils';
import { generateWeatherNarrative } from './WeatherHelpers';

interface HeroHeaderProps {
    data: WeatherMetrics;
    units: UnitPreferences;
    isLive: boolean;
    isDay: boolean;
    dateLabel: string;
    timeLabel: string;
    timeZone?: string;
    sources?: Record<string, { source: string; sourceColor?: 'green' | 'amber' | 'red'; sourceName?: string }>;
}

export const HeroHeader: React.FC<HeroHeaderProps> = ({
    data,
    units,
    isLive,
    isDay,
    dateLabel,
    timeLabel,
    timeZone,
    sources
}) => {
    // Helper to get source text color for temperature
    const getTempColor = (): string => {
        if (!sources || !sources['airTemperature']) return 'text-white';
        const sourceColor = sources['airTemperature']?.sourceColor;
        switch (sourceColor) {
            case 'green': return 'text-emerald-400';
            case 'amber': return 'text-amber-400';
            case 'red': return 'text-red-400';
            default: return 'text-white';
        }
    };

    return (
        <div className="relative w-full rounded-2xl overflow-hidden backdrop-blur-md border border-white/10 bg-black">
            <div className="absolute inset-0 z-0">
                <div className={`absolute inset-0 bg-gradient-to-br ${isDay ? 'from-blue-900/20 via-slate-900/40 to-black/60' : 'from-red-900/10 via-slate-900/40 to-black/60'}`} />
            </div>
            <div className={`relative z-10 rounded-2xl p-0 backdrop-blur-md flex flex-col overflow-hidden border shadow-lg ${isDay ? 'bg-gradient-to-br from-sky-900/20 via-slate-900/40 to-black/40 border-sky-400/20 shadow-sky-900/5' : 'bg-gradient-to-br from-indigo-900/20 via-slate-900/40 to-black/40 border-indigo-400/20 shadow-indigo-900/5'}`}>
                <div className="absolute -top-10 -right-10 w-40 h-40 bg-gradient-to-br from-indigo-500/20 via-purple-500/10 to-transparent rounded-full blur-2xl pointer-events-none" />
                <div className="flex flex-row w-full min-h-[90px]">
                    {/* Temperature */}
                    <div className="flex-1 border-r border-white/5 p-2 flex flex-col justify-center items-start min-w-0 bg-white/0">
                        <div className="flex items-start leading-none relative">
                            {(() => {
                                const tempStr = (data.airTemperature !== null ? convertTemp(data.airTemperature, units.temp) : '--').toString();
                                const len = tempStr.length;
                                const sizeClass = len > 3 ? 'text-3xl md:text-4xl' : len > 2 ? 'text-4xl md:text-5xl' : 'text-5xl md:text-6xl';
                                return <span className={`${sizeClass} font-black tracking-tighter ${getTempColor()} drop-shadow-2xl leading-none transition-all duration-300`}>{tempStr}°</span>;
                            })()}
                        </div>
                        <div className="flex items-center gap-2 mt-1">
                            <div className="flex items-center gap-0.5">
                                <ArrowUpIcon className="w-2.5 h-2.5 text-orange-400 opacity-70" />
                                <span className="text-[10px] font-bold text-white opacity-80">
                                    {(data as any).highTemp !== undefined ? convertTemp((data as any).highTemp, units.temp) : '--'}°
                                </span>
                            </div>
                            <div className="w-px h-2.5 bg-white/20"></div>
                            <div className="flex items-center gap-0.5">
                                <ArrowDownIcon className="w-2.5 h-2.5 text-cyan-400 opacity-70" />
                                <span className="text-[10px] font-bold text-white opacity-80">
                                    {(data as any).lowTemp !== undefined ? convertTemp((data as any).lowTemp, units.temp) : '--'}°
                                </span>
                            </div>
                        </div>
                    </div>

                    {/* Weather Narrative */}
                    <div className="flex-1 border-r border-white/5 p-3 flex flex-col justify-center items-center min-w-0 bg-gradient-to-br from-white/5 to-transparent backdrop-blur-sm overflow-hidden">
                        <div className="text-xs md:text-sm font-medium text-left leading-relaxed text-white/90 overflow-y-auto max-h-[75px] w-full pr-1 scrollbar-hide">
                            {generateWeatherNarrative(data)}
                        </div>
                    </div>

                    {/* Date/Time */}
                    <div className="flex-1 p-2 flex flex-col justify-between items-end min-w-0 bg-white/0">
                        <span className={`${isLive ? 'text-emerald-400' : 'text-blue-400'} font-extrabold text-[10px] md:text-xs tracking-[0.2em] leading-none w-full text-right`}>
                            {isLive ? "TODAY" : "FORECAST"}
                        </span>
                        <span className={`${isLive ? 'text-emerald-400' : 'text-blue-400'} ${(!isLive && dateLabel !== "TODAY") ? 'text-lg md:text-xl' : 'text-xl md:text-2xl'} font-black tracking-tighter leading-none w-full text-right whitespace-nowrap -translate-y-1`}>
                            {isLive ? "NOW" : dateLabel}
                        </span>
                        {timeLabel && (
                            <span className={`text-xs md:text-sm font-bold ${isLive ? 'text-emerald-400' : 'text-blue-400'} font-mono text-right whitespace-nowrap`}>
                                {timeLabel}
                            </span>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};
