import React, { useCallback, useId, useRef, useState } from 'react';
import { triggerHaptic } from '../../../utils/system';
import { SafeImage } from '../../ui/SafeImage';
import { GeneratedPlaylistArtwork } from './GeneratedPlaylistArtwork';
import { MoreIcon, PlayIcon } from './icons';
import { LONG_PRESS_MS, type PlaylistTileProps } from './types';

// ── Playlist tile ─────────────────────────────────────────────────

export const PlaylistTile: React.FC<PlaylistTileProps> = React.memo(({ playlist, active, onTap, onLongPress }) => {
    // Track whether the remote artwork URL fails to load. Apple Music's
    // user-library artwork URLs sometimes need credentials WKWebView
    // can't supply, or the CDN host blocks the cross-origin fetch from
    // capacitor://localhost — in either case the <img> renders blank.
    // When that happens we swap to the generated mesh-gradient cover.
    const [imageFailed, setImageFailed] = useState(false);
    const [pressing, setPressing] = useState(false);
    const instructionsId = useId();
    const showRemote = !!playlist.artworkUrl && !imageFailed;

    // Long-press detection. Touch start kicks off a 500ms timer; if it
    // fires, we call onLongPress and flag suppressClick so the
    // subsequent onClick (which iOS fires after touchend) is ignored.
    // Touch move / cancel / quick lift cancels the timer cleanly.
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const suppressClickRef = useRef(false);

    const startPress = useCallback(() => {
        suppressClickRef.current = false;
        setPressing(true);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
            suppressClickRef.current = true;
            setPressing(false);
            onLongPress(playlist);
        }, LONG_PRESS_MS);
    }, [onLongPress, playlist]);

    const cancelPress = useCallback(() => {
        if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
        setPressing(false);
    }, []);

    const handleClick = useCallback(() => {
        // If long-press already fired, swallow the click that iOS
        // synthesises after touchend.
        if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
        }
        onTap(playlist.id);
    }, [onTap, playlist.id]);

    return (
        <div className="relative">
            <button
                onClick={handleClick}
                onTouchStart={startPress}
                onTouchEnd={cancelPress}
                onTouchMove={cancelPress}
                onTouchCancel={cancelPress}
                onMouseDown={startPress}
                onMouseUp={cancelPress}
                onMouseLeave={cancelPress}
                aria-label={playlist.name}
                aria-describedby={instructionsId}
                className={`group relative block w-full aspect-square overflow-hidden rounded-2xl border bg-slate-900 text-left shadow-xl transition-all focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-sky-400/80 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 ${
                    pressing ? 'scale-[0.94]' : 'active:scale-[0.97]'
                } ${
                    active
                        ? 'border-sky-300/70 ring-2 ring-sky-400/35 shadow-2xl'
                        : 'border-white/10 hover:-translate-y-0.5 hover:border-sky-300/35 hover:shadow-2xl'
                }`}
            >
                {showRemote ? (
                    <SafeImage
                        src={playlist.artworkUrl}
                        alt={playlist.name}
                        className="w-full h-full object-cover"
                        loading="lazy"
                        onError={() => setImageFailed(true)}
                        fallback={
                            <GeneratedPlaylistArtwork name={playlist.name} previewTracks={playlist.previewTracks} />
                        }
                    />
                ) : (
                    <GeneratedPlaylistArtwork name={playlist.name} previewTracks={playlist.previewTracks} />
                )}
                <div className="absolute inset-0 bg-linear-to-t from-slate-950 via-slate-950/18 to-transparent" />
                {/* One visual language for both remote and generated artwork:
                 * a small operational badge, then a strong title treatment at
                 * the waterline. It makes a mixed library feel intentional. */}
                <div className="absolute left-2.5 top-2.5 flex items-center gap-1.5 rounded-lg border border-white/10 bg-slate-950/75 px-2 py-1 backdrop-blur-md">
                    {active ? (
                        <>
                            <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />
                            <span className="text-[9px] font-black uppercase tracking-[0.14em] text-sky-200">
                                Playing
                            </span>
                        </>
                    ) : (
                        <>
                            <PlayIcon className="h-2.5 w-2.5 text-sky-200" />
                            <span className="text-[9px] font-black uppercase tracking-[0.14em] text-white/75">
                                Playlist
                            </span>
                        </>
                    )}
                </div>
                <div className="absolute inset-x-0 bottom-0 p-3 pt-10">
                    <div className="truncate text-[15px] font-extrabold leading-tight text-white">{playlist.name}</div>
                    {playlist.curator && (
                        <div className="mt-1 truncate text-[11px] font-medium text-white/65">{playlist.curator}</div>
                    )}
                </div>
            </button>
            <button
                type="button"
                onClick={() => {
                    triggerHaptic('light');
                    onLongPress(playlist);
                }}
                aria-label={`More options for ${playlist.name}`}
                className="absolute right-1 top-1 flex h-11 w-11 items-center justify-center rounded-2xl border border-white/15 bg-slate-950/75 text-white/85 shadow-xs backdrop-blur-md transition-all hover:border-sky-200/35 hover:bg-sky-500/[0.14] hover:text-sky-100 active:scale-90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-sky-400"
            >
                <MoreIcon className="h-4 w-4" />
            </button>
            <span id={instructionsId} className="sr-only">
                Tap to play. Use more options to view tracks, add music, or manage this playlist.
            </span>
        </div>
    );
});
PlaylistTile.displayName = 'PlaylistTile';
