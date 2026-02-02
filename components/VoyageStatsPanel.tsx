/**
 * Voyage Statistics Panel
 * Shows comprehensive stats and analytics for current voyage
 */

import React from 'react';
import { ShipLogEntry } from '../types';
import { calculateVoyageStats } from '../utils/voyageData';

interface VoyageStatsPanelProps {
    entries: ShipLogEntry[];
}

export const VoyageStatsPanel: React.FC<VoyageStatsPanelProps> = ({ entries }) => {
    const stats = calculateVoyageStats(entries);

    if (!stats || entries.length === 0) {
        return null;
    }

    return (
        <div className="bg-slate-900/50 border border-white/10 rounded-xl p-4 mb-4">
            <h3 className="text-white font-bold text-lg mb-4 flex items-center gap-2">
                <svg className="w-5 h-5 text-sky-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
                Voyage Statistics
            </h3>

            {/* Distance & Time */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                <StatCard
                    label="Total Distance"
                    value={stats.totalDistance.toFixed(1)}
                    unit="NM"
                    color="emerald"
                />
                <StatCard
                    label="Duration"
                    value={stats.totalTime}
                    unit=""
                    color="blue"
                />
                <StatCard
                    label="Entries"
                    value={stats.totalEntries}
                    unit=""
                    color="purple"
                />
                <StatCard
                    label="Waypoints"
                    value={stats.waypointCount}
                    unit=""
                    color="sky"
                />
            </div>

            {/* Speed Stats */}
            <div className="bg-slate-800/50 rounded-lg p-3 mb-4">
                <div className="text-xs text-slate-400 uppercase tracking-wider mb-2">Speed Analysis</div>
                <div className="grid grid-cols-3 gap-3">
                    <MiniStat label="Average" value={stats.avgSpeed.toFixed(1)} unit="kts" />
                    <MiniStat label="Maximum" value={stats.maxSpeed.toFixed(1)} unit="kts" />
                    <MiniStat label="Minimum" value={stats.minSpeed.toFixed(1)} unit="kts" />
                </div>
            </div>

            {/* Weather Summary */}
            {(stats.weather.avgWindSpeed > 0 || stats.weather.avgWaveHeight > 0) && (
                <div className="bg-slate-800/50 rounded-lg p-3">
                    <div className="text-xs text-slate-400 uppercase tracking-wider mb-2">
                        Weather Summary (Average)
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                        {stats.weather.avgWindSpeed > 0 && (
                            <MiniStat
                                label="Wind"
                                value={stats.weather.avgWindSpeed.toFixed(1)}
                                unit="kts"
                            />
                        )}
                        {stats.weather.avgWaveHeight > 0 && (
                            <MiniStat
                                label="Waves"
                                value={stats.weather.avgWaveHeight.toFixed(1)}
                                unit="m"
                            />
                        )}
                        {stats.weather.avgAirTemp > 0 && (
                            <MiniStat
                                label="Air Temp"
                                value={Math.round(stats.weather.avgAirTemp)}
                                unit="°C"
                            />
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

// Sub-components

interface StatCardProps {
    label: string;
    value: string | number;
    unit: string;
    color: 'emerald' | 'blue' | 'purple' | 'sky';
}

const StatCard: React.FC<StatCardProps> = ({ label, value, unit, color }) => {
    const colorClasses = {
        emerald: 'from-emerald-500/20 to-emerald-600/20 border-emerald-500/30 text-emerald-400',
        blue: 'from-blue-500/20 to-blue-600/20 border-blue-500/30 text-blue-400',
        purple: 'from-purple-500/20 to-purple-600/20 border-purple-500/30 text-purple-400',
        sky: 'from-sky-500/20 to-sky-600/20 border-sky-500/30 text-sky-400'
    };

    return (
        <div className={`bg-gradient-to-br ${colorClasses[color]} border rounded-lg p-3 text-center`}>
            <div className="text-xs text-slate-400 uppercase tracking-wider mb-1">{label}</div>
            <div className="text-2xl font-bold text-white">
                {value}
                {unit && <span className="text-sm ml-1 opacity-70">{unit}</span>}
            </div>
        </div>
    );
};

interface MiniStatProps {
    label: string;
    value: string | number;
    unit: string;
}

const MiniStat: React.FC<MiniStatProps> = ({ label, value, unit }) => (
    <div className="text-center">
        <div className="text-[10px] text-slate-400 uppercase">{label}</div>
        <div className="text-lg font-bold text-white">
            {value}
            <span className="text-xs ml-1 text-slate-400">{unit}</span>
        </div>
    </div>
);
