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
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { PageHeader } from '../ui/PageHeader';
import { OverlayPortal } from '../ui/OverlayPortal';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useKeyboardOffset } from '../../hooks/useKeyboardOffset';
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
    getAudioRoute,
    showRoutePicker,
} from '../../services/voice/integrations/appleMusic';
import { triggerHaptic } from '../../utils/system';
import { markMusicEngaged } from '../../services/musicEngagement';
import { SafeImage } from '../ui/SafeImage';

interface MusicPageProps {
    onBack: () => void;
}

interface PlaylistPreviewJob {
    playlist: UserPlaylist;
    generation: number;
}

const MAX_CONCURRENT_PLAYLIST_PREVIEWS = 2;

export const MusicPage: React.FC<MusicPageProps> = ({ onBack }) => {
    // Flag the session as "music engaged" the moment this page
    // mounts. GlobalNowPlayingBar gates ALL its polling on this
    // flag, so before the user has shown intent to use music, the
    // app makes zero AppleMusic bridge calls. Idempotent.
    useEffect(() => {
        markMusicEngaged();
    }, []);

    const [authGranted, setAuthGranted] = useState<boolean | null>(null);
    const [authStatus, setAuthStatus] = useState<string>('');
    const [playlists, setPlaylists] = useState<UserPlaylist[]>([]);
    const [loadingPlaylists, setLoadingPlaylists] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [activePlaylistId, setActivePlaylistId] = useState<string | null>(null);
    const [nowPlaying, setNowPlaying] = useState<NowPlaying | null>(null);
    // WHICH speaker is playing. iOS exposes no way to list available outputs
    // (there is no `availableOutputs` to match `availableInputs` — Apple keeps
    // that list for the system picker), so the honest surface is: show the
    // current route, and let the picker do the choosing.
    const [speaker, setSpeaker] = useState<{ name: string; icon: string } | null>(null);
    // Every library refresh has a generation. Both metadata and preview
    // responses must still be current before they are allowed to repaint
    // the UI; MusicKit calls cannot be cancelled once they cross the bridge.
    const playlistPreviewGenerationRef = useRef(0);
    // A single queue for the component keeps MusicKit hydration capped at
    // two calls even when the skipper refreshes while an earlier preview
    // batch is still in flight.
    const playlistPreviewQueueRef = useRef<PlaylistPreviewJob[]>([]);
    const activePlaylistPreviewCountRef = useRef(0);
    // Apple Music can take a few seconds to sync a newly created
    // playlist into the next MusicLibraryRequest. Keep the confirmed
    // creation visible until the native library catches up.
    const pendingCreatedPlaylistsRef = useRef(new Map<string, UserPlaylist>());
    /** Create-playlist modal: open state + busy flag for the submit. */
    const [createOpen, setCreateOpen] = useState(false);
    const [createBusy, setCreateBusy] = useState(false);
    const [createError, setCreateError] = useState<string | null>(null);

    const drainPlaylistPreviewQueueRef = useRef<() => void>(() => undefined);
    const drainPlaylistPreviewQueue = useCallback(() => {
        while (
            activePlaylistPreviewCountRef.current < MAX_CONCURRENT_PLAYLIST_PREVIEWS &&
            playlistPreviewQueueRef.current.length > 0
        ) {
            const job = playlistPreviewQueueRef.current.shift();
            if (!job || job.generation !== playlistPreviewGenerationRef.current) continue;

            activePlaylistPreviewCountRef.current += 1;
            void getPlaylistTracks(job.playlist.id)
                .then((detail) => {
                    if (!detail.available || job.generation !== playlistPreviewGenerationRef.current) return;
                    const preview = detail.tracks.slice(0, 5).map((track) => ({
                        title: track.title,
                        artist: track.artist,
                    }));
                    setPlaylists((previous) =>
                        previous.map((current) =>
                            current.id === job.playlist.id ? { ...current, previewTracks: preview } : current,
                        ),
                    );
                })
                .catch(() => {
                    /* Per-playlist preview failure → tile keeps its monogram. */
                })
                .finally(() => {
                    activePlaylistPreviewCountRef.current = Math.max(0, activePlaylistPreviewCountRef.current - 1);
                    drainPlaylistPreviewQueueRef.current();
                });
        }
    }, []);
    drainPlaylistPreviewQueueRef.current = drainPlaylistPreviewQueue;

    // Invalidate every in-flight callback after unmount. The calls themselves
    // may complete later, but cannot set state on a page that no longer exists.
    useEffect(() => {
        return () => {
            playlistPreviewGenerationRef.current += 1;
            playlistPreviewQueueRef.current = [];
        };
    }, []);

    /** Load playlists. Triggered after auth + on manual refresh.
     *
     * Two-phase load to avoid the hang we hit when hydrating every
     * playlist's track list in parallel inside the Swift plugin
     * (MusicKit can't handle N concurrent .with([.tracks]) calls
     * cleanly on a real library):
     *   Phase 1: fetch playlist metadata only — fast, gets the grid up
     *   Phase 2: load track previews in a tiny, bounded background queue
     *           and merge each preview into its tile as it arrives.
     *           MusicKit library hydration is fragile on real-world
     *           libraries; a burst of concurrent requests can wedge the
     *           bridge. Two at a time keeps the grid responsive without
     *           reopening that failure mode.
     */
    const loadPlaylists = useCallback(async () => {
        const generation = ++playlistPreviewGenerationRef.current;
        // A newer refresh supersedes every preview that has not crossed the
        // native bridge yet. In-flight calls finish naturally and the shared
        // drain starts current work only when a slot becomes free.
        playlistPreviewQueueRef.current = [];
        setLoadingPlaylists(true);
        setLoadError(null);
        try {
            const r = await getUserPlaylists();
            if (generation !== playlistPreviewGenerationRef.current) return;
            if (!r.available) {
                setLoadError(r.reason ?? 'unknown');
                setPlaylists([]);
                return;
            }
            const returnedIds = new Set(r.playlists.map((playlist) => playlist.id));
            for (const id of returnedIds) {
                pendingCreatedPlaylistsRef.current.delete(id);
            }
            const pendingCreates = Array.from(pendingCreatedPlaylistsRef.current.values()).filter(
                (playlist) => !returnedIds.has(playlist.id),
            );
            setPlaylists([...r.playlists, ...pendingCreates]);
            // Background phase: fetch previews through the component-wide
            // queue. The cap applies across refreshes, not just within one
            // response, which protects the native MusicLibrary bridge.
            playlistPreviewQueueRef.current = r.playlists.map((playlist) => ({ playlist, generation }));
            drainPlaylistPreviewQueue();
        } catch (error) {
            if (generation !== playlistPreviewGenerationRef.current) return;
            setLoadError(
                error instanceof Error && error.message ? error.message : 'Could not load Apple Music library.',
            );
        } finally {
            if (generation === playlistPreviewGenerationRef.current) {
                setLoadingPlaylists(false);
            }
        }
    }, [drainPlaylistPreviewQueue]);

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

    /** Poll now-playing adaptively while the page is mounted. iOS
     *  doesn't push state changes back to JS, so we poll — but the
     *  rate shifts with state to keep the bridge quiet when nothing
     *  is happening (Shane bug report 2026-05-17: paused track was
     *  generating ~60 polls/min between this page and the global
     *  bar). Cadence ladder:
     *
     *    playing            →  1 s   (playback time scrubs visibly here,
     *                                  faster than the global bar's 2 s
     *                                  because the user is actively watching)
     *    paused with track  →  5 s   (rare external change via lock screen)
     *    no track queued    → 30 s   (virtually nothing should change)
     *
     *  setTimeout chain (not setInterval) so each tick picks a fresh
     *  delay from the just-fetched state. */
    useEffect(() => {
        let cancelled = false;
        let timer: number | undefined;

        const poll = async () => {
            const np = await getNowPlaying();
            if (cancelled) return;
            setNowPlaying(np);
            const delay = np?.isPlaying ? 1000 : np?.title ? 5000 : 30000;
            timer = window.setTimeout(() => void poll(), delay);
        };
        void poll();

        return () => {
            cancelled = true;
            if (timer !== undefined) window.clearTimeout(timer);
        };
    }, []);

    useEffect(() => {
        let alive = true;
        const read = () => {
            void getAudioRoute().then((route) => {
                if (!alive) return;
                const primary = route?.outputs?.[0];
                if (!primary?.name) {
                    setSpeaker(null);
                    return;
                }
                setSpeaker({
                    name: primary.name,
                    icon: primary.isAirPlay ? '📡' : primary.isBluetooth ? '🔊' : primary.isBuiltIn ? '📱' : '🎚️',
                });
            });
        };
        read();
        // Routes change when a speaker is picked, or when the boat's stereo
        // comes and goes on Bluetooth — neither fires a JS event.
        const timer = setInterval(read, 5_000);
        return () => {
            alive = false;
            clearInterval(timer);
        };
    }, []);

    // ── On deck: the ACTIVE playlist's tracks under the rail ───────
    // Once a playlist is playing, its songs render as a tappable list
    // so the skipper can jump around inside it without opening sheets.
    const [onDeckTracks, setOnDeckTracks] = useState<PlaylistTrack[]>([]);
    const [onDeckLoading, setOnDeckLoading] = useState(false);
    useEffect(() => {
        if (!activePlaylistId) {
            setOnDeckTracks([]);
            return;
        }
        let cancelled = false;
        setOnDeckLoading(true);
        void getPlaylistTracks(activePlaylistId)
            .then((detail) => {
                if (cancelled) return;
                setOnDeckTracks(detail.available ? detail.tracks : []);
            })
            .catch(() => {
                if (!cancelled) setOnDeckTracks([]);
            })
            .finally(() => {
                if (!cancelled) setOnDeckLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [activePlaylistId]);

    /** Refresh nowPlaying immediately, then again ~400 ms later to
     *  catch the artwork after the Swift-side catalog search finishes.
     *  Used right after play/skip actions where the user expects an
     *  instant UI update — waiting for the next 1s tick adds visible
     *  lag. */
    const refreshNowPlayingFast = useCallback(() => {
        void (async () => {
            const np1 = await getNowPlaying();
            setNowPlaying(np1);
            // Second poll catches the resolved artwork URL once the
            // catalog search completes (~200-500 ms).
            setTimeout(() => {
                void (async () => {
                    const np2 = await getNowPlaying();
                    setNowPlaying(np2);
                })();
            }, 400);
        })();
    }, []);

    const handleGrantAccess = useCallback(async () => {
        const r = await requestAuthorization();
        setAuthGranted(r.granted);
        setAuthStatus(r.status);
        if (r.granted) await loadPlaylists();
    }, [loadPlaylists]);

    /** MusicKit's denied/restricted state cannot be fixed by asking for
     * permission again. `app-settings:` is Apple's supported route to this
     * app's Settings page; avoid undocumented App-Prefs deep links, which
     * are unreliable and can create App Review risk. */
    const handleOpenMusicSystemSettings = useCallback(() => {
        try {
            window.location.href = 'app-settings:';
        } catch {
            /* Browser preview only: there is no safe system-settings fallback. */
        }
    }, []);

    const handlePlayPlaylist = useCallback(
        async (id: string) => {
            setLoadError(null);
            try {
                const r = await playPlaylist(id);
                if (r.success) setActivePlaylistId(id);
                else setLoadError(r.error ? `Couldn't play: ${r.error}` : 'Apple Music could not start that playlist.');
            } catch (err) {
                // Hits the JS-side 12s timeout — see services/voice/
                // integrations/appleMusic.ts withTimeout. Most common
                // cause is the audio session being wedged after Calypso
                // TTS; the Swift prepareAudioSession() helper closes
                // that loop, so a retry usually works.
                setLoadError((err as Error).message);
            }
            refreshNowPlayingFast();
        },
        [refreshNowPlayingFast],
    );

    const handlePause = useCallback(async () => {
        try {
            await pauseMusic();
        } catch (err) {
            setLoadError((err as Error).message);
        }
        refreshNowPlayingFast();
    }, [refreshNowPlayingFast]);

    const handleResume = useCallback(async () => {
        try {
            const r = await resumeMusic();
            // resume() returns { status: 'no_queue' } when there's
            // nothing to play (cold-start tap on the play button).
            // Surface a friendly hint instead of doing nothing.
            const parsed = JSON.parse(r.content) as { status?: string };
            if (parsed.status === 'no_queue') {
                setLoadError('Nothing queued — pick a playlist or song to start.');
            }
        } catch (err) {
            setLoadError((err as Error).message);
        }
        refreshNowPlayingFast();
    }, [refreshNowPlayingFast]);

    const handleNext = useCallback(async () => {
        try {
            await skipNext();
        } catch (err) {
            setLoadError((err as Error).message);
        }
        refreshNowPlayingFast();
    }, [refreshNowPlayingFast]);

    const handlePrevious = useCallback(async () => {
        try {
            await skipPrevious();
        } catch (err) {
            setLoadError((err as Error).message);
        }
        refreshNowPlayingFast();
    }, [refreshNowPlayingFast]);

    /** Jump to a specific song inside the ACTIVE playlist (on-deck list). */
    const handlePlayOnDeck = useCallback(
        async (trackId: string) => {
            if (!activePlaylistId) return;
            triggerHaptic('light');
            try {
                await playTrackInPlaylist(activePlaylistId, trackId);
            } catch (err) {
                setLoadError((err as Error).message);
            }
            refreshNowPlayingFast();
        },
        [activePlaylistId, refreshNowPlayingFast],
    );

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
            setDetailError(r.error ? `Couldn't play: ${r.error}` : 'Apple Music could not start this playlist.');
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
                setDetailError(r.error ? `Couldn't play: ${r.error}` : 'Apple Music could not start this track.');
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
                if (r.id) {
                    const createdPlaylist: UserPlaylist = {
                        id: r.id,
                        name: r.name?.trim() || trimmed,
                        curator: '',
                        artworkUrl: '',
                        previewTracks: [],
                    };
                    pendingCreatedPlaylistsRef.current.set(createdPlaylist.id, createdPlaylist);
                    setPlaylists((previous) =>
                        previous.some((playlist) => playlist.id === createdPlaylist.id)
                            ? previous
                            : [...previous, createdPlaylist],
                    );
                }
                // Re-load the grid as well. The pending-create map above
                // prevents iCloud's delayed response from making the new
                // tile disappear in the meantime.
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

    /** Re-fetch the open playlist while preserving recent optimistic
     * additions which Apple Music has not yet echoed back to the app. */
    const refreshDetailTracks = useCallback(async () => {
        if (!detailPlaylist) return;
        const r = await getPlaylistTracks(detailPlaylist.id);
        if (!r.available) return;
        setDetailTracks((prev) => {
            const freshIds = new Set(r.tracks.map((track) => track.id));
            const optimisticOnly = prev.filter((track) => !freshIds.has(track.id));
            return [...r.tracks, ...optimisticOnly];
        });
    }, [detailPlaylist]);

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
        await refreshDetailTracks();
    }, [refreshDetailTracks]);

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
            setDetailError(
                r.error ? `Couldn't delete: ${r.error}` : 'Apple Music could not open this playlist for deletion.',
            );
            setConfirmDelete(null);
        }
    }, [confirmDelete, closeDetail, loadPlaylists]);

    /** Returning from the Apple Music app after a manual add or delete
     * must refresh the library. `visibilitychange` covers the web
     * preview; Capacitor's appStateChange is the reliable signal on an
     * actual iPhone. */
    useEffect(() => {
        let disposed = false;
        let appStateListener: { remove: () => void } | null = null;
        const refreshAfterMusicApp = () => {
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
            void loadPlaylists();
            void refreshDetailTracks();
        };
        const onVisibility = () => {
            if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;
            refreshAfterMusicApp();
        };

        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', onVisibility);
        }
        void import('@capacitor/app')
            .then(({ App }) => App.addListener('appStateChange', ({ isActive }) => isActive && refreshAfterMusicApp()))
            .then((listener) => {
                if (disposed) listener.remove();
                else appStateListener = listener;
            })
            .catch(() => {
                /* Browser build: visibilitychange above remains enough. */
            });

        return () => {
            disposed = true;
            if (typeof document !== 'undefined') {
                document.removeEventListener('visibilitychange', onVisibility);
            }
            appStateListener?.remove();
        };
    }, [loadPlaylists, refreshDetailTracks]);

    const musicAccessNeedsSettings = authStatus === 'denied' || authStatus === 'restricted';

    // ── Scroll-fade mask ───────────────────────────────────────────
    // Content fades to transparent just above the global bottom nav so
    // rows dissolve into the dark instead of sliding under the bar.
    const maskBottomEnd = 'calc(4rem + env(safe-area-inset-bottom))';
    const fadeMask = `linear-gradient(to bottom, black 0, black calc(100% - calc(${maskBottomEnd} + 12px)), transparent calc(100% - ${maskBottomEnd}))`;

    const activePlaylist = activePlaylistId ? (playlists.find((p) => p.id === activePlaylistId) ?? null) : null;

    return (
        <div className="relative flex flex-col h-full overflow-hidden bg-slate-950">
            {/* A restrained deep-water glow keeps this surface tied to the
             * rest of Thalassa without competing with the album artwork. */}
            <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 top-0 h-80 opacity-80"
                style={{
                    background:
                        'radial-gradient(ellipse at 82% -20%, rgba(14, 165, 233, 0.19), transparent 52%), radial-gradient(ellipse at 4% 0%, rgba(2, 132, 199, 0.11), transparent 48%)',
                }}
            />
            <div className="relative flex min-h-0 flex-1 flex-col">
                <PageHeader title="Apple Music" subtitle="Soundtrack for the watch" onBack={onBack} />

                <div
                    className="flex-1 overflow-y-auto"
                    style={{
                        paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 0.75rem)',
                        maskImage: fadeMask,
                        WebkitMaskImage: fadeMask,
                    }}
                >
                    {authGranted === false && (
                        <div className="mx-auto flex max-w-md flex-col items-center justify-center px-4 pt-12 text-center">
                            <div className="relative mb-5 flex h-20 w-20 items-center justify-center rounded-3xl border border-sky-400/25 bg-gradient-to-br from-sky-400/20 to-sky-500/10 shadow-2xl">
                                <div className="absolute inset-2 rounded-2xl border border-sky-200/10" />
                                <MusicIcon className="relative h-9 w-9 text-sky-300" />
                            </div>
                            <div className="text-[11px] font-black uppercase tracking-[0.2em] text-sky-300/75">
                                Onboard audio
                            </div>
                            <div className="mt-2 text-xl font-extrabold text-white">Connect Apple Music</div>
                            <div className="mt-2 max-w-xs text-sm leading-relaxed text-slate-300">
                                Give Calypso access to your library, playlists, and proper hands-free playback while you
                                sail.
                            </div>
                            {musicAccessNeedsSettings ? (
                                <div
                                    role="alert"
                                    className="mt-6 max-w-sm rounded-2xl border border-amber-300/25 bg-amber-300/[0.075] p-3.5 text-left"
                                >
                                    <div className="text-sm font-extrabold text-amber-100">
                                        Apple Music is turned off
                                    </div>
                                    <p className="mt-1 text-xs leading-relaxed text-amber-100/80">
                                        Allow Apple Music for Thalassa in iOS Settings, then return here to connect it.
                                    </p>
                                    <button
                                        onClick={handleOpenMusicSystemSettings}
                                        className="mt-3 inline-flex min-h-10 items-center gap-2 rounded-xl bg-amber-200 px-3.5 py-2 text-xs font-extrabold text-[#251603] shadow-xl active:scale-[0.98]"
                                    >
                                        Open Music settings
                                    </button>
                                </div>
                            ) : authStatus === 'unsupported' ? (
                                <div className="mt-6 max-w-xs rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-xs leading-relaxed text-slate-300">
                                    Apple Music controls are available in the Thalassa iPhone app.
                                </div>
                            ) : (
                                <button
                                    onClick={() => void handleGrantAccess()}
                                    className="mt-6 inline-flex min-h-12 items-center gap-2 rounded-2xl bg-sky-600 px-5 py-3 text-sm font-extrabold text-white shadow-xl transition-all hover:bg-sky-500 active:scale-[0.97]"
                                >
                                    <MusicIcon className="h-4 w-4" />
                                    Connect Apple Music
                                </button>
                            )}
                            <p className="mt-4 max-w-xs text-xs leading-relaxed text-slate-500">
                                Your library stays yours. Thalassa only uses access to play and organise the music you
                                choose.
                            </p>
                            {authStatus && authStatus !== 'notDetermined' && !musicAccessNeedsSettings && (
                                <div className="mt-4 text-xs text-slate-500">
                                    Status: <code>{authStatus}</code>
                                </div>
                            )}
                        </div>
                    )}

                    {authGranted === true && (
                        <div className="flex min-h-full flex-col">
                            {/* ═══ THE STAGE — now playing, front and centre ═══ */}
                            <div className="px-4 pt-1">
                                <NowPlayingStage
                                    nowPlaying={nowPlaying}
                                    playlistName={activePlaylist?.name ?? null}
                                    speaker={speaker}
                                    onPause={() => void handlePause()}
                                    onResume={() => void handleResume()}
                                    onNext={() => void handleNext()}
                                    onPrevious={() => void handlePrevious()}
                                    onPickSpeaker={() => {
                                        triggerHaptic('light');
                                        void showRoutePicker();
                                    }}
                                />
                            </div>

                            {/* ═══ PLAYLIST RAIL — left-to-right, thumb country ═══ */}
                            <div className="mt-5 flex items-end justify-between gap-3 px-4">
                                <div>
                                    <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.18em] text-sky-200/75">
                                        <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />
                                        Your playlists
                                        {playlists.length > 0 && (
                                            <span className="rounded-full border border-white/10 bg-white/[0.05] px-1.5 py-0.5 text-[9px] text-slate-300">
                                                {playlists.length}
                                            </span>
                                        )}
                                    </div>
                                    <div className="mt-1 text-[10px] font-medium uppercase tracking-wider text-slate-500">
                                        Tap to play · hold for options
                                    </div>
                                </div>
                                <div className="flex shrink-0 items-center gap-2">
                                    <button
                                        onClick={() => void loadPlaylists()}
                                        disabled={loadingPlaylists}
                                        className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/[0.045] text-sky-200 transition-all hover:border-sky-400/35 hover:bg-sky-500/10 active:scale-95 disabled:opacity-40"
                                        aria-label="Refresh Apple Music library"
                                    >
                                        <RefreshIcon className={`h-4 w-4 ${loadingPlaylists ? 'animate-spin' : ''}`} />
                                    </button>
                                    <button
                                        onClick={() => {
                                            triggerHaptic('light');
                                            setCreateError(null);
                                            setCreateOpen(true);
                                        }}
                                        className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-sky-400/35 bg-sky-600 px-3 text-[11px] font-black uppercase tracking-wider text-white shadow-xl transition-all hover:bg-sky-500 active:scale-95"
                                        aria-label="Create playlist"
                                    >
                                        <PlusIcon className="h-3.5 w-3.5" />
                                        New
                                    </button>
                                </div>
                            </div>

                            {loadingPlaylists && playlists.length === 0 ? (
                                <div
                                    className="mt-3 flex gap-3 overflow-hidden px-4"
                                    aria-label="Loading Apple Music playlists"
                                >
                                    {[0, 1, 2].map((skeleton) => (
                                        <div
                                            key={skeleton}
                                            className="h-40 w-40 shrink-0 animate-pulse rounded-2xl border border-white/[0.06] bg-gradient-to-br from-slate-800/70 to-slate-950/70"
                                        />
                                    ))}
                                </div>
                            ) : playlists.length === 0 && !loadError ? (
                                <div className="mx-4 mt-3 flex flex-col items-center rounded-2xl border border-white/[0.06] bg-white/[0.02] px-6 py-8 text-center">
                                    <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl border border-sky-400/20 bg-sky-400/10">
                                        <LibraryIcon className="h-5 w-5 text-sky-300" />
                                    </div>
                                    <div className="text-base font-extrabold text-white">Your library is clear</div>
                                    <div className="mt-1.5 max-w-xs text-xs leading-relaxed text-slate-400">
                                        Hit New to build your first playlist right here, or create some in Apple Music
                                        and refresh.
                                    </div>
                                </div>
                            ) : (
                                <div
                                    className="mt-3 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1"
                                    style={{ scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch' }}
                                >
                                    {playlists.map((p) => (
                                        <div key={p.id} className="w-40 shrink-0 snap-start">
                                            <PlaylistTile
                                                playlist={p}
                                                active={activePlaylistId === p.id}
                                                // Tap = play instantly (the common case —
                                                // skipper just wants the music going).
                                                // Long-press / ⋯ = detail sheet (Play,
                                                // Add tracks, Delete).
                                                onTap={() => void handlePlayPlaylist(p.id)}
                                                onLongPress={() => void openDetail(p)}
                                            />
                                        </div>
                                    ))}
                                    {/* Trailing spacer so the last card can snap clear of the edge */}
                                    <div className="w-1 shrink-0" aria-hidden="true" />
                                </div>
                            )}

                            {loadError && (
                                <div
                                    role="alert"
                                    className="mx-4 mt-4 rounded-2xl border border-amber-300/25 bg-amber-300/[0.075] px-4 py-3 text-sm text-amber-100"
                                >
                                    <div className="font-bold">Apple Music needs attention</div>
                                    <div className="mt-1 text-xs leading-relaxed text-amber-100/80">
                                        {loadError === 'permission_denied'
                                            ? 'Access is denied. Enable Apple Music for Thalassa in iOS Settings, then return here.'
                                            : loadError}
                                    </div>
                                    {loadError !== 'permission_denied' && (
                                        <button
                                            onClick={() => void loadPlaylists()}
                                            className="mt-3 inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-amber-200/25 bg-amber-100/10 px-3 text-xs font-bold text-amber-50 active:scale-[0.98]"
                                        >
                                            <RefreshIcon className="h-3.5 w-3.5" />
                                            Try again
                                        </button>
                                    )}
                                </div>
                            )}

                            {/* ═══ ON DECK — the active playlist's songs ═══ */}
                            {activePlaylist && (onDeckLoading || onDeckTracks.length > 0) && (
                                <div className="mt-6 flex min-h-0 flex-1 flex-col px-4">
                                    <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.18em] text-sky-200/75">
                                        <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />
                                        On deck
                                        <span className="truncate font-bold normal-case tracking-normal text-slate-400">
                                            — {activePlaylist.name}
                                        </span>
                                    </div>
                                    {onDeckLoading && onDeckTracks.length === 0 ? (
                                        <div className="mt-3 flex-1 space-y-2">
                                            {[0, 1, 2].map((skeleton) => (
                                                <div
                                                    key={skeleton}
                                                    className="h-12 animate-pulse rounded-xl border border-white/[0.05] bg-white/[0.03]"
                                                />
                                            ))}
                                        </div>
                                    ) : (
                                        <div className="mt-3 flex-1 overflow-hidden rounded-2xl border border-white/[0.07] bg-white/[0.02]">
                                            {onDeckTracks.map((track, index) => {
                                                const isCurrent =
                                                    !!nowPlaying?.title &&
                                                    nowPlaying.title === track.title &&
                                                    (!track.artist ||
                                                        !nowPlaying.artist ||
                                                        nowPlaying.artist === track.artist);
                                                return (
                                                    <button
                                                        key={track.id}
                                                        onClick={() => void handlePlayOnDeck(track.id)}
                                                        className={`flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors ${
                                                            index > 0 ? 'border-t border-white/[0.05]' : ''
                                                        } ${
                                                            isCurrent
                                                                ? 'bg-sky-500/[0.12]'
                                                                : 'hover:bg-white/[0.04] active:bg-sky-500/[0.08]'
                                                        }`}
                                                    >
                                                        <span
                                                            className={`w-6 shrink-0 text-center font-mono text-[11px] tabular-nums ${
                                                                isCurrent ? 'text-sky-300' : 'text-slate-500'
                                                            }`}
                                                        >
                                                            {isCurrent ? (
                                                                <PlayingGlyph playing={!!nowPlaying?.isPlaying} />
                                                            ) : (
                                                                index + 1
                                                            )}
                                                        </span>
                                                        <span className="min-w-0 flex-1">
                                                            <span
                                                                className={`block truncate text-[13px] font-bold ${
                                                                    isCurrent ? 'text-sky-100' : 'text-white'
                                                                }`}
                                                            >
                                                                {track.title}
                                                            </span>
                                                            {track.artist && (
                                                                <span className="mt-0.5 block truncate text-[11px] text-slate-400">
                                                                    {track.artist}
                                                                </span>
                                                            )}
                                                        </span>
                                                        <PlayIcon
                                                            className={`h-3.5 w-3.5 shrink-0 ${
                                                                isCurrent ? 'text-sky-300' : 'text-slate-600'
                                                            }`}
                                                        />
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Filler — the column always reads full-height:
                                when nothing is on deck, an invitation panel
                                stretches down to just above the menu bar. */}
                            {(!activePlaylist || (!onDeckLoading && onDeckTracks.length === 0)) && (
                                <div className="mx-4 mt-6 flex min-h-[10rem] flex-1 flex-col items-center justify-center overflow-hidden rounded-2xl border border-white/[0.05] bg-white/[0.015] px-6 py-6 text-center">
                                    <svg
                                        className="pointer-events-none mb-3 h-6 w-24 text-sky-300/25"
                                        viewBox="0 0 96 24"
                                        preserveAspectRatio="none"
                                        aria-hidden="true"
                                    >
                                        <path
                                            d="M0,12 Q12,4 24,12 T48,12 T72,12 T96,12"
                                            fill="none"
                                            stroke="currentColor"
                                            strokeWidth="2"
                                            strokeLinecap="round"
                                        />
                                    </svg>
                                    <div className="text-xs font-bold uppercase tracking-widest text-slate-500">
                                        Songs line up here
                                    </div>
                                    <div className="mt-1 max-w-[16rem] text-[11px] leading-relaxed text-slate-600">
                                        Press play on a playlist and its tracks fill this space — tap any song to jump
                                        to it.
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* Playlist detail sheet — opens on long-press */}
                {detailPlaylist && (
                    <PlaylistDetailSheet
                        playlist={detailPlaylist}
                        tracks={detailTracks}
                        loading={detailLoading}
                        error={detailError}
                        covered={addTracksOpen || confirmDelete !== null}
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

                {/* Create-playlist modal — opens from New in the rail header */}
                {createOpen && (
                    <CreatePlaylistSheet
                        busy={createBusy}
                        error={createError}
                        onClose={() => setCreateOpen(false)}
                        onSubmit={(n, d) => void handleCreatePlaylist(n, d)}
                    />
                )}
            </div>
        </div>
    );
};

/** Three-bar equaliser glyph for the current track row. Static bars when
 *  paused; the gentle stagger only runs while audio is actually moving. */
const PlayingGlyph: React.FC<{ playing: boolean }> = ({ playing }) => (
    <span className="inline-flex h-3.5 items-end gap-[2px]" aria-label={playing ? 'Playing' : 'Paused'}>
        {[0, 1, 2].map((bar) => (
            <span
                key={bar}
                className={`w-[3px] rounded-sm bg-sky-400 ${playing ? 'animate-pulse' : ''}`}
                style={{
                    height: bar === 1 ? '100%' : '60%',
                    animationDelay: playing ? `${bar * 180}ms` : undefined,
                }}
            />
        ))}
    </span>
);

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
                className={`group relative block w-full aspect-square overflow-hidden rounded-2xl border bg-slate-900 text-left shadow-xl transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/80 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 ${
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
                <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/18 to-transparent" />
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
                    onLongPress();
                }}
                aria-label={`More options for ${playlist.name}`}
                className="absolute right-1 top-1 flex h-11 w-11 items-center justify-center rounded-2xl border border-white/15 bg-slate-950/75 text-white/85 shadow-sm backdrop-blur-md transition-all hover:border-sky-200/35 hover:bg-sky-500/[0.14] hover:text-sky-100 active:scale-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
                <MoreIcon className="h-4 w-4" />
            </button>
            <span id={instructionsId} className="sr-only">
                Tap to play. Use more options to view tracks, add music, or manage this playlist.
            </span>
        </div>
    );
};

// ── Playlist detail sheet — long-press → bottom sheet w/ tracks ────

interface PlaylistDetailSheetProps {
    playlist: UserPlaylist;
    tracks: PlaylistTrack[];
    loading: boolean;
    error: string | null;
    covered: boolean;
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
                className={`relative w-full max-w-lg max-h-full flex flex-col rounded-[2rem] border border-sky-300/15 bg-gradient-to-b from-slate-900 via-slate-950 to-slate-950 shadow-2xl transition-opacity duration-300 ease-out ${
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
                        className="absolute right-3 top-2 w-9 h-9 rounded-full flex items-center justify-center text-white/70 hover:text-white active:bg-white/10 transition-colors"
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
                        className="flex w-full items-center justify-center gap-2 rounded-2xl border border-sky-300/25 bg-sky-400/[0.09] py-3 text-sm font-bold text-sky-200 transition-transform active:scale-[0.97]"
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
                                className="flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left transition-colors hover:bg-sky-500/[0.06] active:bg-sky-400/[0.1]"
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
                    <div className="shrink-0 border-t border-white/10 py-3 flex justify-center bg-black/40 backdrop-blur-sm">
                        <button
                            onClick={onDelete}
                            aria-label={`Delete ${playlist.name} playlist`}
                            className="text-red-400/80 hover:text-red-300 active:text-red-200 text-xs font-medium px-4 py-2 rounded-lg active:bg-red-500/10 transition-colors"
                        >
                            Delete this playlist
                        </button>
                    </div>
                )}
            </div>
        </OverlayPortal>
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
        <OverlayPortal className="flex flex-col" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
            <div
                role="presentation"
                onClick={onClose}
                className={`absolute inset-0 bg-black/80 backdrop-blur-md transition-opacity duration-300 ${
                    mounted ? 'opacity-100' : 'opacity-0'
                }`}
            />
            <div
                ref={focusTrapRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                aria-describedby={descriptionId}
                className={`relative mt-auto flex flex-col rounded-t-[2rem] border-t border-sky-300/15 bg-gradient-to-b from-slate-900 via-slate-950 to-slate-950 shadow-2xl transition-transform duration-300 ease-out ${
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
                    // No min-height when the keyboard is up: the
                    // available space is already small (viewport minus
                    // keyboard and safe area), and a 55vh
                    // floor would force the sheet's top edge above the
                    // viewport, hiding the search input the skipper
                    // is trying to type into. Only apply the floor
                    // when the keyboard is hidden so the sheet still
                    // has presence on the empty-search initial state.
                    minHeight: keyboardHeight > 0 ? undefined : '55vh',
                    maxHeight:
                        keyboardHeight > 0
                            ? `calc(100vh - ${keyboardHeight}px - 2rem)`
                            : 'calc(92dvh - env(safe-area-inset-bottom))',
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
                        className="flex-1 rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-sm text-white placeholder:text-white/50 transition-colors focus:border-sky-300/60 focus:bg-sky-400/[0.07] focus:outline-none"
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
        </OverlayPortal>
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
            aria-label={`${added ? 'Added' : redirected ? 'Opened' : adding ? 'Adding' : 'Add'} ${song.title} by ${
                song.artist
            }${song.album ? ` from ${song.album}` : ''}`}
            className={`w-full flex items-center gap-3 px-2 py-2 rounded-xl transition-colors text-left ${
                added
                    ? 'bg-emerald-500/10'
                    : redirected
                      ? 'bg-amber-500/10'
                      : 'hover:bg-sky-500/[0.06] active:bg-sky-400/[0.1]'
            }`}
        >
            <div className="w-10 h-10 rounded-lg overflow-hidden shrink-0 bg-white/5">
                {showRemote ? (
                    <SafeImage
                        src={song.artworkUrl}
                        alt=""
                        className="w-full h-full object-cover"
                        onError={() => setImageFailed(true)}
                        fallback={<GeneratedPlaylistArtwork name={song.title} />}
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
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/20 border-t-sky-400" />
                ) : added ? (
                    <CheckIcon className="w-5 h-5 text-emerald-400" />
                ) : redirected ? (
                    <ExternalLinkIcon className="w-5 h-5 text-amber-300" />
                ) : (
                    <PlusIcon className="h-5 w-5 text-sky-300" />
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
    const titleId = useId();
    const descriptionId = useId();
    const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
    const focusTrapRef = useFocusTrap<HTMLDivElement>(true, {
        initialFocusRef: cancelButtonRef,
        onEscape: onCancel,
    });
    useEffect(() => {
        const id = requestAnimationFrame(() => setMounted(true));
        return () => cancelAnimationFrame(id);
    }, []);
    return (
        <OverlayPortal>
            <div
                role="presentation"
                onClick={onCancel}
                className={`absolute inset-0 bg-black/70 backdrop-blur-md transition-opacity duration-300 ${
                    mounted ? 'opacity-100' : 'opacity-0'
                }`}
            />
            <div className="absolute inset-0 flex items-center justify-center px-4 pointer-events-none">
                <div
                    ref={focusTrapRef}
                    role="alertdialog"
                    aria-modal="true"
                    aria-labelledby={titleId}
                    aria-describedby={descriptionId}
                    className={`relative w-full max-w-sm rounded-3xl border border-sky-300/15 bg-gradient-to-b from-slate-900 via-slate-950 to-slate-950 shadow-2xl transition-all duration-300 ease-out pointer-events-auto ${
                        mounted ? 'opacity-100 scale-100' : 'opacity-0 scale-95'
                    }`}
                >
                    <div className="px-5 pt-5 pb-5">
                        <div id={titleId} className="text-white font-bold text-lg">
                            Delete in Apple Music
                        </div>
                        <div id={descriptionId} className="text-white/60 text-sm mt-2 leading-relaxed">
                            Apple doesn't let third-party apps delete library playlists — only their own Music app can.
                            Tap below and we'll open it for you so you can remove "{playlistName}".
                        </div>
                        <div className="flex gap-2 mt-6">
                            <button
                                ref={cancelButtonRef}
                                onClick={onCancel}
                                disabled={busy}
                                aria-label={`Cancel deleting ${playlistName} playlist`}
                                className="flex-1 py-3 rounded-2xl border border-white/15 text-white/70 font-bold active:scale-[0.97] transition-transform disabled:opacity-40"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={onConfirm}
                                disabled={busy}
                                aria-label={`Open Apple Music to delete ${playlistName} playlist`}
                                className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-sky-600 py-3 text-sm font-extrabold text-white transition-transform active:scale-[0.97] disabled:opacity-40 disabled:active:scale-100"
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
        </OverlayPortal>
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

    const canSubmit = name.trim().length > 0 && !busy;

    const keyboardHeight = useKeyboardOffset();

    return (
        <OverlayPortal>
            <div
                role="presentation"
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
                    ref={focusTrapRef}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby={titleId}
                    aria-describedby={descriptionId}
                    className={`relative w-full max-w-sm rounded-3xl border border-sky-300/15 bg-gradient-to-b from-slate-900 via-slate-950 to-slate-950 shadow-2xl transition-all duration-300 ease-out pointer-events-auto ${
                        mounted ? 'opacity-100 scale-100' : 'opacity-0 scale-95'
                    }`}
                >
                    <div className="px-5 pt-5 pb-5">
                        <div id={titleId} className="text-white font-bold text-lg">
                            New playlist
                        </div>
                        <div id={descriptionId} className="text-white/50 text-xs mt-1">
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
                                aria-label="Playlist name"
                                disabled={busy}
                                maxLength={80}
                                className="w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-sm text-white placeholder:text-white/50 transition-colors focus:border-sky-300/60 focus:bg-sky-400/[0.07] focus:outline-none"
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
                                aria-label="Playlist description"
                                disabled={busy}
                                maxLength={140}
                                className="w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-sm text-white placeholder:text-white/50 transition-colors focus:border-sky-300/60 focus:bg-sky-400/[0.07] focus:outline-none"
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
                                aria-label="Cancel playlist creation"
                                className="flex-1 py-3 rounded-2xl border border-white/15 text-white/70 font-bold active:scale-[0.97] transition-transform disabled:opacity-40"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={() => onSubmit(name, description)}
                                disabled={!canSubmit}
                                aria-label="Create new playlist"
                                className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-sky-600 py-3 text-sm font-extrabold text-white transition-transform active:scale-[0.97] disabled:opacity-40 disabled:active:scale-100"
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
        </OverlayPortal>
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
// returns a null artwork URL. This generator gives it a proper,
// understated Thalassa cover: a three-blob deep-water mesh gradient
// in a palette deterministically picked from the playlist name, a
// subtle horizon wave, and a serif initial overlaid in the centre.
//
// Deterministic = the same playlist always renders the same artwork
// across sessions, and the 2-col grid stays visually varied because
// adjacent playlists hash to different palettes.

/** 10 deep-water, chart-light, and warm-beacon palettes — every
 * playlist hashes to one. Deliberately no candy-colour treatment: a
 * mixed library should look calm, legible, and seaworthy. */
const PLAYLIST_PALETTES: ReadonlyArray<{ a: string; b: string; c: string; bg: string }> = [
    { a: '#22d3ee', b: '#0e7490', c: '#0c4a6e', bg: '#061827' }, // tidal cyan
    { a: '#38bdf8', b: '#2563eb', c: '#172554', bg: '#07152d' }, // bluewater
    { a: '#fbbf24', b: '#d97706', c: '#78350f', bg: '#21150a' }, // beacon amber
    { a: '#2dd4bf', b: '#0f766e', c: '#164e63', bg: '#061c25' }, // reef green
    { a: '#94a3b8', b: '#334155', c: '#0f172a', bg: '#070d16' }, // storm slate
    { a: '#f59e0b', b: '#ea580c', c: '#7c2d12', bg: '#211109' }, // sun on canvas
    { a: '#14b8a6', b: '#0891b2', c: '#0c4a6e', bg: '#08202a' }, // lagoon chart
    { a: '#a3e635', b: '#15803d', c: '#14532d', bg: '#071b16' }, // kelp line
    { a: '#fcd34d', b: '#b45309', c: '#713f12', bg: '#21180a' }, // brass compass
    { a: '#67e8f9', b: '#0284c7', c: '#1e3a8a', bg: '#07142a' }, // moonlit passage
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

// ── Now playing stage ──────────────────────────────────────────────
// The page's hero: playback isn't a footnote in a floating bar any
// more, it IS the top of the page. Blurred artwork backdrop, big art,
// a proper thumb-sized transport, and the speaker (output) control
// living where output controls belong — next to the transport.

interface NowPlayingStageProps {
    nowPlaying: NowPlaying | null;
    /** Name of the playlist the current queue came from, when known. */
    playlistName: string | null;
    speaker: { name: string; icon: string } | null;
    onPause: () => void;
    onResume: () => void;
    onNext: () => void;
    onPrevious: () => void;
    onPickSpeaker: () => void;
}

/** Format seconds as M:SS / H:MM:SS. NaN/Infinity → "0:00". */
function formatPlaybackTime(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const total = Math.floor(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

const SpeakerChip: React.FC<{ speaker: { name: string; icon: string } | null; onPick: () => void }> = ({
    speaker,
    onPick,
}) => (
    <button
        type="button"
        onClick={onPick}
        aria-label={speaker ? `Playing on ${speaker.name}. Choose a speaker` : 'Choose a speaker'}
        className="inline-flex max-w-[10rem] min-h-[44px] items-center gap-1.5 rounded-full border border-sky-400/25 bg-slate-950/60 px-2.5 py-1.5 text-[10px] font-black uppercase tracking-[0.12em] text-sky-200 backdrop-blur-md transition active:scale-95"
    >
        <span aria-hidden="true">{speaker?.icon ?? '🔈'}</span>
        <span className="truncate">{speaker?.name ?? 'Speaker'}</span>
    </button>
);

const NowPlayingStage: React.FC<NowPlayingStageProps> = ({
    nowPlaying,
    playlistName,
    speaker,
    onPause,
    onResume,
    onNext,
    onPrevious,
    onPickSpeaker,
}) => {
    const [imageFailed, setImageFailed] = useState(false);
    const artworkUrl = nowPlaying?.artworkUrl;
    const showRemote = !!artworkUrl && !imageFailed;
    // Reset the failure flag whenever the track changes — different
    // artwork URLs deserve fresh load attempts.
    useEffect(() => {
        setImageFailed(false);
    }, [artworkUrl]);

    // ── Smoothed playback time ─────────────────────────────────────
    // The parent polls native `nowPlaying` once a second, so the raw
    // playbackTime only updates at 1Hz — a visibly stepping progress
    // bar. Interpolate locally at ~10Hz while playing, snapping back
    // to the authoritative value every time a new poll lands.
    const pollTime = nowPlaying?.playbackTime ?? 0;
    const duration = nowPlaying?.duration ?? 0;
    const isPlaying = !!nowPlaying?.isPlaying;
    const [smoothTime, setSmoothTime] = useState(pollTime);
    const lastPollRef = useRef({ value: pollTime, at: Date.now() });

    useEffect(() => {
        lastPollRef.current = { value: pollTime, at: Date.now() };
        setSmoothTime(pollTime);
    }, [pollTime, isPlaying]);

    useEffect(() => {
        if (!isPlaying || duration <= 0) return;
        const id = window.setInterval(() => {
            const elapsed = (Date.now() - lastPollRef.current.at) / 1000;
            setSmoothTime(Math.min(duration, lastPollRef.current.value + elapsed));
        }, 100);
        return () => window.clearInterval(id);
    }, [isPlaying, duration]);

    // ── Idle stage — inviting, not empty ───────────────────────────
    if (!nowPlaying?.title) {
        return (
            <section className="relative overflow-hidden rounded-3xl border border-sky-400/15 bg-gradient-to-br from-sky-400/[0.08] via-slate-900/70 to-slate-950/85 px-4 py-4 shadow-xl">
                <svg
                    className="pointer-events-none absolute bottom-0 left-0 w-full opacity-60"
                    viewBox="0 0 200 40"
                    preserveAspectRatio="none"
                    aria-hidden="true"
                >
                    <path d="M0,20 Q50,6 100,20 T200,20 L200,40 L0,40 Z" fill="white" opacity="0.04" />
                    <path d="M0,28 Q50,14 100,28 T200,28 L200,40 L0,40 Z" fill="white" opacity="0.035" />
                </svg>
                <div className="relative flex items-center gap-3.5">
                    <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-sky-400/25 bg-sky-400/10">
                        <MusicIcon className="h-6 w-6 text-sky-300" />
                    </div>
                    <div className="min-w-0 flex-1">
                        <div className="text-[10px] font-black uppercase tracking-[0.18em] text-sky-200/70">
                            All quiet on deck
                        </div>
                        <div className="mt-0.5 text-base font-extrabold text-white">Pick a playlist to cast off</div>
                    </div>
                    <SpeakerChip speaker={speaker} onPick={onPickSpeaker} />
                </div>
            </section>
        );
    }

    const showProgress = duration > 0;
    const clamped = showProgress ? Math.min(Math.max(smoothTime, 0), duration) : 0;
    const remaining = Math.max(0, duration - clamped);
    const pct = showProgress ? (clamped / duration) * 100 : 0;

    return (
        <section className="relative overflow-hidden rounded-3xl border border-sky-400/20 bg-slate-900/80 shadow-2xl">
            {/* Ambient backdrop — the artwork itself, blurred into the deep */}
            {showRemote && (
                <div aria-hidden="true" className="absolute inset-0 overflow-hidden">
                    <img
                        src={artworkUrl}
                        alt=""
                        className="h-full w-full scale-125 object-cover opacity-35 blur-2xl saturate-150"
                    />
                    <div className="absolute inset-0 bg-gradient-to-b from-slate-950/40 via-slate-950/60 to-slate-950/85" />
                </div>
            )}
            <div className="relative p-4">
                <div className="flex items-center gap-3.5">
                    {showRemote ? (
                        <SafeImage
                            src={artworkUrl}
                            alt=""
                            className="h-24 w-24 shrink-0 rounded-2xl object-cover shadow-2xl ring-1 ring-white/20"
                            loading="eager"
                            onError={() => setImageFailed(true)}
                            fallback={
                                <div className="h-24 w-24 shrink-0 overflow-hidden rounded-2xl shadow-2xl ring-1 ring-white/20">
                                    <GeneratedPlaylistArtwork name={nowPlaying.title || nowPlaying.album || 'Music'} />
                                </div>
                            }
                        />
                    ) : (
                        <div className="h-24 w-24 shrink-0 overflow-hidden rounded-2xl shadow-2xl ring-1 ring-white/20">
                            <GeneratedPlaylistArtwork name={nowPlaying.title || nowPlaying.album || 'Music'} />
                        </div>
                    )}
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 text-[9px] font-black uppercase tracking-[0.16em] text-sky-200/70">
                            <span className={`h-1.5 w-1.5 rounded-full ${isPlaying ? 'bg-sky-400' : 'bg-slate-500'}`} />
                            {isPlaying ? 'Now playing' : 'Paused'}
                            {playlistName && (
                                <span className="truncate font-bold normal-case tracking-normal text-slate-400">
                                    · {playlistName}
                                </span>
                            )}
                        </div>
                        <div className="mt-1 truncate text-lg font-extrabold leading-tight text-white">
                            {nowPlaying.title}
                        </div>
                        {nowPlaying.artist && (
                            <div className="mt-0.5 truncate text-[13px] font-medium text-slate-300/80">
                                {nowPlaying.artist}
                            </div>
                        )}
                    </div>
                </div>

                {showProgress && (
                    <div
                        className="mt-3.5 flex items-center gap-2 text-[10px] font-mono tabular-nums text-slate-400"
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={Math.round(duration)}
                        aria-valuenow={Math.round(clamped)}
                        aria-label={`Playback progress — ${formatPlaybackTime(clamped)} of ${formatPlaybackTime(duration)}`}
                    >
                        <span className="w-8 text-right">{formatPlaybackTime(clamped)}</span>
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
                            <div
                                className="h-full rounded-full bg-gradient-to-r from-sky-500 to-sky-300 transition-[width] duration-150 ease-linear"
                                style={{ width: `${pct}%` }}
                            />
                        </div>
                        <span className="w-10 text-left">-{formatPlaybackTime(remaining)}</span>
                    </div>
                )}

                {/* Transport — big, centred, thumb-first. The speaker chip
                    used to ride shotgun in a fixed 4.5 rem slot on this row —
                    but the chip runs up to 10 rem wide (icon + name), so
                    justify-end overflowed it LEFT, straight over the Next
                    button (Shane 2026-08-11: "it is covering up the forward
                    button"). It now sits on its own line below, tucked into
                    the corner where there is nothing to shadow. */}
                <div className="mt-3 flex items-center justify-center gap-4">
                    <button
                        onClick={onPrevious}
                        className="flex h-12 w-12 items-center justify-center rounded-full text-slate-200 transition-all hover:bg-white/[0.08] active:scale-90"
                        aria-label="Previous"
                    >
                        <SkipPrevIcon className="h-6 w-6" />
                    </button>
                    {isPlaying ? (
                        <button
                            onClick={onPause}
                            className="flex h-14 w-14 items-center justify-center rounded-full bg-sky-500 text-white shadow-2xl shadow-sky-500/30 transition-transform active:scale-90"
                            aria-label="Pause"
                        >
                            <PauseIcon className="h-6 w-6" />
                        </button>
                    ) : (
                        <button
                            onClick={onResume}
                            className="flex h-14 w-14 items-center justify-center rounded-full bg-sky-500 text-white shadow-2xl shadow-sky-500/30 transition-transform active:scale-90"
                            aria-label="Play"
                        >
                            <PlayIcon className="ml-0.5 h-6 w-6" />
                        </button>
                    )}
                    <button
                        onClick={onNext}
                        className="flex h-12 w-12 items-center justify-center rounded-full text-slate-200 transition-all hover:bg-white/[0.08] active:scale-90"
                        aria-label="Next"
                    >
                        <SkipNextIcon className="h-6 w-6" />
                    </button>
                </div>
                <div className="-mb-1 -mr-1 mt-1.5 flex justify-end">
                    <SpeakerChip speaker={speaker} onPick={onPickSpeaker} />
                </div>
            </div>
        </section>
    );
};

// ── Icons (inline SVG, no external dep) ────────────────────────────

const MusicIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
        <path d="M9 17.5a2.5 2.5 0 0 1-2.5 2.5A2.5 2.5 0 0 1 4 17.5 2.5 2.5 0 0 1 6.5 15c.34 0 .67.07.97.18V6L20 4v11.5a2.5 2.5 0 0 1-2.5 2.5 2.5 2.5 0 0 1-2.5-2.5 2.5 2.5 0 0 1 2.5-2.5c.34 0 .67.07.97.18V7.79L9 9.5v8z" />
    </svg>
);

const RefreshIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg
        className={className}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
    >
        <path d="M20 11a8 8 0 0 0-14.9-4.1L3 9" />
        <path d="M3 4v5h5" />
        <path d="M4 13a8 8 0 0 0 14.9 4.1L21 15" />
        <path d="M21 20v-5h-5" />
    </svg>
);

const LibraryIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg
        className={className}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
    >
        <rect x="4" y="4" width="16" height="16" rx="3" />
        <path d="M9 9v6.5" />
        <path d="M9 9l6-1.5v6" />
        <circle cx="7.2" cy="16.2" r="1.8" />
        <circle cx="13.2" cy="14.7" r="1.8" />
    </svg>
);

const MoreIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <circle cx="5" cy="12" r="1.8" />
        <circle cx="12" cy="12" r="1.8" />
        <circle cx="19" cy="12" r="1.8" />
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

const CloseIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg
        className={className}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
    >
        <path d="M18 6L6 18M6 6l12 12" />
    </svg>
);
