/**
 * Galley rows an older build fenced in the outbox push again (126-B2b, binder
 * audit GAL-02 repair; Shane 2026-10-09: "check all of the binders to make
 * sure that they are at the same standard as the rest of the app").
 *
 * Before 126 a meal planned from a searched recipe stored the search result's
 * display key (Date.now() + Math.random(), about 1.79e12) in
 * meal_plans.spoonacular_id, and persistRecipe saved an ownerless copy of the
 * recipe under the same key, once per scheduling. Both columns are INTEGER:
 * Postgres refused every such row, the outbox retried it every cycle, and the
 * meal never reached the iPad or the crew. Nothing ever fixed the queued
 * payloads.
 *
 * Run once per database load (LocalDatabase's ready chain, before the sync
 * engine's first push). In this order, so that a crash at any point leaves a
 * state the next run finishes:
 *  1. meals: the display key is nulled in the row and every queued payload,
 *     and a meal with no recipe link is linked to the copy it was planned
 *     from (or that copy's survivor). A meal linked to a copy step 2 removes
 *     follows it to the survivor; one the server may already hold also
 *     queues an UPDATE of the link.
 *  2. duplicates: among copies the server provably never took (their first
 *     queued item is the INSERT, still carrying the refused key), exact
 *     duplicates (owner, title, ingredients, directions) keep the oldest;
 *     the others are removed from the phone.
 *  3. recipes: the display key is nulled in every remaining row and payload.
 * Nothing to fix: no writes and no log. One warn line when anything changed,
 * counts only (log.warn is the only level a production build keeps).
 */
import { createLogger } from '../../utils/createLogger';
import {
    discardUnsentRecord,
    getAll,
    getFullQueue,
    getLocalDatabaseSession,
    isLocalDatabaseSessionCurrent,
    rewriteQueuedRecord,
    updateLocal,
    type LocalDatabaseSession,
    type SyncQueueItem,
} from '../vessel/LocalDatabase';
import { isPgInteger } from './recipeRefs';

const log = createLogger('Galley');

const RECIPES = 'recipes';
const MEALS = 'meal_plans';

export interface GalleyRepairResult {
    meals: number;
    recipes: number;
    duplicates: number;
}

type Payload = Record<string, unknown>;
type MealLink = { id: string; updated_at?: string; recipe_id?: unknown };

/** One record of a table: its local row (if any), its queue items, and their parsed payloads. */
interface Entry {
    id: string;
    row: Payload | null;
    items: SyncQueueItem[];
    payloads: Map<string, Payload>;
}

/** A spoonacular_id Postgres refuses. Null (no id) is fine and never touched. */
const isRefused = (value: unknown): boolean => value !== null && value !== undefined && !isPgInteger(value);

/** Only this table's rows and queue items: other tables' payloads can be huge (DOC-2). */
function entriesOf(table: string, queue: readonly SyncQueueItem[]): Map<string, Entry> {
    const entries = new Map<string, Entry>();
    const entry = (id: string): Entry => {
        let found = entries.get(id);
        if (!found) {
            found = { id, row: null, items: [], payloads: new Map() };
            entries.set(id, found);
        }
        return found;
    };
    for (const row of getAll<Payload>(table)) {
        if (row && typeof row.id === 'string') entry(row.id).row = row;
    }
    for (const item of queue) {
        if (item.table_name !== table) continue;
        const found = entry(item.record_id);
        found.items.push(item);
        if (item.mutation_type !== 'INSERT' && item.mutation_type !== 'UPDATE') continue;
        const payload = parsePayload(item);
        if (payload) found.payloads.set(item.id, payload);
    }
    return entries;
}

/** A queue item's payload object, or null (left as it is: SyncService surfaces a malformed item). */
function parsePayload(item: Readonly<SyncQueueItem>): Payload | null {
    try {
        const payload: unknown = JSON.parse(item.payload);
        return payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Payload) : null;
    } catch {
        return null;
    }
}

/** Every refused spoonacular_id the record carries, in its row or its queue. */
function refusedIds(entry: Entry): unknown[] {
    return [entry.row?.spoonacular_id, ...[...entry.payloads.values()].map((payload) => payload.spoonacular_id)].filter(
        isRefused,
    );
}

/**
 * The proof discardUnsentRecord asks for: this INSERT still carries an id
 * Postgres refuses, so it can never have committed (not even before a
 * timeout).
 */
const carriesRefusedId = (insert: Readonly<SyncQueueItem>): boolean => isRefused(parsePayload(insert)?.spoonacular_id);

/** The server never took it: its history starts with an INSERT that still carries a refused id. */
function provablyUnsent(entry: Entry): boolean {
    const first = entry.items[0];
    return first?.mutation_type === 'INSERT' && isRefused(entry.payloads.get(first.id)?.spoonacular_id);
}

const createdAt = (entry: Entry): string =>
    String(entry.row?.created_at ?? [...entry.payloads.values()][0]?.created_at ?? '');
const byAge = (a: Entry, b: Entry): number => createdAt(a).localeCompare(createdAt(b)) || a.id.localeCompare(b.id);

const nullRefusedId = (payload: Payload): Payload =>
    'spoonacular_id' in payload && isRefused(payload.spoonacular_id) ? { ...payload, spoonacular_id: null } : payload;

