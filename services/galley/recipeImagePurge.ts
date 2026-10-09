/**
 * One-off clear-out of throwaway recipe photo copies (126-B2a, binder audit
 * GAL-12; Shane 2026-10-09: "check all of the binders to make sure that they
 * are at the same standard as the rest of the app").
 *
 * Every scheduling of a searched recipe used to cache its photo in
 * localStorage as a base64 data URI under the search result's fake id
 * (`thalassa_recipe_img_1791234567890.42`), with no cap and no reader: only
 * real Spoonacular ids (at most nine digits) are ever read back. Those copies
 * go, once per install, at idle when the Galley opens.
 *
 * Its own small module so the Galley page can call it without pulling in (or
 * every page test re-mocking) the recipe service.
 */

/** The key prefix GalleyRecipeService.cacheRecipeImage writes. */
export const RECIPE_IMAGE_CACHE_PREFIX = 'thalassa_recipe_img_';
const PURGE_DONE_KEY = 'thalassa_recipe_img_purge_v1';
const REAL_ID_KEY = /^\d{1,9}$/;

/** Removes every photo copy not keyed by a real id, once. Returns how many went. */
export function purgeOrphanRecipeImages(): number {
    try {
        if (localStorage.getItem(PURGE_DONE_KEY)) return 0;
        const orphans: string[] = [];
        for (let index = 0; index < localStorage.length; index += 1) {
            const key = localStorage.key(index);
            if (
                key?.startsWith(RECIPE_IMAGE_CACHE_PREFIX) &&
                key !== PURGE_DONE_KEY &&
                !REAL_ID_KEY.test(key.slice(RECIPE_IMAGE_CACHE_PREFIX.length))
            ) {
                orphans.push(key);
            }
        }
        for (const key of orphans) localStorage.removeItem(key);
        localStorage.setItem(PURGE_DONE_KEY, '1');
        return orphans.length;
    } catch {
        // Storage unavailable (private mode, blocked): try again next time.
        return 0;
    }
}

/** Runs the purge when the main thread is idle. Returns a cancel for an effect cleanup. */
export function purgeOrphanRecipeImagesWhenIdle(): () => void {
    const host = globalThis as {
        requestIdleCallback?: (callback: () => void) => number;
        cancelIdleCallback?: (handle: number) => void;
    };
    if (typeof host.requestIdleCallback === 'function') {
        const handle = host.requestIdleCallback(() => purgeOrphanRecipeImages());
        return () => host.cancelIdleCallback?.(handle);
    }
    // WKWebView has no requestIdleCallback.
    const timer = setTimeout(purgeOrphanRecipeImages, 2_000);
    return () => clearTimeout(timer);
}
