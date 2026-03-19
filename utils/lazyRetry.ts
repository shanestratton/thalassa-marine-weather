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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyRetry<T extends React.ComponentType<any>>(
    factory: () => Promise<{ default: T }>,
    moduleName?: string,
): React.LazyExoticComponent<T> {
    return React.lazy(() =>
        factory().catch((err: Error) => {
            // Use a module-specific key so one failed module doesn't block others
            const key = `lazyRetry_${moduleName ?? 'default'}`;
            if (!sessionStorage.getItem(key)) {
                sessionStorage.setItem(key, '1');
                // Clear ALL stale retry keys that are older than this session
                // (in case user had a previous failed session)
                window.location.reload();
                // Return a never-resolving promise to stop React rendering during reload
                return new Promise<{ default: T }>(() => {});
            }
            // If we already retried this module, clear the key and re-throw
            // so ErrorBoundary catches it instead of infinite reload loops
            sessionStorage.removeItem(key);
            throw err;
        }),
    );
}
