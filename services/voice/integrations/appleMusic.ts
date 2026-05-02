/**
 * Apple Music integration for Calypso — native + URL-scheme hybrid.
 *
 * Phase 2: native plugin (`AppleMusicPlugin`, MediaPlayer.framework
 * backed) handles library search + playback control + now-playing
 * read-back. Phase 1 URL-scheme hand-off remains as a fallback for
 * songs that aren't in the user's library (catalog plays).
 *
 * Tools surfaced to Calypso via the orchestrator (when the Apple
 * Music integration toggle is on AND the user is on Skipper tier):
 *   - play_music({ query, kind? })  — library-first search-and-play,
 *     URL-scheme fallback if nothing matches in library.
 *   - pause_music({})                — pause current playback.
 *   - resume_music({})               — resume.
 *   - skip_track({})                 — next track.
 *   - previous_track({})             — previous track.
 *   - now_playing({})                — read back what's playing
 *     (title / artist / album / position) — the new capability the
 *     URL-scheme implementation couldn't deliver.
 *
 * Native plugin auth: MPMediaLibrary.requestAuthorization() prompts
 * with the NSAppleMusicUsageDescription string from Info.plist. The
 * plugin handles the prompt inline on first searchAndPlay() call —
 * no separate permission UI to manage.
 *
 * Catalog vs. library: MediaPlayer.framework only sees what the user
 * already has in their library (purchased + iCloud + downloaded
 * tracks via Apple Music subscription). For songs not in the library
 * we hand off to the Apple Music app via URL scheme — same path as
 * Phase 1. Cleaner UX would be MusicKit catalog search, but that
 * needs a server-signed developer token; deferred to Phase 3.
 */

import { Capacitor, registerPlugin } from '@capacitor/core';

// ── Native plugin bridge ────────────────────────────────────────────

interface AppleMusicPluginInterface {
    requestAuthorization(): Promise<{ status: string; granted: boolean }>;
    getAuthorizationStatus(): Promise<{ status: string; granted: boolean }>;
    searchAndPlay(opts: { query: string; kind?: 'auto' | 'artist' | 'album' | 'playlist' | 'song' }): Promise<{
        status: 'playing' | 'not_found_in_library' | 'permission_denied';
        matched_kind: '' | 'artist' | 'album' | 'playlist' | 'song';
        title: string;
        subtitle?: string;
        track_count?: number;
    }>;
    pause(): Promise<{ status: string }>;
    resume(): Promise<{ status: string }>;
    next(): Promise<{ status: string }>;
    previous(): Promise<{ status: string }>;
    nowPlaying(): Promise<{
        is_playing: boolean;
        state: string;
        title: string;
        artist: string;
        album: string;
        position_sec: number;
        duration_sec: number;
    }>;
}

const AppleMusicNative = registerPlugin<AppleMusicPluginInterface>('AppleMusic');

/** Whether the native plugin is wired up (only on iOS native). */
function nativeAvailable(): boolean {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';
}

/**
 * Hand a URL off to the OS shell. We dropped `App.openUrl()` because
 * it's been removed from `@capacitor/app` since v4 — the recommended
 * native-platform path is now to set `window.location.href`, which the
 * WKWebView delegate forwards to UIApplication.openURL for any custom
 * scheme it doesn't handle internally. For HTTPS Universal Links iOS
 * still routes through the same delegate, so this works for both
 * `music://...` and `https://music.apple.com/...`.
 *
 * Wrapped in a function so the error path can return a tool result.
 */
function dispatchUrl(url: string): void {
    // Using window.open with `_self` triggers the same WKNavigationDelegate
    // hook as window.location.href, but doesn't replace the current entry
    // in the back/forward stack — keeps the app in a sane state if the OS
    // hand-off fails for any reason.
    const opened = window.open(url, '_self');
    if (!opened) {
        // Fallback: assignment is more aggressive (will throw if the
        // navigation is blocked, which we want — the catch surfaces it).
        window.location.href = url;
    }
}

/**
 * Search-and-play with library-first dispatch. The native plugin
 * tries the user's library first (artist → album → playlist → song
 * priority order); if nothing matches in library, we fall back to
 * the URL-scheme hand-off for catalog playback.
 *
 * `kind` lets the LLM disambiguate when needed — "play the playlist
 * called passage" should be `kind='playlist'` to avoid an artist
 * named "Passage" hijacking the match.
 */
