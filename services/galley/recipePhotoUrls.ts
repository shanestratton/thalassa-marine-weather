/**
 * Which recipe photo URLs are stored recipe photos (the public `recipe-photos`
 * bucket), and whose. Pure: no storage, no network.
 *
 * Moved out of GalleyRecipeService (132-B18) so the Captain's Table copy of a
 * recipe (recipeCommunityCopy.ts) can tell a stored photo from a link without
 * importing the recipe service. A stored photo is only ever moved or taken
 * down by the server-first paths in GalleyRecipeService.
 */

export const RECIPE_PHOTO_BUCKET = 'recipe-photos';

/** Is this a URL into the recipe-photos bucket? */
export function isManagedRecipePhotoUrl(value: string | null | undefined): boolean {
    if (!value) return false;
    try {
        const url = new URL(value);
        return url.pathname.includes(`/recipe-photos/`);
    } catch {
        return false;
    }
}

/**
 * The bucket path of this owner's photo for this recipe, when the URL is one
 * (`<owner>/<recipe>.jpg`, or the legacy `<recipe>.jpg`), else null.
 */
export function managedPhotoPathFromUrl(
    value: string | null | undefined,
    ownerId: string,
    recipeId: string,
): string | null {
    if (!value) return null;
    try {
        const url = new URL(value);
        const markers = [
            `/storage/v1/object/public/${RECIPE_PHOTO_BUCKET}/`,
            `/storage/v1/object/sign/${RECIPE_PHOTO_BUCKET}/`,
        ];
        const marker = markers.find((candidate) => url.pathname.includes(candidate));
        if (!marker) return null;
        const path = decodeURIComponent(url.pathname.slice(url.pathname.indexOf(marker) + marker.length));
        if (path.includes('..') || path.includes('\\')) return null;
        const ownerPath = `${ownerId}/${recipeId}.jpg`;
        const legacyPath = `${recipeId}.jpg`;
        return path === ownerPath || path === legacyPath ? path : null;
    } catch {
        return null;
    }
}
