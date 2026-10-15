/**
 * Who may change a saved recipe from the Galley (132-B18, binder audit GAL-08).
 *
 * The owner edits a recipe they wrote and deletes any of theirs (a recipe
 * saved when a meal was planned is theirs too, though it cannot be edited:
 * it is a copy of someone else's). In a skipper's shared galley, crew the
 * skipper lets write the Galley may change a personal recipe there, once the
 * held one-store migration is live (its policy lets them); before that the
 * server refuses it, so it is not offered. Crew never delete: the server
 * keeps that the skipper's. Pure: the page passes what it knows.
 */
import type { StoredRecipe } from '../GalleyRecipeService';
import type { BinderSource } from '../vessel/sharedBinders';

export interface SavedRecipeRights {
    edit: boolean;
    delete: boolean;
    /** Why Edit is not offered, when that is worth saying; else null. */
    editNote: string | null;
}

export function savedRecipeRights(
    recipe: Pick<StoredRecipe, 'user_id' | 'is_custom' | 'visibility'>,
    self: string | null,
    galley: BinderSource,
    oneStore: boolean,
): SavedRecipeRights {
    if (galley.mode === 'shared') {
        const skippers = recipe.user_id === galley.ownerId;
        if (!skippers) return { edit: false, delete: false, editNote: null };
        if (!galley.canWrite) {
            return { edit: false, delete: false, editNote: 'The galley is shared with you to look at, not change.' };
        }
        if (!recipe.is_custom) return { edit: false, delete: false, editNote: null };
        if (recipe.visibility !== 'personal') {
            return {
                edit: false,
                delete: false,
                editNote: 'Only the skipper can change a recipe shared on the Captain’s Table.',
            };
        }
        return oneStore
            ? { edit: true, delete: false, editNote: null }
            : { edit: false, delete: false, editNote: 'Only the skipper can change their recipes for now.' };
    }
    const mine = recipe.user_id === null || recipe.user_id === self;
    return {
        edit: mine && recipe.is_custom,
        delete: mine,
        // A copy saved when a meal was planned (or a row that lost its
        // is_custom before 126): nothing more is known, so nothing more is said.
        editNote: mine && !recipe.is_custom ? 'This recipe can’t be edited here.' : null,
    };
}
