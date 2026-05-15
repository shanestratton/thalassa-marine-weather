/**
 * GlobalNowPlayingBar — fixed bar above the bottom nav that surfaces
 * music transport controls on every page.
 *
 * Why this exists: ApplicationMusicPlayer keeps playing after you
 * leave the Music page (that's the whole point of background music
 * while you sail). But the in-page NowPlayingBar was the only pause
 * UI in the app — once you'd navigated away, you had no way to stop
 * the music short of going back to Music, or using iOS Control
 * Center / lockscreen. This bar fixes both halves of that:
 *
 *  - Pause/play button → pauseMusic() / resumeMusic()
 *  - X (dismiss) button → stopMusic() (pause + clear queue), bar
 *    auto-hides because there's no longer a track to surface
 *  - Tap the bar (away from buttons) → navigate to the Music page
 *
 * Auto-hides when there's no track playing (nothing to control).
 *
 * Owns its own 2 s nowPlaying poll. MusicPage runs an independent
 * 1 s poll — two pollers is wasteful but cheaper than threading a
 * shared store right now, and bridge calls are tiny (a cache hit
 * once the Swift side has resolved the current entry).
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
    getNowPlaying,
    pauseMusic,
    resumeMusic,
    stopMusic,
    getAuthorizationStatus,
    type NowPlaying,
} from '../../services/voice/integrations/appleMusic';
import { useUI } from '../../context/UIContext';
import { triggerHaptic } from '../../utils/system';

const EMPTY_NOW_PLAYING: NowPlaying = {
    title: '',
    artist: '',
    album: '',
    artworkUrl: '',
    state: '',
    isPlaying: false,
    playbackTime: 0,
    duration: 0,
};

export const GlobalNowPlayingBar: React.FC = () => {
    const { currentView, setPage } = useUI();
    const [nowPlaying, setNowPlaying] = useState<NowPlaying>(EMPTY_NOW_PLAYING);
    const [busy, setBusy] = useState(false);
    const [imageFailed, setImageFailed] = useState(false);

    // Poll once per 2 s WHEN MusicKit is authorized.
    //
    // First-launch trap: accessing ApplicationMusicPlayer.shared on
    // the Swift side surfaces the iOS MusicKit authorization prompt
    // ("Allow Thalassa to use Apple Music?") even when we're just
    // reading queue status. That triggered at boot on every fresh
    // install simply because this bar mounts with the app and
    // started polling.
    //
    // Fix: read auth status FIRST (currentStatus is a synchronous
    // property that does not prompt). Only start polling if the
    // user has previously granted MusicKit access (e.g. by opening
    // the Music page and tapping play). For users who never use
    // music, the bar stays silent forever, which is correct —
    // there's nothing to surface.
    //
    // We re-check every 5 s in case the user grants auth via the
    // Music page later in the session; the bar will then start
    // polling without requiring an app restart.
    const [authorized, setAuthorized] = useState(false);
    useEffect(() => {
        let cancelled = false;
        const check = async () => {
            const a = await getAuthorizationStatus();
            if (!cancelled) setAuthorized(a.granted);
        };
        void check();
        const id = window.setInterval(() => void check(), 5000);
        return () => {
            cancelled = true;
            window.clearInterval(id);
        };
    }, []);

    useEffect(() => {
        if (!authorized) return;
        let cancelled = false;
        const poll = async () => {
            const np = await getNowPlaying();
            if (!cancelled) setNowPlaying(np ?? EMPTY_NOW_PLAYING);
        };
        void poll();
        const id = window.setInterval(() => void poll(), 2000);
        return () => {
            cancelled = true;
            window.clearInterval(id);
        };
    }, [authorized]);

    // Reset image-error state when the track changes so a stale
    // failed-image flag doesn't suppress artwork for the next track.
    useEffect(() => {
        setImageFailed(false);
    }, [nowPlaying.artworkUrl]);

    const handleTogglePlayPause = useCallback(
        async (e: React.MouseEvent) => {
            e.stopPropagation(); // don't trigger the bar-tap → Music navigation
            if (busy) return;
            setBusy(true);
            triggerHaptic('light');
            try {
                if (nowPlaying.isPlaying) {
                    await pauseMusic();
                } else {
                    await resumeMusic();
                }
                // Optimistic UI — flip the local state so the icon
                // updates instantly instead of waiting for the next poll.
                setNowPlaying((np) => ({ ...np, isPlaying: !np.isPlaying }));
            } finally {
                setBusy(false);
            }
        },
        [busy, nowPlaying.isPlaying],
    );

    const handleDismiss = useCallback(
        async (e: React.MouseEvent) => {
            e.stopPropagation();
            if (busy) return;
            setBusy(true);
            triggerHaptic('medium');
            try {
                await stopMusic();
                // Stop clears the queue server-side — wipe local state too
                // so the bar disappears immediately without waiting for
                // the next 2 s poll tick.
                setNowPlaying(EMPTY_NOW_PLAYING);
            } finally {
                setBusy(false);
            }
        },
        [busy],
    );

    const handleBarTap = useCallback(() => {
        triggerHaptic('light');
        setPage('music');
    }, [setPage]);

    // Hide conditions:
    //  - No track in queue (empty title) → nothing to surface
    //  - Already on the Music page → in-page bar handles it; second
    //    bar would be duplicate visual noise
    //  - On the map / dashboard / certain full-screen views where
    //    the bottom nav itself is hidden (keep simple: just check
    //    title for now, extend if needed)
    if (!nowPlaying.title) return null;
    if (currentView === 'music') return null;

    const artwork = nowPlaying.artworkUrl && !imageFailed ? nowPlaying.artworkUrl : null;

    return (
        <button
            type="button"
            onClick={handleBarTap}
            aria-label={`Now playing: ${nowPlaying.title}${nowPlaying.artist ? ` by ${nowPlaying.artist}` : ''}. Tap to open music page.`}
            className="fixed left-2 right-2 z-[850] flex items-center gap-3 px-3 py-2 rounded-2xl border border-white/10 bg-slate-900/90 backdrop-blur-xl shadow-2xl active:scale-[0.99] transition-transform"
            style={{
                // Slot above the bottom nav (h-16 = 64px + safe area inset)
                bottom: 'calc(env(safe-area-inset-bottom) + 68px)',
            }}
        >
            {/* Artwork */}
            {artwork ? (
                <img
                    src={artwork}
                    alt=""
                    className="w-10 h-10 rounded-lg object-cover shrink-0"
                    onError={() => setImageFailed(true)}
                />
            ) : (
                <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-sky-500/30 to-cyan-500/20 shrink-0 flex items-center justify-center">
                    <span className="text-base">🎵</span>
                </div>
            )}

            {/* Title + artist */}
            <div className="flex-1 min-w-0 text-left">
                <div className="text-sm font-bold text-white truncate">{nowPlaying.title}</div>
                {nowPlaying.artist && <div className="text-[11px] text-white/60 truncate">{nowPlaying.artist}</div>}
            </div>

            {/* Transport — play/pause + dismiss */}
            <div className="flex items-center gap-1 shrink-0">
                <button
                    type="button"
                    onClick={(e) => void handleTogglePlayPause(e)}
                    disabled={busy}
                    aria-label={nowPlaying.isPlaying ? 'Pause' : 'Play'}
                    className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 active:scale-90 transition-all flex items-center justify-center disabled:opacity-50"
                >
                    {nowPlaying.isPlaying ? (
                        // Pause icon
                        <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="currentColor">
                            <rect x="6" y="5" width="4" height="14" rx="1" />
                            <rect x="14" y="5" width="4" height="14" rx="1" />
                        </svg>
                    ) : (
                        // Play icon
                        <svg className="w-4 h-4 text-white ml-0.5" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M8 5v14l11-7z" />
                        </svg>
                    )}
                </button>
                <button
                    type="button"
                    onClick={(e) => void handleDismiss(e)}
                    disabled={busy}
                    aria-label="Stop and dismiss now playing"
                    className="w-10 h-10 rounded-full text-white/50 hover:text-white hover:bg-white/10 active:scale-90 transition-all flex items-center justify-center disabled:opacity-50"
                >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                </button>
            </div>
        </button>
    );
};
