import React from 'react';
import { t } from '../../theme';
import { VoyagePlan, VesselProfile, HourlyForecast } from '../../types';
import { WindIcon, WaveIcon, SunIcon, MoonIcon } from '../Icons';

interface PassageTimelineProps {
    voyagePlan: VoyagePlan;
    vessel: VesselProfile;
    hourlyData?: HourlyForecast[];
}

export const PassageTimeline: React.FC<PassageTimelineProps> = ({ voyagePlan, vessel, hourlyData }) => {
    // Parse duration to hours
    const durationStr = voyagePlan.durationApprox.toLowerCase();
    let durationHours = 0;
    if (durationStr.includes('day')) {
        const days = parseFloat(durationStr.match(/(\d+\.?\d*)/)?.[0] || '0');
        durationHours = days * 24;
    } else if (durationStr.includes('hour')) {
        durationHours = parseFloat(durationStr.match(/(\d+\.?\d*)/)?.[0] || '0');
    }

    // Generate hourly forecast data (mock for now - will be replaced with real API data)
    const hours = Math.ceil(durationHours);
    const timelineData = Array.from({ length: hours }, (_, i) => {
        const hour = i;
        const windSpeed = 12 + Math.sin(i / 4) * 8; // Mock oscillating wind
        const waveHeight = 1.5 + Math.sin(i / 6) * 1; // Mock oscillating waves
        const isDay = (hour % 24) >= 6 && (hour % 24) < 18; // Rough day/night

        return {
            hour,
            time: `T+${hour}`,
            windSpeed: Math.max(0, windSpeed),
            waveHeight: Math.max(0, waveHeight),
            isDay
        };
    });

    // Calculate max values for scaling
    const maxWind = Math.max(...timelineData.map(d => d.windSpeed));
    const maxWave = Math.max(...timelineData.map(d => d.waveHeight));

    // Waypoint positions (as percentage of total duration)
    const waypointPositions = voyagePlan.waypoints.map((wp, idx) => {
        // Estimate position based on even distribution (simplified)
        const position = ((idx + 1) / (voyagePlan.waypoints.length + 1)) * 100;
        return { name: wp.name, position };
    });

    return (
        <div className="w-full bg-slate-900 ${t.border.default} rounded-3xl p-6 md:p-8 shadow-xl relative overflow-hidden">
            <div className="absolute top-0 right-0 w-96 h-96 bg-blue-500/5 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2 pointer-events-none"></div>

            <div className="relative z-10">
                <div className="flex justify-between items-center mb-6 border-b border-white/5 pb-4">
                    <div>
                        <h3 className="text-lg font-bold text-white uppercase tracking-widest flex items-center gap-2">
                            <SunIcon className="w-5 h-5 text-amber-400" />
                            Passage Timeline
                        </h3>
                        <p className="text-sm text-slate-400 font-medium">Hourly Weather Forecast Along Route</p>
                    </div>
                    <span className="text-sm font-mono text-sky-500 bg-sky-500/10 px-3 py-1.5 rounded border border-sky-500/20">
                        {hours} HOURS
                    </span>
                </div>

                {/* Timeline Chart */}
                <div className="relative h-64 md:h-80">
                    {/* Day/Night Background Bands */}
                    <div className="absolute inset-0 flex">
                        {timelineData.map((data, i) => (
                            <div
                                key={i}
                                className={`flex-1 transition-colors ${data.isDay ? 'bg-amber-500/5' : 'bg-indigo-900/20'
                                    }`}
                                style={{ borderRight: '1px solid rgba(255,255,255,0.02)' }}
                            />
                        ))}
                    </div>

                    {/* Wind Speed Bars */}
                    <div className="absolute inset-0 flex items-end px-1 gap-0.5">
                        {timelineData.map((data, i) => {
                            const heightPercent = (data.windSpeed / maxWind) * 60; // 60% of container
                            return (
                                <div
                                    key={i}
                                    className="flex-1 relative group cursor-pointer"
                                >
                                    <div
                                        className="w-full bg-gradient-to-t from-sky-500/40 to-sky-400/60 rounded-t transition-all hover:from-sky-500/60 hover:to-sky-400/80"
                                        style={{ height: `${heightPercent}%` }}
                                    >
                                        {/* Tooltip on hover */}
                                        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-20">
                                            <div className="bg-slate-800 ${t.border.strong} rounded-lg px-3 py-2 text-sm whitespace-nowrap shadow-xl">
                                                <div className="font-bold text-white mb-1">{data.time}</div>
                                                <div className="text-sky-300">Wind: {data.windSpeed.toFixed(1)} kts</div>
                                                <div className="text-blue-300">Wave: {data.waveHeight.toFixed(1)} m</div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    {/* Wave Height Line */}
                    <svg className="absolute inset-0 pointer-events-none" preserveAspectRatio="none">
                        <polyline
                            points={timelineData.map((data, i) => {
                                const x = (i / (timelineData.length - 1)) * 100;
                                const y = 100 - (data.waveHeight / maxWave) * 40; // 40% of container (top portion)
                                return `${x},${y}`;
                            }).join(' ')}
                            fill="none"
                            stroke="rgba(59, 130, 246, 0.8)"
                            strokeWidth="2"
                            vectorEffect="non-scaling-stroke"
                        />
                    </svg>

                    {/* Waypoint Markers */}
                    {waypointPositions.map((wp, idx) => (
                        <div
                            key={idx}
                            className="absolute top-0 bottom-0 flex flex-col items-center"
                            style={{ left: `${wp.position}%` }}
                        >
                            <div className="w-px h-full bg-amber-400/40 relative">
                                <div className="absolute top-1/2 -translate-y-1/2 left-1/2 -translate-x-1/2 w-3 h-3 bg-amber-400 border-2 border-slate-900 rounded-full shadow-lg"></div>
                                <div className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-full mt-2 text-sm font-bold text-amber-400 bg-slate-900/80 px-2 py-1 rounded whitespace-nowrap">
                                    WP{idx + 1}
                                </div>
                            </div>
                        </div>
                    ))}
                </div>

                {/* Legend */}
                <div className="flex flex-wrap items-center gap-6 mt-6 pt-4 border-t border-white/5 text-sm">
                    <div className="flex items-center gap-2">
                        <div className="w-4 h-4 bg-gradient-to-t from-sky-500/40 to-sky-400/60 rounded"></div>
                        <span className="text-gray-400">Wind Speed (kts)</span>
                    </div>
                    <div className="flex items-center gap-2">
                        <div className="w-6 h-0.5 bg-blue-400"></div>
                        <span className="text-gray-400">Wave Height (m)</span>
                    </div>
                    <div className="flex items-center gap-2">
                        <div className="w-4 h-4 bg-amber-500/10 rounded"></div>
                        <SunIcon className="w-3 h-3 text-amber-400" />
                        <span className="text-gray-400">Day</span>
                    </div>
                    <div className="flex items-center gap-2">
                        <div className="w-4 h-4 bg-indigo-900/30 rounded"></div>
                        <MoonIcon className="w-3 h-3 text-indigo-400" />
                        <span className="text-gray-400">Night</span>
                    </div>
                    <div className="flex items-center gap-2">
                        <div className="w-3 h-3 bg-amber-400 rounded-full"></div>
                        <span className="text-gray-400">Waypoints</span>
                    </div>
                </div>
            </div>
        </div>
    );
};
