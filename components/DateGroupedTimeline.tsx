/**
 * Date Grouped Timeline
 * Shows log entries grouped by date with collapsible sections
 */

import React, { useState } from 'react';
import { ShipLogEntry } from '../types';
import { GroupedEntries } from '../utils/voyageData';
import { CompassIcon, WindIcon } from './Icons';

interface DateGroupedTimelineProps {
    groupedEntries: GroupedEntries[];
}

export const DateGroupedTimeline: React.FC<DateGroupedTimelineProps> = ({ groupedEntries }) => {
    const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set(groupedEntries.map(g => g.date)));

    const toggleDate = (date: string) => {
        const newExpanded = new Set(expandedDates);
        if (newExpanded.has(date)) {
            newExpanded.delete(date);
        } else {
            newExpanded.add(date);
        }
        setExpandedDates(newExpanded);
    };

    if (groupedEntries.length === 0) {
        return (
            <div className="text-center py-20 text-slate-400">
                <svg className="w-16 h-16 mx-auto mb-4 opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                <p className="text-lg font-bold mb-2">No Entries Match Filters</p>
                <p className="text-sm">Try adjusting your filters or search</p>
            </div>
        );
    }

    return (
        <div className="space-y-3">
            {groupedEntries.map((group) => {
                const isExpanded = expandedDates.has(group.date);

                return (
                    <div key={group.date} className="bg-slate-900/30 rounded-xl overflow-hidden border border-white/5">
                        {/* Date Header - Collapsible */}
                        <button
                            onClick={() => toggleDate(group.date)}
                            className="w-full px-4 py-3 flex items-center justify-between hover:bg-slate-800/50 transition-colors"
                        >
                            <div className="flex items-center gap-3">
                                <svg
                                    className={`w-5 h-5 text-slate-400 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                >
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                </svg>
                                <div className="text-left">
                                    <div className="text-white font-bold">{group.displayDate}</div>
                                    <div className="text-xs text-slate-400">
                                        {group.stats.entryCount} entries · {group.stats.totalDistance.toFixed(1)} NM
                                    </div>
                                </div>
                            </div>

                            {/* Day Stats */}
                            <div className="flex gap-4 text-xs text-slate-400">
                                <div>
                                    <span className="text-white font-bold">{group.stats.avgSpeed.toFixed(1)}</span> kts avg
                                </div>
                                <div>
                                    <span className="text-white font-bold">{group.stats.maxSpeed.toFixed(1)}</span> kts max
                                </div>
                            </div>
                        </button>

                        {/* Entries */}
                        {isExpanded && (
                            <div className="px-2 pb-2 space-y-2">
                                {group.entries.map((entry) => (
                                    <LogEntryCard key={entry.id} entry={entry} />
                                ))}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
};

// Log Entry Card Component
const LogEntryCard: React.FC<{ entry: ShipLogEntry }> = ({ entry }) => {
    const timestamp = new Date(entry.timestamp);
    const timeStr = timestamp.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    // Entry type colors
    const typeColors = {
        auto: 'bg-green-500/20 text-green-400 border-green-500/30',
        manual: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
        waypoint: 'bg-blue-500/20 text-blue-400 border-blue-500/30'
    };

    return (
        <div className="bg-slate-800/50 border border-white/10 rounded-xl p-4 hover:bg-slate-800 transition-colors">
            {/* Header: Time + Type */}
            <div className="flex justify-between items-start mb-3">
                <div className="text-white font-bold text-lg">{timeStr}</div>
                <span className={`px-2 py-1 rounded-lg text-xs font-bold uppercase border ${typeColors[entry.entryType]}`}>
                    {entry.entryType}
                </span>
            </div>

            {/* Position */}
            <div className="mb-3">
                <div className="text-xs text-slate-400 mb-1">Position</div>
                <div className="text-emerald-400 font-mono font-bold text-base">
                    {entry.positionFormatted}
                </div>
            </div>

            {/* Navigation Stats */}
            {(entry.distanceNM || entry.speedKts || entry.courseDeg !== undefined) && (
                <div className="grid grid-cols-3 gap-2 mb-3">
                    {entry.distanceNM !== undefined && (
                        <div className="bg-slate-900/50 rounded-lg p-2">
                            <div className="text-[10px] text-slate-400 uppercase">Distance</div>
                            <div className="text-sm font-bold text-white">{entry.distanceNM.toFixed(1)} NM</div>
                        </div>
                    )}
                    {entry.speedKts !== undefined && (
                        <div className="bg-slate-900/50 rounded-lg p-2">
                            <div className="text-[10px] text-slate-400 uppercase">Speed</div>
                            <div className="text-sm font-bold text-white">{entry.speedKts.toFixed(1)} kts</div>
                        </div>
                    )}
                    {entry.courseDeg !== undefined && (
                        <div className="bg-slate-900/50 rounded-lg p-2 flex items-center gap-2">
                            <CompassIcon className="w-4 h-4 text-sky-400" rotation={entry.courseDeg} />
                            <div>
                                <div className="text-[10px] text-slate-400 uppercase">Course</div>
                                <div className="text-sm font-bold text-white">{entry.courseDeg}°</div>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Weather Snapshot */}
            {(entry.windSpeed || entry.waveHeight) && (
                <div className="pt-2 border-t border-white/5 text-xs text-slate-400 flex items-center gap-3">
                    {entry.windSpeed && (
                        <span className="flex items-center gap-1">
                            <WindIcon className="w-3 h-3" />
                            {entry.windSpeed}kts {entry.windDirection}
                        </span>
                    )}
                    {entry.waveHeight && <span>Seas: {entry.waveHeight.toFixed(1)}m</span>}
                    {entry.airTemp && <span>Air: {entry.airTemp}°</span>}
                </div>
            )}

            {/* Notes */}
            {entry.notes && (
                <div className="mt-3 pt-3 border-t border-white/5">
                    <div className="text-xs text-slate-400 mb-1">Notes</div>
                    <div className="text-sm text-white italic">"{entry.notes}"</div>
                </div>
            )}

            {/* Waypoint Name */}
            {entry.waypointName && (
                <div className="mt-2 px-2 py-1 bg-blue-500/10 border border-blue-500/20 rounded text-blue-400 text-xs font-bold">
                    📍 {entry.waypointName}
                </div>
            )}
        </div>
    );
};