export async function playMusicByQuery(
    query: string,
    kind?: 'auto' | 'artist' | 'album' | 'playlist' | 'song',
): Promise<{ content: string; isError: boolean }> {
    const trimmed = (query || '').trim();
    if (!trimmed) {
        return { content: 'ERROR: empty music query', isError: true };
    }

    // 1. Native library-first path (iOS only). The plugin handles
    // permission prompting inline on first call.
    if (nativeAvailable()) {
        try {
            const r = await AppleMusicNative.searchAndPlay({ query: trimmed, kind: kind ?? 'auto' });
            if (r.status === 'playing') {
                return {
                    content: JSON.stringify({
                        status: 'playing',
                        source: 'library',
                        matched_kind: r.matched_kind,
                        title: r.title,
                        subtitle: r.subtitle ?? '',
                        track_count: r.track_count ?? 0,
                        note: `Playing from library. Narrate back what's queued: ${r.title}${r.subtitle ? ` — ${r.subtitle}` : ''}.`,
                    }),
                    isError: false,
                };
            }
            if (r.status === 'permission_denied') {
                return {
                    content: JSON.stringify({
                        status: 'permission_denied',
                        note: 'The skipper denied Apple Music library access. Tell them they can grant it in iOS Settings → Thalassa → Apple Music.',
                    }),
                    isError: false,
                };
            }
            // Library miss → fall through to URL-scheme catalog path.
        } catch (nativeErr) {
            console.warn('[appleMusic] native plugin failed, falling back to URL scheme', nativeErr);
            // Don't return — fall through to URL scheme as a graceful
            // degradation if the native plugin throws.
        }
    }

    // 2. URL-scheme catalog fallback. Same path as Phase 1.
    const encoded = encodeURIComponent(trimmed);
    const nativeUrl = `music://music.apple.com/search?term=${encoded}`;
    const universalUrl = `https://music.apple.com/search?term=${encoded}`;

    if (!Capacitor.isNativePlatform()) {
        // Web — open in a new tab; no Apple Music app on web, but the
        // music.apple.com web player exists. Opens a search page.
        try {
            window.open(universalUrl, '_blank');
            return {
                content: JSON.stringify({
                    status: 'opened_web',
                    query: trimmed,
                    note: 'Opened Apple Music web search in a new tab. Native playback requires iOS.',
                }),
                isError: false,
            };
        } catch (err) {
            return { content: `ERROR: failed to open music link: ${(err as Error).message}`, isError: true };
        }
    }

    // Native iOS path — URL hand-off (catalog match)
    try {
        dispatchUrl(nativeUrl);
        return {
            content: JSON.stringify({
                status: 'launched_apple_music_catalog',
                source: 'catalog',
                query: trimmed,
                note: 'Not found in library — handed off to the Apple Music app for catalog search. Calypso cannot read back what plays from this path; only library items report now-playing details.',
            }),
            isError: false,
        };
    } catch (nativeErr) {
        // Fallback to the universal link
        try {
            dispatchUrl(universalUrl);
            return {
                content: JSON.stringify({
                    status: 'launched_apple_music_via_universal_link',
                    source: 'catalog',
                    query: trimmed,
                }),
                isError: false,
            };
        } catch (fallbackErr) {
            const detail = (fallbackErr as Error).message || (nativeErr as Error).message;
            return {
                content: `ERROR: could not open Apple Music — ${detail}`,
                isError: true,
            };
        }
    }
}

// ── Native playback control + now-playing ──────────────────────────

/**
 * Pause whatever's currently playing. No-op (returns success) if
 * nothing is queued — Apple Music doesn't error in that case.
 */
export async function pauseMusic(): Promise<{ content: string; isError: boolean }> {
    if (!nativeAvailable()) {
        return {
            content: JSON.stringify({
                status: 'unsupported_on_web',
                note: 'Pause requires the native iOS plugin. Tell the skipper they can pause from CarPlay or the lock screen.',
            }),
            isError: false,
        };
    }
    try {
        await AppleMusicNative.pause();
        return { content: JSON.stringify({ status: 'paused' }), isError: false };
    } catch (err) {
        return { content: `ERROR: pause failed — ${(err as Error).message}`, isError: true };
    }
}

