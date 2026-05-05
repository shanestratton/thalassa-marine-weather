/**
 * MusicPage — Apple Music playlists for the skipper.
 *
 * V1 focus: tap-to-play the user's home-made library playlists.
 * Loaded via MusicKit on first mount; cached in component state.
 * Now-playing footer shows current track + transport controls.
 *
 * The whole architecture:
 *   - Native: ApplicationMusicPlayer.shared (plays DRM Apple Music
 *     subscription content; was the missing piece all the previous
 *     MPMusicPlayerController attempts couldn't deliver)
 *   - JS: services/voice/integrations/appleMusic.ts wraps the native
 *     plugin with typed helpers (getUserPlaylists, playPlaylist,
 *     pauseMusic, resumeMusic, skipNext, getNowPlaying)
 *   - This page: tile grid of playlists + transport bar
 *
 * Future iterations: catalog search UI, queue management, radio
 * stations, recommendations. V1 is deliberately tight.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { PageHeader } from '../ui/PageHeader';
import {
    getUserPlaylists,
    playPlaylist,
    pauseMusic,
    resumeMusic,
    skipNext,
    skipPrevious,
    getNowPlaying,
    requestAuthorization,
    getAuthorizationStatus,
    getPlaylistTracks,
    playTrackInPlaylist,
    type UserPlaylist,
    createPlaylistByName,
    searchCatalogSongs,
    addSongToPlaylist,
    deletePlaylistById,
    type NowPlaying,
    type PlaylistTrack,
    type PlaylistTrackPreview,
    type CatalogSongResult,
} from '../../services/voice/integrations/appleMusic';
import { triggerHaptic } from '../../utils/system';

interface MusicPageProps {
    onBack: () => void;
}

export const MusicPage: React.FC<MusicPageProps> = ({ onBack }) => {
    const [authGranted, setAuthGranted] = useState<boolean | null>(null);
    const [authStatus, setAuthStatus] = useState<string>('');
    const [playlists, setPlaylists] = useState<UserPlaylist[]>([]);
    const [loadingPlaylists, setLoadingPlaylists] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [activePlaylistId, setActivePlaylistId] = useState<string | null>(null);
    const [nowPlaying, setNowPlaying] = useState<NowPlaying | null>(null);
    /** Create-playlist modal: open state + busy flag for the submit. */
    const [createOpen, setCreateOpen] = useState(false);
    const [createBusy, setCreateBusy] = useState(false);
    const [createError, setCreateError] = useState<string | null>(null);

    /** Load playlists. Triggered after auth + on manual refresh.
     *
     * Two-phase load to avoid the hang we hit when hydrating every
     * playlist's track list in parallel inside the Swift plugin
     * (MusicKit can't handle N concurrent .with([.tracks]) calls
     * cleanly on a real library):
     *   Phase 1: fetch playlist metadata only — fast, gets the grid up
     *   Phase 2: fire getPlaylistTracks per playlist in the background
     *           and merge each preview into its tile as it arrives.
     *           If one stalls, only that tile is missing the song
     *           list (falls back to monogram).
     */
    const loadPlaylists = useCallback(async () => {
        setLoadingPlaylists(true);
        setLoadError(null);
        try {
            const r = await getUserPlaylists();
            if (!r.available) {
                setLoadError(r.reason ?? 'unknown');
                setPlaylists([]);
                return;
            }
            setPlaylists(r.playlists);
            // Background phase: fetch first-few tracks per playlist
            // in parallel and patch them onto each tile as they
            // resolve. Errors on individual playlists swallow.
            void Promise.all(
                r.playlists.map(async (p) => {
                    try {
                        const detail = await getPlaylistTracks(p.id);
                        if (!detail.available) return;
                        const preview = detail.tracks.slice(0, 5).map((t) => ({
                            title: t.title,
                            artist: t.artist,
                        }));
                        setPlaylists((prev) =>
                            prev.map((pl) => (pl.id === p.id ? { ...pl, previewTracks: preview } : pl)),
                        );
                    } catch {
                        /* per-playlist preview failure → tile keeps monogram */
                    }
                }),
            ).catch(() => undefined);
        } finally {
            setLoadingPlaylists(false);
        }
    }, []);

    /** Initial mount: check auth status, prompt if needed, then load. */
    useEffect(() => {
        let cancelled = false;
        const init = async () => {
            const status = await getAuthorizationStatus();
            if (cancelled) return;
            setAuthGranted(status.granted);
            setAuthStatus(status.status);
            if (status.granted) {
                await loadPlaylists();
            }
        };
        void init();
        return () => {
            cancelled = true;
        };
    }, [loadPlaylists]);

    /** Poll now-playing every 2s while page is mounted. iOS doesn't
     *  give us a push notification for state changes, so we poll. */
    useEffect(() => {
        let cancelled = false;
        let interval: ReturnType<typeof setInterval> | undefined;
        const poll = async () => {
            const np = await getNowPlaying();
            if (!cancelled) setNowPlaying(np);
        };
        void poll();
        interval = setInterval(() => void poll(), 2000);
        return () => {
            cancelled = true;
            if (interval) clearInterval(interval);
        };
    }, []);

    const handleGrantAccess = useCallback(async () => {
        const r = await requestAuthorization();
        setAuthGranted(r.granted);
        setAuthStatus(r.status);
        if (r.granted) await loadPlaylists();
    }, [loadPlaylists]);

    const handlePlayPlaylist = useCallback(async (id: string) => {
        setActivePlaylistId(id);
        const r = await playPlaylist(id);
        if (!r.success) {
            setLoadError(`Couldn't play: ${r.error}`);
        }
        // Now-playing will update via the poll loop.
    }, []);

    const handlePause = useCallback(async () => {
        await pauseMusic();
        const np = await getNowPlaying();
        setNowPlaying(np);
    }, []);

    const handleResume = useCallback(async () => {
        await resumeMusic();
        const np = await getNowPlaying();
        setNowPlaying(np);
    }, []);

    const handleNext = useCallback(async () => {
        await skipNext();
        const np = await getNowPlaying();
        setNowPlaying(np);
    }, []);

    const handlePrevious = useCallback(async () => {
        await skipPrevious();
        const np = await getNowPlaying();
        setNowPlaying(np);
    }, []);

    // ── Long-press → playlist detail sheet ────────────────────────
    /** Currently-open detail sheet, plus its track list (loaded
     *  on-demand when the sheet opens). null = sheet closed. */
    const [detailPlaylist, setDetailPlaylist] = useState<UserPlaylist | null>(null);
    const [detailTracks, setDetailTracks] = useState<PlaylistTrack[]>([]);
    const [detailLoading, setDetailLoading] = useState(false);
    const [detailError, setDetailError] = useState<string | null>(null);
    /** Catalog-search "Add tracks" sheet open state. The sheet itself
     *  manages its own search/results internal state. */
    const [addTracksOpen, setAddTracksOpen] = useState(false);
    /** Delete-playlist confirmation state. When set, a small confirm
     *  prompt overlays the detail sheet. */
    const [confirmDelete, setConfirmDelete] = useState<UserPlaylist | null>(null);
    const [deleteBusy, setDeleteBusy] = useState(false);

    const openDetail = useCallback(async (playlist: UserPlaylist) => {
        triggerHaptic('medium');
        setDetailPlaylist(playlist);
        setDetailTracks([]);
        setDetailError(null);
        setDetailLoading(true);
        try {
            const r = await getPlaylistTracks(playlist.id);
            if (!r.available) {
                setDetailError(r.error ?? 'failed to load tracks');
            } else {
                setDetailTracks(r.tracks);
            }
        } finally {
            setDetailLoading(false);
        }
    }, []);

    const closeDetail = useCallback(() => {
        setDetailPlaylist(null);
        setDetailTracks([]);
        setDetailError(null);
    }, []);

    const handlePlayAll = useCallback(async () => {
        if (!detailPlaylist) return;
        triggerHaptic('light');
        const r = await playPlaylist(detailPlaylist.id);
        if (r.success) {
            setActivePlaylistId(detailPlaylist.id);
            closeDetail();
        } else {
            setDetailError(`Couldn't play: ${r.error}`);
        }
    }, [detailPlaylist, closeDetail]);

    const handlePlayTrack = useCallback(
        async (trackId: string) => {
            if (!detailPlaylist) return;
            triggerHaptic('light');
            const r = await playTrackInPlaylist(detailPlaylist.id, trackId);
            if (r.success) {
                setActivePlaylistId(detailPlaylist.id);
                closeDetail();
            } else {
                setDetailError(`Couldn't play: ${r.error}`);
            }
        },
        [detailPlaylist, closeDetail],
    );

    const handleCreatePlaylist = useCallback(
        async (name: string, description: string) => {
            const trimmed = name.trim();
            if (!trimmed) return;
            setCreateBusy(true);
            setCreateError(null);
            triggerHaptic('medium');
            const r = await createPlaylistByName(trimmed, description.trim() || undefined);
            setCreateBusy(false);
            if (r.success) {
                setCreateOpen(false);
                // Re-load the grid so the new playlist appears.
                void loadPlaylists();
            } else {
                setCreateError(r.error ?? 'Could not create playlist');
            }
        },
        [loadPlaylists],
    );

    /** Open the catalog-search add-tracks sheet over the detail sheet. */
    const handleOpenAddTracks = useCallback(() => {
        triggerHaptic('light');
        setAddTracksOpen(true);
    }, []);

    /** Add a single song from catalog search to the currently-open
     *  playlist. Returns success/failure so the AddTracksSheet can
     *  show per-row feedback (added / failed). */
    /**
     * Add a song to the open detail-sheet playlist. Returns one of:
     *   "added"     — REST or native add succeeded; track is in the
     *                 user's cloud library playlist
     *   "redirect"  — both REST and native rejected; we opened the
     *                 song's page in Apple Music app so the skipper
     *                 can long-press → Add to Playlist there
     *   "failed"    — anything else (network, search miss, etc.)
     *
     * On success, the song is OPTIMISTICALLY appended to detailTracks
     * so the skipper sees it immediately. Apple's library-sync
     * round-trip can take a few seconds to reflect changes via
     * MusicLibraryRequest, so a re-fetch right after an add often
     * returns the pre-add state.
     */
    const handleAddSongToPlaylist = useCallback(
        async (song: CatalogSongResult): Promise<'added' | 'redirect' | 'failed'> => {
            if (!detailPlaylist) return 'failed';
            const r = await addSongToPlaylist(song.id, detailPlaylist.id);
            if (r.success) {
                triggerHaptic('light');
                // Optimistic: append the song to the visible track
                // list straight away so the skipper sees what they
                // just added. Don't wait for the next getPlaylistTracks
                // round-trip — Apple's library sync is laggy.
                setDetailTracks((prev) => [
                    ...prev,
                    {
                        id: song.id,
                        title: song.title,
                        artist: song.artist,
                        durationMs: song.durationMs,
                        artworkUrl: song.artworkUrl,
                    },
                ]);
                return 'added';
            }
            if (r.notSupported) {
                // Both REST and native paths failed. Open Apple Music
                // to the song so the skipper can long-press → Add to
                // Playlist there.
                triggerHaptic('medium');
                try {
                    window.location.href = `music://music.apple.com/song/${encodeURIComponent(song.id)}`;
                } catch {
                    try {
                        window.open(`music://music.apple.com/song/${encodeURIComponent(song.id)}`, '_system');
                    } catch {
                        /* best-effort */
                    }
                }
                return 'redirect';
            }
            return 'failed';
        },
        [detailPlaylist],
    );

    /** Close the add-tracks sheet. We DO re-fetch the playlist tracks
     *  so the detail sheet stays accurate, but the merge logic below
     *  protects the optimistic adds: any track we just optimistically
     *  appended that hasn't yet appeared in Apple's authoritative
     *  list (their library sync is laggy) stays visible. Without
     *  this merge, a fresh fetch right after an add would clobber
     *  the optimistic state and the skipper sees "the song wasn't
     *  added" when actually it was. */
    const handleCloseAddTracks = useCallback(async () => {
        setAddTracksOpen(false);
        if (!detailPlaylist) return;
        const r = await getPlaylistTracks(detailPlaylist.id);
        if (!r.available) return;
        setDetailTracks((prev) => {
            const freshIds = new Set(r.tracks.map((t) => t.id));
            // Tracks we have locally that the fresh fetch is missing
            // — these are recent optimistic adds Apple hasn't synced.
            // Keep them at the end so the skipper still sees what
            // they added.
            const optimisticOnly = prev.filter((t) => !freshIds.has(t.id));
            return [...r.tracks, ...optimisticOnly];
        });
    }, [detailPlaylist]);

    /** Show the delete confirmation prompt. The actual delete fires on
     *  confirm. */
    const handleRequestDelete = useCallback(() => {
        if (!detailPlaylist) return;
        triggerHaptic('medium');
        setConfirmDelete(detailPlaylist);
    }, [detailPlaylist]);

    /** Open Apple Music app via the music:// URL scheme so the
     *  skipper can delete the playlist there. Apple's MusicKit API
     *  does not expose library-playlist deletion to third-party
     *  apps, so this is the only path available. We still call
     *  deletePlaylistById first — if Apple ever adds the API, our
     *  code uses it automatically. Today, deletePlaylistById always
     *  reports notSupported and we fall through to the open-app
     *  branch.
     */
    const handleConfirmDelete = useCallback(async () => {
        if (!confirmDelete) return;
        setDeleteBusy(true);
        const r = await deletePlaylistById(confirmDelete.id);
        setDeleteBusy(false);
        if (r.success) {
            // The day Apple adds the API — already wired up.
            setConfirmDelete(null);
            closeDetail();
            void loadPlaylists();
            return;
        }
        if (r.notSupported) {
            // Open Apple Music via the music:// URL scheme. iOS's
            // WebKit delegates unknown schemes to the system, which
            // launches the matching app. Belt-and-braces with
            // window.open as a fallback in case WebKit blocks the
            // direct location-href change.
            try {
                window.location.href = 'music://';
            } catch {
                try {
                    window.open('music://', '_system');
                } catch {
                    /* best-effort */
                }
            }
            setConfirmDelete(null);
        } else {
            setDetailError(`Couldn't delete: ${r.error}`);
            setConfirmDelete(null);
        }
    }, [confirmDelete, closeDetail, loadPlaylists]);

    const nowPlayingVisible = !!(nowPlaying && nowPlaying.title);

    // ── Scroll-fade mask ───────────────────────────────────────────
    // Tiles scrolling toward the bottom of the page would otherwise
    // pass UNDER the floating NowPlayingBar, looking smudged through
    // its backdrop-blur. Apply a CSS mask-image gradient to the
    // scroll area so content fades to transparent ~60px above the
    // bar's top edge — tiles dissolve into the dark before reaching
    // it instead of sliding under. When the bar isn't visible we
    // still fade above the global nav for the same reason.
    //
    // Math:
    //   - 4rem  = global bottom-nav height
    //   - 80px  = floating bar height (artwork 48 + p-3 + pb-2)
    //   - 60px  = fade gradient height (the soft transition zone)
    const maskBottomEnd = nowPlayingVisible
        ? 'calc(4rem + env(safe-area-inset-bottom) + 80px)'
        : 'calc(4rem + env(safe-area-inset-bottom))';
    const maskFadeStart = `calc(${maskBottomEnd} + 60px)`;
    const fadeMask = `linear-gradient(to bottom, black 0, black calc(100% - ${maskFadeStart}), transparent calc(100% - ${maskBottomEnd}))`;

    return (
        <div className="flex flex-col h-full bg-gradient-to-b from-slate-900 via-slate-950 to-black">
            <PageHeader
                title="Music"
                subtitle="Apple Music playlists"
                onBack={onBack}
                action={
                    authGranted === true ? (
                        <button
                            onClick={() => {
                                triggerHaptic('light');
                                setCreateError(null);
                                setCreateOpen(true);
                            }}
                            className="w-10 h-10 rounded-full bg-pink-500/15 border border-pink-400/30 flex items-center justify-center text-pink-300 hover:bg-pink-500/25 active:scale-95 transition-all"
                            aria-label="Create playlist"
                        >
                            <svg
                                className="w-5 h-5"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.5"
                                strokeLinecap="round"
                            >
                                <path d="M12 5v14M5 12h14" />
                            </svg>
                        </button>
                    ) : null
                }
            />

            {/* Body — bottom padding accounts for the global nav, plus
             *  extra room when the floating NowPlayingBar is visible
             *  so the last row of tiles can scroll into view above it.
             *  The mask-image gradient fades content to transparent
             *  just above the bar so tiles don't smudge under it. */}
            <div
                className="flex-1 overflow-y-auto px-4"
                style={{
                    paddingBottom: nowPlayingVisible
                        ? 'calc(4rem + 4.75rem + env(safe-area-inset-bottom) + 1rem)'
                        : 'calc(4rem + env(safe-area-inset-bottom) + 1rem)',
                    maskImage: fadeMask,
                    WebkitMaskImage: fadeMask,
                }}
            >
                {authGranted === false && (
                    <div className="flex flex-col items-center justify-center pt-16 px-6 text-center">
                        <div className="w-20 h-20 rounded-full bg-pink-500/10 flex items-center justify-center mb-4">
                            <MusicIcon className="w-10 h-10 text-pink-400" />
                        </div>
                        <div className="text-white font-bold text-lg mb-2">Apple Music access required</div>
                        <div className="text-gray-400 text-sm mb-6 max-w-xs">
                            Tap to grant access so Calypso can browse your library and play your playlists.
                        </div>
                        <button
                            onClick={() => void handleGrantAccess()}
                            className="px-6 py-3 rounded-2xl bg-gradient-to-br from-pink-500 to-rose-600 text-white font-bold shadow-lg active:scale-[0.97] transition-transform"
                        >
                            Grant access
                        </button>
                        {authStatus && authStatus !== 'notDetermined' && (
                            <div className="text-xs text-gray-500 mt-4">
                                Status: <code>{authStatus}</code>
                            </div>
                        )}
                    </div>
                )}

                {authGranted === true && loadingPlaylists && playlists.length === 0 && (
                    <div className="flex items-center justify-center pt-16">
                        <div className="text-gray-400 text-sm">Loading your playlists…</div>
                    </div>
                )}

                {authGranted === true && !loadingPlaylists && playlists.length === 0 && !loadError && (
                    <div className="flex flex-col items-center justify-center pt-16 px-6 text-center">
                        <div className="text-white font-bold mb-2">No playlists found</div>
                        <div className="text-gray-400 text-sm max-w-xs">
                            Create some playlists in the Apple Music app, then come back and tap refresh.
                        </div>
                        <button
                            onClick={() => void loadPlaylists()}
                            className="mt-6 px-4 py-2 rounded-xl border border-pink-400/40 text-pink-300 text-sm hover:bg-pink-400/10 transition-colors"
                        >
                            Refresh
                        </button>
                    </div>
                )}

                {loadError && (
                    <div className="text-amber-400 text-sm px-2 py-3 mb-3 bg-amber-500/10 rounded-lg">
                        {loadError === 'permission_denied'
                            ? 'Apple Music access denied. Enable in iOS Settings → Thalassa → Apple Music.'
                            : `Couldn't load playlists: ${loadError}`}
                    </div>
                )}

                {playlists.length > 0 && (
                    <div className="grid grid-cols-2 gap-3 pt-2">
                        {playlists.map((p) => (
                            <PlaylistTile
                                key={p.id}
                                playlist={p}
                                active={activePlaylistId === p.id}
                                // Tap and long-press both open the detail
                                // sheet now — that's where Play, Add
                                // tracks, and Delete all live as obvious
                                // buttons. Matches Apple Music / Spotify
                                // conventions where tapping a playlist
                                // shows you the contents before playing.
                                onTap={() => void openDetail(p)}
                                onLongPress={() => void openDetail(p)}
                            />
                        ))}
                    </div>
                )}
            </div>

            {/* Floating now-playing bar — fixed-positioned above the
             *  global bottom-nav so it overlays the playlist grid
             *  rather than pushing tiles upward. The grid scroll area
             *  above gets extra bottom padding so the last row stays
             *  reachable. z-[800] sits below the nav (z-[900]) and
             *  above page content. */}
            {nowPlayingVisible && (
                <div
                    className="fixed left-0 right-0 z-[800] pointer-events-none"
                    style={{ bottom: 'calc(4rem + env(safe-area-inset-bottom))' }}
                >
                    <div className="pointer-events-auto px-3 pb-2">
                        <div className="rounded-2xl overflow-hidden bg-black/70 backdrop-blur-xl border border-white/10 shadow-2xl">
                            <NowPlayingBar
                                nowPlaying={nowPlaying!}
                                onPause={() => void handlePause()}
                                onResume={() => void handleResume()}
                                onNext={() => void handleNext()}
                                onPrevious={() => void handlePrevious()}
                            />
                        </div>
                    </div>
                </div>
            )}

            {/* Playlist detail sheet — opens on long-press */}
            {detailPlaylist && (
                <PlaylistDetailSheet
                    playlist={detailPlaylist}
                    tracks={detailTracks}
                    loading={detailLoading}
                    error={detailError}
                    onClose={closeDetail}
                    onPlayAll={() => void handlePlayAll()}
                    onPlayTrack={(trackId) => void handlePlayTrack(trackId)}
                    onAddTracks={handleOpenAddTracks}
                    onDelete={handleRequestDelete}
                />
            )}

            {/* Add-tracks (catalog search) sheet — overlays the detail sheet */}
            {addTracksOpen && detailPlaylist && (
                <AddTracksSheet
                    playlistName={detailPlaylist.name}
                    onClose={() => void handleCloseAddTracks()}
                    onAddSong={handleAddSongToPlaylist}
                />
            )}

            {/* Delete confirmation — small modal over everything */}
            {confirmDelete && (
                <DeleteConfirmSheet
                    playlistName={confirmDelete.name}
                    busy={deleteBusy}
                    onCancel={() => setConfirmDelete(null)}
                    onConfirm={() => void handleConfirmDelete()}
                />
            )}

            {/* Create-playlist modal — opens from the + button in the header */}
            {createOpen && (
                <CreatePlaylistSheet
                    busy={createBusy}
                    error={createError}
                    onClose={() => setCreateOpen(false)}
                    onSubmit={(n, d) => void handleCreatePlaylist(n, d)}
                />
            )}
        </div>
    );
};

