import React, { useMemo, useCallback } from 'react';
import { t } from '../../theme';
import { useEnvironment } from '../../context/ThemeContext';
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
    MinusIcon,
    CompassIcon,
    DropletIcon
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
    data: WeatherMetrics;  // Bottom row - updates with scroll
    currentData?: WeatherMetrics; // Top row - always shows current/live data
    units: UnitPreferences;
    cardTime?: number | null;
    sources?: Record<string, { source: string; sourceColor?: 'emerald' | 'amber' | 'white'; sourceName?: string }>;
    currentSources?: Record<string, { source: string; sourceColor?: 'emerald' | 'amber' | 'white'; sourceName?: string }>; // Sources for top row
    trends?: Record<string, 'up' | 'down' | 'stable'>;
    isLive?: boolean;
    topRowIsLive?: boolean; // Controls top row color independently
}

const HeroWidgetsComponent: React.FC<HeroWidgetsProps> = ({
    data,
    currentData,
    units,
    cardTime,
    sources,
    currentSources,
    trends,
    isLive = true,
    topRowIsLive = true
}) => {
    const env = useEnvironment();
    const isOnshore = env === 'onshore';
    const headingSize = isOnshore ? 'text-[10px]' : 'text-sm';
    const metricSize = 'text-base';
    const unitSize = isOnshore ? 'text-[10px]' : 'text-sm';
    // Use currentData for top row if provided, otherwise fallback to data
    const topRowData = currentData || data;
    const topRowSourcesMap = currentSources || sources;

    // PERF: Memoize helper to get source text color
    const getSourceColor = useCallback((metricKey: string, isTopRow: boolean = false): string => {
        // Top row always shows source colors (it's always current data)
        // Bottom row shows white when scrolling
        const effectiveIsLive = isTopRow ? topRowIsLive : isLive;
        const sourcesMap = isTopRow ? topRowSourcesMap : sources;

        // Forecast data should always be white
        if (!effectiveIsLive) return 'text-white';

        // Live data shows source colors
        if (!sourcesMap || !sourcesMap[metricKey]) return 'text-white';
        const sourceColor = sourcesMap[metricKey]?.sourceColor;
        switch (sourceColor) {
            case 'emerald': return 'text-emerald-400';  // Buoy data
            case 'amber': return 'text-amber-400';      // StormGlass data
            default: return 'text-white';               // Default/fallback
        }
    }, [isLive, topRowIsLive, sources, topRowSourcesMap]);

    // PERF: Memoize helper to render trend arrow
    const getTrendIcon = useCallback((metricKey: string) => {
        if (!trends || !trends[metricKey]) return null;
        const trend = trends[metricKey];
        if (trend === 'up') return <ArrowUpIcon className="w-2.5 h-2.5 text-orange-400 ml-0.5" />;
        if (trend === 'down') return <ArrowDownIcon className="w-2.5 h-2.5 text-cyan-400 ml-0.5" />;
        return <MinusIcon className="w-2.5 h-2.5 text-gray-500 ml-0.5" />;
    }, [trends]);

    return (
        <div
            className={`relative w-full rounded-xl overflow-hidden backdrop-blur-md ${t.border.default} bg-black`}
            role="region"
            aria-label="Weather metrics dashboard"
        >
            {/* TOP ROW: Wind Speed, Wind Direction, Wind Gusts, Wave Height, Wave Period */}
            <div
                className="w-full grid grid-cols-5 gap-2 px-2 py-2 border-b border-white/5"
                role="group"
                aria-label="Current conditions - Wind Speed, Wind Direction, Wind Gusts, Wave Height, Wave Period"
            >
                {/* Wind Speed */}
                <div
                    className="flex flex-col items-center justify-center gap-1 bg-white/10 rounded-lg p-1.5 min-h-[60px] shadow-lg"
                    aria-label={`Wind speed ${topRowData.windSpeed !== null && topRowData.windSpeed !== undefined ? convertSpeed(topRowData.windSpeed, units.speed) : 'unknown'} ${units.speed}`}
                >
                    <div className="flex items-center gap-1">
                        <WindIcon className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" />
                        <span className={`${headingSize} text-sky-300 uppercase tracking-wider font-bold`}>Wind</span>
                    </div>
                    <div className="flex items-baseline gap-0.5">
                        <span className={`${metricSize} font-black ${getSourceColor('windSpeed', true)}`}>
                            {topRowData.windSpeed !== null && topRowData.windSpeed !== undefined ? convertSpeed(topRowData.windSpeed, units.speed) : '--'}
                        </span>
                        <span className={`${unitSize} font-medium text-gray-400`}>{units.speed}</span>
                        {getTrendIcon('windSpeed')}
                    </div>
                </div>
                {/* Wind Direction */}
                <div className="flex flex-col items-center justify-center gap-1 bg-white/10 rounded-lg p-1.5 min-h-[60px] shadow-lg"
                    aria-label={`Wind direction ${topRowData.windDirection || 'unknown'}`}
                >
                    <div className="flex items-center gap-1">
                        <CompassIcon className="w-3.5 h-3.5 text-sky-400" rotation={topRowData.windDegree || 0} />
                        <span className={`${headingSize} text-sky-300 uppercase tracking-wider font-bold`}>Dir</span>
                    </div>
                    <span className={`${metricSize} font-black ${getSourceColor('windDirection', true)}`}>
                        {topRowData.windDirection || '--'}
                    </span>
                </div>
                {/* Wind Gusts */}
                <div className="flex flex-col items-center justify-center gap-1 bg-white/10 rounded-lg p-1.5 min-h-[60px] shadow-lg"
                    aria-label={`Wind gusts ${topRowData.windGust !== null && topRowData.windGust !== undefined ? convertSpeed(topRowData.windGust, units.speed) : 'unknown'} ${units.speed}`}
                >
                    <div className="flex items-center gap-1">
                        <WindIcon className="w-3.5 h-3.5 text-purple-400" />
                        <span className={`${headingSize} text-purple-300 uppercase tracking-wider font-bold`}>Gust</span>
                    </div>
                    <div className="flex items-baseline gap-0.5">
                        <span
                            className={`${metricSize} font-black ${getSourceColor('windGust', true)}`}
                        >
                            {(() => {
                                const gust = topRowData.windGust !== null && topRowData.windGust !== undefined ? convertSpeed(topRowData.windGust, units.speed) : null;
                                return gust !== null ? Math.round(gust) : '--';
                            })()}
                        </span>
                        <span className={`${unitSize} font-medium text-gray-400`}>{units.speed}</span>
                        {getTrendIcon('windGust')}
                    </div>
                </div>
                {/* Wave Height */}
                <div className="flex flex-col items-center justify-center gap-1 bg-white/10 rounded-lg p-1.5 min-h-[60px] shadow-lg"
                    aria-label={`Wave height ${topRowData.waveHeight !== null && topRowData.waveHeight !== undefined ? convertLength(topRowData.waveHeight, units.waveHeight) : 'unknown'} ${units.waveHeight}`}
                >
                    <div className="flex items-center gap-1">
                        <WaveIcon className="w-3.5 h-3.5 text-cyan-400" />
                        <span className={`${headingSize} text-cyan-300 uppercase tracking-wider font-bold`}>Wave</span>
                    </div>
                    <div className="flex items-baseline gap-0.5">
                        <span className={`${metricSize} font-bold ${getSourceColor('waveHeight', true)}`}>
                            {topRowData.waveHeight !== null && topRowData.waveHeight !== undefined ? convertLength(topRowData.waveHeight, units.waveHeight) : '--'}
                        </span>
                        <span className={`${unitSize} font-medium text-gray-400`}>{units.waveHeight}</span>
                        {getTrendIcon('waveHeight')}
                    </div>
                </div>
                {/* Wave Period */}
                <div className="flex flex-col items-center justify-center gap-1 bg-white/10 rounded-lg p-1.5 min-h-[60px] shadow-lg"
                    aria-label={`Wave period ${topRowData.swellPeriod !== null && topRowData.swellPeriod !== undefined ? Math.round(topRowData.swellPeriod) : 'unknown'} seconds`}
                >
                    <div className="flex items-center gap-1">
                        <WaveIcon className="w-3.5 h-3.5 text-cyan-400" />
                        <span className={`${headingSize} text-cyan-300 uppercase tracking-wider font-bold`}>Per.</span>
                    </div>
                    <div className="flex items-baseline gap-0.5">
                        <span className={`${metricSize} font-black ${getSourceColor('swellPeriod', true)}`}>
                            {topRowData.swellPeriod !== null && topRowData.swellPeriod !== undefined ? Math.round(topRowData.swellPeriod) : '--'}
                        </span>
                        <span className={`${unitSize} font-medium text-gray-400`}>s</span>
                    </div>
                </div>
            </div>
            {/* BOTTOM ROW: UV, Visibility, Pressure, Sea Temp, Rainfall */}
            <div className="w-full grid grid-cols-5 gap-2 px-2 py-2"
                role="group"
                aria-label="Conditions - UV, Visibility, Pressure, Sea Temperature, Rainfall"
            >
                {/* UV */}
                <div className="flex flex-col items-center justify-center gap-1 bg-white/10 rounded-lg p-1.5 min-h-[60px] shadow-lg"
                    aria-label={`UV index ${data.uvIndex !== null && data.uvIndex !== undefined ? Math.ceil(data.uvIndex) : 'unknown'}`}
                >
                    <div className="flex items-center gap-1">
                        <SunIcon className="w-3.5 h-3.5 text-amber-400" />
                        <span className={`${headingSize} text-amber-300 uppercase tracking-wider font-bold`}>UV</span>
                    </div>
                    <span className={`text-sm font-bold ${getSourceColor('uvIndex')}`}>
                        {data.uvIndex !== null && data.uvIndex !== undefined ? Math.ceil(data.uvIndex) : '--'}
                    </span>
                </div>
                {/* Visibility */}
                <div className="flex flex-col items-center justify-center gap-1 bg-white/10 rounded-lg p-1.5 min-h-[60px] shadow-lg"
                    aria-label={`Visibility ${data.visibility !== null && data.visibility !== undefined ? Math.round(data.visibility) : 'unknown'} ${units.visibility || 'nm'}`}
                >
                    <div className="flex items-center gap-1">
                        <EyeIcon className="w-3.5 h-3.5 text-emerald-400" />
                        <span className={`${headingSize} text-emerald-300 uppercase tracking-wider font-bold`}>Vis</span>
                    </div>
                    <div className="flex items-baseline gap-0.5">
                        <span className={`text-base font-black ${getSourceColor('visibility')}`}>
                            {data.visibility !== null && data.visibility !== undefined ? Math.round(data.visibility) : '--'}
                        </span>
                        <span className="text-sm font-medium text-gray-400\">{units.visibility || 'nm'}</span>
                        {getTrendIcon('visibility')}
                    </div>
                </div>
                {/* Pressure */}
                <div className="flex flex-col items-center justify-center gap-1 bg-white/10 rounded-lg p-1.5 min-h-[60px] shadow-lg"
                    aria-label={`Barometric pressure ${data.pressure !== null && data.pressure !== undefined ? Math.round(data.pressure) : 'unknown'} hectopascals`}
                >
                    <div className="flex items-center gap-1">
                        <GaugeIcon className="w-3.5 h-3.5 text-teal-400" />
                        <span className={`${headingSize} text-teal-300 uppercase tracking-wider font-bold`}>hPa</span>
                    </div>
                    <span className={`text-base font-black ${getSourceColor('pressure')}`}>
                        {data.pressure !== null && data.pressure !== undefined ? Math.round(data.pressure) : '--'}
                    </span>
                </div>
                {/* Sea Temp */}
                <div className="flex flex-col items-center justify-center gap-1 bg-white/10 rounded-lg p-1.5 min-h-[60px] shadow-lg"
                    aria-label={`Sea temperature ${data.waterTemperature !== null && data.waterTemperature !== undefined ? convertTemp(data.waterTemperature, units.temp) : 'unknown'} degrees ${units.temp === 'C' ? 'Celsius' : 'Fahrenheit'}`}
                >
                    <div className="flex items-center gap-1">
                        <ThermometerIcon className="w-3.5 h-3.5 text-blue-400" />
                        <span className={`${headingSize} text-blue-300 uppercase tracking-wider font-bold`}>Seas</span>
                    </div>
                    <span className={`text-sm font-bold ${getSourceColor('waterTemperature')}`}>
                        {data.waterTemperature !== null && data.waterTemperature !== undefined ? convertTemp(data.waterTemperature, units.temp) : '--'}°
                    </span>
                </div>
                {/* Rainfall */}
                <div className="flex flex-col items-center justify-center gap-1 bg-white/10 rounded-lg p-1.5 min-h-[60px] shadow-lg"
                    aria-label={`Rainfall ${data.precipitation !== null && data.precipitation !== undefined ? Math.round(data.precipitation) : 'unknown'} millimeters`}
                >
                    <div className="flex items-center gap-1">
                        <DropletIcon className="w-3.5 h-3.5 text-blue-400" />
                        <span className={`${headingSize} text-blue-300 uppercase tracking-wider font-bold`}>Rain</span>
                    </div>
                    <div className="flex items-baseline gap-0.5">
                        <span className={`text-base font-black ${getSourceColor('precipitation')}`}>
                            {data.precipitation !== null && data.precipitation !== undefined ? Math.round(data.precipitation) : '--'}
                        </span>
                        <span className="text-sm font-medium text-gray-400">mm</span>
                    </div>
                </div>
            </div>
        </div>
    );
};

// PERF: Wrap with React.memo to prevent re-renders when props haven't changed
export const HeroWidgets = React.memo(HeroWidgetsComponent);
