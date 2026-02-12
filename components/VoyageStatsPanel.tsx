/**
 * Voyage Statistics Panel
 * Compact, scrollable stats panel that fits between header and bottom button
 */

import React from 'react';
import { t } from '../theme';
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
        <div className="space-y-3">
            {/* Primary Stats Row - 4 key metrics */}
            <div className="grid grid-cols-4 gap-2">
                <CompactStat label="Distance" value={stats.totalDistance.toFixed(1)} unit="NM" />
                <CompactStat label="Duration" value={stats.totalTime} />
                <CompactStat label="Avg Spd" value={stats.avgSpeed.toFixed(1)} unit="kts" />
                <CompactStat label="Entries" value={stats.totalEntries} />
            </div>

            {/* Speed Row */}
            <div className="bg-slate-800/50 rounded-lg px-3 py-2">
                <div className="text-sm text-slate-500 uppercase tracking-wider mb-1">Speed</div>
                <div className="flex justify-between">
                    <MiniStat label="Max" value={stats.maxSpeed.toFixed(1)} unit="kts" />
                    <MiniStat label="Min" value={stats.minSpeed.toFixed(1)} unit="kts" />
                    <MiniStat label="Waypts" value={stats.waypointCount} />
                </div>
            </div>

            {/* Weather Row - only show if we have data */}
            {(stats.weather.avgWindSpeed > 0 || stats.weather.avgWaveHeight > 0) && (
                <div className="bg-slate-800/50 rounded-lg px-3 py-2">
                    <div className="text-sm text-slate-500 uppercase tracking-wider mb-1">Weather Avg</div>
                    <div className="flex justify-between">
                        {stats.weather.avgWindSpeed > 0 && (
                            <MiniStat label="Wind" value={stats.weather.avgWindSpeed.toFixed(0)} unit="kts" />
                        )}
                        {stats.weather.avgWaveHeight > 0 && (
                            <MiniStat label="Waves" value={(stats.weather.avgWaveHeight * 0.3048).toFixed(1)} unit="m" />
                        )}
                        {stats.weather.avgAirTemp > 0 && (
                            <MiniStat label="Temp" value={Math.round(stats.weather.avgAirTemp)} unit="°" />
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

// Compact stat card for main row
const CompactStat = ({ label, value, unit }: { label: string; value: string | number; unit?: string }) => (
    <div className={`bg-slate-800/60 ${t.border.subtle} rounded-lg p-2 text-center`}>
        <div className="text-sm text-slate-500 uppercase tracking-wider">{label}</div>
        <div className="text-lg font-bold text-white leading-tight">
            {value}
            {unit && <span className="text-sm ml-0.5 text-slate-400">{unit}</span>}
        </div>
    </div>
);

// Mini stat for secondary rows
const MiniStat = ({ label, value, unit }: { label: string; value: string | number; unit?: string }) => (
    <div className="text-center">
        <div className="text-sm text-slate-500 uppercase">{label}</div>
        <div className="text-sm font-bold text-white">
            {value}
            {unit && <span className="text-sm ml-0.5 text-slate-400">{unit}</span>}
        </div>
    </div>
);
