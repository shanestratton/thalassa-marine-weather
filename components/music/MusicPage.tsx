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

const NowPlayingBar: React.FC<NowPlayingBarProps> = ({ nowPlaying, onPause, onResume, onNext, onPrevious }) => (
    <div className="shrink-0 border-t border-white/10 bg-black/60 backdrop-blur-md p-3">
        <div className="flex items-center gap-3">
            {nowPlaying.artworkUrl ? (
                <img src={nowPlaying.artworkUrl} alt="" className="w-12 h-12 rounded-lg object-cover shrink-0" />
            ) : (
                <div className="w-12 h-12 rounded-lg overflow-hidden shrink-0">
                    <GeneratedPlaylistArtwork name={nowPlaying.title || nowPlaying.album || 'Music'} />
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