// ── Playlist tile ─────────────────────────────────────────────────

interface PlaylistTileProps {
    playlist: UserPlaylist;
    active: boolean;
    onTap: () => void;
    onLongPress: () => void;
}

/** Hold this long for the tap to register as a long-press. Matches
 *  iOS's default long-press recognition window so it feels native. */
const LONG_PRESS_MS = 500;

const PlaylistTile: React.FC<PlaylistTileProps> = ({ playlist, active, onTap, onLongPress }) => {
    // Track whether the remote artwork URL fails to load. Apple Music's
    // user-library artwork URLs sometimes need credentials WKWebView
    // can't supply, or the CDN host blocks the cross-origin fetch from
    // capacitor://localhost — in either case the <img> renders blank.
    // When that happens we swap to the generated mesh-gradient cover.
    const [imageFailed, setImageFailed] = useState(false);
    const [pressing, setPressing] = useState(false);
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
            onLongPress();
        }, LONG_PRESS_MS);
    }, [onLongPress]);

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
        onTap();
    }, [onTap]);

    return (
        <button
            onClick={handleClick}
            onTouchStart={startPress}
            onTouchEnd={cancelPress}
            onTouchMove={cancelPress}
            onTouchCancel={cancelPress}
            onMouseDown={startPress}
            onMouseUp={cancelPress}
            onMouseLeave={cancelPress}
            className={`relative aspect-square rounded-2xl overflow-hidden border transition-all ${
                pressing ? 'scale-[0.94]' : 'active:scale-[0.97]'
            } ${active ? 'border-pink-400/60 ring-2 ring-pink-400/40' : 'border-white/10 hover:border-white/30'}`}
        >
            {showRemote ? (
                <img
                    src={playlist.artworkUrl}
                    alt={playlist.name}
                    className="w-full h-full object-cover"
                    loading="lazy"
                    onError={() => setImageFailed(true)}
                />
            ) : (
                <GeneratedPlaylistArtwork name={playlist.name} previewTracks={playlist.previewTracks} />
            )}
            {/* Title overlay */}
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/60 to-transparent p-3 pt-8">
                <div className="text-white font-bold text-sm truncate text-left">{playlist.name}</div>
                {playlist.curator && (
                    <div className="text-white/60 text-xs truncate text-left mt-0.5">{playlist.curator}</div>
                )}
            </div>
        </button>
    );
};

