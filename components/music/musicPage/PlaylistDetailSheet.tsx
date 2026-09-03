import React, { useEffect, useId, useRef, useState } from 'react';
import { useFocusTrap } from '../../../hooks/useFocusTrap';
import { OverlayPortal } from '../../ui/OverlayPortal';
import { SafeImage } from '../../ui/SafeImage';
import { GeneratedPlaylistArtwork } from './GeneratedPlaylistArtwork';
import { formatDuration } from './helpers';
import { CloseIcon, PlayIcon, PlusIcon } from './icons';
import type { PlaylistDetailSheetProps } from './types';

// ── Playlist detail sheet — long-press → bottom sheet w/ tracks ────

export const PlaylistDetailSheet: React.FC<PlaylistDetailSheetProps> = ({
    playlist,
    tracks,
    loading,
    error,
    covered,
    onClose,
    onPlayAll,
    onPlayTrack,
    onAddTracks,
    onDelete,
}) => {
    const [imageFailed, setImageFailed] = useState(false);
    const [mounted, setMounted] = useState(false);
    const titleId = useId();
    const closeButtonRef = useRef<HTMLButtonElement | null>(null);
    const focusTrapRef = useFocusTrap<HTMLDivElement>(true, {
        initialFocusRef: closeButtonRef,
        onEscape: onClose,
    });
    // Trigger the slide-up animation by toggling `mounted` on next
    // frame after mount. Without rAF the initial render and the
    // animated state would batch into the same paint.
    useEffect(() => {
        const id = requestAnimationFrame(() => setMounted(true));
        return () => cancelAnimationFrame(id);
    }, []);

    const showRemote = !!playlist.artworkUrl && !imageFailed;

    return (
        <OverlayPortal
            className="flex items-center justify-center p-4 pb-[calc(4rem+env(safe-area-inset-bottom)+1rem)] pt-[max(1rem,env(safe-area-inset-top))]"
            aria-hidden={covered || undefined}
        >
            {/* Backdrop — absolute inset-0 so it still covers the
             *  full viewport (including the padding zone behind the nav). */}
            <div
                role="presentation"
                onClick={onClose}
                className={`absolute inset-0 bg-black/70 backdrop-blur-md transition-opacity duration-300 ${
                    mounted ? 'opacity-100' : 'opacity-0'
                }`}
            />
            {/* Centred per the standing modal rule (Shane 2026-09-02: "all modal boxes centered on the punters screen"). */}
            {/* Card — min-h-[55vh] gives empty playlists visual
             *  presence (Play + Add tracks land mid-screen instead of
             *  squashed at the bottom). Slide-up swapped for a fade now
             *  that the card is centred. */}
            <div
                ref={focusTrapRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                className={`relative w-full max-w-lg max-h-full flex flex-col rounded-4xl border border-sky-300/15 bg-linear-to-b from-slate-900 via-slate-950 to-slate-950 shadow-2xl transition-opacity duration-300 ease-out ${
                    mounted ? 'opacity-100' : 'opacity-0'
                }`}
                style={{
                    minHeight: '55vh',
                }}
            >
                {/* Drag handle + close button */}
                <div className="relative flex justify-center pt-3 pb-1">
                    <div className="w-12 h-1.5 rounded-full bg-white/25" />
                    <button
                        ref={closeButtonRef}
                        onClick={onClose}
                        className="hit-target-44 absolute right-3 top-2 w-9 h-9 rounded-full flex items-center justify-center text-white/70 hover:text-white active:bg-white/10 transition-colors"
                        aria-label={`Close ${playlist.name} playlist details`}
                    >
                        <CloseIcon className="w-5 h-5" />
                    </button>
                </div>

                {/* Hero */}
                <div className="flex items-center gap-4 px-5 py-4">
                    <div className="h-20 w-20 shrink-0 overflow-hidden rounded-2xl shadow-lg ring-1 ring-sky-200/20">
                        {showRemote ? (
                            <SafeImage
                                src={playlist.artworkUrl}
                                alt=""
                                className="w-full h-full object-cover"
                                loading="eager"
                                onError={() => setImageFailed(true)}
                                fallback={<GeneratedPlaylistArtwork name={playlist.name} />}
                            />
                        ) : (
                            <GeneratedPlaylistArtwork name={playlist.name} />
                        )}
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="mb-1 text-[10px] font-black uppercase tracking-[0.17em] text-sky-200/65">
                            Playlist
                        </div>
                        <div id={titleId} className="truncate text-lg font-extrabold leading-tight text-white">
                            {playlist.name}
                        </div>
                        <div className="text-white/60 text-sm mt-0.5">
                            {loading
                                ? 'Loading…'
                                : tracks.length > 0
                                  ? `${tracks.length} track${tracks.length === 1 ? '' : 's'}`
                                  : 'No tracks'}
                        </div>
                        {playlist.curator && (
                            <div className="text-white/40 text-xs truncate mt-0.5">{playlist.curator}</div>
                        )}
                    </div>
                </div>

                {/* Action buttons */}
                <div className="px-5 pb-3 space-y-2">
                    <button
                        onClick={onPlayAll}
                        disabled={loading || tracks.length === 0}
                        aria-label={`Play all tracks in ${playlist.name}`}
                        className="flex w-full items-center justify-center gap-2 rounded-2xl bg-sky-600 py-3 text-sm font-extrabold text-white shadow-xl transition-transform active:scale-[0.97] disabled:opacity-40 disabled:active:scale-100"
                    >
                        <PlayIcon className="w-4 h-4" />
                        <span>Play</span>
                    </button>
                    <button
                        onClick={onAddTracks}
                        aria-label={`Add tracks to ${playlist.name}`}
                        className="flex w-full items-center justify-center gap-2 rounded-2xl border border-sky-300/25 bg-sky-400/9 py-3 text-sm font-bold text-sky-200 transition-transform active:scale-[0.97]"
                    >
                        <PlusIcon className="w-5 h-5" />
                        <span>Add tracks</span>
                    </button>
                </div>

                {/* Error banner */}
                {error && (
                    <div className="mx-5 mb-2 px-3 py-2 rounded-lg bg-amber-500/15 border border-amber-400/30 text-amber-300 text-xs">
                        {error}
                    </div>
                )}

                {/* Track list — min-h-0 is REQUIRED on flex children
                 *  that need overflow-scroll. Without it, flex's default
                 *  `min-height: auto` lets the child grow to fit its
                 *  content, so the scroll container never actually
                 *  overflows and iOS rubber-bands the whole sheet
                 *  instead of scrolling the list. overscroll-contain
                 *  stops the scroll from chaining up to the backdrop. */}
                <div
                    className="flex-1 min-h-0 overflow-y-auto px-3"
                    style={{ overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch' }}
                >
                    {loading && (
                        <div className="flex flex-col items-center justify-center py-12 text-white/40 text-sm gap-2">
                            <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-sky-400" />
                            Loading tracks…
                        </div>
                    )}
                    {!loading &&
                        tracks.map((track, i) => (
                            <button
                                key={track.id}
                                onClick={() => onPlayTrack(track.id)}
                                aria-label={`Play track ${i + 1}: ${track.title} by ${track.artist}`}
                                className="flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left transition-colors hover:bg-sky-500/6 active:bg-sky-400/10"
                            >
                                <div className="w-8 text-center text-white/40 text-sm font-medium tabular-nums shrink-0">
                                    {i + 1}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="text-white text-sm font-medium truncate">{track.title}</div>
                                    <div className="text-white/50 text-xs truncate mt-0.5">{track.artist}</div>
                                </div>
                                <div className="text-white/40 text-xs tabular-nums shrink-0">
                                    {formatDuration(track.durationMs)}
                                </div>
                            </button>
                        ))}
                </div>

                {/* Delete this playlist — sticky footer so it's always
                 *  visible regardless of scroll state. Lives outside the
                 *  scroll container because long track lists made the
                 *  delete button unreachable on iOS (the inner scroll
                 *  rubber-banded back before reaching the bottom).
                 *  shrink-0 keeps it pinned at the sheet's bottom edge. */}
                {!loading && (
                    <div className="shrink-0 border-t border-white/10 py-3 flex justify-center bg-black/40 backdrop-blur-xs">
                        <button
                            onClick={onDelete}
                            aria-label={`Delete ${playlist.name} playlist`}
                            className="min-h-[44px] text-red-400/80 hover:text-red-300 active:text-red-200 text-xs font-medium px-4 py-2 rounded-lg active:bg-red-500/10 transition-colors"
                        >
                            Delete this playlist
                        </button>
                    </div>
                )}
            </div>
        </OverlayPortal>
    );
};
