/**
 * The Captain's Table copy of a recipe follows an edit saved on the phone
 * (132-B18, binder audit GAL-04).
 *
 * A recipe shared from the Captain's Table's own form has two rows with one
 * id: its library row (`recipes`, which the outbox syncs) and its Captain's
 * Table copy (`community_recipes`). The Captain's Table reads the copy until
 * the held one-store migration is pushed (recipeStoreColumn.ts), and builds
 * before 132 read it after that. An edit now saves on the phone first and its
 * library row goes out through the outbox; this sends the same change to the
 * copy. Straight away when the phone is online, else the next time an edit is
 * saved, the Galley opens or the Captain's Table loads. Until then the copy
 * shows the recipe as it was. A recipe written in the Galley has no copy, and
 * nothing is sent for it.
 *
 * Text and settings only. A change to a stored photo goes to the server
 * first, through updateCustomRecipe's own path, so this never moves or
 * removes a photo: it copies image_url only when neither the copy's photo nor
 * the new one is a stored recipe photo. The waiting list is this account's,
 * on this phone (authScopedStorageKey): ids only, never the recipe.
 */
import { supabase } from '../supabase';
import { getById } from '../vessel/LocalDatabase';
import { authScopedStorageKey, getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../authIdentityScope';
import { createLogger, getErrorMessage } from '../../utils/createLogger';
import { parseRecipeSteps } from './recipeRefs';
import { isManagedRecipePhotoUrl } from './recipePhotoUrls';

// A device-log trace (GAL-13): a reason and the error message, never an id.
const log = createLogger('Galley');

const PENDING_KEY = 'thalassa_recipe_copies_pending_v1';
const COMMUNITY_TABLE = 'community_recipes';

/** The library row fields the copy takes. */
interface CopySource {
    id: string;
    user_id: string | null;
    title: string;
    image_url: string;
    ready_in_minutes: number;
    servings: number;
    instructions: string;
    ingredients: unknown[];
    tags: string[];
    visibility: 'personal' | 'shared';
}

function readPending(): string[] {
    try {
        const raw = localStorage.getItem(authScopedStorageKey(PENDING_KEY));
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
    } catch {
        return [];
    }
}

function writePending(ids: string[]): void {
    try {
        if (ids.length === 0) localStorage.removeItem(authScopedStorageKey(PENDING_KEY));
        else localStorage.setItem(authScopedStorageKey(PENDING_KEY), JSON.stringify(ids));
    } catch {
        /* storage full: the copy waits for the next edit */
    }
}

/** The recipes whose Captain's Table copy still waits for an edit. */
export function pendingCommunityCopies(): string[] {
    return readPending();
}

/** An edit to this recipe was saved on the phone: its copy (if any) must follow. */
export function markCommunityCopyPending(recipeId: string): void {
    const pending = readPending();
    if (!pending.includes(recipeId)) writePending([...pending, recipeId]);
}

/** What the copy takes from the library row. */
export function communityCopyPatch(row: CopySource, copyImage: string | null | undefined): Record<string, unknown> {
    const image = row.image_url || '';
    return {
        title: row.title,
        ready_in_minutes: row.ready_in_minutes,
        servings: row.servings,
        ingredients: row.ingredients ?? [],
        tags: row.tags ?? [],
        visibility: row.visibility === 'shared' ? 'community' : 'private',
        instructions: parseRecipeSteps(row.instructions),
        ...(isManagedRecipePhotoUrl(image) || isManagedRecipePhotoUrl(copyImage) ? {} : { image_url: image || null }),
        updated_at: new Date().toISOString(),
    };
}

/** 'done': sent, or nothing to send. 'retry': keep it waiting. */
async function sendCopy(recipeId: string): Promise<'done' | 'retry'> {
    const scope = getAuthIdentityScope();
    let row: CopySource | null;
    try {
        row = getById<CopySource>('recipes', recipeId);
    } catch (error) {
        log.warn('galley: recipe-copy', getErrorMessage(error));
        return 'retry';
    }
    // Deleted since (deleteCustomRecipe took the copy with it), or not this
    // account's recipe: nothing for this phone to send.
    if (!row || !row.user_id || row.user_id !== scope.userId) return 'done';
    if (!supabase) return 'retry';
    try {
        const {
            data: { session },
        } = await supabase.auth.getSession();
        if (session?.user?.id !== row.user_id || !isAuthIdentityScopeCurrent(scope)) return 'retry';
        const read = await supabase
            .from(COMMUNITY_TABLE)
            .select('id, user_id, image_url')
            .eq('id', recipeId)
            .eq('user_id', row.user_id)
            .maybeSingle();
        if (read.error || !isAuthIdentityScopeCurrent(scope)) return 'retry';
        if (!read.data) return 'done';
        const written = await supabase
            .from(COMMUNITY_TABLE)
            .update(communityCopyPatch(row, (read.data as { image_url?: string | null }).image_url))
            .eq('id', recipeId)
            .eq('user_id', row.user_id)
            .select('id, user_id')
            .maybeSingle();
        if (written.error || (written.data as { id?: unknown } | null)?.id !== recipeId) return 'retry';
        return 'done';
    } catch (error) {
        log.warn('galley: recipe-copy', getErrorMessage(error));
        return 'retry';
    }
}

let flushing: Promise<number> | null = null;

/**
 * Send every waiting copy. Never throws; resolves to how many still wait.
 * Two calls at once share one run.
 */
export function flushCommunityCopies(): Promise<number> {
    if (flushing) return flushing;
    const run = async () => {
        try {
            const scope = getAuthIdentityScope();
            for (const recipeId of readPending()) {
                if (!isAuthIdentityScopeCurrent(scope)) break;
                if ((await sendCopy(recipeId)) === 'done' && isAuthIdentityScopeCurrent(scope)) {
                    writePending(readPending().filter((id) => id !== recipeId));
                }
            }
        } catch (error) {
            log.warn('galley: recipe-copy', getErrorMessage(error));
        }
        return readPending().length;
    };
    // Cleared once the run settles, never before it is stored (a run with
    // nothing to send finishes in the same tick it starts).
    flushing = run()
        .catch(() => readPending().length)
        .finally(() => {
            flushing = null;
        });
    return flushing;
}