// ── Playlist detail sheet — long-press → bottom sheet w/ tracks ────

interface PlaylistDetailSheetProps {
    playlist: UserPlaylist;
    tracks: PlaylistTrack[];
    loading: boolean;
    error: string | null;
    onClose: () => void;
    onPlayAll: () => void;
    onPlayTrack: (trackId: string) => void;
    onAddTracks: () => void;
    onDelete: () => void;
}

const PlaylistDetailSheet: React.FC<PlaylistDetailSheetProps> = ({
    playlist,
    tracks,
    loading,
    error,
    onClose,
    onPlayAll,
    onPlayTrack,
    onAddTracks,
    onDelete,
}) => {
    const [imageFailed, setImageFailed] = useState(false);
    const [mounted, setMounted] = useState(false);
    // Trigger the slide-up animation by toggling `mounted` on next
    // frame after mount. Without rAF the initial render and the
    // animated state would batch into the same paint.
    useEffect(() => {
        const id = requestAnimationFrame(() => setMounted(true));
        return () => cancelAnimationFrame(id);
    }, []);

    const showRemote = !!playlist.artworkUrl && !imageFailed;

    return (
        <div
            className="fixed inset-0 z-50 flex flex-col"
            // Pad the bottom by the global bottom-nav height + safe area
            // so the sheet's bottom edge lands above the nav. Without
            // this, mt-auto pins the sheet to the screen bottom and
            // the nav (z-[900]) renders ON TOP of the sheet's action
            // buttons — invisible action buttons for empty playlists.
            style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom))' }}
        >
            {/* Backdrop — absolute inset-0 so it still covers the
             *  full viewport (including the padding zone behind the nav). */}
            <button
                aria-label="Close playlist details"
                onClick={onClose}
                className={`absolute inset-0 bg-black/70 backdrop-blur-md transition-opacity duration-300 ${
                    mounted ? 'opacity-100' : 'opacity-0'
                }`}
            />
            {/* Sheet — min-h-[55vh] gives empty playlists visual
             *  presence (Play + Add tracks land mid-screen instead of
             *  squashed at the bottom). max-h respects the nav-clear
             *  padding above. */}
            <div
                className={`relative mt-auto bg-gradient-to-b from-slate-900 via-slate-950 to-black rounded-t-3xl border-t border-white/10 flex flex-col shadow-2xl transition-transform duration-300 ease-out ${
                    mounted ? 'translate-y-0' : 'translate-y-full'
                }`}
                style={{
                    minHeight: '55vh',
                    maxHeight: 'calc(92vh - 4rem - env(safe-area-inset-bottom))',
                }}
            >
                {/* Drag handle */}
                <div className="flex justify-center pt-3 pb-1">
                    <div className="w-12 h-1.5 rounded-full bg-white/25" />
                </div>

                {/* Hero */}
                <div className="flex items-center gap-4 px-5 py-4">
                    <div className="w-20 h-20 rounded-xl overflow-hidden shrink-0 shadow-lg ring-1 ring-white/10">
                        {showRemote ? (
                            <img
                                src={playlist.artworkUrl}
                                alt=""
                                className="w-full h-full object-cover"
                                onError={() => setImageFailed(true)}
                            />
                        ) : (
                            <GeneratedPlaylistArtwork name={playlist.name} />
                        )}
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="text-white font-bold text-lg truncate leading-tight">{playlist.name}</div>
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
                        className="w-full py-3 rounded-2xl bg-white text-black font-bold flex items-center justify-center gap-2 active:scale-[0.97] transition-transform disabled:opacity-40 disabled:active:scale-100"
                    >
                        <PlayIcon className="w-4 h-4" />
                        <span>Play</span>
                    </button>
                    <button
                        onClick={onAddTracks}
                        className="w-full py-3 rounded-2xl bg-pink-500/15 border border-pink-400/40 text-pink-300 font-bold flex items-center justify-center gap-2 active:scale-[0.97] transition-transform"
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

                {/* Track list */}
                <div className="flex-1 overflow-y-auto px-3 pb-8">
                    {loading && (
                        <div className="flex flex-col items-center justify-center py-12 text-white/40 text-sm gap-2">
                            <div className="w-6 h-6 rounded-full border-2 border-white/20 border-t-pink-400 animate-spin" />
                            Loading tracks…
                        </div>
                    )}
                    {!loading &&
                        tracks.map((track, i) => (
                            <button
                                key={track.id}
                                onClick={() => onPlayTrack(track.id)}
                                className="w-full flex items-center gap-3 px-2 py-2.5 rounded-xl active:bg-white/10 transition-colors text-left"
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
                    {/* Delete this playlist — destructive action,
                     *  intentionally subtle and at the bottom so it's
                     *  not an easy mis-tap. */}
                    {!loading && (
                        <div className="pt-6 pb-2 flex justify-center">
                            <button
                                onClick={onDelete}
                                className="text-red-400/80 hover:text-red-300 active:text-red-200 text-xs font-medium px-4 py-2 rounded-lg active:bg-red-500/10 transition-colors"
                            >
                                Delete this playlist
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

// ── Add tracks sheet — catalog search → tap to add ────────────────

interface AddTracksSheetProps {
    playlistName: string;
    onClose: () => void;
    /** Try to add a song. Returns one of:
     *    "added"    — direct add succeeded
     *    "redirect" — Apple doesn't allow it; the parent already
     *                 opened the song in Apple Music app for manual add
     *    "failed"   — generic failure
     *
     * Full song object is passed (not just id) so the parent can do
     * an optimistic UI append without re-fetching the catalog. */
    onAddSong: (song: CatalogSongResult) => Promise<'added' | 'redirect' | 'failed'>;
}

const AddTracksSheet: React.FC<AddTracksSheetProps> = ({ playlistName, onClose, onAddSong }) => {
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
    const inputRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        const id = requestAnimationFrame(() => setMounted(true));
        const focusId = setTimeout(() => inputRef.current?.focus(), 250);
        return () => {
            cancelAnimationFrame(id);
            clearTimeout(focusId);
        };
    }, []);

    // Track keyboard for the search input — same pattern as the
    // create-playlist sheet so the input doesn't slide behind the
    // keyboard.
    const [keyboardHeight, setKeyboardHeight] = useState(0);
    useEffect(() => {
        let showHandle: { remove: () => Promise<void> } | undefined;
        let hideHandle: { remove: () => Promise<void> } | undefined;
        let cancelled = false;
        void (async () => {
            try {
                const { Keyboard } = await import('@capacitor/keyboard');
                if (cancelled) return;
                showHandle = await Keyboard.addListener('keyboardWillShow', (info) => {
                    setKeyboardHeight(info.keyboardHeight);
                });
                hideHandle = await Keyboard.addListener('keyboardWillHide', () => {
                    setKeyboardHeight(0);
                });
            } catch {
                /* keyboard plugin unavailable */
            }
        })();
        return () => {
            cancelled = true;
            void showHandle?.remove().catch(() => undefined);
            void hideHandle?.remove().catch(() => undefined);
        };
    }, []);

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
        <div
            className="fixed inset-0 z-[55] flex flex-col"
            style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom))' }}
        >
            <button
                aria-label="Close add tracks"
                onClick={onClose}
                className={`absolute inset-0 bg-black/80 backdrop-blur-md transition-opacity duration-300 ${
                    mounted ? 'opacity-100' : 'opacity-0'
                }`}
            />
            <div
                className={`relative mt-auto bg-gradient-to-b from-slate-900 via-slate-950 to-black rounded-t-3xl border-t border-white/10 flex flex-col shadow-2xl transition-transform duration-300 ease-out ${
                    mounted ? 'translate-y-0' : 'translate-y-full'
                }`}
                style={{
                    // Lift the entire sheet above the keyboard. Bottom
                    // sheets need full keyboard-height translation
                    // (centred modals only need half — different math).
                    // Also clamp max-h when the keyboard is up so the
                    // sheet doesn't render with its top edge above the
                    // viewport — the inner scroll handles overflow but
                    // the user can't scroll into off-screen space.
                    transform:
                        keyboardHeight > 0
                            ? `translateY(-${keyboardHeight}px)`
                            : mounted
                              ? 'translateY(0)'
                              : 'translateY(100%)',
                    minHeight: '55vh',
                    maxHeight:
                        keyboardHeight > 0
                            ? `calc(100vh - ${keyboardHeight}px - 2rem)`
                            : 'calc(92vh - 4rem - env(safe-area-inset-bottom))',
                }}
            >
                {/* Drag handle */}
                <div className="flex justify-center pt-3 pb-1">
                    <div className="w-12 h-1.5 rounded-full bg-white/25" />
                </div>

                {/* Header — back button + title */}
                <div className="flex items-center gap-3 px-5 pt-1 pb-3">
                    <button
                        onClick={onClose}
                        className="w-9 h-9 -ml-2 rounded-full flex items-center justify-center text-white/80 active:bg-white/10 transition-colors shrink-0"
                        aria-label="Back to playlist"
                    >
                        <ChevronLeftIcon className="w-6 h-6" />
                    </button>
                    <div className="flex-1 min-w-0">
                        <div className="text-white font-bold text-lg leading-tight">Add tracks</div>
                        <div className="text-white/50 text-xs mt-0.5 truncate">to "{playlistName}"</div>
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
                        className="flex-1 bg-white/5 border border-white/15 rounded-xl px-4 py-3 text-white placeholder:text-white/30 text-sm focus:border-pink-400/60 focus:outline-none focus:bg-white/10 transition-colors"
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') void handleSearch();
                        }}
                    />
                    <button
                        onClick={() => void handleSearch()}
                        disabled={searching || !query.trim()}
                        className="px-4 py-3 rounded-xl bg-pink-500/15 border border-pink-400/40 text-pink-300 font-bold text-sm active:scale-[0.97] transition-transform disabled:opacity-40 disabled:active:scale-100"
                    >
                        {searching ? '…' : 'Search'}
                    </button>
                </div>

                {searchError && (
                    <div className="mx-5 mb-2 px-3 py-2 rounded-lg bg-amber-500/15 border border-amber-400/30 text-amber-300 text-xs">
                        {searchError}
                    </div>
                )}

                {/* Results list */}
                <div className="flex-1 overflow-y-auto px-3 pb-8">
                    {results.length === 0 && !searching && !searchError && (
                        <div className="text-center text-white/40 text-sm py-12 px-6">
                            Search Apple Music's catalog and tap a result to add it to{' '}
                            <span className="text-white/60">"{playlistName}"</span>.
                        </div>
                    )}
                    {showRedirectExplain && (
                        <div className="mx-2 mb-3 px-3 py-2.5 rounded-lg bg-amber-500/10 border border-amber-400/30 text-amber-200 text-xs leading-relaxed">
                            Apple doesn't allow apps to add songs straight into your playlists — only their Music app
                            can. Tapping a song opens it in Apple Music, where you can long-press and pick{' '}
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
    );
};

