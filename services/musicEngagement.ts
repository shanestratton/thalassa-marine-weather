/**
 * musicEngagement — singleton "has the user touched music this
 * session?" flag.
 *
 * Reset on every cold boot. Set to true when:
 *   - the user navigates to the Music page (signals intent)
 *   - any play / queue / search method runs in the AppleMusic
 *     service (caller has decided to do something with music)
 *
 * GlobalNowPlayingBar gates ALL its polling on this flag — auth
 * status, nowPlaying, everything. The boot trap was: even after
 * MusicKit auth was granted, the bar would happily poll forever
 * even though the user hadn't asked for any music. Logs showed
 * dozens of `AppleMusic nowPlaying` bridge calls per minute on a
 * silent app. With this flag, the bar literally does nothing
 * until the user shows intent.
 *
 * Subscribers re-render when the flag flips so the bar can start
 * polling instantly when music is engaged for the first time
 * (no missed-frame, no needs-restart).
 */

let engaged = false;
const listeners = new Set<(v: boolean) => void>();

export function isMusicEngaged(): boolean {
    return engaged;
}

export function markMusicEngaged(): void {
    if (engaged) return;
    engaged = true;
    listeners.forEach((fn) => {
        try {
            fn(true);
        } catch {
            /* ok */
        }
    });
}

export function subscribeMusicEngagement(fn: (v: boolean) => void): () => void {
    listeners.add(fn);
    return () => {
        listeners.delete(fn);
    };
}
