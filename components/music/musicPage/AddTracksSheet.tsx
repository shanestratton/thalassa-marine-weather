import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useFocusTrap } from '../../../hooks/useFocusTrap';
import { useKeyboardOffset } from '../../../hooks/useKeyboardOffset';
import { searchCatalogSongs, type CatalogSongResult } from '../../../services/voice/integrations/appleMusic';
import { OverlayPortal } from '../../ui/OverlayPortal';
import { SongResultRow } from './SongResultRow';
import { ChevronLeftIcon } from './icons';
import type { AddTracksSheetProps } from './types';

// ── Add tracks sheet — catalog search → tap to add ────────────────

export const AddTracksSheet: React.FC<AddTracksSheetProps> = ({ playlistName, onClose, onAddSong }) => {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<CatalogSongResult[]>([]);
    const [searching, setSearching] = useState(false);
    const [searchError, setSearchError] = useState<string | null>(null);
    /** Per-row state: which song is currently in flight, which were
     *  added successfully (green check), and which redirected to
     *  Apple Music (amber arrow). */
    const [addingId, setAddingId] = useState<string | null>(null);
    const [addedIds, setAddedIds] = useState<Set<string>>(new Set());
    const [redirectedIds, setRedirectedIds] = useState<Set<string>>(new Set());
    /** One-time banner explaining Apple's limitation, shown after the
     *  first redirect of this session. */
    const [showRedirectExplain, setShowRedirectExplain] = useState(false);
    const [mounted, setMounted] = useState(false);
    const titleId = useId();
    const descriptionId = useId();
    const inputRef = useRef<HTMLInputElement | null>(null);
    const focusTrapRef = useFocusTrap<HTMLDivElement>(true, {
        initialFocusRef: inputRef,
        onEscape: onClose,
    });

    useEffect(() => {
        const id = requestAnimationFrame(() => setMounted(true));
        return () => cancelAnimationFrame(id);
    }, []);

    const keyboardHeight = useKeyboardOffset();

    const handleSearch = useCallback(async () => {
        const trimmed = query.trim();
        if (!trimmed) return;
        setSearching(true);
        setSearchError(null);
        try {
            const r = await searchCatalogSongs(trimmed, 25);
            if (r.available) {
                setResults(r.songs);
                if (r.songs.length === 0) setSearchError(`No catalog match for "${trimmed}"`);
            } else {
                setSearchError(r.error ?? 'Catalog search failed');
                setResults([]);
            }
        } finally {
            setSearching(false);
        }
    }, [query]);

    const handleAdd = useCallback(
        async (song: CatalogSongResult) => {
            if (addingId || addedIds.has(song.id) || redirectedIds.has(song.id)) return;
            setAddingId(song.id);
            const outcome = await onAddSong(song);
            setAddingId(null);
            if (outcome === 'added') {
                setAddedIds((prev) => new Set([...prev, song.id]));
            } else if (outcome === 'redirect') {
                setRedirectedIds((prev) => new Set([...prev, song.id]));
                setShowRedirectExplain(true);
            } else {
                setSearchError("Couldn't add that track");
            }
        },
        [addingId, addedIds, redirectedIds, onAddSong],
    );

    return (
        <OverlayPortal>
            <div
                role="presentation"
                onClick={onClose}
                className={`absolute inset-0 bg-black/80 backdrop-blur-md transition-opacity duration-300 ${
                    mounted ? 'opacity-100' : 'opacity-0'
                }`}
            />
            {/* Centred like every other modal (house rule — this was the
             * last bottom sheet on the Music page). The card is centred in the
             * viewport above the keyboard, clears the tab bar, and the
             * results list scrolls inside it. */}
            <div
                className="absolute inset-0 flex items-center justify-center px-3 pointer-events-none"
                style={{ bottom: keyboardHeight }}
            >
                <div
                    ref={focusTrapRef}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby={titleId}
                    aria-describedby={descriptionId}
                    className={`relative w-full max-w-2xl flex flex-col overflow-hidden rounded-2xl border border-sky-300/15 bg-linear-to-b from-slate-900 via-slate-950 to-slate-950 shadow-2xl transition-all duration-300 ease-out pointer-events-auto ${
                        mounted ? 'opacity-100 scale-100' : 'opacity-0 scale-95'
                    }`}
                    style={{
                        // Same clearance as ModalSheet: 6rem above and below
                        // with the keyboard down (clear of the tab bar); with
                        // it up, the visible area less a small margin. The
                        // floor gives the empty-search state some presence
                        // but never pushes the card past its cap.
                        maxHeight:
                            keyboardHeight > 0 ? `calc(100dvh - ${keyboardHeight}px - 2rem)` : 'calc(100dvh - 12rem)',
                        minHeight: keyboardHeight > 0 ? undefined : 'min(55vh, calc(100dvh - 12rem))',
                    }}
                >
                    {/* Header — back button + title */}
                    <div className="flex items-center gap-3 px-5 pt-4 pb-3">
                        <button
                            onClick={onClose}
                            className="hit-target-44 w-9 h-9 -ml-2 rounded-full flex items-center justify-center text-white/80 active:bg-white/10 transition-colors shrink-0"
                            aria-label={`Back to ${playlistName} playlist details`}
                        >
                            <ChevronLeftIcon className="w-6 h-6" />
                        </button>
                        <div className="flex-1 min-w-0">
                            <div id={titleId} className="text-white font-bold text-lg leading-tight">
                                Add tracks
                            </div>
                            <div id={descriptionId} className="text-white/50 text-xs mt-0.5 truncate">
                                to "{playlistName}"
                            </div>
                        </div>
                    </div>

                    {/* Search input */}
                    <div className="px-5 pb-3 flex gap-2">
                        <input
                            ref={inputRef}
                            type="text"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="Song or artist…"
                            aria-label="Search Apple Music catalog"
                            className="flex-1 rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-sm text-white placeholder:text-white/50 transition-colors focus:border-sky-300/60 focus:bg-sky-400/[0.07] focus:outline-hidden"
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') void handleSearch();
                            }}
                        />
                        <button
                            onClick={() => void handleSearch()}
                            disabled={searching || !query.trim()}
                            className="rounded-xl border border-sky-300/30 bg-sky-600 px-4 py-3 text-sm font-extrabold text-white transition-transform active:scale-[0.97] disabled:opacity-40 disabled:active:scale-100"
                        >
                            {searching ? '…' : 'Search'}
                        </button>
                    </div>

                    {searchError && (
                        <div className="mx-5 mb-2 px-3 py-2 rounded-lg bg-amber-500/15 border border-amber-400/30 text-amber-300 text-xs">
                            {searchError}
                        </div>
                    )}

                    {/* Results list — the card's only scroller */}
                    <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-5">
                        {results.length === 0 && !searching && !searchError && (
                            <div className="text-center text-white/40 text-sm py-12 px-6">
                                Search Apple Music's catalog and tap a result to add it to{' '}
                                <span className="text-white/60">"{playlistName}"</span>.
                            </div>
                        )}
                        {showRedirectExplain && (
                            <div className="mx-2 mb-3 px-3 py-2.5 rounded-lg bg-amber-500/10 border border-amber-400/30 text-amber-200 text-xs leading-relaxed">
                                Apple doesn't allow apps to add songs straight into your playlists — only their Music
                                app can. Tapping a song opens it in Apple Music, where you can long-press and pick{' '}
                                <strong className="text-amber-100">Add to a Playlist → "{playlistName}"</strong>. We'll
                                refresh this view when you come back.
                            </div>
                        )}
                        {results.map((song) => (
                            <SongResultRow
                                key={song.id}
                                song={song}
                                adding={addingId === song.id}
                                added={addedIds.has(song.id)}
                                redirected={redirectedIds.has(song.id)}
                                onAdd={() => void handleAdd(song)}
                            />
                        ))}
                    </div>
                </div>
            </div>
        </OverlayPortal>
    );
};
