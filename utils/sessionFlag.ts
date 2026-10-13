/**
 * The foreground-session flag's keys and build fingerprint, shared by the
 * session watch (services/webContentKill.ts, loaded lazily) and the one boot
 * step that must read the flag before that watch has run: the tablet start
 * (utils/glassBesideChartStart.ts lastSessionDiedInForeground).
 */

/** Raised while the app is in the foreground; cleared on an orderly exit. */
export const SESSION_OPEN_KEY = 'thalassa.sessionOpen';
/** The running tally of sessions that ended without one. */
export const ABNORMAL_EXITS_KEY = 'thalassa.abnormalExits';

/**
 * A fingerprint of the running build, from the hashed bundle filename.
 *
 * Vite emits /assets/index-<hash>.js and the hash changes on every build, so
 * this identifies the install without a build-time constant or an async
 * Capacitor call on the boot path.
 *
 * Needed because an Xcode "Run" TERMINATES the previous app in the foreground.
 * Shane installed builds all day on 2026-08-09 and every one of them looked
 * exactly like a crash to this module — same missing cleanup, same raised flag.
 * A death across a build change is a reinstall, not a fault.
 */
export function buildFingerprint(): string | null {
    try {
        const scripts = document.getElementsByTagName('script');
        for (const script of Array.from(scripts)) {
            const src = script.getAttribute('src') || '';
            const match = src.match(/\/assets\/[^/]*-([A-Za-z0-9_-]{6,})\.js/);
            if (match) return match[1];
        }
    } catch {
        /* fall through */
    }
    return null;
}