export async function repairGalleyOutbox(): Promise<GalleyRepairResult> {
    const result: GalleyRepairResult = { meals: 0, recipes: 0, duplicates: 0 };
    let session: LocalDatabaseSession;
    try {
        session = getLocalDatabaseSession();
    } catch {
        // The database is changing accounts: the next load repairs.
        return result;
    }
    const queue = getFullQueue();
    const recipes = entriesOf(RECIPES, queue);
    const meals = entriesOf(MEALS, queue);
    const stuckRecipes = [...recipes.values()].filter((entry) => refusedIds(entry).length > 0).sort(byAge);
    const stuckMeals = [...meals.values()].filter((entry) => refusedIds(entry).length > 0);
    if (stuckRecipes.length === 0 && stuckMeals.length === 0) return result;

    // Exact duplicate copies the server never took: the oldest survives.
    const self = session.identity ?? '';
    const survivors = new Map<string, string>();
    const survivorOf = new Map<string, string>();
    for (const entry of stuckRecipes) {
        if (!entry.row || !provablyUnsent(entry)) continue;
        const row = entry.row;
        const key = JSON.stringify([
            String(row.user_id || self),
            String(row.title ?? '')
                .trim()
                .toLowerCase(),
            JSON.stringify(row.ingredients ?? null),
            JSON.stringify(row.instructions ?? null),
        ]);
        const survivor = survivors.get(key);
        if (survivor) survivorOf.set(entry.id, survivor);
        else survivors.set(key, entry.id);
    }
    // The copy each refused id was saved under, or its survivor.
    const linkFor = new Map<unknown, string>();
    for (const entry of stuckRecipes) {
        if (!entry.row) continue;
        for (const id of refusedIds(entry)) {
            if (!linkFor.has(id)) linkFor.set(id, survivorOf.get(entry.id) ?? entry.id);
        }
    }
    const removed = (value: unknown): value is string => typeof value === 'string' && survivorOf.has(value);
    const relink = (value: unknown): unknown => (removed(value) ? survivorOf.get(value) : value);

    try {
        // 1. Meals.
        for (const entry of meals.values()) {
            const payloads = [...entry.payloads.values()];
            const linksRemoved =
                removed(entry.row?.recipe_id) || payloads.some((payload) => removed(payload.recipe_id));
            const refused = refusedIds(entry);
            if (refused.length === 0 && !linksRemoved) continue;
            const plannedFrom = refused.map((id) => linkFor.get(id)).find(Boolean) ?? null;
            // The server may hold this meal already: only a queued UPDATE moves
            // its link there. updateLocal below writes that UPDATE and the row
            // together (outbox first), so the row is never relinked here: a
            // relinked row with no UPDATE queued would look done to the next
            // run, and the server would keep naming a removed copy.
            const serverMayHold = removed(entry.row?.recipe_id) && !provablyUnsent(entry);
            const rowChanges: Payload = {};
            if (entry.row) {
                if (isRefused(entry.row.spoonacular_id)) rowChanges.spoonacular_id = null;
                if (removed(entry.row.recipe_id)) {
                    if (!serverMayHold) rowChanges.recipe_id = relink(entry.row.recipe_id);
                } else if (!entry.row.recipe_id && plannedFrom) rowChanges.recipe_id = plannedFrom;
            }
            if (!isLocalDatabaseSessionCurrent(session)) return result;
            const outcome = await rewriteQueuedRecord(
                MEALS,
                entry.id,
                (payload, item) => {
                    const next = { ...nullRefusedId(payload) };
                    if ('recipe_id' in next) next.recipe_id = relink(next.recipe_id);
                    if (plannedFrom && !next.recipe_id && ('recipe_id' in next || item.mutation_type === 'INSERT')) {
                        next.recipe_id = plannedFrom;
                    }
                    return next;
                },
                rowChanges,
            );
            let changed = outcome.items > 0 || outcome.row;
            if (serverMayHold) {
                if (!isLocalDatabaseSessionCurrent(session)) return result;
                const moved = await updateLocal<MealLink>(MEALS, entry.id, { recipe_id: relink(entry.row?.recipe_id) });
                changed = changed || moved !== null;
            }
            if (changed) result.meals += 1;
        }

        // 2. Duplicate copies.
        const discarded = new Set<string>();
        for (const id of survivorOf.keys()) {
            if (!isLocalDatabaseSessionCurrent(session)) return result;
            if (await discardUnsentRecord(RECIPES, id, carriesRefusedId)) {
                discarded.add(id);
                result.duplicates += 1;
            }
        }

        // 3. Recipes.
        for (const entry of stuckRecipes) {
            if (discarded.has(entry.id)) continue;
            if (!isLocalDatabaseSessionCurrent(session)) return result;
            const outcome = await rewriteQueuedRecord(
                RECIPES,
                entry.id,
                nullRefusedId,
                isRefused(entry.row?.spoonacular_id) ? { spoonacular_id: null } : null,
            );
            if (outcome.items > 0 || outcome.row) result.recipes += 1;
        }
        return result;
    } finally {
        if (result.meals + result.recipes + result.duplicates > 0) {
            log.warn(
                `galley-repair: ${result.meals} meals, ${result.recipes} recipes fixed, ${result.duplicates} duplicate copies removed`,
            );
        }
    }
}
