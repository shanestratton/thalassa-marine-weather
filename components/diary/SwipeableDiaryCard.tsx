/**
 * SwipeableDiaryCard — Individual diary entry card with swipe-to-delete
 * 
 * Extracted from DiaryPage for:
 * 1. React.memo — prevents re-renders when sibling entries change
 * 2. Module-level definition — stable component reference across parent renders
 */

import React from 'react';
import { DiaryEntry, MOOD_CONFIG } from '../../services/DiaryService';
import { useSwipeable } from '../../hooks/useSwipeable';

/** Format lat/lon to a human-readable coordinate string */
const formatCoord = (lat: number, lon: number): string => {
    const latDir = lat >= 0 ? 'N' : 'S';
    const lonDir = lon >= 0 ? 'E' : 'W';
    return `${Math.abs(lat).toFixed(4)}°${latDir}, ${Math.abs(lon).toFixed(4)}°${lonDir}`;
};

interface SwipeableDiaryCardProps {
    entry: DiaryEntry;
    onTap: () => void;
    onDelete: () => void;
    onEdit: () => void;
    selected: boolean;
    onToggleSelect: () => void;
}

export const SwipeableDiaryCard: React.FC<SwipeableDiaryCardProps> = React.memo(({
    entry, onTap, onDelete, onEdit, selected, onToggleSelect
}) => {
    const { swipeOffset, isSwiping, resetSwipe, ref } = useSwipeable();
    const moodCfg = MOOD_CONFIG[entry.mood] || MOOD_CONFIG.neutral;
    const entryHasCoords = entry.latitude != null && entry.longitude != null;

    return (
        <div className="relative overflow-hidden rounded-2xl">
            {/* Delete button (revealed on swipe) */}
            <div
                className={`absolute right-0 top-0 bottom-0 w-20 bg-red-600 flex items-center justify-center rounded-r-2xl transition-opacity ${swipeOffset > 0 ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
                onClick={() => { resetSwipe(); onDelete(); }}
            >
                <div className="text-center text-white">
                    <svg className="w-5 h-5 mx-auto mb-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                    <span className="text-[11px] font-bold">Delete</span>
                </div>
            </div>

            {/* Main card (slides on swipe) */}
            <div
                className={`relative transition-transform ${isSwiping ? '' : 'duration-200'} flex items-stretch border ${selected ? 'border-sky-500/50' : 'border-white/5'} rounded-2xl overflow-hidden bg-white/[0.03]`}
                style={{ transform: `translateX(-${swipeOffset}px)` }}
                ref={ref}
                onClick={() => { if (swipeOffset === 0) onTap(); }}
            >
                {/* Selection checkbox */}
                <button
                    onClick={(e) => { e.stopPropagation(); onToggleSelect(); }}
                    className="shrink-0 flex items-center justify-center w-10 ml-1"
                    aria-label={selected ? 'Deselect' : 'Select'}
                >
                    <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all ${selected
                        ? 'bg-sky-500 border-sky-500'
                        : 'border-gray-500/40 bg-transparent'
                        }`}
                    >
                        {selected && (
                            <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                        )}
                    </div>
                </button>

                {/* Blue accent bar */}
                <div className="w-1.5 shrink-0 bg-sky-500" />

                {/* Content */}
                <div className="flex-1 p-4">
                    {/* Mood badge — top of card */}
                    <div className="flex items-center gap-1.5 mb-1.5">
                        <span className="text-micro">{moodCfg.emoji}</span>
                        <span className="text-micro font-bold text-gray-500 uppercase tracking-widest">{moodCfg.label || entry.mood}</span>
                        {entry.audio_url && <span className="text-[10px] text-emerald-400 bg-emerald-500/15 px-1.5 py-0.5 rounded-full font-bold">🎙️</span>}
                        {entry._offline && <span className="text-[10px] text-amber-400 bg-amber-500/15 px-1.5 py-0.5 rounded-full font-bold">PENDING</span>}
                    </div>
                    <div className="flex items-center justify-between gap-3">
                        <div className="flex-1 text-left min-w-0">
                            <h4 className="text-sm font-black text-white tracking-wide mb-0.5 truncate">{entry.title}</h4>
                            <p className="text-label text-gray-400 line-clamp-2 leading-relaxed">
                                {entry.body || (entry.audio_url ? 'Voice memo attached' : '')}
                            </p>
                            {entryHasCoords && (
                                <div className="flex items-center gap-1.5 mt-1.5 text-[11px] text-sky-500/60">
                                    <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
                                    </svg>
                                    <span className="font-mono font-medium">{formatCoord(entry.latitude!, entry.longitude!)}</span>
                                    {entry.location_name && !entry.location_name.includes('°') && (
                                        <span className="text-gray-500 truncate">— {entry.location_name}</span>
                                    )}
                                </div>
                            )}
                            {!entryHasCoords && entry.location_name && (
                                <div className="flex items-center gap-1.5 mt-1.5 text-[11px] text-sky-500/50">
                                    <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
                                    </svg>
                                    <span className="font-medium truncate">{entry.location_name}</span>
                                </div>
                            )}
                        </div>

                        {/* Edit button — vertically centered */}
                        <button
                            onClick={(e) => { e.stopPropagation(); onEdit(); }}
                            className="shrink-0 p-2 rounded-lg hover:bg-white/10 transition-colors self-center"
                            aria-label="Edit entry"
                        >
                            <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" />
                            </svg>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
});

SwipeableDiaryCard.displayName = 'SwipeableDiaryCard';
