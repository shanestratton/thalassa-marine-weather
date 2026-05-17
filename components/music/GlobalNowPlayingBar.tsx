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
import { isMusicEngaged, subscribeMusicEngagement } from '../../services/musicEngagement';
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

    // Engagement gate — do absolutely nothing until the user has
    // shown intent to use music this session (opened the Music page
    // OR triggered a play action). Reset on every cold boot.
    //
    // Shane's bug report: on a fresh app boot with MusicKit already
    // authorized, the bar was polling getMusicKitAuthorizationStatus
    // every 5s and nowPlaying every 2s even though no music was
    // playing and the user hadn't asked for any. Logs showed dozens
    // of bridge calls per minute on a silent app. With this gate,
    // the bar literally does nothing until the user navigates to
    // the Music page (which flips the engagement flag).
    const [engaged, setEngaged] = useState(() => isMusicEngaged());
    useEffect(() => {
        return subscribeMusicEngagement(setEngaged);
    }, []);

    // Auth status check, gated on engagement. Polls every 5 s
    // UNTIL auth is granted — once `authorized` flips true we
    // tear the interval down (the effect's [authorized] dep
    // triggers cleanup → the next render's early-return below
    // skips the setup). Auth revocation between sessions is
    // rare enough that picking it up on the next launch is fine.
    const [authorized, setAuthorized] = useState(false);
    useEffect(() => {
        if (!engaged || authorized) return;
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
    }, [engaged, authorized]);

    // nowPlaying poll — only when engaged AND authorized.
    //
    // Adaptive cadence based on playback state (Shane bug report
    // 2026-05-17: a single play→pause was generating 30+ bridge
    // calls because TWO pollers ran simultaneously — this bar at
    // 2 s + MusicPage at 1 s — and the cadence didn't slow when
    // nothing was changing. Both now use the adaptive ladder
    // below):
    //
    //   playing            →  2 s   (playback time needs to scrub)
    //   paused with track  →  8 s   (rare external change via lock screen)
    //   no track queued    → 30 s   (nothing should be changing)
    //
    // setTimeout chain (not setInterval) so each tick can pick a
    // fresh delay from the current state, not the state at mount.
    useEffect(() => {
        if (!engaged || !authorized) return;
        let cancelled = false;
        let timer: number | undefined;

        const poll = async () => {
            const np = await getNowPlaying();
            if (cancelled) return;
            const resolved = np ?? EMPTY_NOW_PLAYING;
            setNowPlaying(resolved);
            const delay = resolved.isPlaying ? 2000 : resolved.title ? 8000 : 30000;
            timer = window.setTimeout(() => void poll(), delay);
        };
        void poll();

        return () => {
            cancelled = true;
            if (timer !== undefined) window.clearTimeout(timer);
        };
    }, [engaged, authorized]);

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

    // Tracks the title the user has explicitly dismissed via the X
    // button. iOS persists the last-played track in
    // MPNowPlayingInfoCenter even after our stopMusic() call, so
    // each poll's getNowPlaying() returns the same title back and
    // the bar reappears. Holding the dismissed title in state lets
    // us suppress the bar for THIS track until either:
    //   - a different track starts playing (effect below clears it), or
    //   - the user explicitly opens the Music page (effect below
    //     clears it — they're back in music context intentionally).
    const [dismissedTitle, setDismissedTitle] = useState<string | null>(null);

    const handleDismiss = useCallback(
        async (e: React.MouseEvent) => {
            e.stopPropagation();
            if (busy) return;
            setBusy(true);
            triggerHaptic('medium');
            try {
                await stopMusic();
                // Remember which track was dismissed so subsequent
                // polls returning the same title don't re-show the
                // bar. Set this BEFORE the local-state wipe so the
                // suppression takes effect even if the next poll
                // races before the EMPTY render lands.
                setDismissedTitle(nowPlaying.title || null);
                // Optimistic UI — wipe local state so the bar
                // disappears in the current render, not after the
                // next 2 s poll tick.
                setNowPlaying(EMPTY_NOW_PLAYING);
            } finally {
                setBusy(false);
            }
        },
        [busy, nowPlaying.title],
    );

    // Reset the dismissal whenever a DIFFERENT track starts playing
    // — the user pressed X on "Kryptonite", but if "Black Hole Sun"
    // comes on next, that's a new event and the bar should show.
    useEffect(() => {
        if (dismissedTitle !== null && nowPlaying.title && nowPlaying.title !== dismissedTitle) {
            setDismissedTitle(null);
        }
    }, [nowPlaying.title, dismissedTitle]);

    // Reset the dismissal when the user explicitly opens the Music
    // page. Going there means "I'm thinking about music again" —
    // so the bar should be allowed to reappear next time they
    // navigate away with a track active.
    useEffect(() => {
        if (currentView === 'music' && dismissedTitle !== null) {
            setDismissedTitle(null);
        }
    }, [currentView, dismissedTitle]);

    const handleBarTap = useCallback(() => {
        triggerHaptic('light');
        setPage('music');
    }, [setPage]);

    // Hide conditions:
    //  - No track in queue (empty title) → nothing to surface
    //  - User dismissed THIS track via the X button (track persists
    //    in iOS now-playing info center after stopMusic; without
    //    this guard the next poll re-shows it within 8 s).
    //  - Already on the Music page → in-page bar handles it; second
    //    bar would be duplicate visual noise
    //  - On the map / dashboard / certain full-screen views where
    //    the bottom nav itself is hidden (keep simple: just check
    //    title for now, extend if needed)
    if (!nowPlaying.title) return null;
    if (dismissedTitle !== null && nowPlaying.title === dismissedTitle) return null;
    if (currentView === 'music') return null;

    const artwork = nowPlaying.artworkUrl && !imageFailed ? nowPlaying.artworkUrl : null;

    return (
        <button
            type="button"
            onClick={handleBarTap}
            aria-label={`Now playing: ${nowPlaying.title}${nowPlaying.artist ? ` by ${nowPlaying.artist}` : ''}. Tap to open music page.`}
            // Compact floating pill (2026-05-18 — was a full-width bar
            // that walled off the bottom of every screen; Shane: "in the
            // way on most screens, make it float"). Right-anchored so
            // it sits in iOS's natural picture-in-picture zone and
            // leaves the left ~60% of the screen clear for content.
            // max-w cap keeps it tight even with a long track title.
            className="fixed right-2 z-[850] flex items-center gap-2.5 pl-2 pr-1.5 py-2 rounded-2xl border border-white/10 bg-slate-900/90 backdrop-blur-xl shadow-2xl active:scale-[0.99] transition-transform max-w-[280px]"
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

            {/* Title + artist — capped at 120px so a long title doesn't
                blow the pill back out to full-width. Artist line stays
                — it's the second-most-useful piece of info after the
                title, and at 11px on one line it costs nothing. */}
            <div className="min-w-0 max-w-[120px] text-left">
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
