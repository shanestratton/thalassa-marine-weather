/**
 * Log Filter Toolbar
 * Filter entries by type, date, and search terms
 */

import React from 'react';

export interface LogFilters {
    types: ('auto' | 'manual' | 'waypoint')[];
    searchQuery: string;
    dateFilter?: 'all' | 'today' | 'week' | 'custom';
}

interface LogFilterToolbarProps {
    filters: LogFilters;
    onFiltersChange: (filters: LogFilters) => void;
    totalEntries: number;
    filteredCount: number;
    entryCounts?: {
        auto: number;
        manual: number;
        waypoint: number;
    };
}

export const LogFilterToolbar: React.FC<LogFilterToolbarProps> = ({
    filters,
    onFiltersChange,
    totalEntries,
    filteredCount,
    entryCounts
}) => {
    const toggleType = (type: 'auto' | 'manual' | 'waypoint') => {
        const newTypes = filters.types.includes(type)
            ? filters.types.filter(t => t !== type)
            : [...filters.types, type];
        onFiltersChange({ ...filters, types: newTypes });
    };

    const isTypeActive = (type: 'auto' | 'manual' | 'waypoint') => {
        return filters.types.includes(type);
    };

    return (
        <div className="bg-slate-900/30 border border-white/5 rounded-xl p-2 mb-2" role="toolbar" aria-label="Log entry filters">
            {/* Compact Row: Search + Filters */}
            <div className="flex gap-2 items-center">
                {/* Search */}
                <div className="relative flex-1">
                    <input
                        type="text"
                        placeholder="Search..."
                        aria-label="Search log entries"
                        value={filters.searchQuery}
                        onChange={(e) => onFiltersChange({ ...filters, searchQuery: e.target.value })}
                        className="w-full bg-slate-800/60 border border-white/5 rounded-lg px-3 py-2 pl-8 text-white text-xs placeholder-slate-500 focus:border-sky-500 focus:outline-none"
                    />
                    <svg
                        className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                    >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                    {filters.searchQuery && (
                        <button
                            onClick={() => onFiltersChange({ ...filters, searchQuery: '' })}
                            aria-label="Clear search"
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                        >
                            ×
                        </button>
                    )}
                </div>

                {/* Type Pill Filters with Counts */}
                <div className="flex gap-1" role="group" aria-label="Entry type filters">
                    <FilterPill
                        label="Man"
                        count={entryCounts?.manual}
                        active={isTypeActive('manual')}
                        onClick={() => toggleType('manual')}
                        color="purple"
                    />
                    <FilterPill
                        label="Way"
                        count={entryCounts?.waypoint}
                        active={isTypeActive('waypoint')}
                        onClick={() => toggleType('waypoint')}
                        color="blue"
                    />
                </div>
            </div>

            {/* Results - Very Compact */}
            <div className="text-[10px] text-slate-500 text-center mt-1.5">
                {filteredCount}/{totalEntries} entries
            </div>
        </div>
    );
};

// Filter Pill Component with Count
interface FilterPillProps {
    label: string;
    count?: number;
    active: boolean;
    onClick: () => void;
    color: 'green' | 'purple' | 'blue';
}

const FilterPill: React.FC<FilterPillProps> = ({ label, count, active, onClick, color }) => {
    const colorClasses = {
        green: active
            ? 'bg-green-500/30 border-green-500/60 text-green-400'
            : 'bg-slate-800/60 border-white/5 text-slate-500',
        purple: active
            ? 'bg-purple-500/30 border-purple-500/60 text-purple-400'
            : 'bg-slate-800/60 border-white/5 text-slate-500',
        blue: active
            ? 'bg-blue-500/30 border-blue-500/60 text-blue-400'
            : 'bg-slate-800/60 border-white/5 text-slate-500'
    };

    return (
        <button
            onClick={onClick}
            aria-label={`Filter ${label === 'Man' ? 'manual' : 'waypoint'} entries${count !== undefined ? ` (${count})` : ''}`}
            aria-pressed={active}
            className={`min-w-[56px] min-h-[36px] px-3 py-1.5 rounded-lg border text-xs font-bold transition-all active:scale-95 ${colorClasses[color]}`}
        >
            {label}
            {count !== undefined && count > 0 && (
                <span className="ml-0.5 opacity-70">{count}</span>
            )}
        </button>
    );
};
