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
}

export const LogFilterToolbar: React.FC<LogFilterToolbarProps> = ({
    filters,
    onFiltersChange,
    totalEntries,
    filteredCount
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
        <div className="bg-slate-900/50 border border-white/10 rounded-xl p-3 mb-3">
            {/* Search Bar */}
            <div className="relative mb-3">
                <input
                    type="text"
                    placeholder="Search notes or waypoints..."
                    value={filters.searchQuery}
                    onChange={(e) => onFiltersChange({ ...filters, searchQuery: e.target.value })}
                    className="w-full bg-slate-800 border border-white/10 rounded-lg px-4 py-2 pl-10 text-white placeholder-slate-400 focus:border-sky-500 focus:outline-none"
                />
                <svg
                    className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
            </div>

            {/* Type Filters */}
            <div className="flex gap-2 mb-3">
                <FilterButton
                    label="Auto"
                    count={totalEntries}
                    active={isTypeActive('auto')}
                    onClick={() => toggleType('auto')}
                    color="green"
                />
                <FilterButton
                    label="Manual"
                    count={totalEntries}
                    active={isTypeActive('manual')}
                    onClick={() => toggleType('manual')}
                    color="purple"
                />
                <FilterButton
                    label="Waypoints"
                    count={totalEntries}
                    active={isTypeActive('waypoint')}
                    onClick={() => toggleType('waypoint')}
                    color="blue"
                />
            </div>

            {/* Results Count */}
            <div className="text-xs text-slate-400 text-center">
                Showing <span className="text-white font-bold">{filteredCount}</span> of {totalEntries} entries
                {filters.searchQuery && (
                    <button
                        onClick={() => onFiltersChange({ ...filters, searchQuery: '' })}
                        className="ml-2 text-sky-400 hover:text-sky-300 underline"
                    >
                        Clear search
                    </button>
                )}
            </div>
        </div>
    );
};

// Filter Button Component
interface FilterButtonProps {
    label: string;
    count: number;
    active: boolean;
    onClick: () => void;
    color: 'green' | 'purple' | 'blue';
}

const FilterButton: React.FC<FilterButtonProps> = ({ label, active, onClick, color }) => {
    const colorClasses = {
        green: active
            ? 'bg-green-500/20 border-green-500/50 text-green-400'
            : 'bg-slate-800 border-white/10 text-slate-400 hover:border-green-500/30',
        purple: active
            ? 'bg-purple-500/20 border-purple-500/50 text-purple-400'
            : 'bg-slate-800 border-white/10 text-slate-400 hover:border-purple-500/30',
        blue: active
            ? 'bg-blue-500/20 border-blue-500/50 text-blue-400'
            : 'bg-slate-800 border-white/10 text-slate-400 hover:border-blue-500/30'
    };

    return (
        <button
            onClick={onClick}
            className={`flex-1 px-3 py-2 rounded-lg border text-xs font-bold uppercase tracking-wider transition-colors ${colorClasses[color]}`}
        >
            {label}
        </button>
    );
};
