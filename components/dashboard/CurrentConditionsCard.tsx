import React from 'react';
import { WeatherMetrics, UnitPreferences } from '../../types';
import { convertSpeed } from '../../utils';
import { SunIcon, RainIcon, WindIcon, DropletIcon, ThermometerIcon } from '../Icons';

interface CurrentConditionsCardProps {
    data: WeatherMetrics;
    units: UnitPreferences;
    timeZone?: string;
}

/**
 * Minimal current conditions card for Essential mode.
 * Single row of 5 key metrics — condition is already shown in the header card above,
 * so this card just provides complementary at-a-glance data.
 */
export const CurrentConditionsCard: React.FC<CurrentConditionsCardProps> = ({
    data,
    units,
}) => {
    const windRotation = data.windDegree ? data.windDegree : 0;

    const windSpeed = data.windSpeed !== null && data.windSpeed !== undefined
        ? Math.round(convertSpeed(data.windSpeed, units.speed) ?? 0)
        : '--';
    const windDir = data.windDirection || '--';
    const rainChance = data.precipitation !== null && data.precipitation !== undefined
        ? `${Math.round(data.precipitation)}%`
        : '--';
    const uvIndex = data.uvIndex !== undefined ? Math.round(data.uvIndex) : '--';
    const humidity = data.humidity !== null && data.humidity !== undefined
        ? `${Math.round(data.humidity)}%`
        : '--';
    const dewPoint = data.dewPoint !== null && data.dewPoint !== undefined
        ? `${Math.round(data.dewPoint)}°`
        : '--';

    return (
        <div className="w-full rounded-xl overflow-hidden backdrop-blur-md bg-white/[0.08] border border-white/[0.15] shadow-2xl transition-all duration-300">
            {/* Single row: 5 key metrics — clean, minimal, no redundancy with header */}
            <div className="grid grid-cols-5 divide-x divide-white/[0.12] h-[80px]">
                {/* Wind */}
                <div className="flex flex-col items-center justify-center">
                    <div className="flex items-center gap-1">
                        <svg
                            className="w-3 h-3 text-teal-400"
                            style={{ transform: `rotate(${windRotation + 180}deg)` }}
                            viewBox="0 0 24 24"
                            fill="currentColor"
                        >
                            <path d="M12 2L8 10h8L12 2z" />
                            <rect x="10" y="10" width="4" height="12" />
                        </svg>
                        <span className="text-xs font-bold text-teal-400 uppercase tracking-wider">{windDir}</span>
                    </div>
                    <div className="flex items-baseline mt-1">
                        <span className="text-2xl font-bold text-white tracking-tight">{windSpeed}</span>
                        <span className="text-[10px] text-white/50 font-medium ml-0.5">{units.speed}</span>
                    </div>
                </div>

                {/* Rain */}
                <div className="flex flex-col items-center justify-center">
                    <div className="flex items-center gap-1">
                        <RainIcon className="w-3 h-3 text-teal-400" />
                        <span className="text-xs font-bold text-teal-400 uppercase tracking-wider">Rain</span>
                    </div>
                    <span className="text-2xl font-bold text-white tracking-tight mt-1">{rainChance}</span>
                </div>

                {/* UV */}
                <div className="flex flex-col items-center justify-center">
                    <div className="flex items-center gap-1">
                        <SunIcon className="w-3 h-3 text-teal-400" />
                        <span className="text-xs font-bold text-teal-400 uppercase tracking-wider">UV</span>
                    </div>
                    <span className="text-2xl font-bold text-white tracking-tight mt-1">{uvIndex}</span>
                </div>

                {/* Humidity */}
                <div className="flex flex-col items-center justify-center">
                    <div className="flex items-center gap-1">
                        <DropletIcon className="w-3 h-3 text-teal-400" />
                        <span className="text-xs font-bold text-teal-400 uppercase tracking-wider">Humid</span>
                    </div>
                    <span className="text-2xl font-bold text-white tracking-tight mt-1">{humidity}</span>
                </div>

                {/* Dew Point */}
                <div className="flex flex-col items-center justify-center">
                    <div className="flex items-center gap-1">
                        <ThermometerIcon className="w-3 h-3 text-teal-400" />
                        <span className="text-xs font-bold text-teal-400 uppercase tracking-wider">Dew</span>
                    </div>
                    <span className="text-2xl font-bold text-white tracking-tight mt-1">{dewPoint}</span>
                </div>
            </div>
        </div>
    );
};
