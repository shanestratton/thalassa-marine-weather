import React, { useMemo, useCallback } from 'react';
import { useEnvironment } from '../../context/ThemeContext';
import { t } from '../../theme';
import { ArrowUpIcon, ArrowDownIcon, SunriseIcon, SunsetIcon } from '../Icons';
import { WeatherMetrics, UnitPreferences } from '../../types';
import { convertTemp } from '../../utils';
import { generateWeatherNarrative } from './WeatherHelpers';

/** Selects a weather background image based on conditions */
function getWeatherBackgroundImage(condition?: string, isDay?: boolean, cloudCover?: number | null, moonIllumination?: number): string {
    const c = (condition || '').toLowerCase();

    // Storm / Thunder always wins
    if (c.includes('storm') || c.includes('thunder')) return '/weather-bg/storm.png';
    // Rain / Showers / Drizzle / Pouring
    if (c.includes('rain') || c.includes('shower') || c.includes('drizzle') || c.includes('pour')) return '/weather-bg/rain.png';
    // Fog / Mist / Haze
    if (c.includes('fog') || c.includes('mist') || c.includes('haze')) return '/weather-bg/fog.png';

    // Night scenes
    if (!isDay) {
        if (moonIllumination !== undefined && moonIllumination > 0.3) return '/weather-bg/night-moon.png';
        return '/weather-bg/night-dark.png';
    }

    // Day scenes — use cloud cover thresholds
    const cc = cloudCover ?? 0;
    if (cc > 70) return '/weather-bg/cloudy.png';
    if (cc > 30) return '/weather-bg/partly-cloudy.png';
    return '/weather-bg/sunny.png';
}

