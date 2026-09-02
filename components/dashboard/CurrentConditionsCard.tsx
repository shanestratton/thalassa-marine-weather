import React from 'react';
import { WeatherMetrics, UnitPreferences } from '../../types';
import { convertSpeed, convertDistance, convertPrecip } from '../../utils';
import { DropletIcon, EyeIcon } from '../Icons';
import { AnimatedSunIcon, AnimatedRainIcon } from '../ui/AnimatedIcons';

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
export const CurrentConditionsCard: React.FC<CurrentConditionsCardProps> = React.memo(({ data, units }) => {
    // A bearing we do not have must not be drawn. The old
    // `data.windDegree ? data.windDegree : 0` rendered the arrow pointing due
    // south beside a "--" direction — the card inventing a heading is exactly
    // the failure this app's honesty rules exist to prevent. The truthy test
    // also swallowed a real 0° (due north) as "missing".
    const windRotation =
        typeof data.windDegree === 'number' && Number.isFinite(data.windDegree) ? data.windDegree : null;

    const windSpeed =
        data.windSpeed !== null && data.windSpeed !== undefined
            ? Math.round(convertSpeed(data.windSpeed, units.speed) ?? 0)
            : '--';
    const windDir = data.windDirection || '--';
    // `precipitation` is an AMOUNT in millimetres, not a probability — this cell
    // appended '%' to it (audit 2026-09-02). convertPrecip returns a formatted
    // inch string for Fahrenheit users (unit mark embedded) and mm otherwise.
    const rainAmount =
        data.precipitation !== null && data.precipitation !== undefined
            ? (convertPrecip(data.precipitation, units.temp) ?? '0')
            : '--';
    const rainUnit = units.temp === 'F' || rainAmount === '--' ? '' : 'mm';
    const uvIndex =
        data.uvIndex !== null && data.uvIndex !== undefined && !isNaN(data.uvIndex) ? Math.round(data.uvIndex) : '--';
    const humidity = data.humidity !== null && data.humidity !== undefined ? `${Math.round(data.humidity)}%` : '--';
    const visibility = (() => {
        if (data.visibility === null || data.visibility === undefined) return '--';
        const converted = convertDistance(data.visibility, units.visibility || 'nm');
        if (typeof converted === 'string' && converted.includes('+')) return converted;
        const num = parseFloat(String(converted));
        return isNaN(num) ? converted : String(Math.round(num));
    })();
    const visUnit = units.visibility || 'nm';

    return (
        <div className="w-full rounded-xl overflow-hidden bg-white/8 border border-white/15 shadow-2xl transition-all duration-300">
            {/* Keyframes moved to index.css */}

            {/* Single row: 5 key metrics — clean, minimal, no redundancy with header */}
            <div className="grid grid-cols-5 divide-x divide-white/12 h-[80px]">
                {/* Wind */}
                <div className="flex flex-col items-center justify-center">
                    <div className="flex items-center gap-1">
                        {windRotation !== null && (
                            <svg
                                className="w-3 h-3 text-emerald-400"
                                style={{ transform: `rotate(${windRotation + 180}deg)` }}
                                viewBox="0 0 24 24"
                                fill="currentColor"
                                role="img"
                                aria-label={`Wind from ${Math.round(windRotation)} degrees`}
                            >
                                <path d="M12 2L8 10h8L12 2z" />
                                <rect x="10" y="10" width="4" height="12" />
                            </svg>
                        )}
                        <span className="text-xs font-bold text-emerald-400 uppercase tracking-wider">{windDir}</span>
                    </div>
                    <div className="flex items-baseline mt-1">
                        <span className="text-2xl font-mono font-medium text-ivory tracking-tight">{windSpeed}</span>
                        <span className="text-[11px] text-white/60 font-medium ml-0.5">{units.speed}</span>
                    </div>
                </div>

                {/* UV */}
                <div className="flex flex-col items-center justify-center">
                    <div className="flex items-center gap-1">
                        <AnimatedSunIcon className="w-3 h-3 text-emerald-400" />
                        <span className="text-xs font-bold text-emerald-400 uppercase tracking-wider">UV</span>
                    </div>
                    <span className="text-2xl font-mono font-medium text-ivory tracking-tight mt-1">{uvIndex}</span>
                </div>

                {/* Visibility */}
                <div className="flex flex-col items-center justify-center">
                    <div className="flex items-center gap-1">
                        <EyeIcon className="w-3 h-3 text-emerald-400" />
                        <span className="text-xs font-bold text-emerald-400 uppercase tracking-wider">Vis</span>
                    </div>
                    <div className="flex items-baseline mt-1">
                        <span className="text-2xl font-mono font-medium text-ivory tracking-tight">{visibility}</span>
                        <span className="text-[11px] text-white/60 font-medium ml-0.5">{visUnit}</span>
                    </div>
                </div>

                {/* Humidity */}
                <div className="flex flex-col items-center justify-center">
                    <div className="flex items-center gap-1">
                        <DropletIcon className="w-3 h-3 text-emerald-400" />
                        <span className="text-xs font-bold text-emerald-400 uppercase tracking-wider">HUM</span>
                    </div>
                    <span className="text-2xl font-mono font-medium text-ivory tracking-tight mt-1">{humidity}</span>
                </div>

                {/* Rain */}
                <div className="flex flex-col items-center justify-center">
                    <div className="flex items-center gap-1">
                        <AnimatedRainIcon className="w-3 h-3 text-emerald-400" />
                        <span className="text-xs font-bold text-emerald-400 uppercase tracking-wider">Rain</span>
                    </div>
                    <div className="flex items-baseline mt-1">
                        <span className="text-2xl font-mono font-medium text-ivory tracking-tight">{rainAmount}</span>
                        {rainUnit && <span className="text-[11px] text-white/60 font-medium ml-0.5">{rainUnit}</span>}
                    </div>
                </div>
            </div>
        </div>
    );
});
