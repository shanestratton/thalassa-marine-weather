import React from 'react';
import {
    WindIcon,
    WaveIcon,
    GaugeIcon,
    EyeIcon,
    SunIcon,
    SunriseIcon,
    SunsetIcon,
    ThermometerIcon,
    ArrowUpIcon,
    ArrowDownIcon,
    MinusIcon
} from '../Icons';
import { WeatherMetrics, UnitPreferences } from '../../types';
import {
    convertTemp,
    convertSpeed,
    convertLength,
    convertDistance
} from '../../utils';
import { getMoonPhase } from './WeatherHelpers';

interface HeroWidgetsProps {
    data: WeatherMetrics;
    units: UnitPreferences;
    cardTime?: number | null;
    sources?: Record<string, { source: string; sourceColor?: 'green' | 'amber' | 'red'; sourceName?: string }>;
    trends?: Record<string, 'up' | 'down' | 'stable'>;
}

export const HeroWidgets: React.FC<HeroWidgetsProps> = ({
    data,
    units,
    cardTime,
    sources,
    trends
}) => {
    // Helper to get source text color
    const getSourceColor = (metricKey: string): string => {
        if (!sources || !sources[metricKey]) return 'text-white';
        const sourceColor = sources[metricKey]?.sourceColor;
        switch (sourceColor) {
            case 'green': return 'text-emerald-400';
            case 'amber': return 'text-amber-400';
            case 'red': return 'text-red-400';
            default: return 'text-white';
        }
    };

    // Helper to render trend arrow
    const getTrendIcon = (metricKey: string) => {
        if (!trends || !trends[metricKey]) return null;
        const trend = trends[metricKey];
        if (trend === 'up') return <ArrowUpIcon className="w-2.5 h-2.5 text-orange-400 ml-0.5" />;
        if (trend === 'down') return <ArrowDownIcon className="w-2.5 h-2.5 text-cyan-400 ml-0.5" />;
        return <MinusIcon className="w-2.5 h-2.5 text-gray-500 ml-0.5" />;
    };

    return (
        <div className="relative w-full rounded-xl overflow-hidden backdrop-blur-md border border-white/10 bg-black">
            {/* TOP ROW */}
            <div className="w-full grid grid-cols-5 gap-2 px-2 py-2 border-b border-white/5">
                <div className="flex flex-col items-center justify-center gap-1 bg-white/10 rounded-lg p-1.5 min-h-[60px] shadow-lg">
                    <div className="flex items-center gap-1">
                        <WindIcon className="w-3.5 h-3.5 text-sky-400" />
                        <span className="text-[9px] text-sky-300 uppercase tracking-wider font-bold">Wind</span>
                    </div>
                    <div className="flex items-baseline gap-0.5">
                        <span className={`text-base font-black ${getSourceColor('windSpeed')}`}>
                            {data.windSpeed !== null && data.windSpeed !== undefined ? convertSpeed(data.windSpeed, units.speed) : '--'}
                        </span>
                        <span className="text-[8px] font-medium text-gray-400">{units.speed}</span>
                        {getTrendIcon('windSpeed')}
                    </div>
                </div>
                <div className="flex flex-col items-center justify-center gap-1 bg-white/10 rounded-lg p-1.5 min-h-[60px] shadow-lg">
                    <div className="flex items-center gap-1">
                        <WindIcon className="w-3.5 h-3.5 text-purple-400" />
                        <span className="text-[9px] text-purple-300 uppercase tracking-wider font-bold">Gust</span>
                    </div>
                    <div className="flex items-baseline gap-0.5">
                        <span className={`text-sm font-bold ${getSourceColor('windGust')}`}>
                            {data.windGust !== null && data.windGust !== undefined ? convertSpeed(data.windGust, units.speed) : '--'}
                        </span>
                        <span className="text-[8px] font-medium text-gray-400">{units.speed}</span>
                        {getTrendIcon('windGust')}
                    </div>
                </div>
                <div className="flex flex-col items-center justify-center gap-1 bg-white/10 rounded-lg p-1.5 min-h-[60px] shadow-lg">
                    <div className="flex items-center gap-1">
                        <WaveIcon className="w-3.5 h-3.5 text-cyan-400" />
                        <span className="text-[9px] text-cyan-300 uppercase tracking-wider font-bold">Waves</span>
                    </div>
                    <div className="flex items-baseline gap-0.5">
                        <span className={`text-sm font-bold ${getSourceColor('waveHeight')}`}>
                            {data.waveHeight !== null && data.waveHeight !== undefined ? convertLength(data.waveHeight, units.waveHeight) : '--'}
                        </span>
                        <span className="text-[8px] font-medium text-gray-400">{units.waveHeight}</span>
                        {getTrendIcon('waveHeight')}
                    </div>
                </div>
                <div className="flex flex-col items-center justify-center gap-1 bg-white/10 rounded-lg p-1.5 min-h-[60px] shadow-lg">
                    <div className="flex items-center gap-1">
                        <ThermometerIcon className="w-3.5 h-3.5 text-blue-400" />
                        <span className="text-[9px] text-blue-300 uppercase tracking-wider font-bold">Seas</span>
                    </div>
                    <span className={`text-sm font-bold ${getSourceColor('waterTemperature')}`}>
                        {data.waterTemperature !== null && data.waterTemperature !== undefined ? convertTemp(data.waterTemperature, units.temp) : '--'}°
                    </span>
                </div>
                <div className="flex flex-col items-center justify-center gap-1 bg-white/10 rounded-lg p-1.5 min-h-[60px] shadow-lg">
                    <div className="flex items-center gap-1">
                        <GaugeIcon className="w-3.5 h-3.5 text-teal-400" />
                        <span className="text-[9px] text-teal-300 uppercase tracking-wider font-bold">hPa</span>
                    </div>
                    <span className={`text-base font-black ${getSourceColor('pressure')}`}>
                        {data.pressure !== null && data.pressure !== undefined ? Math.round(data.pressure) : '--'}
                    </span>
                </div>
            </div>
            {/* BOTTOM ROW: Vis→UV→Sunrise→Sunset→Moon */}
            <div className="w-full grid grid-cols-5 gap-2 px-2 py-2">
                <div className="flex flex-col items-center justify-center gap-1 bg-white/10 rounded-lg p-1.5 min-h-[60px] shadow-lg">
                    <div className="flex items-center gap-1">
                        <EyeIcon className="w-3.5 h-3.5 text-emerald-400" />
                        <span className="text-[9px] text-emerald-300 uppercase tracking-wider font-bold">Vis</span>
                    </div>
                    <div className="flex items-baseline gap-0.5">
                        <span className={`text-base font-black ${getSourceColor('visibility')}`}>
                            {data.visibility !== null && data.visibility !== undefined ? convertDistance(data.visibility, units.visibility || 'nm') : '--'}
                        </span>
                        <span className="text-[8px] font-medium text-gray-400">{units.visibility || 'nm'}</span>
                        {getTrendIcon('visibility')}
                    </div>
                </div>
                <div className="flex flex-col items-center justify-center gap-1 bg-white/10 rounded-lg p-1.5 min-h-[60px] shadow-lg">
                    <div className="flex items-center gap-1">
                        <SunIcon className="w-3.5 h-3.5 text-amber-400" />
                        <span className="text-[9px] text-amber-300 uppercase tracking-wider font-bold">UV</span>
                    </div>
                    <span className={`text-sm font-bold ${getSourceColor('uvIndex')}`}>
                        {data.uvIndex !== null && data.uvIndex !== undefined ? Math.round(data.uvIndex) : '--'}
                    </span>
                </div>
                <div className="flex flex-col items-center justify-center gap-1 bg-white/10 rounded-lg p-1.5 min-h-[60px] shadow-lg">
                    <div className="flex items-center gap-1">
                        <SunriseIcon className="w-3.5 h-3.5 text-orange-400" />
                        <span className="text-[9px] text-orange-300 uppercase tracking-wider font-bold">Rise</span>
                    </div>
                    <span className="text-base font-black text-emerald-400">{data.sunrise || '--:--'}</span>
                </div>
                <div className="flex flex-col items-center justify-center gap-1 bg-white/10 rounded-lg p-1.5 min-h-[60px] shadow-lg">
                    <div className="flex items-center gap-1">
                        <SunsetIcon className="w-3.5 h-3.5 text-pink-400" />
                        <span className="text-[9px] text-pink-300 uppercase tracking-wider font-bold">Set</span>
                    </div>
                    <span className="text-base font-black text-emerald-400">{data.sunset || '--:--'}</span>
                </div>
                <div className="flex flex-col items-center justify-center gap-1 bg-white/10 rounded-lg p-1.5 min-h-[60px] shadow-lg">
                    <div className="flex items-center gap-1">
                        <span className="text-[9px] text-slate-300 uppercase tracking-wider font-bold">Moon</span>
                    </div>
                    <span className="text-xl leading-none">
                        {getMoonPhase(new Date(cardTime || Date.now())).emoji}
                    </span>
                </div>
            </div>
        </div>
    );
};