interface HeroHeaderProps {
    data: WeatherMetrics;
    units: UnitPreferences;
    isLive: boolean;
    isDay: boolean;
    dateLabel: string;
    timeLabel: string;
    timeZone?: string;
    sources?: Record<string, { source: string; sourceColor?: 'emerald' | 'amber' | 'white'; sourceName?: string }>;
    isEssentialMode?: boolean;
    onToggleMode?: () => void;
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
    isEssentialMode = false,
    onToggleMode
}) => {
    const env = useEnvironment();
    const toggleLabelSize = env === 'onshore' ? 'text-[10px]' : 'text-sm';
    // PERF: Memoize helper to get source text color for temperature
    const getTempColor = useCallback((): string => {
        // Forecast data should always be white
        if (!isLive) return 'text-white';

        // Live data shows source colors
        if (!sources || !sources['airTemperature']) return 'text-white';
        const sourceColor = sources['airTemperature']?.sourceColor;
        switch (sourceColor) {
            case 'emerald': return 'text-emerald-400';  // Buoy data
            case 'amber': return 'text-amber-400';      // StormGlass data
            default: return 'text-white';               // Default
        }
    }, [isLive, sources]);

    // PERF: Memoize weather narrative generation
    const weatherNarrative = useMemo(() => generateWeatherNarrative(data), [data]);

    const bgImage = getWeatherBackgroundImage(data.condition, isDay, data.cloudCover, data.moonIllumination);

    return (
        <div className={`relative w-full rounded-2xl overflow-hidden backdrop-blur-md ${t.border.default} bg-black`}>
            {/* Dynamic Weather Background Image */}
            <div className="absolute inset-0 z-0 overflow-hidden bg-black">
                <img
                    src={bgImage}
                    alt=""
                    className="w-full h-full object-cover"
                    style={{ minWidth: '100%', minHeight: '100%' }}
                />
            </div>
            <div className="absolute inset-0 z-[1] bg-black/50" />
            <div className={`relative z-10 rounded-2xl p-0 flex flex-col overflow-hidden border shadow-lg ${isDay ? 'border-sky-400/20 shadow-sky-900/5' : 'border-indigo-400/20 shadow-indigo-900/5'}`}>
                <div className="absolute -top-10 -right-10 w-40 h-40 bg-gradient-to-br from-indigo-500/20 via-purple-500/10 to-transparent rounded-full blur-2xl pointer-events-none" />
                <div className="flex flex-row w-full min-h-[90px]">
                    {/* Temperature */}
                    <div className="flex-1 p-2 flex flex-col justify-center items-start min-w-0">
                        <div className="flex items-start leading-none">
                            {(() => {
                                const tempStr = (data.airTemperature !== null ? convertTemp(data.airTemperature, units.temp) : '--').toString();
                                const len = tempStr.length;
                                const sizeClass = len > 3 ? 'text-3xl md:text-4xl' : len > 2 ? 'text-4xl md:text-5xl' : 'text-5xl md:text-6xl';
                                return (
                                    <span
                                        className={`${sizeClass} font-black tracking-tighter ${getTempColor()} drop-shadow-2xl leading-none`}
                                        aria-label={`Temperature ${tempStr} degrees`}
                                    >
                                        {tempStr}°
                                    </span>
                                );
                            })()}
                        </div>
                        <div className="flex items-center gap-2 mt-2">
                            <div className="flex items-center gap-0.5">
                                <ArrowUpIcon className="w-2.5 h-2.5 text-orange-400 opacity-70" />
                                <span className="text-sm font-bold text-white opacity-80">
                                    {(data as any).highTemp !== undefined ? convertTemp((data as any).highTemp, units.temp) : '--'}°
                                </span>
                            </div>
                            <div className="w-px h-2.5 bg-white/20"></div>
                            <div className="flex items-center gap-0.5">
                                <ArrowDownIcon className="w-2.5 h-2.5 text-cyan-400 opacity-70" />
                                <span className="text-sm font-bold text-white opacity-80">
                                    {(data as any).lowTemp !== undefined ? convertTemp((data as any).lowTemp, units.temp) : '--'}°
                                </span>
                            </div>
                        </div>
                    </div>

                    {/* Date/Time - NOW IN CENTER - CLICKABLE TOGGLE */}
                    <button
                        onClick={onToggleMode}
                        className="flex-1 p-2 flex flex-col justify-center items-center min-w-0 hover:bg-white/5 active:bg-white/10 transition-colors cursor-pointer touch-none select-none"
                        style={{ WebkitTapHighlightColor: 'transparent' }}
                        aria-label="Toggle Mode">
                        <span className={`${isLive ? 'text-emerald-400' : 'text-blue-400'} font-extrabold text-sm md:text-sm tracking-[0.2em] leading-none w-full text-center`}>
                            {isLive ? "TODAY" : "FORECAST"}
                        </span>
                        <span className={`${isLive ? 'text-emerald-400' : 'text-blue-400'} ${(!isLive && dateLabel !== "TODAY") ? 'text-lg md:text-xl' : 'text-xl md:text-2xl'} font-black tracking-tighter leading-none w-full text-center whitespace-nowrap mt-0.5`}>
                            {isLive ? "NOW" : dateLabel}
                        </span>
                        {timeLabel && (
                            <span className={`text-sm font-bold ${isLive ? 'text-emerald-400' : 'text-blue-400'} font-mono text-center whitespace-nowrap mt-1`}>
                                {timeLabel}
                            </span>
                        )}
                        {/* Essential/Full mode toggle indicator */}
                        <div className="flex items-center gap-1.5 mt-1.5">
                            <span className={`${toggleLabelSize} font-bold uppercase tracking-wider ${isEssentialMode ? 'text-amber-400' : 'text-white/40'}`}>
                                Basic
                            </span>
                            <div className={`w-6 h-3 rounded-full ${isEssentialMode ? 'bg-amber-500/30' : 'bg-white/10'} relative transition-colors`}>
                                <div className={`absolute top-0.5 w-2 h-2 rounded-full ${isEssentialMode ? 'bg-amber-400 left-0.5' : 'bg-white/60 right-0.5'} transition-all`} />
                            </div>
                            <span className={`${toggleLabelSize} font-bold uppercase tracking-wider ${!isEssentialMode ? 'text-sky-400' : 'text-white/40'}`}>
                                Full
                            </span>
                        </div>
                    </button>

                    {/* Weather Narrative - NOW ON RIGHT */}
                    <div className="flex-1 p-3 flex flex-col justify-center items-center min-w-0 overflow-hidden">
                        <div
                            className="text-sm md:text-sm font-medium text-left leading-relaxed text-white/90 overflow-y-scroll h-[75px] w-full pr-1 scrollbar-hide"
                            aria-live="polite"
                            aria-label="Weather description"
                        >
                            {weatherNarrative}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

// PERF: Wrap with React.memo to prevent re-renders when props haven't changed
export const HeroHeader = React.memo(HeroHeaderComponent);