/**
 * Resume current playback. Same caveat as pause — no-op if nothing
 * is queued.
 */
export async function resumeMusic(): Promise<{ content: string; isError: boolean }> {
    if (!nativeAvailable()) {
        return { content: JSON.stringify({ status: 'unsupported_on_web' }), isError: false };
    }
    try {
        await AppleMusicNative.resume();
        return { content: JSON.stringify({ status: 'playing' }), isError: false };
    } catch (err) {
        return { content: `ERROR: resume failed — ${(err as Error).message}`, isError: true };
    }
}

export async function skipNext(): Promise<{ content: string; isError: boolean }> {
    if (!nativeAvailable()) {
        return { content: JSON.stringify({ status: 'unsupported_on_web' }), isError: false };
    }
    try {
        await AppleMusicNative.next();
        return { content: JSON.stringify({ status: 'skipped_to_next' }), isError: false };
    } catch (err) {
        return { content: `ERROR: skip failed — ${(err as Error).message}`, isError: true };
    }
}

export async function skipPrevious(): Promise<{ content: string; isError: boolean }> {
    if (!nativeAvailable()) {
        return { content: JSON.stringify({ status: 'unsupported_on_web' }), isError: false };
    }
    try {
        await AppleMusicNative.previous();
        return { content: JSON.stringify({ status: 'skipped_to_previous' }), isError: false };
    } catch (err) {
        return { content: `ERROR: previous failed — ${(err as Error).message}`, isError: true };
    }
}

/**
 * Read back what's currently playing. Returns null-typed fields when
 * nothing is queued — Calypso interprets `is_playing: false` AND empty
 * title as "nothing's playing" rather than failing.
 *
 * Position + duration are in whole seconds — Calypso converts to
 * "two minutes in, six minutes total" style narration server-side.
 */
export async function nowPlaying(): Promise<{ content: string; isError: boolean }> {
    if (!nativeAvailable()) {
        return {
            content: JSON.stringify({
                status: 'unsupported_on_web',
                note: 'Now-playing read-back requires the native iOS plugin.',
            }),
            isError: false,
        };
    }
    try {
        const np = await AppleMusicNative.nowPlaying();
        // Help Calypso phrase the answer naturally: convert raw seconds
        // to minutes-and-seconds for the position + duration so the LLM
        // doesn't have to do mental arithmetic.
        const positionLabel = formatDuration(np.position_sec);
        const durationLabel = formatDuration(np.duration_sec);
        return {
            content: JSON.stringify({
                ...np,
                position_label: positionLabel,
                duration_label: durationLabel,
                note:
                    np.title.length === 0
                        ? 'Nothing currently playing on Apple Music. Tell the skipper plainly.'
                        : 'Read back the title + artist naturally; mention how far in only if the skipper asks.',
            }),
            isError: false,
        };
    } catch (err) {
        return { content: `ERROR: nowPlaying failed — ${(err as Error).message}`, isError: true };
    }
}

/** "138" → "two minutes 18 seconds" (TTS-friendly). */
function formatDuration(totalSec: number): string {
    if (!isFinite(totalSec) || totalSec <= 0) return 'unknown';
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    if (m === 0) return `${s} seconds`;
    if (s === 0) return `${m} ${m === 1 ? 'minute' : 'minutes'}`;
    return `${m} ${m === 1 ? 'minute' : 'minutes'} ${s} seconds`;
}

/**
 * Open Apple Music's "Now Playing" view. Useful when the skipper asks
 * "show me what's playing" and wants the visual; the audio is already
 * coming out of the speakers.
 */
export async function showNowPlaying(): Promise<{ content: string; isError: boolean }> {
    if (!Capacitor.isNativePlatform()) {
        return {
            content: JSON.stringify({ status: 'unsupported_on_web' }),
            isError: false,
        };
    }
    try {
        // Generic Apple Music open — lands on whatever screen the app
        // was on, typically Now Playing if music is active.
        dispatchUrl('music://');
        return {
            content: JSON.stringify({ status: 'opened_apple_music' }),
            isError: false,
        };
    } catch (err) {
        return { content: `ERROR: ${(err as Error).message}`, isError: true };
    }
}
