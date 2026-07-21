/**
 * lazyRetry — React.lazy() wrapper with automatic page reload on stale chunk errors.
 *
 * After a deploy, Vite generates new chunk hashes. Users with cached index.html
 * try to import the old chunk filename → 404 → "Failed to fetch dynamically
 * imported module". This wrapper reloads the page once to get fresh module URLs.
 *
 * Uses a per-module sessionStorage key to prevent infinite reload loops.
 */
import React from 'react';
import { crumb } from './flightRecorder';

/**
 * Global reload throttle. The per-module keys alone allowed a reload
 * PING-PONG (field bug 2026-07-09, "page refreshes every 10 seconds"):
 * module A fails → reload (keyA set) → A fails again (keyA cleared,
 * thrown) but module B fails → reload (keyB set) → A fails → reload
 * (keyA re-set)… — with a service worker serving a stale chunk
 * manifest, two failing modules re-armed each other forever and the
 * punter lost his trace every cycle. One reload per minute across ALL
 * modules; anything faster falls through to the ErrorBoundary, which
 * at least leaves the rest of the app standing.
 */
const GLOBAL_COOLDOWN_KEY = 'lazyRetry_lastReloadAt';
const RELOAD_COOLDOWN_MS = 60_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyRetry<T extends React.ComponentType<any>>(
    factory: () => Promise<{ default: T }>,
    moduleName?: string,
): React.LazyExoticComponent<T> {
    return React.lazy(() =>
        factory().catch((err: Error) => {
            // Use a module-specific key so one failed module doesn't block others
            const key = `lazyRetry_${moduleName ?? 'default'}`;
            const lastReloadAt = Number(sessionStorage.getItem(GLOBAL_COOLDOWN_KEY) ?? 0);
            const cooledDown = Date.now() - lastReloadAt > RELOAD_COOLDOWN_MS;
            if (!sessionStorage.getItem(key) && cooledDown) {
                sessionStorage.setItem(key, '1');
                sessionStorage.setItem(GLOBAL_COOLDOWN_KEY, String(Date.now()));
                // This reload was previously silent — it lands the punter back
                // on the default page looking exactly like a crash. Leave a
                // trace so the two are never confused again.
                crumb('lazyRetry:reload', moduleName ?? 'default');
                window.location.reload();
                // Return a never-resolving promise to stop React rendering during reload
                return new Promise<{ default: T }>(() => {});
            }
            // Already retried this module (or a reload fired within the
            // cooldown): clear the key and re-throw so ErrorBoundary
            // catches it instead of an infinite reload loop.
            sessionStorage.removeItem(key);
            throw err;
        }),
    );
}
