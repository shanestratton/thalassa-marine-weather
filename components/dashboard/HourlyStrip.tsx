import React from 'react';
import { UnitPreferences, HourlyForecast } from '../../types';
import { convertTemp } from '../../utils';
import { SunIcon, CloudIcon, RainIcon, WindIcon } from '../Icons';

interface HourlyStripProps {
    hourly: HourlyForecast[];
    units: UnitPreferences;
    timeZone?: string;
    onHourSelect?: (hour: HourlyForecast) => void;
}

/**
 * Compact horizontal strip showing hourly forecasts
 * Used in Essential mode for quick weather overview
 */
export const HourlyStrip: React.FC<HourlyStripProps> = ({
    hourly,
    units,
    timeZone,
    onHourSelect
}) => {
    // Get weather icon based on conditions
    const getWeatherIcon = (condition?: string, precipitation?: number | null) => {
        const cond = (condition || '').toLowerCase();
        if (cond.includes('rain') || cond.includes('shower') || (precipitation && precipitation > 1)) {
            return <RainIcon className="w-5 h-5 text-blue-400" />;
        }
        if (cond.includes('cloud') || cond.includes('overcast')) {
            return <CloudIcon className="w-5 h-5 text-gray-300" />;
        }
        if (cond.includes('wind') || cond.includes('gust')) {
            return <WindIcon className="w-5 h-5 text-cyan-400" />;
        }
        // Default sunny/clear
        return <SunIcon className="w-5 h-5 text-yellow-400" />;
    };

    // Format hour for display (time is ISO string)
    const formatHour = (timeStr: string) => {
        const date = new Date(timeStr);
        try {
            return date.toLocaleTimeString([], {
                hour: 'numeric',
                hour12: true,
                timeZone: timeZone || undefined
            }).replace(' ', '');
        } catch {
            return date.toLocaleTimeString([], { hour: 'numeric', hour12: true }).replace(' ', '');
        }
    };

    // Take first 24 hours
    const hoursToShow = hourly.slice(0, 24);

    if (!hoursToShow.length) {
        return null;
    }

    // Cards will fill available width with scroll-snap
    return (
        <div className="w-full overflow-hidden">
            <div
                className="flex overflow-x-auto gap-0 scrollbar-hide snap-x snap-mandatory"
                style={{
                    WebkitOverflowScrolling: 'touch',
                    scrollBehavior: 'smooth'
                }}
            >
                {hoursToShow.map((hour, idx) => (
                    <button
                        key={hour.time || idx}
                        onClick={() => onHourSelect?.(hour)}
                        className="flex-shrink-0 flex flex-col items-center justify-center bg-white/5 rounded-lg py-2 hover:bg-white/10 transition-colors border border-white/5 snap-start"
                        style={{
                            // Width calculated to show ~7 cards (adjusts to screen)
                            width: 'calc((100vw - 16px) / 7)',
                            minWidth: '48px',
                            maxWidth: '60px'
                        }}
                    >
                        {/* Hour */}
                        <span className="text-[10px] text-white/60 font-medium mb-1">
                            {formatHour(hour.time)}
                        </span>

                        {/* Weather Icon */}
                        {getWeatherIcon(hour.condition, hour.precipitation)}

                        {/* Temperature */}
                        <span className="text-sm font-bold text-white mt-1">
                            {hour.temperature !== null && hour.temperature !== undefined
                                ? `${convertTemp(hour.temperature, units.temp)}°`
                                : '--'}
                        </span>

                        {/* Wind speed small */}
                        <span className="text-[9px] text-white/50">
                            {hour.windSpeed !== null && hour.windSpeed !== undefined
                                ? `${Math.round(hour.windSpeed)}${units.speed}`
                                : ''}
                        </span>
                    </button>
                ))}
            </div>
        </div>
    );
};
