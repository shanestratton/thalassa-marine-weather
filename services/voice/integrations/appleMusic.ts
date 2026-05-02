/**
 * Apple Music integration for Calypso — URL-scheme based.
 *
 * Phase 1 implementation: launches the Apple Music app via iOS URL
 * schemes (`music://` / `https://music.apple.com/`). The iPhone resolves
 * the URL, Apple Music opens with the requested search or track, and
 * playback starts. We don't get any return data (no "now playing"
 * read-back, no playlist contents), but it covers 80% of voice-assistant
 * use: "play me some Pink Floyd", "queue Hotel California", etc.
 *
 * Phase 2 (future): native MusicKit plugin for full library read +
 * playback state. That'd let Calypso say "now playing: Comfortably
 * Numb, 2 minutes in" and the like.
 *
 * Why URL schemes are good enough for v1:
 *   - No native plugin to maintain
 *   - No NSAppleMusicUsageDescription permission prompt
 *   - Works on every iOS 12+ device with Apple Music installed
 *   - Apple Music handles the actual playback + UI
 *
 * Tools registered with Calypso when the skipper enables the
 * integration (via the Settings → Calypso Integrations toggle):
 *   - play_music({ query }): search-and-play. Calypso narrates back
 *     "playing X by Y in Apple Music."
 *
 * Why a single tool, not five: voice control benefits from one
 * intent-shaped surface. "Play X" / "queue X" / "play album X" all
 * funnel through one tool whose query string carries the intent.
 * Apple Music's search resolves the most-relevant track, album, or
 * playlist for the query.
 */

import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';

/**
 * Open Apple Music with a search-and-play action. Returns immediately
 * after handing off to the OS — we don't wait for or receive any
 * confirmation that playback started.
 *
 * Returns a result object suitable for handing back to Calypso as a
 * tool_result: `is_error: false` if the URL was dispatched, true if
 * something went wrong (no Apple Music installed, URL scheme rejected).
 */
export async function playMusicByQuery(query: string): Promise<{ content: string; isError: boolean }> {
    const trimmed = (query || '').trim();
    if (!trimmed) {
        return { content: 'ERROR: empty music query', isError: true };
    }

    // Apple Music's search URL scheme. Encoding the query so spaces +
    // special chars survive the URL round-trip. The `/search` route
    // opens Apple Music's search page with the query pre-filled and
    // (on iOS) auto-plays the top result for natural-language queries
    // like "play pink floyd dark side".
    const encoded = encodeURIComponent(trimmed);
    // music:// scheme: native Apple Music app deep link
    // https://music.apple.com/ scheme: Universal Link (also opens
    //   the app on iOS, with web fallback on other platforms)
    // We try the native scheme first since we know iOS; the universal
    // link is the fallback.
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

    // Native iOS path — try the music:// URL scheme first.
    try {
        await App.openUrl({ url: nativeUrl });
        return {
            content: JSON.stringify({
                status: 'launched_apple_music',
                query: trimmed,
                note: 'Apple Music app opened with search-and-play for the requested query. Calypso cannot read back what is currently playing — say so plainly if asked.',
            }),
            isError: false,
        };
    } catch (nativeErr) {
        // Fallback to the universal link
        try {
            await App.openUrl({ url: universalUrl });
            return {
                content: JSON.stringify({
                    status: 'launched_apple_music_via_universal_link',
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
        await App.openUrl({ url: 'music://' });
        return {
            content: JSON.stringify({ status: 'opened_apple_music' }),
            isError: false,
        };
    } catch (err) {
        return { content: `ERROR: ${(err as Error).message}`, isError: true };
    }
}