interface SongResultRowProps {
    song: CatalogSongResult;
    adding: boolean;
    added: boolean;
    redirected: boolean;
    onAdd: () => void;
}

const SongResultRow: React.FC<SongResultRowProps> = ({ song, adding, added, redirected, onAdd }) => {
    const [imageFailed, setImageFailed] = useState(false);
    const showRemote = !!song.artworkUrl && !imageFailed;
    return (
        <button
            onClick={onAdd}
            disabled={adding || added}
            className={`w-full flex items-center gap-3 px-2 py-2 rounded-xl transition-colors text-left ${
                added ? 'bg-emerald-500/10' : redirected ? 'bg-amber-500/10' : 'active:bg-white/10'
            }`}
        >
            <div className="w-10 h-10 rounded-lg overflow-hidden shrink-0 bg-white/5">
                {showRemote ? (
                    <img
                        src={song.artworkUrl}
                        alt=""
                        className="w-full h-full object-cover"
                        onError={() => setImageFailed(true)}
                    />
                ) : (
                    <GeneratedPlaylistArtwork name={song.title} />
                )}
            </div>
            <div className="flex-1 min-w-0">
                <div className="text-white text-sm font-medium truncate">{song.title}</div>
                <div className="text-white/50 text-xs truncate mt-0.5">
                    {song.artist}
                    {song.album ? ` · ${song.album}` : ''}
                </div>
            </div>
            <div className="w-8 h-8 flex items-center justify-center shrink-0">
                {adding ? (
                    <div className="w-4 h-4 rounded-full border-2 border-white/20 border-t-pink-400 animate-spin" />
                ) : added ? (
                    <CheckIcon className="w-5 h-5 text-emerald-400" />
                ) : redirected ? (
                    <ExternalLinkIcon className="w-5 h-5 text-amber-300" />
                ) : (
                    <PlusIcon className="w-5 h-5 text-pink-300" />
                )}
            </div>
        </button>
    );
};

