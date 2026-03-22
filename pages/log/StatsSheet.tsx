/**
 * StatsSheet — Statistics action sheet extracted from LogPage.
 * Shows "Selected Voyage" and "All Voyages" stat options.
 */
import React from 'react';
import { ShipLogEntry } from '../../types';

interface StatsSheetProps {
    onClose: () => void;
    onSelectVoyage: (voyageId: string | null) => void;
    onShowStats: () => void;
    entries: ShipLogEntry[];
    selectedVoyageId: string | null;
    currentVoyageId: string | null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    voyageGroups: any[];
}

export const StatsSheet: React.FC<StatsSheetProps> = ({
    onClose,
    onSelectVoyage,
    onShowStats,
    entries,
    selectedVoyageId,
    currentVoyageId,
    voyageGroups,
}) => {
    const effectiveVoyageId = selectedVoyageId || currentVoyageId || voyageGroups[0]?.voyageId || null;
    const voyageEntryCount = effectiveVoyageId ? entries.filter((e) => e.voyageId === effectiveVoyageId).length : 0;

    return (
        <div className="fixed inset-0 z-[950] flex flex-col bg-slate-950 animate-[slideUp_0.3s_ease-out]">
            <div className="shrink-0 bg-slate-900/90 backdrop-blur-md border-b border-white/10 px-4 pt-3 pb-3">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-lg bg-amber-500/20 flex items-center justify-center">
                            <svg
                                className="w-4.5 h-4.5 text-amber-400"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                                />
                            </svg>
                        </div>
                        <h2 className="text-lg font-bold text-white">Voyage Statistics</h2>
                    </div>
                    <button
                        aria-label="Close"
                        onClick={onClose}
                        className="p-2 text-slate-400 hover:text-white transition-colors"
                    >
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M6 18L18 6M6 6l12 12"
                            />
                        </svg>
                    </button>
                </div>
                <p className="text-sm text-slate-400 mt-2">Analyze your sailing performance</p>
            </div>

            <div className="flex-1 flex flex-col justify-center px-4 pb-8">
                <div className="space-y-4 max-w-2xl mx-auto w-full">
                    {/* Selected Voyage Card */}
                    <button
                        aria-label="View voyage statistics"
                        onClick={() => {
                            onSelectVoyage(effectiveVoyageId);
                            onShowStats();
                            onClose();
                        }}
                        className="w-full flex items-center gap-4 p-5 rounded-2xl bg-gradient-to-r from-amber-500/15 to-amber-600/5 border border-amber-500/20 hover:border-amber-400/40 active:scale-[0.98] transition-all"
                    >
                        <div className="w-14 h-14 rounded-xl bg-amber-500/20 flex items-center justify-center shrink-0">
                            <svg
                                className="w-7 h-7 text-amber-400"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={1.5}
                                    d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                                />
                            </svg>
                        </div>
                        <div className="flex-1 text-left">
                            <div className="text-white font-bold text-lg">Selected Voyage</div>
                            <div className="text-slate-400 text-sm mt-1">Stats for the highlighted track</div>
                        </div>
                        {voyageEntryCount > 0 && (
                            <span className="px-2.5 py-1 rounded-lg bg-amber-500/20 text-amber-400 text-xs font-bold">
                                {voyageEntryCount} pts
                            </span>
                        )}
                        <svg className="w-5 h-5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                    </button>

                    {/* All Voyages Card */}
                    <button
                        aria-label="View all statistics"
                        onClick={() => {
                            onSelectVoyage(null);
                            onShowStats();
                            onClose();
                        }}
                        className="w-full flex items-center gap-4 p-5 rounded-2xl bg-gradient-to-r from-purple-500/15 to-purple-600/5 border border-purple-500/20 hover:border-purple-400/40 active:scale-[0.98] transition-all"
                    >
                        <div className="w-14 h-14 rounded-xl bg-purple-500/20 flex items-center justify-center shrink-0">
                            <svg
                                className="w-7 h-7 text-purple-400"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={1.5}
                                    d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"
                                />
                            </svg>
                        </div>
                        <div className="flex-1 text-left">
                            <div className="text-white font-bold text-lg">All Voyages</div>
                            <div className="text-slate-400 text-sm mt-1">Combined statistics across every voyage</div>
                        </div>
                        <span className="px-2.5 py-1 rounded-lg bg-purple-500/20 text-purple-400 text-xs font-bold">
                            {entries.length} pts
                        </span>
                        <svg className="w-5 h-5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                    </button>
                </div>
            </div>
        </div>
    );
};
