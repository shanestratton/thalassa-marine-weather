/**
 * Date Grouped Timeline - Premium UX Version
 * Compact entries by default, tap to expand
 * Sticky date headers, smooth animations
 */

import React, { useState, useMemo } from 'react';
import { ShipLogEntry } from '../types';
import { GroupedEntries } from '../utils/voyageData';
import { CompassIcon, WindIcon } from './Icons';
import {
    formatTime24Colon,
    formatCourseTrue,
    getBeaufortDescription,
    getSeaStateDescription,
    getWatchPeriodName
} from '../utils/marineFormatters';

interface DateGroupedTimelineProps {
    groupedEntries: GroupedEntries[];
    expandToday?: boolean;
    onDeleteEntry?: (entryId: string) => void;
    onEditEntry?: (entry: ShipLogEntry) => void;
    voyageFirstEntryId?: string;
    voyageLastEntryId?: string;
}

// Get today's date as YYYY-MM-DD in local timezone
function getTodayDateString(): string {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

export const DateGroupedTimeline: React.FC<DateGroupedTimelineProps> = ({
    groupedEntries,
    expandToday = false,
    onDeleteEntry,
    onEditEntry,
    voyageFirstEntryId,
    voyageLastEntryId
}) => {
    const todayStr = useMemo(() => getTodayDateString(), []);

    // Track expanded dates
    const [expandedDates, setExpandedDates] = useState<Set<string>>(() => {
        if (expandToday) {
            const hasToday = groupedEntries.some(g => g.date === todayStr);
            return hasToday ? new Set([todayStr]) : new Set();
        }
        return new Set(groupedEntries.map(g => g.date));
    });

    // Track expanded individual entries
    const [expandedEntries, setExpandedEntries] = useState<Set<string>>(new Set());

    const toggleDate = (date: string) => {
        const newExpanded = new Set(expandedDates);
        if (newExpanded.has(date)) {
            newExpanded.delete(date);
        } else {
            newExpanded.add(date);
        }
        setExpandedDates(newExpanded);
    };

    const toggleEntry = (entryId: string) => {
        const newExpanded = new Set(expandedEntries);
        if (newExpanded.has(entryId)) {
            newExpanded.delete(entryId);
        } else {
            newExpanded.add(entryId);
        }
        setExpandedEntries(newExpanded);
    };

    if (groupedEntries.length === 0) {
        return (
            <div className="text-center py-12 text-slate-400">
                <svg className="w-12 h-12 mx-auto mb-3 opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                <p className="font-bold mb-1">No Entries Match Filters</p>
                <p className="text-sm">Try adjusting your filters or search</p>
            </div>
        );
    }

    return (
        <div className="space-y-2">
            {groupedEntries.map((group) => {
                const isExpanded = expandedDates.has(group.date);
                const isToday = group.date === todayStr;

                return (
                    <div key={group.date} className="rounded-xl overflow-hidden border border-white/5 bg-slate-900/20">
                        {/* Date Header - Sticky */}
                        <button
                            onClick={() => toggleDate(group.date)}
                            className={`w-full px-3 py-2 flex items-center justify-between transition-all duration-150 ${isToday ? 'bg-sky-900/30 hover:bg-sky-900/40' : 'bg-slate-800/50 hover:bg-slate-800/70'
                                }`}
                        >
                            <div className="flex items-center gap-2">
                                <svg
                                    className={`w-4 h-4 text-slate-400 transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`}
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                >
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                </svg>
                                <div className="text-left">
                                    <div className="flex items-center gap-2">
                                        <span className={`font-bold ${isToday ? 'text-sky-400' : 'text-white'}`}>
                                            {isToday ? 'Today' : group.displayDate}
                                        </span>
                                        {isToday && (
                                            <span className="px-1.5 py-0.5 bg-sky-500/20 text-sky-400 text-[10px] font-bold rounded-full">
                                                LIVE
                                            </span>
                                        )}
                                    </div>
                                    <div className="text-[10px] text-slate-400">
                                        {group.stats.entryCount} entries · {group.stats.totalDistance.toFixed(1)} NM
                                    </div>
                                </div>
                            </div>

                            {/* Day Stats - Compact */}
                            <div className="flex gap-3 text-[10px] text-slate-400">
                                <span><span className="text-white font-bold">{group.stats.avgSpeed.toFixed(1)}</span> avg</span>
                                <span><span className="text-white font-bold">{group.stats.maxSpeed.toFixed(1)}</span> max</span>
                            </div>
                        </button>

                        {/* Entries - Animated */}
                        <div className={`transition-all duration-200 ease-out overflow-hidden ${isExpanded ? 'max-h-[2000px] opacity-100' : 'max-h-0 opacity-0'}`}>
                            <div className="p-1.5 space-y-1">
                                {group.entries.map((entry) => (
                                    <CompactLogEntry
                                        key={entry.id}
                                        entry={entry}
                                        isExpanded={expandedEntries.has(entry.id)}
                                        onToggle={() => toggleEntry(entry.id)}
                                        onDelete={onDeleteEntry ? () => onDeleteEntry(entry.id) : undefined}
                                        onEdit={onEditEntry ? () => onEditEntry(entry) : undefined}
                                        isVoyageStart={entry.id === voyageFirstEntryId}
                                        isVoyageEnd={entry.id === voyageLastEntryId}
                                    />
                                ))}
                            </div>
                        </div>
                    </div>
                );
            })}
        </div>
    );
};

// --- COMPACT LOG ENTRY ---
interface CompactLogEntryProps {
    entry: ShipLogEntry;
    isExpanded: boolean;
    onToggle: () => void;
    onDelete?: () => void;
    onEdit?: () => void;
    isVoyageStart?: boolean;
    isVoyageEnd?: boolean;
}

const CompactLogEntry: React.FC<CompactLogEntryProps> = ({ entry, isExpanded, onToggle, onDelete, onEdit, isVoyageStart, isVoyageEnd }) => {
    const timestamp = new Date(entry.timestamp);
    const timeStr = formatTime24Colon(timestamp);

    // Entry type colors - more subtle for compact view
    const typeIndicator = {
        auto: { color: 'bg-green-500', label: 'A' },
        manual: { color: 'bg-purple-500', label: 'M' },
        waypoint: { color: 'bg-blue-500', label: 'W' }
    };

    const type = typeIndicator[entry.entryType];

    // Beaufort color
    const getBfColor = (bf: number) => {
        if (bf <= 3) return 'text-sky-400';
        if (bf <= 5) return 'text-amber-400';
        if (bf <= 7) return 'text-orange-400';
        return 'text-red-400';
    };

    return (
        <div className={`rounded-lg transition-all duration-150 ${isExpanded ? 'bg-slate-800/80' : 'bg-slate-800/40 hover:bg-slate-800/60'}`}>
            {/* Compact Row - Always Visible */}
            <button
                onClick={onToggle}
                className="w-full px-2.5 py-2 flex items-center gap-2 text-left active:scale-[0.99] transition-transform"
            >
                {/* Type Indicator */}
                <div className={`w-1.5 h-8 rounded-full ${type.color} opacity-70`} />

                {/* Time */}
                <div className="w-12 font-mono font-bold text-white text-sm">{timeStr}</div>

                {/* Voyage Start/End Labels */}
                {isVoyageStart && (
                    <span className="px-1.5 py-0.5 bg-green-500/20 text-green-400 text-[10px] font-bold rounded-full">
                        Start
                    </span>
                )}
                {isVoyageEnd && !isVoyageStart && (
                    <span className="px-1.5 py-0.5 bg-red-500/20 text-red-400 text-[10px] font-bold rounded-full">
                        End
                    </span>
                )}

                {/* Core Info - Responsive */}
                <div className="flex-1 flex items-center gap-3 overflow-hidden">
                    {/* Speed */}
                    {entry.speedKts !== undefined && (
                        <span className="text-xs">
                            <span className="text-white font-bold">{entry.speedKts.toFixed(1)}</span>
                            <span className="text-slate-400">kts</span>
                        </span>
                    )}

                    {/* Course */}
                    {entry.courseDeg !== undefined && (
                        <span className="text-xs flex items-center gap-0.5">
                            <CompassIcon className="w-3 h-3 text-sky-400" rotation={entry.courseDeg} />
                            <span className="text-white font-bold">{formatCourseTrue(entry.courseDeg)}</span>
                        </span>
                    )}

                    {/* Wind */}
                    {entry.windSpeed !== undefined && (
                        <span className="text-xs flex items-center gap-0.5">
                            <WindIcon className="w-3 h-3 text-slate-400" />
                            <span className="text-white font-bold">{entry.windSpeed}</span>
                            {entry.beaufortScale !== undefined && (
                                <span className={`${getBfColor(entry.beaufortScale)}`}>F{entry.beaufortScale}</span>
                            )}
                        </span>
                    )}

                    {/* Waypoint indicator */}
                    {entry.waypointName && (
                        <span className="text-blue-400 text-xs font-bold truncate max-w-[100px]">
                            📍 {entry.waypointName}
                        </span>
                    )}

                    {/* Notes indicator */}
                    {entry.notes && !entry.waypointName && (
                        <span className="text-slate-400 text-xs truncate max-w-[120px] italic">
                            "{entry.notes}"
                        </span>
                    )}
                </div>

                {/* Expand indicator */}
                <svg
                    className={`w-4 h-4 text-slate-500 transition-transform duration-150 ${isExpanded ? 'rotate-180' : ''}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
            </button>

            {/* Expanded Details */}
            <div className={`transition-all duration-200 ease-out overflow-hidden ${isExpanded ? 'max-h-[500px] opacity-100' : 'max-h-0 opacity-0'}`}>
                <div className="px-3 pb-3 pt-1 border-t border-white/5">
                    {/* Position */}
                    <div className="mb-2">
                        <div className="text-[10px] text-slate-500 uppercase">Position</div>
                        <div className="text-emerald-400 font-mono font-bold text-sm">
                            {entry.positionFormatted}
                        </div>
                    </div>

                    {/* Nav Stats Grid */}
                    <div className="grid grid-cols-3 gap-2 mb-2">
                        {entry.distanceNM !== undefined && (
                            <div className="bg-slate-900/50 rounded-lg p-1.5 text-center">
                                <div className="text-[9px] text-slate-500 uppercase">Dist</div>
                                <div className="text-xs font-bold text-white">{entry.distanceNM.toFixed(1)} NM</div>
                            </div>
                        )}
                        {entry.speedKts !== undefined && (
                            <div className="bg-slate-900/50 rounded-lg p-1.5 text-center">
                                <div className="text-[9px] text-slate-500 uppercase">Speed</div>
                                <div className="text-xs font-bold text-white">{entry.speedKts.toFixed(1)} kts</div>
                            </div>
                        )}
                        {entry.courseDeg !== undefined && (
                            <div className="bg-slate-900/50 rounded-lg p-1.5 text-center">
                                <div className="text-[9px] text-slate-500 uppercase">Course</div>
                                <div className="text-xs font-bold text-white">{formatCourseTrue(entry.courseDeg)}</div>
                            </div>
                        )}
                    </div>

                    {/* Weather Details */}
                    {(entry.windSpeed || entry.waveHeight || entry.pressure) && (
                        <div className="flex flex-wrap gap-2 text-[11px] text-slate-400 mb-2">
                            {entry.windSpeed !== undefined && (
                                <span className="flex items-center gap-1">
                                    <WindIcon className="w-3 h-3" />
                                    <span className="text-white font-bold">{entry.windSpeed}kts</span>
                                    {entry.windDirection}
                                    {entry.beaufortScale !== undefined && (
                                        <span className={getBfColor(entry.beaufortScale)}>
                                            ({getBeaufortDescription(entry.beaufortScale)})
                                        </span>
                                    )}
                                </span>
                            )}
                            {entry.waveHeight !== undefined && (
                                <span>
                                    Seas <span className="text-white font-bold">{entry.waveHeight.toFixed(1)}m</span>
                                    {entry.seaState !== undefined && ` (${getSeaStateDescription(entry.seaState)})`}
                                </span>
                            )}
                            {entry.pressure !== undefined && (
                                <span><span className="text-white font-bold">{entry.pressure.toFixed(0)}</span>hPa</span>
                            )}
                        </div>
                    )}

                    {/* Notes */}
                    {entry.notes && (
                        <div className="bg-slate-900/30 rounded-lg p-2 text-sm text-white italic">
                            "{entry.notes}"
                        </div>
                    )}

                    {/* Waypoint */}
                    {entry.waypointName && (
                        <div className="mt-2 px-2 py-1 bg-blue-500/10 border border-blue-500/20 rounded text-blue-400 text-xs font-bold">
                            📍 {entry.waypointName}
                        </div>
                    )}

                    {/* Event Category */}
                    {entry.eventCategory && (
                        <div className="mt-2">
                            <span className="px-2 py-0.5 bg-slate-700/50 rounded text-[10px] text-slate-300 uppercase tracking-wider">
                                {entry.eventCategory}
                            </span>
                        </div>
                    )}

                    {/* Watch Period */}
                    {entry.watchPeriod && (
                        <div className="mt-2 text-[10px] text-slate-500">
                            {getWatchPeriodName(entry.watchPeriod)}
                        </div>
                    )}

                    {/* Action Buttons */}
                    {(onEdit || onDelete) && (
                        <div className="mt-3 flex gap-2">
                            {onEdit && (
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onEdit();
                                    }}
                                    className="flex-1 px-3 py-2 bg-blue-600/20 hover:bg-blue-600/40 border border-blue-500/30 rounded-lg text-blue-400 text-xs font-bold transition-colors flex items-center justify-center gap-1.5"
                                >
                                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                                    </svg>
                                    Edit
                                </button>
                            )}
                            {onDelete && (
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onDelete();
                                    }}
                                    className="flex-1 px-3 py-2 bg-red-600/20 hover:bg-red-600/40 border border-red-500/30 rounded-lg text-red-400 text-xs font-bold transition-colors flex items-center justify-center gap-1.5"
                                >
                                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                    </svg>
                                    Delete
                                </button>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};
