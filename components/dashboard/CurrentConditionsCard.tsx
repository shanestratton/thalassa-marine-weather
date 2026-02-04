import React from 'react';
import { WeatherMetrics, UnitPreferences } from '../../types';
import { convertTemp, convertSpeed } from '../../utils';
import { SunIcon, CloudIcon, RainIcon, WindIcon, DropletIcon, ThermometerIcon } from '../Icons';

interface CurrentConditionsCardProps {
    data: WeatherMetrics;
    units: UnitPreferences;
    timeZone?: string;
}

/**
 * Compact current conditions summary card for Essential mode
 * Shows: weather icon, temp, wind+direction, rain %, UV, humidity, dew point
 */
export const CurrentConditionsCard: React.FC<CurrentConditionsCardProps> = ({
    data,
    units,
}) => {
    // Get weather icon based on conditions
    const getWeatherIcon = () => {
        const cond = (data.condition || '').toLowerCase();
        const precip = data.precipitation;

        if (cond.includes('rain') || cond.includes('shower') || (precip && precip > 1)) {
            return <RainIcon className="w-8 h-8 text-blue-400" />;
        }
        if (cond.includes('cloud') || cond.includes('overcast')) {
            return <CloudIcon className="w-8 h-8 text-gray-300" />;
        }
        if (cond.includes('wind') || cond.includes('gust')) {
            return <WindIcon className="w-8 h-8 text-cyan-400" />;
        }
        return <SunIcon className="w-8 h-8 text-yellow-400" />;
    };

    // Wind direction arrow rotation
    const windRotation = data.windDegree ? data.windDegree : 0;

    // Format values with fallbacks
    const temp = data.airTemperature !== null && data.airTemperature !== undefined
        ? convertTemp(data.airTemperature, units.temp)
        : '--';

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

    const dewPoint = data.dewPoint !== null && data.dewPoint !== undefined
        ? convertTemp(data.dewPoint, units.temp)
        : '--';

    const condition = data.condition || 'Clear';

    return (
        <div className="w-full px-3 py-2">
            <div className="bg-white/5 backdrop-blur-md rounded-xl border border-white/10 p-3">
                {/* Top Row: Icon + Condition + Temp */}
                <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                        {getWeatherIcon()}
                        <span className="text-white/80 font-medium text-sm capitalize">
                            {condition}
                        </span>
                    </div>
                    <span className="text-3xl font-black text-white tracking-tight">
                        {temp}°
                    </span>
                </div>

                {/* Bottom Row: Stats Grid */}
                <div className="grid grid-cols-5 gap-2 text-center">
                    {/* Wind */}
                    <div className="flex flex-col items-center">
                        <div className="flex items-center gap-0.5">
                            <svg
                                className="w-3 h-3 text-cyan-400"
                                style={{ transform: `rotate(${windRotation + 180}deg)` }}
                                viewBox="0 0 24 24"
                                fill="currentColor"
                            >
                                <path d="M12 2L8 10h8L12 2z" />
                                <rect x="10" y="10" width="4" height="12" />
                            </svg>
                            <span className="text-[10px] text-white/50 font-bold">{windDir}</span>
                        </div>
                        <span className="text-sm font-bold text-white">{windSpeed}</span>
                        <span className="text-[8px] text-white/40 uppercase">{units.speed}</span>
                    </div>

                    {/* Rain */}
                    <div className="flex flex-col items-center">
                        <RainIcon className="w-3 h-3 text-blue-400" />
                        <span className="text-sm font-bold text-white">{rainChance}</span>
                        <span className="text-[8px] text-white/40 uppercase">Rain</span>
                    </div>

                    {/* UV */}
                    <div className="flex flex-col items-center">
                        <SunIcon className="w-3 h-3 text-orange-400" />
                        <span className="text-sm font-bold text-white">{uvIndex}</span>
                        <span className="text-[8px] text-white/40 uppercase">UV</span>
                    </div>

                    {/* Humidity */}
                    <div className="flex flex-col items-center">
                        <DropletIcon className="w-3 h-3 text-sky-400" />
                        <span className="text-sm font-bold text-white">{humidity}</span>
                        <span className="text-[8px] text-white/40 uppercase">Humid</span>
                    </div>

                    {/* Dew Point */}
                    <div className="flex flex-col items-center">
                        <ThermometerIcon className="w-3 h-3 text-teal-400" />
                        <span className="text-sm font-bold text-white">{dewPoint}°</span>
                        <span className="text-[8px] text-white/40 uppercase">Dew</span>
                    </div>
                </div>
            </div>
        </div>
    );
};
