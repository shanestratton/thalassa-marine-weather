/**
 * Weather Windows Panel
 * 7-14 day departure window analyzer with GO/CAUTION/NO-GO indicators
 */

import React from 'react';
import { t } from '../../theme';
import { HourlyForecast, VesselProfile } from '../../types';
import { WindIcon, WaveIcon, SunIcon, CloudIcon, AlertTriangleIcon } from '../Icons';

interface WeatherWindowsPanelProps {
    // Weather data for route start point
    hourlyForecasts: HourlyForecast[];
    // Vessel limits for GO/NO-GO calculation
    vessel: VesselProfile;
    // Route bearing (degrees) for wind angle calculation
    routeBearing?: number;
    // Callback when user selects a departure window
    onSelectWindow?: (date: string, rating: 'go' | 'caution' | 'nogo') => void;
    // Selected departure date
    selectedDate?: string;
}

interface DayWindow {
    date: string;
    dayName: string;
    rating: 'go' | 'caution' | 'nogo';
    maxWind: number;
    maxWaves: number;
    avgVisibility: number;
    hasStorm: boolean;
    windAngle: number; // Relative to route
    recommendation: string;
}

/**
 * Analyze hourly data to determine departure window quality
 */
function analyzeWindows(
    hourlyData: HourlyForecast[],
    vessel: VesselProfile,
    routeBearing: number = 0
): DayWindow[] {
    if (!hourlyData || hourlyData.length === 0) return [];

    // Group by date
    const byDate = new Map<string, HourlyForecast[]>();
    hourlyData.forEach(h => {
        const date = h.time.split('T')[0];
        if (!byDate.has(date)) byDate.set(date, []);
        byDate.get(date)!.push(h);
    });

    const windows: DayWindow[] = [];
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    byDate.forEach((hours, dateStr) => {
        const date = new Date(dateStr);
        const dayName = dayNames[date.getDay()];

        // Calculate metrics for the day
        const maxWind = Math.max(...hours.map(h => h.windSpeed || 0));
        const maxWaves = Math.max(...hours.map(h => h.waveHeight || 0));
        const avgVisibility = hours.reduce((sum, h) => sum + (h.visibility || 10), 0) / hours.length;

        // Check for storm conditions using condition text
        const stormKeywords = ['thunder', 'storm', 'severe', 'lightning'];
        const hasStorm = hours.some(h =>
            h.condition && stormKeywords.some(kw => h.condition.toLowerCase().includes(kw))
        );

        // Calculate average wind direction relative to route (use windDegree which is numeric)
        const avgWindDir = hours.reduce((sum, h) => sum + (h.windDegree || 0), 0) / hours.length;
        const windAngle = Math.abs(((avgWindDir - routeBearing + 180) % 360) - 180);

        // Determine rating based on vessel limits
        let rating: 'go' | 'caution' | 'nogo' = 'go';
        let recommendation = 'Favorable conditions';

        // NO-GO conditions
        if (hasStorm) {
            rating = 'nogo';
            recommendation = 'Storm activity predicted';
        } else if (maxWind > (vessel.maxWindSpeed || 25)) {
            rating = 'nogo';
            recommendation = `Winds exceed vessel limit (${maxWind.toFixed(0)} kts)`;
        } else if (maxWaves > (vessel.maxWaveHeight || 3)) {
            rating = 'nogo';
            recommendation = `Seas exceed vessel limit (${maxWaves.toFixed(1)}m)`;
        } else if (avgVisibility < 1) {
            rating = 'nogo';
            recommendation = 'Poor visibility (<1km)';
        }
        // CAUTION conditions
        else if (maxWind > (vessel.maxWindSpeed || 25) * 0.7) {
            rating = 'caution';
            recommendation = `Moderate winds (${maxWind.toFixed(0)} kts)`;
        } else if (maxWaves > (vessel.maxWaveHeight || 3) * 0.6) {
            rating = 'caution';
            recommendation = `Moderate seas (${maxWaves.toFixed(1)}m)`;
        } else if (windAngle < 45) {
            rating = 'caution';
            recommendation = 'Headwinds expected';
        } else if (avgVisibility < 5) {
            rating = 'caution';
            recommendation = 'Reduced visibility';
        }
        // GO conditions
        else if (windAngle > 90 && windAngle < 150) {
            recommendation = 'Favorable winds (beam reach)';
        } else if (windAngle >= 150) {
            recommendation = 'Tailwinds expected';
        }

        windows.push({
            date: dateStr,
            dayName,
            rating,
            maxWind,
            maxWaves,
            avgVisibility,
            hasStorm,
            windAngle,
            recommendation
        });
    });

    // Return first 7 days
    return windows.slice(0, 7);
}

