/**
 * Is the one recipe store on the server yet? (132-B18, binder audit GAL-06,
 * GAL-08, GAL-16; Shane 15 Oct: one store for your own and shared recipes)
 *
 * The change comes with a HELD migration
 * (supabase/held-migrations/20261015170000_recipes_one_store.sql) that Shane
 * pushes himself. It moves the Captain's Table onto `recipes` (sharing is
 * visibility 'shared' there), with the author's name and the ratings on the
 * row, and lets crew change a personal recipe in a skipper's galley they may
 * write. Until it is live the app keeps today's two stores: the Captain's
 * Table reads community_recipes, plus the recipes shared from the Galley,
 * which it cannot rate yet, and only a recipe's owner changes it.
 *
 * A COLUMN PROBE of recipes.rating_avg says it is live: a read that names the
 * column and asks for no rows. "Absent", "could not ask" and "not asked yet"
 * all mean: two stores. A present column is remembered for the session; an
 * absent one is asked again after an hour (the push may happen while the app
 * is open); a probe that failed or did not answer in time is asked again next
 * time. The same pattern as services/vessel/maintenanceHistoryColumn.ts.
 */
import { createLogger } from '../../utils/createLogger';

const log = createLogger('Galley.RecipeStore');

const PROBE_TIMEOUT_MS = 5_000;
const ABSENT_RECHECK_MS = 60 * 60_000;

type Known = { present: true } | { present: false; at: number };
let known: Known | null = null;
let inFlight: Promise<boolean> | null = null;

/** The minimal client surface the probe needs (a Supabase client satisfies it). */
interface ProbeClient {
    from: (table: string) => {
        select: (columns: string) => {
            limit: (count: number) => PromiseLike<{ error: { code?: string; message?: string } | null }>;
        };
    };
}

function missingColumn(error: { code?: string; message?: string }): boolean {
    // 42703: undefined column (Postgres). PGRST204: column not in PostgREST's schema cache.
    if (error.code === '42703' || error.code === 'PGRST204') return true;
    return /rating_avg/.test(error.message ?? '') && /does not exist|could not find/i.test(error.message ?? '');
}

/**
 * Ask (or remember) whether the one recipe store is live. Never throws;
 * false unless the column was seen. `client` is the Supabase client.
 */
export async function recipesOneStore(client: unknown, now = Date.now()): Promise<boolean> {
    if (known?.present) return true;
    if (known && !known.present && now - known.at < ABSENT_RECHECK_MS) return false;
    if (inFlight) return inFlight;
    const ask = async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const probe = (client as ProbeClient).from('recipes').select('rating_avg').limit(0);
            const result = await Promise.race([
                Promise.resolve(probe),
                new Promise<null>((resolve) => {
                    timer = setTimeout(() => resolve(null), PROBE_TIMEOUT_MS);
                }),
            ]);
            if (!result) return false; // timed out: unknown, ask next time
            if (!result.error) {
                known = { present: true };
                log.warn('recipes.rating_avg is present: one recipe store');
                return true;
            }
            if (missingColumn(result.error)) {
                known = { present: false, at: now };
                return false;
            }
            return false; // some other refusal (signed out, say): unknown, ask next time
        } catch {
            return false; // offline or no client: unknown, ask next time
        } finally {
            if (timer) clearTimeout(timer);
        }
    };
    // Cleared once the probe settles, never before it is stored: a client
    // that throws at once settles in the same tick the probe starts.
    inFlight = ask().finally(() => {
        inFlight = null;
    });
    return inFlight;
}

/**
 * Has the column already been SEEN this session? A synchronous peek for a
 * save, which must not wait on the network: until a probe has answered, a
 * crew member's change to a skipper's recipe is not offered or queued.
 */
export function recipesOneStoreKnown(): boolean {
    return known?.present === true;
}

/** Tests only. */
export function __resetRecipeStoreColumnForTests(): void {
    known = null;
    inFlight = null;
}
