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
    addPlaylistToQueue,
    playTrackInPlaylist,
    type UserPlaylist,
    type NowPlaying,
    type PlaylistTrack,
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

    /** Load playlists. Triggered after auth + on manual refresh. */
    const loadPlaylists = useCallback(async () => {
        setLoadingPlaylists(true);
        setLoadError(null);
        try {
            const r = await getUserPlaylists();
            if (!r.available) {
                setLoadError(r.reason ?? 'unknown');
                setPlaylists([]);
            } else {
                setPlaylists(r.playlists);
            }
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

    const handleAddToQueue = useCallback(async () => {
        if (!detailPlaylist) return;
        triggerHaptic('light');
        const r = await addPlaylistToQueue(detailPlaylist.id);
        if (r.success) {
            // Stay on the sheet so the skipper sees the success — close
            // after a beat so the action feels acknowledged.
            setTimeout(() => closeDetail(), 600);
        } else {
            setDetailError(`Couldn't add: ${r.error}`);
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

    return (
        <div className="flex flex-col h-full bg-gradient-to-b from-slate-900 via-slate-950 to-black">
            <PageHeader title="Music" subtitle="Apple Music playlists" onBack={onBack} />

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-4 pb-4">
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
                                onTap={() => void handlePlayPlaylist(p.id)}
                                onLongPress={() => void openDetail(p)}
                            />
                        ))}
                    </div>
                )}
            </div>

            {/* Now-playing footer */}
            {nowPlaying && nowPlaying.title && (
                <NowPlayingBar
                    nowPlaying={nowPlaying}
                    onPause={() => void handlePause()}
                    onResume={() => void handleResume()}
                    onNext={() => void handleNext()}
                    onPrevious={() => void handlePrevious()}
                />
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
                    onAddToQueue={() => void handleAddToQueue()}
                    onPlayTrack={(trackId) => void handlePlayTrack(trackId)}
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
                <GeneratedPlaylistArtwork name={playlist.name} />
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
    onAddToQueue: () => void;
    onPlayTrack: (trackId: string) => void;
}

const PlaylistDetailSheet: React.FC<PlaylistDetailSheetProps> = ({
    playlist,
    tracks,
    loading,
    error,
    onClose,
    onPlayAll,
    onAddToQueue,
    onPlayTrack,
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
        <div className="fixed inset-0 z-50 flex flex-col">
            {/* Backdrop */}
            <button
                aria-label="Close playlist details"
                onClick={onClose}
                className={`absolute inset-0 bg-black/70 backdrop-blur-md transition-opacity duration-300 ${
                    mounted ? 'opacity-100' : 'opacity-0'
                }`}
            />
            {/* Sheet */}
            <div
                className={`relative mt-auto bg-gradient-to-b from-slate-900 via-slate-950 to-black rounded-t-3xl border-t border-white/10 max-h-[88vh] flex flex-col shadow-2xl transition-transform duration-300 ease-out ${
                    mounted ? 'translate-y-0' : 'translate-y-full'
                }`}
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
                <div className="flex gap-2 px-5 pb-3">
                    <button
                        onClick={onPlayAll}
                        disabled={loading || tracks.length === 0}
                        className="flex-1 py-3 rounded-2xl bg-white text-black font-bold flex items-center justify-center gap-2 active:scale-[0.97] transition-transform disabled:opacity-40 disabled:active:scale-100"
                    >
                        <PlayIcon className="w-4 h-4" />
                        <span>Play</span>
                    </button>
                    <button
                        onClick={onAddToQueue}
                        disabled={loading || tracks.length === 0}
                        className="flex-1 py-3 rounded-2xl bg-pink-500/15 border border-pink-400/40 text-pink-300 font-bold flex items-center justify-center gap-2 active:scale-[0.97] transition-transform disabled:opacity-40 disabled:active:scale-100"
                    >
                        <PlusIcon className="w-5 h-5" />
                        <span>Add</span>
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

const GeneratedPlaylistArtwork: React.FC<{ name: string }> = ({ name }) => {
    const palette = paletteFor(name);
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
            {/* Serif monogram — large, semi-translucent, dropshadow for contrast */}
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
        <div className="shrink-0 border-t border-white/10 bg-black/60 backdrop-blur-md p-3">
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
