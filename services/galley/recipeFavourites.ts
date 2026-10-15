/**
 * A sailor's favourite recipes (132-B18, binder audit GAL-08).
 *
 * The Galley's Favourite badge read recipes.is_favorite, which nothing ever
 * set, while the Captain's Table kept its hearts in a list of its own. Now
 * there is one list, keyed by the recipe's id, which is the same id in the
 * Galley and on the Captain's Table: a heart on one is a star on the other.
 * It is this account's list on this phone (authScopedStorageKey). It does
 * not follow the sailor to another device, and in a skipper's shared galley
 * it marks the skipper's recipes for this sailor only.
 *
 * Its own small module so the Galley page reads it without pulling in (or
 * every page test re-mocking) the recipe service.
 */
import { authScopedStorageKey } from '../authIdentityScope';

/** The key the Captain's Table has always used, scoped to the account. */
const FAVOURITES_KEY = 'thalassa_galley_favourites';

/** The ids of this account's favourite recipes. */
export function getFavouriteIds(): Set<string> {
    try {
        const raw = localStorage.getItem(authScopedStorageKey(FAVOURITES_KEY));
        if (raw) return new Set(JSON.parse(raw) as string[]);
    } catch {
        /* ignore */
    }
    return new Set();
}

/** Toggle a recipe as favourite. Returns new favourite state. */
export function toggleFavourite(recipeId: string): boolean {
    const favs = getFavouriteIds();
    const isFav = favs.has(recipeId);
    if (isFav) {
        favs.delete(recipeId);
    } else {
        favs.add(recipeId);
    }
    try {
        localStorage.setItem(authScopedStorageKey(FAVOURITES_KEY), JSON.stringify([...favs]));
    } catch {
        /* storage full */
    }
    return !isFav;
}