export const WeatherWindowsPanel: React.FC<WeatherWindowsPanelProps> = ({
    hourlyForecasts,
    vessel,
    routeBearing = 0,
    onSelectWindow,
    selectedDate
}) => {
    const windows = analyzeWindows(hourlyForecasts, vessel, routeBearing);

    if (windows.length === 0) {
        return (
            <div className="bg-slate-800/50 rounded-xl p-4 ${t.border.default}">
                <div className="text-center text-slate-400 text-sm">
                    Enter route to see departure windows
                </div>
            </div>
        );
    }

    const ratingColors = {
        go: 'from-emerald-500 to-green-600',
        caution: 'from-amber-500 to-orange-600',
        nogo: 'from-red-500 to-rose-600'
    };

    const ratingBorders = {
        go: 'border-emerald-500/50',
        caution: 'border-amber-500/50',
        nogo: 'border-red-500/50'
    };

    const ratingLabels = {
        go: 'GO',
        caution: 'CAUTION',
        nogo: 'NO-GO'
    };

    return (
        <div className="space-y-3">
            {/* Header */}
            <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
                    <SunIcon className="w-4 h-4 text-amber-400" />
                    7-Day Departure Windows
                </h3>
                <span className="text-sm text-slate-500 uppercase">Tap to select</span>
            </div>

            {/* Windows Strip */}
            <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
                {windows.map((window) => {
                    const isSelected = selectedDate === window.date;
                    return (
                        <button
                            key={window.date}
                            onClick={() => onSelectWindow?.(window.date, window.rating)}
                            className={`
                                flex-shrink-0 w-16 rounded-xl p-2 transition-all
                                ${isSelected ? 'ring-2 ring-white scale-105' : 'hover:scale-102'}
                                bg-gradient-to-b ${ratingColors[window.rating]}
                                border ${ratingBorders[window.rating]}
                                shadow-lg
                            `}
                        >
                            {/* Day */}
                            <div className="text-sm font-bold text-white/80 uppercase">
                                {window.dayName}
                            </div>

                            {/* Date */}
                            <div className="text-lg font-black text-white">
                                {new Date(window.date).getDate()}
                            </div>

                            {/* Rating Badge */}
                            <div className="text-sm font-bold text-white bg-black/20 rounded px-1 py-0.5 mt-1">
                                {ratingLabels[window.rating]}
                            </div>

                            {/* Icon indicator */}
                            <div className="mt-2">
                                {window.hasStorm ? (
                                    <AlertTriangleIcon className="w-4 h-4 text-white/80 mx-auto" />
                                ) : window.maxWaves > 2 ? (
                                    <WaveIcon className="w-4 h-4 text-white/80 mx-auto" />
                                ) : (
                                    <WindIcon className="w-4 h-4 text-white/80 mx-auto" />
                                )}
                            </div>
                        </button>
                    );
                })}
            </div>

            {/* Selected Window Details */}
            {selectedDate && (() => {
                const selected = windows.find(w => w.date === selectedDate);
                if (!selected) return null;

                return (
                    <div className={`
                        rounded-xl p-3 border
                        ${selected.rating === 'go' ? 'bg-emerald-500/10 border-emerald-500/30' :
                            selected.rating === 'caution' ? 'bg-amber-500/10 border-amber-500/30' :
                                'bg-red-500/10 border-red-500/30'}
                    `}>
                        <div className="flex items-center justify-between mb-2">
                            <span className={`
                                text-sm font-bold uppercase px-2 py-0.5 rounded
                                ${selected.rating === 'go' ? 'bg-emerald-500/20 text-emerald-400' :
                                    selected.rating === 'caution' ? 'bg-amber-500/20 text-amber-400' :
                                        'bg-red-500/20 text-red-400'}
                            `}>
                                {ratingLabels[selected.rating]}
                            </span>
                            <span className="text-sm text-slate-400">
                                {new Date(selected.date).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
                            </span>
                        </div>
                        <p className="text-sm text-white">{selected.recommendation}</p>
                        <div className="flex gap-4 mt-2 text-sm text-slate-400">
                            <span>Wind: {selected.maxWind.toFixed(0)} kts</span>
                            <span>Seas: {selected.maxWaves.toFixed(1)}m</span>
                            <span>Vis: {selected.avgVisibility.toFixed(0)} km</span>
                        </div>
                    </div>
                );
            })()}
        </div>
    );
};
