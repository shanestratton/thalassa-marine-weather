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
    stopMusic,
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
    addSongToPlaylist,
    deletePlaylistById,
    type NowPlaying,
    type PlaylistTrack,
    type CatalogSongResult,
    getAudioRoute,
    showRoutePicker,
} from '../../services/voice/integrations/appleMusic';
import { triggerHaptic } from '../../utils/system';
import { markMusicEngaged } from '../../services/musicEngagement';
import { AddTracksSheet } from './musicPage/AddTracksSheet';
import { CreatePlaylistSheet } from './musicPage/CreatePlaylistSheet';
import { DeleteConfirmSheet } from './musicPage/DeleteConfirmSheet';
import { NowPlayingStage } from './musicPage/NowPlayingStage';
import { PlayingGlyph } from './musicPage/PlayingGlyph';
import { PlaylistDetailSheet } from './musicPage/PlaylistDetailSheet';
import { PlaylistTile } from './musicPage/PlaylistTile';
import { LibraryIcon, MusicIcon, PlayIcon, PlusIcon, RefreshIcon } from './musicPage/icons';
import { MAX_CONCURRENT_PLAYLIST_PREVIEWS, type MusicPageProps, type PlaylistPreviewJob } from './musicPage/types';

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
                    setSpeaker((prev) => (prev === null ? prev : null));
                    return;
                }
                const name = primary.name;
                const icon = primary.isAirPlay ? '📡' : primary.isBluetooth ? '🔊' : primary.isBuiltIn ? '📱' : '🎚️';
                // Same route, same object — a fresh literal every 5 s was
                // re-rendering the page for no change.
                setSpeaker((prev) => (prev && prev.name === name && prev.icon === icon ? prev : { name, icon }));
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

    /** Stable rail handlers — see PlaylistTileProps. */
    const handleTileTap = useCallback(
        (playlistId: string) => {
            void handlePlayPlaylist(playlistId);
        },
        [handlePlayPlaylist],
    );

    const handlePause = useCallback(async () => {
        try {
            await pauseMusic();
        } catch (err) {
            setLoadError((err as Error).message);
        }
        refreshNowPlayingFast();
    }, [refreshNowPlayingFast]);

    // Stop = pause + clear the queue: the off switch. The floating bar's X
    // already took this path; the page had only pause.
    const handleStop = useCallback(async () => {
        triggerHaptic('medium');
        try {
            const r = await stopMusic();
            if (r.isError) setLoadError(r.content);
        } catch (err) {
            setLoadError((err as Error).message);
        }
        setActivePlaylistId(null);
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

    const handleTileHold = useCallback(
        (playlist: UserPlaylist) => {
            void openDetail(playlist);
        },
        [openDetail],
    );

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
                            <div className="relative mb-5 flex h-20 w-20 items-center justify-center rounded-3xl border border-sky-400/25 bg-linear-to-br from-sky-400/20 to-sky-500/10 shadow-2xl">
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
                                    className="mt-6 max-w-sm rounded-2xl border border-amber-300/25 bg-amber-300/7.5 p-3.5 text-left"
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
                                <div className="mt-6 max-w-xs rounded-2xl border border-white/10 bg-white/4 px-4 py-3 text-xs leading-relaxed text-slate-300">
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
                                    onStop={() => void handleStop()}
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
                                            <span className="rounded-full border border-white/10 bg-white/5 px-1.5 py-0.5 text-[9px] text-slate-300">
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
                                        className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/10 bg-white/4.5 text-sky-200 transition-all hover:border-sky-400/35 hover:bg-sky-500/10 active:scale-95 disabled:opacity-40"
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
                                        className="inline-flex h-11 items-center gap-1.5 rounded-xl border border-sky-400/35 bg-sky-600 px-3 text-[11px] font-black uppercase tracking-wider text-white shadow-xl transition-all hover:bg-sky-500 active:scale-95"
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
                                            className="h-40 w-40 shrink-0 animate-pulse rounded-2xl border border-white/6 bg-linear-to-br from-slate-800/70 to-slate-950/70"
                                        />
                                    ))}
                                </div>
                            ) : playlists.length === 0 && !loadError ? (
                                <div className="mx-4 mt-3 flex flex-col items-center rounded-2xl border border-white/6 bg-white/2 px-6 py-8 text-center">
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
                                                onTap={handleTileTap}
                                                onLongPress={handleTileHold}
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
                                    className="mx-4 mt-4 rounded-2xl border border-amber-300/25 bg-amber-300/7.5 px-4 py-3 text-sm text-amber-100"
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
                                                    className="h-12 animate-pulse rounded-xl border border-white/5 bg-white/3"
                                                />
                                            ))}
                                        </div>
                                    ) : (
                                        <div className="mt-3 flex-1 overflow-hidden rounded-2xl border border-white/[0.07] bg-white/2">
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
                                                            index > 0 ? 'border-t border-white/5' : ''
                                                        } ${
                                                            isCurrent
                                                                ? 'bg-sky-500/12'
                                                                : 'hover:bg-white/4 active:bg-sky-500/8'
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
                                <div className="mx-4 mt-6 flex min-h-40 flex-1 flex-col items-center justify-center overflow-hidden rounded-2xl border border-white/5 bg-white/1.5 px-6 py-6 text-center">
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
