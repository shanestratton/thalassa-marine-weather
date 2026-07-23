/**
 * Spoken-audio integrations for Calypso — audiobooks + podcasts.
 *
 * Same hand-off pattern as appleMusic's URL-scheme path: we don't
 * have a native plugin for these (audiobooks especially — Audible's
 * SDK is locked behind enterprise licensing). We hand the OS a URL
 * scheme and let the respective app take it from there.
 *
 * Capabilities the URL schemes give us:
 *   - Audible: open the app, optionally to a search query.
 *     `audible://library` deep-links to library; `audible://` opens.
 *   - Apple Podcasts: search via `pcast://podcasts.apple.com/search?term=...`
 *     or universal-link form `https://podcasts.apple.com/search?term=...`.
 *
 * What we LOSE relative to native: no playback control (pause/skip),
 * no now-playing read-back. The skipper has to handle those from the
 * lock screen / CarPlay / the app itself. Calypso narrates this
 * limitation honestly — same pattern as the URL-scheme catalog play
 * for music.
 *
 * Why not a native plugin: Audible has no public iOS SDK, and Apple
 * Podcasts' MPMediaQuery surface is incomplete (you can't reliably
 * enumerate podcast episodes the way you can songs). The URL-scheme
 * hand-off is the practical ceiling without significant infrastructure
 * we don't need today.
 */

import { Capacitor } from '@capacitor/core';

function dispatchUrl(url: string): void {
    const opened = window.open(url, '_self');
    if (!opened) {
        window.location.href = url;
    }
}

function openExternalWebUrl(url: string): void {
    window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * Open Audible. Optional `query` opens the search UI pre-filled —
 * Audible doesn't auto-play search results, the skipper picks one.
 * Empty query opens Audible's library landing page.
 */
export async function playAudiobook(query: string): Promise<{ content: string; isError: boolean }> {
    const trimmed = (query || '').trim();
    const encoded = encodeURIComponent(trimmed);

    // Audible URL schemes:
    //   audible://             — open app (lands on whatever was last)
    //   audible://library      — library tab
    //   audible://search/<q>   — search with query (best for "play me X")
    //   https://www.audible.com/search?keywords=<q> — universal link
    //                                                  fallback for web
    const audibleUrl = trimmed ? `audible://search/${encoded}` : 'audible://library';
    const universalUrl = trimmed
        ? `https://www.audible.com/search?keywords=${encoded}`
        : 'https://www.audible.com/library';

    if (!Capacitor.isNativePlatform()) {
        try {
            openExternalWebUrl(universalUrl);
            return {
                content: JSON.stringify({
                    status: 'opened_web',
                    query: trimmed,
                    note: 'Opened the Audible website in a new tab. Native playback requires the iOS app.',
                }),
                isError: false,
            };
        } catch (err) {
            return { content: `ERROR: failed to open Audible — ${(err as Error).message}`, isError: true };
        }
    }

    try {
        dispatchUrl(audibleUrl);
        return {
            content: JSON.stringify({
                status: 'launched_audible',
                query: trimmed,
                note: 'Audible opened. Tell the skipper: "Audible up — pick the title and tap play, I can\'t auto-play audiobooks."',
            }),
            isError: false,
        };
    } catch (nativeErr) {
        try {
            dispatchUrl(universalUrl);
            return {
                content: JSON.stringify({
                    status: 'launched_audible_via_universal_link',
                    query: trimmed,
                }),
                isError: false,
            };
        } catch (fallbackErr) {
            const detail = (fallbackErr as Error).message || (nativeErr as Error).message;
            return { content: `ERROR: could not open Audible — ${detail}`, isError: true };
        }
    }
}

/**
 * Open Apple Podcasts to a search. Apple Podcasts unlike Music does
 * NOT auto-play from URL schemes — search results page only. Skipper
 * picks an episode + taps play. Calypso narrates this limit.
 */
export async function playPodcast(query: string): Promise<{ content: string; isError: boolean }> {
    const trimmed = (query || '').trim();
    if (!trimmed) {
        return { content: 'ERROR: podcast query is empty', isError: true };
    }
    const encoded = encodeURIComponent(trimmed);
    const podcastUrl = `pcast://podcasts.apple.com/search?term=${encoded}`;
    const universalUrl = `https://podcasts.apple.com/search?term=${encoded}`;

    if (!Capacitor.isNativePlatform()) {
        try {
            openExternalWebUrl(universalUrl);
            return {
                content: JSON.stringify({
                    status: 'opened_web',
                    query: trimmed,
                    note: 'Opened podcasts.apple.com in a new tab.',
                }),
                isError: false,
            };
        } catch (err) {
            return { content: `ERROR: failed to open Podcasts — ${(err as Error).message}`, isError: true };
        }
    }

    try {
        dispatchUrl(podcastUrl);
        return {
            content: JSON.stringify({
                status: 'launched_podcasts',
                query: trimmed,
                note: 'Podcasts opened to search results. Calypso says: "Podcasts up — pick an episode and tap play, search can\'t auto-play."',
            }),
            isError: false,
        };
    } catch (nativeErr) {
        try {
            dispatchUrl(universalUrl);
            return {
                content: JSON.stringify({
                    status: 'launched_podcasts_via_universal_link',
                    query: trimmed,
                }),
                isError: false,
            };
        } catch (fallbackErr) {
            const detail = (fallbackErr as Error).message || (nativeErr as Error).message;
            return { content: `ERROR: could not open Podcasts — ${detail}`, isError: true };
        }
    }
}
