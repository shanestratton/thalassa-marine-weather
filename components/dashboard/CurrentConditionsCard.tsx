import React from 'react';
import { WeatherMetrics, UnitPreferences } from '../../types';
import { convertSpeed } from '../../utils';
import { SunIcon, CloudIcon, RainIcon, WindIcon, DropletIcon, ThermometerIcon } from '../Icons';

interface CurrentConditionsCardProps {
    data: WeatherMetrics;
    units: UnitPreferences;
    timeZone?: string;
}

/**
 * Compact current conditions summary card for Essential mode
 * Shows: weather icon, condition, wind+direction, rain %, UV, humidity, dew point
 * Has weather-based background gradient
 */
export const CurrentConditionsCard: React.FC<CurrentConditionsCardProps> = ({
    data,
    units,
}) => {
    const cond = (data.condition || '').toLowerCase();
    const precip = data.precipitation;

    // Get weather icon based on conditions
    const getWeatherIcon = () => {
        if (cond.includes('rain') || cond.includes('shower') || (precip && precip > 1)) {
            return <RainIcon className="w-6 h-6 text-blue-300" />;
        }
        if (cond.includes('cloud') || cond.includes('overcast')) {
            return <CloudIcon className="w-6 h-6 text-gray-200" />;
        }
        if (cond.includes('wind') || cond.includes('gust')) {
            return <WindIcon className="w-6 h-6 text-cyan-300" />;
        }
        return <SunIcon className="w-6 h-6 text-yellow-300" />;
    };

    // Weather-based background gradient
    const getWeatherGradient = () => {
        if (cond.includes('rain') || cond.includes('shower') || (precip && precip > 1)) {
            return 'from-blue-900/60 via-slate-800/40 to-gray-900/50';
        }
        if (cond.includes('cloud') || cond.includes('overcast')) {
            return 'from-slate-700/50 via-gray-800/40 to-slate-900/50';
        }
        if (cond.includes('storm') || cond.includes('thunder')) {
            return 'from-purple-900/60 via-slate-800/40 to-gray-900/50';
        }
        // Clear/sunny
        return 'from-sky-800/50 via-blue-900/30 to-slate-900/40';
    };

    // Wind direction arrow rotation
    const windRotation = data.windDegree ? data.windDegree : 0;

    // Format values with fallbacks
    const windSpeed = data.windSpeed !== null && data.windSpeed !== undefined
        ? Math.round(convertSpeed(data.windSpeed, units.speed) ?? 0)
        : '--';

    const windDir = data.windDirection || '--';

    const rainChance = data.precipitation !== null && data.precipitation !== undefined
        ? `${Math.round(data.precipitation * 10)}%`
        : '--';

    const uvIndex = data.uvIndex !== undefined ? Math.round(data.uvIndex) : '--';

    const humidity = data.humidity !== null && data.humidity !== undefined
        ? `${Math.round(data.humidity)}%`
        : '--';

    // Dew point comes from StormGlass API
    const dewPoint = data.dewPoint !== null && data.dewPoint !== undefined
        ? `${Math.round(data.dewPoint)}°`
        : '--';

    const condition = data.condition || 'Clear';

    return (
        <div className="w-full h-[140px]">
            <div className={`bg-gradient-to-br ${getWeatherGradient()} backdrop-blur-md rounded-xl border border-white/10 p-4 h-full flex flex-col justify-between`}>
                {/* TOP ROW: Weather Icon + Condition */}
                <div className="flex items-center gap-3">
                    {getWeatherIcon()}
                    <span className="text-white font-bold text-lg capitalize">
                        {condition}
                    </span>
                </div>

                {/* BOTTOM ROW: Stats Grid - 5 columns */}
                <div className="flex items-end justify-between mt-3">
                    {/* Wind */}
                    <div className="flex flex-col items-center flex-1">
                        <div className="flex items-center gap-1 mb-1">
                            <svg
                                className="w-4 h-4 text-cyan-400"
                                style={{ transform: `rotate(${windRotation + 180}deg)` }}
                                viewBox="0 0 24 24"
                                fill="currentColor"
                            >
                                <path d="M12 2L8 10h8L12 2z" />
                                <rect x="10" y="10" width="4" height="12" />
                            </svg>
                            <span className="text-[10px] text-white/60 font-bold">{windDir}</span>
                        </div>
                        <span className="text-xl font-black text-white">{windSpeed}</span>
                        <span className="text-[9px] text-white/50 uppercase tracking-wide">{units.speed}</span>
                    </div>

                    {/* Rain */}
                    <div className="flex flex-col items-center flex-1">
                        <RainIcon className="w-4 h-4 text-blue-400 mb-1" />
                        <span className="text-xl font-black text-white">{rainChance}</span>
                        <span className="text-[9px] text-white/50 uppercase tracking-wide">Rain</span>
                    </div>

                    {/* UV */}
                    <div className="flex flex-col items-center flex-1">
                        <SunIcon className="w-4 h-4 text-orange-400 mb-1" />
                        <span className="text-xl font-black text-white">{uvIndex}</span>
                        <span className="text-[9px] text-white/50 uppercase tracking-wide">UV</span>
                    </div>

                    {/* Humidity */}
                    <div className="flex flex-col items-center flex-1">
                        <DropletIcon className="w-4 h-4 text-sky-400 mb-1" />
                        <span className="text-xl font-black text-white">{humidity}</span>
                        <span className="text-[9px] text-white/50 uppercase tracking-wide">Humid</span>
                    </div>

                    {/* Dew Point */}
                    <div className="flex flex-col items-center flex-1">
                        <ThermometerIcon className="w-4 h-4 text-teal-400 mb-1" />
                        <span className="text-xl font-black text-white">{dewPoint}</span>
                        <span className="text-[9px] text-white/50 uppercase tracking-wide">Dew</span>
                    </div>
                </div>
            </div>
        </div>
    );
};
