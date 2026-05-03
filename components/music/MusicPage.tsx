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
import React, { useCallback, useEffect, useState } from 'react';
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
    type UserPlaylist,
    type NowPlaying,
} from '../../services/voice/integrations/appleMusic';

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
        </div>
    );
};

// ── Playlist tile ─────────────────────────────────────────────────

interface PlaylistTileProps {
    playlist: UserPlaylist;
    active: boolean;
    onTap: () => void;
}

const PlaylistTile: React.FC<PlaylistTileProps> = ({ playlist, active, onTap }) => (
    <button
        onClick={onTap}
        className={`relative aspect-square rounded-2xl overflow-hidden border transition-all active:scale-[0.97] ${
            active ? 'border-pink-400/60 ring-2 ring-pink-400/40' : 'border-white/10 hover:border-white/30'
        }`}
    >
        {playlist.artworkUrl ? (
            <img src={playlist.artworkUrl} alt={playlist.name} className="w-full h-full object-cover" loading="lazy" />
        ) : (
            <div className="w-full h-full bg-gradient-to-br from-pink-500/20 to-purple-500/20 flex items-center justify-center">
                <MusicIcon className="w-12 h-12 text-white/40" />
            </div>
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

// ── Now playing bar ────────────────────────────────────────────────

interface NowPlayingBarProps {
    nowPlaying: NowPlaying;
    onPause: () => void;
    onResume: () => void;
    onNext: () => void;
    onPrevious: () => void;
}

const NowPlayingBar: React.FC<NowPlayingBarProps> = ({ nowPlaying, onPause, onResume, onNext, onPrevious }) => (
    <div className="shrink-0 border-t border-white/10 bg-black/60 backdrop-blur-md p-3">
        <div className="flex items-center gap-3">
            {nowPlaying.artworkUrl ? (
                <img src={nowPlaying.artworkUrl} alt="" className="w-12 h-12 rounded-lg object-cover shrink-0" />
            ) : (
                <div className="w-12 h-12 rounded-lg bg-white/5 flex items-center justify-center shrink-0">
                    <MusicIcon className="w-6 h-6 text-white/40" />
                </div>
            )}
            <div className="flex-1 min-w-0">
                <div className="text-white font-bold text-sm truncate">{nowPlaying.title}</div>
                {nowPlaying.artist && <div className="text-white/60 text-xs truncate mt-0.5">{nowPlaying.artist}</div>}
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