// ── Delete-playlist confirmation ──────────────────────────────────

interface DeleteConfirmSheetProps {
    playlistName: string;
    busy: boolean;
    onCancel: () => void;
    onConfirm: () => void;
}

const DeleteConfirmSheet: React.FC<DeleteConfirmSheetProps> = ({ playlistName, busy, onCancel, onConfirm }) => {
    const [mounted, setMounted] = useState(false);
    useEffect(() => {
        const id = requestAnimationFrame(() => setMounted(true));
        return () => cancelAnimationFrame(id);
    }, []);
    return (
        <div className="fixed inset-0 z-[70]">
            <button
                aria-label="Cancel delete"
                onClick={onCancel}
                className={`absolute inset-0 bg-black/70 backdrop-blur-md transition-opacity duration-300 ${
                    mounted ? 'opacity-100' : 'opacity-0'
                }`}
            />
            <div className="absolute inset-0 flex items-center justify-center px-4 pointer-events-none">
                <div
                    className={`relative w-full max-w-sm bg-gradient-to-b from-slate-900 via-slate-950 to-black rounded-3xl border border-white/10 shadow-2xl transition-all duration-300 ease-out pointer-events-auto ${
                        mounted ? 'opacity-100 scale-100' : 'opacity-0 scale-95'
                    }`}
                >
                    <div className="px-5 pt-5 pb-5">
                        <div className="text-white font-bold text-lg">Delete in Apple Music</div>
                        <div className="text-white/60 text-sm mt-2 leading-relaxed">
                            Apple doesn't let third-party apps delete library playlists — only their own Music app can.
                            Tap below and we'll open it for you so you can remove "{playlistName}".
                        </div>
                        <div className="flex gap-2 mt-6">
                            <button
                                onClick={onCancel}
                                disabled={busy}
                                className="flex-1 py-3 rounded-2xl border border-white/15 text-white/70 font-bold active:scale-[0.97] transition-transform disabled:opacity-40"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={onConfirm}
                                disabled={busy}
                                className="flex-1 py-3 rounded-2xl bg-pink-500 text-white font-bold flex items-center justify-center gap-2 active:scale-[0.97] transition-transform disabled:opacity-40 disabled:active:scale-100"
                            >
                                {busy ? (
                                    <div className="w-4 h-4 rounded-full border-2 border-white/40 border-t-white animate-spin" />
                                ) : (
                                    <span>Open Apple Music</span>
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

// ── Create playlist sheet ──────────────────────────────────────────

interface CreatePlaylistSheetProps {
    busy: boolean;
    error: string | null;
    onClose: () => void;
    onSubmit: (name: string, description: string) => void;
}

const CreatePlaylistSheet: React.FC<CreatePlaylistSheetProps> = ({ busy, error, onClose, onSubmit }) => {
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [mounted, setMounted] = useState(false);
    const inputRef = useRef<HTMLInputElement | null>(null);
    useEffect(() => {
        const id = requestAnimationFrame(() => setMounted(true));
        // Auto-focus the name field on mount
        const focusId = setTimeout(() => inputRef.current?.focus(), 250);
        return () => {
            cancelAnimationFrame(id);
            clearTimeout(focusId);
        };
    }, []);

    const canSubmit = name.trim().length > 0 && !busy;

    // Track the iOS keyboard height so we can shift the modal upward
    // when the keyboard rises and would otherwise cover the inputs.
    // @capacitor/keyboard fires keyboardWillShow / keyboardWillHide
    // with the keyboard's height and animation duration; we pull
    // both into local state and translate the modal accordingly.
    const [keyboardHeight, setKeyboardHeight] = useState(0);
    useEffect(() => {
        let showHandle: { remove: () => Promise<void> } | undefined;
        let hideHandle: { remove: () => Promise<void> } | undefined;
        let cancelled = false;
        void (async () => {
            try {
                const { Keyboard } = await import('@capacitor/keyboard');
                if (cancelled) return;
                showHandle = await Keyboard.addListener('keyboardWillShow', (info) => {
                    setKeyboardHeight(info.keyboardHeight);
                });
                hideHandle = await Keyboard.addListener('keyboardWillHide', () => {
                    setKeyboardHeight(0);
                });
            } catch {
                /* keyboard plugin not available — modal remains static */
            }
        })();
        return () => {
            cancelled = true;
            void showHandle?.remove().catch(() => undefined);
            void hideHandle?.remove().catch(() => undefined);
        };
    }, []);

    return (
        <div className="fixed inset-0 z-[60]">
            <button
                aria-label="Close create playlist"
                onClick={onClose}
                className={`absolute inset-0 bg-black/70 backdrop-blur-md transition-opacity duration-300 ${
                    mounted ? 'opacity-100' : 'opacity-0'
                }`}
            />
            {/* Centered card. When the keyboard rises we shift the
             *  whole card up by half the keyboard height (the card
             *  itself is centred, so half the keyboard's height is
             *  exactly enough to keep the inputs in view without
             *  overshooting). */}
            <div
                className="absolute inset-0 flex items-center justify-center px-4 transition-transform duration-200 ease-out pointer-events-none"
                style={{
                    transform:
                        keyboardHeight > 0 ? `translateY(-${Math.round(keyboardHeight / 2)}px)` : 'translateY(0)',
                }}
            >
                <div
                    className={`relative w-full max-w-sm bg-gradient-to-b from-slate-900 via-slate-950 to-black rounded-3xl border border-white/10 shadow-2xl transition-all duration-300 ease-out pointer-events-auto ${
                        mounted ? 'opacity-100 scale-100' : 'opacity-0 scale-95'
                    }`}
                >
                    <div className="px-5 pt-5 pb-5">
                        <div className="text-white font-bold text-lg">New playlist</div>
                        <div className="text-white/50 text-xs mt-1">
                            Give it a name. You can ask Calypso to "save this to my [name]" while a track is playing to
                            add songs.
                        </div>

                        <label className="block mt-5">
                            <div className="text-[10px] uppercase tracking-widest text-white/40 mb-1.5">Name</div>
                            <input
                                ref={inputRef}
                                type="text"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="Sundowner mix"
                                disabled={busy}
                                maxLength={80}
                                className="w-full bg-white/5 border border-white/15 rounded-xl px-4 py-3 text-white placeholder:text-white/30 text-sm focus:border-pink-400/60 focus:outline-none focus:bg-white/10 transition-colors"
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' && canSubmit) {
                                        onSubmit(name, description);
                                    }
                                }}
                            />
                        </label>

                        <label className="block mt-4">
                            <div className="text-[10px] uppercase tracking-widest text-white/40 mb-1.5">
                                Description (optional)
                            </div>
                            <input
                                type="text"
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                placeholder="What's this playlist for?"
                                disabled={busy}
                                maxLength={140}
                                className="w-full bg-white/5 border border-white/15 rounded-xl px-4 py-3 text-white placeholder:text-white/30 text-sm focus:border-pink-400/60 focus:outline-none focus:bg-white/10 transition-colors"
                            />
                        </label>

                        {error && (
                            <div className="mt-4 px-3 py-2 rounded-lg bg-amber-500/15 border border-amber-400/30 text-amber-300 text-xs">
                                {error}
                            </div>
                        )}

                        <div className="flex gap-2 mt-6">
                            <button
                                onClick={onClose}
                                disabled={busy}
                                className="flex-1 py-3 rounded-2xl border border-white/15 text-white/70 font-bold active:scale-[0.97] transition-transform disabled:opacity-40"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={() => onSubmit(name, description)}
                                disabled={!canSubmit}
                                className="flex-1 py-3 rounded-2xl bg-pink-500 text-white font-bold flex items-center justify-center gap-2 active:scale-[0.97] transition-transform disabled:opacity-40 disabled:active:scale-100"
                            >
                                {busy ? (
                                    <div className="w-4 h-4 rounded-full border-2 border-white/40 border-t-white animate-spin" />
                                ) : (
                                    <span>Create</span>
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

/** Format a millisecond duration as "m:ss" — e.g. 184_000 → "3:04". */
function formatDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return '—';
    const total = Math.round(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

// ── Generated playlist artwork ─────────────────────────────────────
//
// When a user-made playlist has no curator-assigned cover, MusicKit
// returns a null artwork URL and we used to drop a sad pink/purple
// gradient + music-note in there. This generator produces something
// closer to Apple Music's quality: a three-blob radial mesh gradient
// in a palette deterministically picked from a hash of the playlist
// name, a subtle horizon wave at the bottom (the Thalassa nod), and
// a serif initial overlaid in the centre.
//
// Deterministic = the same playlist always renders the same artwork
// across sessions, and the 2-col grid stays visually varied because
// adjacent playlists hash to different palettes.

/** 10 marine + sunset palettes — every playlist hashes to one. */
const PLAYLIST_PALETTES: ReadonlyArray<{ a: string; b: string; c: string; bg: string }> = [
    { a: '#ff6b9d', b: '#c44dd6', c: '#5a3aa3', bg: '#1e1b4b' }, // pink dusk
    { a: '#06b6d4', b: '#3b82f6', c: '#1e3a8a', bg: '#0c1f3f' }, // deep ocean
    { a: '#fbbf24', b: '#f97316', c: '#9a3412', bg: '#3b1d12' }, // sunset
    { a: '#10b981', b: '#0ea5e9', c: '#1e3a8a', bg: '#0a2540' }, // tropic reef
    { a: '#a855f7', b: '#7c3aed', c: '#1e1b4b', bg: '#171232' }, // violet night
    { a: '#f43f5e', b: '#a855f7', c: '#3730a3', bg: '#1f1240' }, // rose horizon
    { a: '#14b8a6', b: '#0891b2', c: '#0c4a6e', bg: '#082f49' }, // lagoon
    { a: '#f87171', b: '#fb7185', c: '#9f1239', bg: '#3f0a1f' }, // hibiscus
    { a: '#fde68a', b: '#fb923c', c: '#7c2d12', bg: '#3a1a0c' }, // golden hour
    { a: '#67e8f9', b: '#0ea5e9', c: '#1e1b4b', bg: '#0c1530' }, // moonlit bay
];

function paletteFor(name: string): (typeof PLAYLIST_PALETTES)[number] {
    let h = 0;
    for (let i = 0; i < name.length; i++) {
        h = (h * 31 + name.charCodeAt(i)) | 0;
    }
    return PLAYLIST_PALETTES[Math.abs(h) % PLAYLIST_PALETTES.length];
}

/**
 * Pick a 1-2 character monogram from the playlist name. Single short
 * names get two letters ("XO" → "XO"), longer names get the first
 * letter of the first significant word. Articles ("the", "a", "my")
 * get skipped so "My Sunset Mix" → "S".
 */
function monogramFor(name: string): string {
    const trimmed = (name || '').trim();
    if (!trimmed) return '♪';
    const words = trimmed.split(/\s+/);
    const skip = new Set(['the', 'a', 'an', 'my', 'our']);
    const first = words.find((w) => !skip.has(w.toLowerCase())) ?? words[0];
    if (words.length === 1 && first.length <= 3) return first.toUpperCase();
    return first.charAt(0).toUpperCase();
}

const GeneratedPlaylistArtwork: React.FC<{
    name: string;
    /** First few tracks to preview on the cover. When provided we
     *  render a song list instead of the serif monogram — gives the
     *  skipper a peek at what's inside without opening the playlist.
     *  Empty / undefined falls back to the monogram (e.g. now-playing
     *  thumbnail where the list wouldn't fit anyway). */
    previewTracks?: PlaylistTrackPreview[];
}> = ({ name, previewTracks }) => {
    const palette = paletteFor(name);
    const tracks = previewTracks ?? [];
    const showList = tracks.length > 0;
    const monogram = monogramFor(name);
    return (
        <div
            className="w-full h-full relative overflow-hidden"
            style={{
                background: `
                    radial-gradient(at 22% 18%, ${palette.a} 0%, transparent 55%),
                    radial-gradient(at 82% 28%, ${palette.b} 0%, transparent 50%),
                    radial-gradient(at 48% 88%, ${palette.c} 0%, transparent 55%),
                    ${palette.bg}
                `,
            }}
        >
            {/* Bright bloom — adds a touch of polish */}
            <div
                className="absolute -top-8 -right-8 w-28 h-28 rounded-full opacity-50 blur-2xl pointer-events-none"
                style={{ background: palette.a }}
            />
            {/* Horizon wave — Thalassa's marine signature, very subtle */}
            <svg
                className="absolute bottom-0 left-0 w-full pointer-events-none"
                viewBox="0 0 200 60"
                preserveAspectRatio="none"
                aria-hidden="true"
            >
                <path d="M0,30 Q50,12 100,30 T200,30 L200,60 L0,60 Z" fill="white" opacity="0.06" />
                <path d="M0,40 Q50,22 100,40 T200,40 L200,60 L0,60 Z" fill="white" opacity="0.05" />
            </svg>
            {showList ? (
                /* Track list — title flush left, artist indented underneath.
                 * Sits in the upper portion of the tile; the bottom title
                 * overlay (rendered by the caller) hides anything that
                 * runs past the safe zone, so we don't need to clip
                 * exactly N tracks — just enough to fill comfortably. */
                <div className="absolute inset-x-2.5 top-2.5 bottom-14 overflow-hidden pointer-events-none">
                    <div className="space-y-1.5">
                        {tracks.slice(0, 4).map((t, i) => (
                            <div key={i} className="leading-tight">
                                <div
                                    className="text-white text-[10.5px] font-semibold truncate"
                                    style={{ textShadow: '0 1px 4px rgba(0,0,0,0.35)' }}
                                >
                                    {t.title}
                                </div>
                                {t.artist && (
                                    <div className="text-white/65 text-[9px] truncate pl-2.5 mt-0.5">{t.artist}</div>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            ) : (
                /* Empty playlist — fall back to the serif monogram. */
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div
                        className="text-white/80 leading-none select-none"
                        style={{
                            fontFamily: 'Georgia, "Times New Roman", serif',
                            fontWeight: 600,
                            fontSize: monogram.length > 1 ? '3.75rem' : '4.5rem',
                            textShadow: '0 4px 16px rgba(0,0,0,0.35)',
                            letterSpacing: monogram.length > 1 ? '-0.02em' : '0',
                        }}
                    >
                        {monogram}
                    </div>
                </div>
            )}
        </div>
    );
};

// ── Now playing bar ────────────────────────────────────────────────

interface NowPlayingBarProps {
    nowPlaying: NowPlaying;
    onPause: () => void;
    onResume: () => void;
    onNext: () => void;
    onPrevious: () => void;
}

const NowPlayingBar: React.FC<NowPlayingBarProps> = ({ nowPlaying, onPause, onResume, onNext, onPrevious }) => {
    const [imageFailed, setImageFailed] = useState(false);
    const showRemote = !!nowPlaying.artworkUrl && !imageFailed;
    // Reset the failure flag whenever the track changes — different
    // artwork URLs deserve fresh load attempts.
    const trackKey = nowPlaying.artworkUrl ?? '';
    useEffect(() => {
        setImageFailed(false);
    }, [trackKey]);
    return (
        <div className="p-3">
            <div className="flex items-center gap-3">
                {showRemote ? (
                    <img
                        src={nowPlaying.artworkUrl}
                        alt=""
                        className="w-12 h-12 rounded-lg object-cover shrink-0"
                        onError={() => setImageFailed(true)}
                    />
                ) : (
                    <div className="w-12 h-12 rounded-lg overflow-hidden shrink-0">
                        <GeneratedPlaylistArtwork name={nowPlaying.title || nowPlaying.album || 'Music'} />
                    </div>
                )}
                <div className="flex-1 min-w-0">
                    <div className="text-white font-bold text-sm truncate">{nowPlaying.title}</div>
                    {nowPlaying.artist && (
                        <div className="text-white/60 text-xs truncate mt-0.5">{nowPlaying.artist}</div>
                    )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                    <button
                        onClick={onPrevious}
                        className="w-9 h-9 rounded-full flex items-center justify-center text-white/70 hover:bg-white/10 active:scale-90 transition-all"
                        aria-label="Previous"
                    >
                        <SkipPrevIcon className="w-5 h-5" />
                    </button>
                    {nowPlaying.isPlaying ? (
                        <button
                            onClick={onPause}
                            className="w-11 h-11 rounded-full bg-white text-black flex items-center justify-center active:scale-90 transition-transform"
                            aria-label="Pause"
                        >
                            <PauseIcon className="w-5 h-5" />
                        </button>
                    ) : (
                        <button
                            onClick={onResume}
                            className="w-11 h-11 rounded-full bg-white text-black flex items-center justify-center active:scale-90 transition-transform"
                            aria-label="Play"
                        >
                            <PlayIcon className="w-5 h-5 ml-0.5" />
                        </button>
                    )}
                    <button
                        onClick={onNext}
                        className="w-9 h-9 rounded-full flex items-center justify-center text-white/70 hover:bg-white/10 active:scale-90 transition-all"
                        aria-label="Next"
                    >
                        <SkipNextIcon className="w-5 h-5" />
                    </button>
                </div>
            </div>
        </div>
    );
};

// ── Icons (inline SVG, no external dep) ────────────────────────────

const MusicIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
        <path d="M9 17.5a2.5 2.5 0 0 1-2.5 2.5A2.5 2.5 0 0 1 4 17.5 2.5 2.5 0 0 1 6.5 15c.34 0 .67.07.97.18V6L20 4v11.5a2.5 2.5 0 0 1-2.5 2.5 2.5 2.5 0 0 1-2.5-2.5 2.5 2.5 0 0 1 2.5-2.5c.34 0 .67.07.97.18V7.79L9 9.5v8z" />
    </svg>
);

const PlayIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
        <path d="M8 5v14l11-7z" />
    </svg>
);

const PauseIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
        <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
    </svg>
);

const SkipNextIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
        <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
    </svg>
);

const SkipPrevIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
        <path d="M6 6h2v12H6V6zm3.5 6L18 6v12l-8.5-6z" />
    </svg>
);

const PlusIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg
        className={className}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
    >
        <path d="M12 5v14M5 12h14" />
    </svg>
);

const CheckIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg
        className={className}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
    >
        <path d="M20 6L9 17l-5-5" />
    </svg>
);

const ExternalLinkIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg
        className={className}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
    >
        <path d="M7 17L17 7M9 7h8v8" />
    </svg>
);

const ChevronLeftIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg
        className={className}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
    >
        <path d="M15 18l-6-6 6-6" />
    </svg>
);
