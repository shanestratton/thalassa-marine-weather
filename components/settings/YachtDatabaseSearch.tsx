/**
 * YachtDatabaseSearch — Reusable yacht model search & select component.
 * Used in VesselTab (Settings) and OnboardingWizard to pick a yacht from
 * the polar database. Selecting a yacht provides the model name, LOA,
 * category, and a polar SHAPE generated from length and type (not ORC or
 * designer data); routing scales it to her cruising speed.
 *
 * Results only appear once the user types in the search box (min 2 chars).
 * Dropdown limited to 5 results for a clean, focused UX.
 */
import React, { useState } from 'react';
import { POLAR_DATABASE, searchPolarDatabase, type PolarDatabaseEntry } from '../../data/polarDatabase';
import { CheckIcon, SailBoatIcon } from '../Icons';

interface YachtDatabaseSearchProps {
    /** Currently selected model name */
    selectedModel?: string;
    /** Called when a yacht is selected from the database */
    onSelect: (entry: PolarDatabaseEntry) => void;
    /** Compact mode for onboarding (fewer results shown) */
    compact?: boolean;
    /** Inside a host card that already titles it (Vessel Profile's "Boat
     *  design" sub-section): no card of its own and no bar heading, so the
     *  form keeps one heading style (UX scorecard run 7). */
    embedded?: boolean;
}

export const YachtDatabaseSearch: React.FC<YachtDatabaseSearchProps> = ({
    selectedModel,
    onSelect,
    compact: _compact,
    embedded = false,
}) => {
    const [search, setSearch] = useState('');
    const [localSelected, setLocalSelected] = useState(selectedModel || '');

    // Only search when user has typed at least 2 characters
    const hasQuery = search.trim().length >= 2;
    const results = hasQuery ? searchPolarDatabase(search) : [];
    const displayResults = results.slice(0, 5); // Show max 5 results

    const grouped = displayResults.reduce(
        (acc, entry) => {
            if (!acc[entry.manufacturer]) acc[entry.manufacturer] = [];
            acc[entry.manufacturer].push(entry);
            return acc;
        },
        {} as Record<string, PolarDatabaseEntry[]>,
    );

    const selectedChip = localSelected ? (
        <span className="text-xs font-bold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-lg inline-flex items-center gap-1 min-w-0">
            <CheckIcon className="w-3 h-3 shrink-0" />
            <span className="truncate">{localSelected}</span>
        </span>
    ) : null;

    return (
        <div className={embedded ? '' : 'bg-white/3 border border-white/6 rounded-2xl p-4'}>
            {embedded ? (
                selectedChip && <div className="mb-3 flex">{selectedChip}</div>
            ) : (
                <div className="flex items-center gap-2 mb-4">
                    <div className="w-1 h-4 rounded-full bg-sky-500" aria-hidden="true" />
                    <span className="text-xs font-bold text-sky-400 uppercase tracking-widest">Select your yacht</span>
                    {selectedChip && <span className="ml-auto flex min-w-0">{selectedChip}</span>}
                </div>
            )}

            <div className="relative">
                <input
                    type="text"
                    aria-label="Search yacht model or manufacturer"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search by model or manufacturer…"
                    className="w-full min-h-11 bg-white/5 border border-white/10 rounded-xl pl-3 pr-9 py-2.5 text-white text-sm font-medium placeholder-gray-500 outline-hidden focus:border-sky-500 transition-colors"
                />
                <svg
                    aria-hidden="true"
                    className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                >
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                    />
                </svg>
            </div>

            {/* Results — only shown when user is searching */}
            {hasQuery && (
                <div className="mt-3 space-y-3 max-h-72 overflow-y-auto custom-scrollbar">
                    {Object.entries(grouped).map(([mfr, entries]) => (
                        <div key={mfr}>
                            <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1.5 px-1">
                                {mfr}
                            </p>
                            <div className="space-y-1">
                                {entries.map((entry) => (
                                    <button
                                        type="button"
                                        aria-label={`Select ${entry.model}`}
                                        aria-pressed={localSelected === entry.model}
                                        key={entry.model}
                                        onClick={() => {
                                            setLocalSelected(entry.model);
                                            onSelect(entry);
                                            setSearch('');
                                        }}
                                        className={`w-full flex items-center justify-between p-3 rounded-xl text-left transition-all ${
                                            localSelected === entry.model
                                                ? 'bg-sky-500/15 border border-sky-500/30 text-white'
                                                : 'bg-white/2 border border-transparent text-gray-300 hover:bg-white/5 hover:border-white/10'
                                        }`}
                                    >
                                        <div className="flex items-center gap-3">
                                            <span className="text-sky-300 inline-flex">
                                                {/* Both monohulls and multihulls render as SailBoat — the
                                                    multihull cat-emoji was decorative only. The category
                                                    label below already differentiates the type. */}
                                                <SailBoatIcon className="w-5 h-5" />
                                            </span>
                                            <div>
                                                <p className="text-sm font-bold">{entry.model}</p>
                                                <p className="text-xs text-gray-400">
                                                    {entry.loa}ft • {entry.category}
                                                </p>
                                            </div>
                                        </div>
                                        {localSelected === entry.model && (
                                            <span className="text-xs font-bold text-sky-400 uppercase bg-sky-500/10 px-2 py-1 rounded-lg">
                                                Active
                                            </span>
                                        )}
                                    </button>
                                ))}
                            </div>
                        </div>
                    ))}
                    {results.length === 0 && (
                        <p className="text-center text-sm text-gray-400 py-4">No boats match "{search}"</p>
                    )}
                    {results.length > 5 && (
                        <p className="text-center text-xs text-gray-400 py-1">
                            Showing 5 of {results.length} results — refine your search
                        </p>
                    )}
                </div>
            )}

            {/* The tables are generated from length and type (data/polarDatabase.ts):
                never credit them to ORC or a designer (build 125, 125-08). */}
            <p data-testid="yacht-database-credit" className="text-xs text-gray-400 mt-3 text-center">
                {POLAR_DATABASE.length} boats available • Generated from length and type: not ORC or designer data
            </p>
        </div>
    );
};
