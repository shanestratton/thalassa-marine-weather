import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { triggerHaptic } from '../../../utils/system';
import { SafeImage } from '../../ui/SafeImage';
import { GeneratedPlaylistArtwork } from './GeneratedPlaylistArtwork';
import { MoreIcon, PlayIcon } from './icons';
import { LONG_PRESS_MS, type PlaylistTileProps } from './types';

// ── Playlist tile ─────────────────────────────────────────────────

export const PlaylistTile: React.FC<PlaylistTileProps> = React.memo(
    ({ playlist, active, selected, playbackState, onTap, onLongPress }) => {
        // Track whether the remote artwork URL fails to load. Apple Music's
        // user-library artwork URLs sometimes need credentials WKWebView
        // can't supply, or the CDN host blocks the cross-origin fetch from
        // capacitor://localhost — in either case the <img> renders blank.
        // When that happens we swap to the generated mesh-gradient cover.
        const [imageFailed, setImageFailed] = useState(false);
        const [pressing, setPressing] = useState(false);
        const instructionsId = useId();
        const previewId = useId();
        const showRemote = !!playlist.artworkUrl && !imageFailed;
        const status =
            active && playbackState === 'playing'
                ? 'Playing'
                : active && playbackState === 'paused'
                  ? 'Paused'
                  : selected || active
                    ? 'Selected'
                    : 'Playlist';
        useEffect(() => {
            setImageFailed(false);
        }, [playlist.artworkUrl]);

        // Long-press detection. Touch start kicks off a 500ms timer; if it
        // fires, we call onLongPress and flag suppressClick so the
        // subsequent onClick (which iOS fires after touchend) is ignored.
        // Touch move / cancel / quick lift cancels the timer cleanly.
        const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
        const suppressClickRef = useRef(false);
        useEffect(
            () => () => {
                if (timerRef.current) clearTimeout(timerRef.current);
            },
            [],
        );

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
                    aria-pressed={!!(selected || active)}
                    aria-describedby={`${instructionsId} ${previewId}`}
                    className={`group relative block w-full overflow-hidden rounded-2xl border bg-slate-900 text-left shadow-xl transition-all focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-sky-400/80 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 ${
                        pressing ? 'scale-[0.94]' : 'active:scale-[0.97]'
                    } ${
                        active
                            ? 'border-sky-300/70 ring-2 ring-sky-400/35 shadow-2xl'
                            : 'border-white/10 hover:-translate-y-0.5 hover:border-sky-300/35 hover:shadow-2xl'
                    }`}
                >
                    <div className="relative aspect-[4/3] w-full overflow-hidden">
                        {showRemote ? (
                            <SafeImage
                                src={playlist.artworkUrl}
                                alt=""
                                className="w-full h-full object-cover"
                                loading="lazy"
                                onError={() => setImageFailed(true)}
                                fallback={<GeneratedPlaylistArtwork name={playlist.name} />}
                            />
                        ) : (
                            <GeneratedPlaylistArtwork name={playlist.name} />
                        )}
                        <div className="absolute inset-0 bg-linear-to-t from-slate-950 via-slate-950/18 to-transparent" />
                        <div className="absolute bottom-2.5 left-2.5 flex items-center gap-1.5 rounded-lg border border-white/10 bg-slate-950/85 px-2 py-1">
                            <PlayIcon
                                className={`h-3 w-3 ${status === 'Playing' ? 'text-sky-300' : 'text-slate-300'}`}
                            />
                            <span className="text-micro font-bold text-sky-100">{status}</span>
                        </div>
                    </div>
                    <div className="p-3">
                        <div className="min-h-[2.5em] line-clamp-2 break-words text-[15px] font-extrabold leading-tight text-white">
                            {playlist.name}
                        </div>
                        {playlist.curator && (
                            <div className="mt-1 truncate text-micro font-medium text-slate-400">
                                {playlist.curator}
                            </div>
                        )}
                        <div id={previewId} className="mt-3 border-t border-white/10 pt-2 text-micro text-slate-300">
                            <span className="sr-only">{status}. </span>
                            {playlist.previewTracks.length > 0 ? (
                                <div className="space-y-1.5">
                                    {playlist.previewTracks.slice(0, 2).map((track, index) => (
                                        <div key={`${index}-${track.title}`}>
                                            <span className="block truncate font-semibold text-slate-200">
                                                {track.title}
                                            </span>
                                            {track.artist && (
                                                <span className="block truncate text-slate-400">{track.artist}</span>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <span className="text-slate-400">View tracks in more options</span>
                            )}
                        </div>
                    </div>
                </button>
                <button
                    type="button"
                    onClick={(event) => {
                        // Safari does not focus a tapped button automatically.
                        // Give the detail dialog an explicit restoration target.
                        event.currentTarget.focus();
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
    },
);
PlaylistTile.displayName = 'PlaylistTile';
