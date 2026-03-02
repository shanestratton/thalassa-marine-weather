/**
 * YachtDatabaseSearch — Reusable yacht model search & select component.
 * Used in VesselTab (Settings) and OnboardingWizard to pick a yacht from
 * the polar database. Selecting a yacht provides the model name, LOA,
 * category, and polar performance data.
 *
 * Results only appear once the user types in the search box (min 2 chars).
 * Dropdown limited to 5 results for a clean, focused UX.
 */
import React, { useState } from 'react';
import { POLAR_DATABASE, searchPolarDatabase, type PolarDatabaseEntry } from '../../data/polarDatabase';

interface YachtDatabaseSearchProps {
    /** Currently selected model name */
    selectedModel?: string;
    /** Called when a yacht is selected from the database */
    onSelect: (entry: PolarDatabaseEntry) => void;
    /** Compact mode for onboarding (fewer results shown) */
    compact?: boolean;
}

export const YachtDatabaseSearch: React.FC<YachtDatabaseSearchProps> = ({ selectedModel, onSelect, compact }) => {
    const [search, setSearch] = useState('');
    const [localSelected, setLocalSelected] = useState(selectedModel || '');

    // Only search when user has typed at least 2 characters
    const hasQuery = search.trim().length >= 2;
    const results = hasQuery ? searchPolarDatabase(search) : [];
    const displayResults = results.slice(0, 5); // Show max 5 results

    const grouped = displayResults.reduce((acc, entry) => {
        if (!acc[entry.manufacturer]) acc[entry.manufacturer] = [];
        acc[entry.manufacturer].push(entry);
        return acc;
    }, {} as Record<string, PolarDatabaseEntry[]>);

    return (
        <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl p-4">
            <div className="flex items-center gap-2 mb-4">
                <div className="w-1 h-4 rounded-full bg-sky-500" />
                <span className="text-xs font-bold text-sky-400 uppercase tracking-widest">Select Your Yacht</span>
                {localSelected && (
                    <span className="ml-auto text-[11px] font-bold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-lg">
                        ✓ {localSelected}
                    </span>
                )}
            </div>

            <div className="relative">
                <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search by model or manufacturer…"
                    className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white text-sm placeholder-gray-500 outline-none focus:border-sky-500 transition-colors"
                />
                <svg className="absolute right-3 top-3.5 w-4 h-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
            </div>

            {/* Results — only shown when user is searching */}
            {hasQuery && (
                <div className="mt-3 space-y-3 max-h-72 overflow-y-auto custom-scrollbar">
                    {Object.entries(grouped).map(([mfr, entries]) => (
                        <div key={mfr}>
                            <p className="text-[11px] font-bold text-gray-500 uppercase tracking-widest mb-1.5 px-1">{mfr}</p>
                            <div className="space-y-1">
                                {entries.map(entry => (
                                    <button
                                        key={entry.model}
                                        onClick={() => { setLocalSelected(entry.model); onSelect(entry); setSearch(''); }}
                                        className={`w-full flex items-center justify-between p-3 rounded-xl text-left transition-all ${localSelected === entry.model
                                            ? 'bg-sky-500/15 border border-sky-500/30 text-white'
                                            : 'bg-white/[0.02] border border-transparent text-gray-300 hover:bg-white/[0.05] hover:border-white/10'
                                            }`}
                                    >
                                        <div className="flex items-center gap-3">
                                            <span className="text-lg">{entry.category === 'multihull' ? '🐈' : '⛵'}</span>
                                            <div>
                                                <p className="text-sm font-bold">{entry.model}</p>
                                                <p className="text-[11px] text-gray-500">{entry.loa}ft • {entry.category}</p>
                                            </div>
                                        </div>
                                        {localSelected === entry.model && (
                                            <span className="text-[11px] font-bold text-sky-400 uppercase bg-sky-500/10 px-2 py-1 rounded-lg">Active</span>
                                        )}
                                    </button>
                                ))}
                            </div>
                        </div>
                    ))}
                    {results.length === 0 && (
                        <p className="text-center text-sm text-gray-500 py-4">No boats match "{search}"</p>
                    )}
                    {results.length > 5 && (
                        <p className="text-center text-[11px] text-gray-500 py-1">
                            Showing 5 of {results.length} results — refine your search
                        </p>
                    )}
                </div>
            )}

            <p className="text-[11px] text-gray-500 mt-3 text-center">
                {POLAR_DATABASE.length} boats available • Data from ORC/sail designer estimates
            </p>
        </div>
    );
};
