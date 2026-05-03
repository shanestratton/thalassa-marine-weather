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
    getLibraryStats(): Promise<{
        auth_status: string;
        auth_granted: boolean;
        artists: number;
        albums: number;
        songs: number;
        playlists: number;
        sample_artists: string[];
        sample_playlists: string[];
    }>;
    playFirstSong(): Promise<{
        status: 'playing' | 'permission_denied' | 'library_empty';
        auth_status?: string;
        title: string;
        artist: string;
        album?: string;
        library_song_count?: number;
    }>;
    searchAndPlay(opts: { query: string; kind?: 'auto' | 'artist' | 'album' | 'playlist' | 'song' }): Promise<{
        status: 'playing' | 'not_found_in_library' | 'permission_denied';
        matched_kind: '' | 'artist' | 'album' | 'playlist' | 'song';
        title: string;
        subtitle?: string;
        track_count?: number;
        // Library counts surfaced on a miss so Calypso can narrate
        // ("checked 47 artists, none matched") instead of silently
        // falling through to catalog.
        library_artists?: number;
        library_albums?: number;
        library_songs?: number;
        library_playlists?: number;
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
 * Direct probe into Capacitor's plugin registry. When a plugin's
 * native implementation IS compiled into the iOS binary, the plugin
 * appears under `Capacitor.Plugins.AppleMusic` as a real proxy.
 * When it's NOT compiled, calls to it reject with a standard
 * "AppleMusic plugin is not implemented on ios" error.
 *
 * Surfacing this lets the diagnostic UI distinguish between
 *   (a) plugin entirely missing from the binary (Xcode build issue)
 *   (b) plugin present but throwing in a method
 *   (c) plugin present but auth/library issue
 *
 * Returns null on web / non-iOS.
 */
export function probeNativePluginPresence(): { registered: boolean; rawShape: string } | null {
    if (!nativeAvailable()) return null;
    try {
        const cap = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor;
        const plugin = cap?.Plugins?.AppleMusic;
        return {
            registered: !!plugin,
            rawShape: plugin ? typeof plugin : 'undefined',
        };
    } catch {
        return { registered: false, rawShape: 'probe-threw' };
    }
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

    /** Tracks whether the native plugin path was attempted but failed
     *  (e.g. plugin not registered, threw, or returned library-miss).
     *  Used to attach a more informative `library_miss_detail` to the
     *  URL-scheme tool result so Calypso narrates exactly what
     *  happened instead of silently handing off. */
    let nativeMissDetail:
        | { reason: 'plugin_error'; error: string }
        | { reason: 'library_miss'; counts: { artists: number; albums: number; songs: number; playlists: number } }
        | null = null;

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
                        note: `Playing from the skipper's library. Narrate back briefly: "Playing ${r.title}${r.subtitle ? ` — ${r.subtitle}` : ''} from your library."`,
                    }),
                    isError: false,
                };
            }
            if (r.status === 'permission_denied') {
                return {
                    content: JSON.stringify({
                        status: 'permission_denied',
                        note: "The skipper denied Apple Music library access (or hasn't granted it yet). Tell them they can flip it on in iOS Settings → Thalassa → Apple Music.",
                    }),
                    isError: false,
                };
            }
            // Library miss → capture stats so the URL fallback has
            // something to narrate ("not in your library — handed
            // off to Apple Music for catalog search; you've got 47
            // artists in library, none matched").
            nativeMissDetail = {
                reason: 'library_miss',
                counts: {
                    artists: r.library_artists ?? 0,
                    albums: r.library_albums ?? 0,
                    songs: r.library_songs ?? 0,
                    playlists: r.library_playlists ?? 0,
                },
            };
        } catch (nativeErr) {
            console.warn('[appleMusic] native plugin failed, falling back to URL scheme', nativeErr);
            nativeMissDetail = { reason: 'plugin_error', error: (nativeErr as Error).message };
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
        const note = composeFallbackNote(trimmed, nativeMissDetail);
        return {
            content: JSON.stringify({
                status: 'launched_apple_music_catalog',
                source: 'catalog',
                query: trimmed,
                miss_detail: nativeMissDetail,
                note,
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

/**
 * Compose the narration note Calypso reads when we fall back to URL.
 * The whole point of this is that the skipper knows EXACTLY why the
 * catalog hand-off happened: not in their library (with counts), or
 * the native plugin failed (with the error), or the plugin isn't
 * available on this device. Silence on this is what made the bug so
 * confusing the first time round.
 */
function composeFallbackNote(
    query: string,
    detail: {
        reason: 'plugin_error' | 'library_miss';
        error?: string;
        counts?: { artists: number; albums: number; songs: number; playlists: number };
    } | null,
): string {
    if (!detail) {
        // No native attempt was made (web / no plugin). Generic note.
        return `Handed off to Apple Music for the search. The skipper's iPhone will resolve "${query}". You cannot read back what plays from this path.`;
    }
    if (detail.reason === 'plugin_error') {
        return `The native music plugin returned an error (${detail.error}). Handed off to the Apple Music app instead. Tell the skipper plainly: "I couldn't reach your library directly — opened Apple Music to search instead. May need a clean Xcode build to wire the native plugin properly."`;
    }
    // library_miss
    const counts = detail.counts;
    if (!counts) {
        return `"${query}" wasn't in the skipper's library. Handed off to Apple Music for catalog search.`;
    }
    if (counts.songs === 0 && counts.artists === 0 && counts.albums === 0 && counts.playlists === 0) {
        return `The skipper's Apple Music library appears empty (no songs / artists / albums / playlists visible). Handed off to Apple Music. Tell them: "I can see your library but it looks empty — make sure you've added music to your Library, not just streamed it."`;
    }
    return `"${query}" wasn't in the skipper's library (checked ${counts.artists} artists, ${counts.albums} albums, ${counts.songs} songs, ${counts.playlists} playlists). Handed off to the Apple Music app for catalog search. Tell the skipper: "Not in your library — opened Apple Music to search the catalog. You'll need to pick a track to play it; I can't auto-play catalog tracks."`;
}

// ── Smoke-test playback ────────────────────────────────────────────

/**
 * Play the first song in the library directly. Bypasses search,
 * matching, the LLM round-trip, and the URL fallback. Pure smoke
 * test of the playback path: "is `MPMusicPlayerController.play()`
 * actually doing anything when we hand it a known-valid item?"
 *
 * Used by the Settings → Calypso → Apple Music "Play first song"
 * diagnostic button. If this WORKS but `play_music` doesn't, the
 * problem is search-side. If this ALSO doesn't work, it's the
 * playback pipeline (audio session conflict, permission, hardware).
 */
export interface PlayFirstSongResult {
    success: boolean;
    status: 'playing' | 'permission_denied' | 'library_empty' | 'plugin_error' | 'unsupported';
    title?: string;
    artist?: string;
    album?: string;
    library_song_count?: number;
    auth_status?: string;
    error?: string;
}

/**
 * Direct-call wrapper around the native plugin's getLibraryStats.
 * Returns a clean object for the Settings UI's "Inspect library"
 * button — separate from `musicDiagnostic` (which envelopes the
 * data in a Calypso-tool-result shape).
 */
export interface LibraryInspection {
    available: boolean;
    /** Reason the inspection failed when available=false. */
    reason?: 'unsupported' | 'plugin_error' | 'permission_denied';
    error?: string;
    auth_status?: string;
    auth_granted?: boolean;
    artists: number;
    albums: number;
    songs: number;
    playlists: number;
    sample_artists: string[];
    sample_playlists: string[];
}

export async function inspectLibrary(): Promise<LibraryInspection> {
    if (!nativeAvailable()) {
        return {
            available: false,
            reason: 'unsupported',
            artists: 0,
            albums: 0,
            songs: 0,
            playlists: 0,
            sample_artists: [],
            sample_playlists: [],
        };
    }
    try {
        const r = await AppleMusicNative.getLibraryStats();
        return {
            available: r.auth_granted,
            reason: r.auth_granted ? undefined : 'permission_denied',
            auth_status: r.auth_status,
            auth_granted: r.auth_granted,
            artists: r.artists,
            albums: r.albums,
            songs: r.songs,
            playlists: r.playlists,
            sample_artists: r.sample_artists,
            sample_playlists: r.sample_playlists,
        };
    } catch (err) {
        return {
            available: false,
            reason: 'plugin_error',
            error: (err as Error).message,
            artists: 0,
            albums: 0,
            songs: 0,
            playlists: 0,
            sample_artists: [],
            sample_playlists: [],
        };
    }
}

export async function playFirstSong(): Promise<PlayFirstSongResult> {
    if (!nativeAvailable()) {
        return {
            success: false,
            status: 'unsupported',
            error: 'Native plugin only available on iOS.',
        };
    }
    try {
        const r = await AppleMusicNative.playFirstSong();
        return {
            success: r.status === 'playing',
            status: r.status,
            title: r.title,
            artist: r.artist,
            album: r.album,
            library_song_count: r.library_song_count,
            auth_status: r.auth_status,
        };
    } catch (err) {
        return {
            success: false,
            status: 'plugin_error',
            error: (err as Error).message,
        };
    }
}

// ── Diagnostic ─────────────────────────────────────────────────────

/**
 * Returns a snapshot of what the native plugin can actually see in
 * the user's Apple Music library. Useful when "play X" silently
 * falls through to URL — the skipper can ask "Calypso, what music
 * can you see?" and get a concrete answer instead of guessing
 * whether it's permissions, an empty library, or the plugin not
 * being loaded.
 *
 * Returns the auth status + counts for each kind + a small sample
 * of artist + playlist names so Calypso can name a few in the
 * narration ("you've got 47 artists including Pink Floyd, Dire
 * Straits, Jimmy Buffett").
 */
export async function musicDiagnostic(): Promise<{ content: string; isError: boolean }> {
    if (!nativeAvailable()) {
        return {
            content: JSON.stringify({
                status: 'unsupported',
                note: "The diagnostic requires the native iOS plugin. On web / non-iOS we can't inspect the music library.",
            }),
            isError: false,
        };
    }
    try {
        const stats = await AppleMusicNative.getLibraryStats();
        const total = stats.artists + stats.albums + stats.songs + stats.playlists;
        return {
            content: JSON.stringify({
                status: 'ok',
                ...stats,
                empty: total === 0,
                note: !stats.auth_granted
                    ? 'Permission for Apple Music library access has not been granted. Tell the skipper: "I don\'t have access to your library yet — first time you ask me to play something, iOS will prompt; or grant it now in Settings → Thalassa → Apple Music."'
                    : total === 0
                      ? 'The library is visible but empty. Probably means the skipper streams via Apple Music subscription but hasn\'t saved anything to their Library. Tell them they need to "Add to Library" tracks they want voice-control over.'
                      : `Library is healthy. ${stats.artists} artists, ${stats.songs} songs, ${stats.playlists} playlists. Sample artists: ${stats.sample_artists.slice(0, 3).join(', ')}. Read a brief summary; mention 2-3 sample artists to make it concrete.`,
            }),
            isError: false,
        };
    } catch (err) {
        return {
            content: JSON.stringify({
                status: 'plugin_error',
                error: (err as Error).message,
                note: 'The native plugin threw — likely the .swift / .m files aren\'t actually compiled into this build yet. Tell the skipper: "Native music plugin isn\'t loaded — Xcode needs a clean build (Product → Clean Build Folder, then rebuild) to pick up the new files."',
            }),
            isError: false,
        };
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
