/**
 * ArchivedVoyagesSection — the collapsible "Archived Voyages" block at the
 * bottom of the Ship's Log list, extracted verbatim from pages/LogPage.tsx.
 * The caller keeps the `length > 0` guard.
 */
import React from 'react';
import type { ShipLogEntry } from '../../types';

export const ArchivedVoyagesSection: React.FC<{
    loggedArchivedVoyages: { voyageId: string; entries: ShipLogEntry[] }[];
    showArchived: boolean;
    setShowArchived: React.Dispatch<React.SetStateAction<boolean>>;
    handleUnarchiveVoyage: (voyageId: string) => void;
}> = ({ loggedArchivedVoyages, showArchived, setShowArchived, handleUnarchiveVoyage }) => (
    <div className="mt-4">
        <button
            aria-expanded={showArchived}
            onClick={() => setShowArchived(!showArchived)}
            className="w-full min-h-[44px] flex items-center justify-between px-3 py-2 rounded-xl bg-amber-500/10 border border-amber-500/20 active:scale-[0.98] transition-all"
        >
            <div className="flex items-center gap-2">
                <svg className="w-4 h-4 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8"
                    />
                </svg>
                <span className="text-xs font-bold text-amber-400 uppercase tracking-wider">Archived Voyages</span>
                <span className="text-[11px] font-bold text-amber-300/60 bg-amber-500/15 px-1.5 py-0.5 rounded-full">
                    {loggedArchivedVoyages.length}
                </span>
            </div>
            <svg
                className={`w-4 h-4 text-amber-400 transition-transform ${showArchived ? 'rotate-180' : ''}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
            >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
        </button>

        {showArchived && (
            <div className="mt-2 space-y-2">
                {loggedArchivedVoyages.map((voyage) => (
                    <div
                        key={voyage.voyageId}
                        className="rounded-2xl bg-slate-900/30 backdrop-blur-md border border-amber-500/10 p-4 flex items-center justify-between"
                    >
                        <div className="min-w-0">
                            <div className="flex items-center gap-2 mb-0.5">
                                <span className="text-xs font-bold text-white/80">
                                    {new Date(voyage.entries[voyage.entries.length - 1]?.timestamp || '')
                                        .toLocaleDateString('en-AU', {
                                            day: '2-digit',
                                            month: 'short',
                                            year: '2-digit',
                                        })
                                        .toUpperCase()}
                                </span>
                                <span className="text-[11px] font-bold text-amber-400 bg-amber-500/15 px-1.5 py-0.5 rounded-full uppercase">
                                    Archived
                                </span>
                            </div>
                            <div className="text-[11px] text-white/60">
                                {voyage.entries.length} entries ·{' '}
                                {Math.max(0, ...voyage.entries.map((e) => e.cumulativeDistanceNM || 0)).toFixed(1)} NM
                            </div>
                        </div>
                        <button
                            aria-label="Unarchive voyage"
                            onClick={() => handleUnarchiveVoyage(voyage.voyageId)}
                            className="hit-target-44 px-3 py-1.5 rounded-lg text-[11px] font-bold text-amber-400 bg-amber-500/15 border border-amber-500/20 uppercase tracking-wider active:scale-[0.95] transition-all"
                        >
                            Unarchive
                        </button>
                    </div>
                ))}
            </div>
        )}
    </div>
);
