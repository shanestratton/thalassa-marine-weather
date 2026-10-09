/**
 * Recipe references at the database boundary (126-B2a, binder audit GAL-02
 * and GAL-07; Shane 2026-10-09: "check all of the binders to make sure that
 * they are at the same standard as the rest of the app").
 *
 * A search result's numeric `GalleyMeal.id` is a display key. Only a real
 * Spoonacular id (a positive Postgres INTEGER) may reach a `spoonacular_id`
 * column: the old fake ids (Date.now() + Math.random()) were refused by
 * Postgres and fenced the meal in the outbox for good. A planned meal links to
 * its recipe through `recipe_id` instead, and a copy of another sailor's
 * recipe gets a deterministic id, so two phones copying it write one row.
 *
 * Pure: no imports beyond types, no storage, no network.
 */
import type { RecipeStep } from '../GalleyRecipeService';

/** The largest value a Postgres INTEGER column takes. */
const PG_INTEGER_MAX = 2_147_483_647;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_STEPS = 200;
const MAX_STEP_LENGTH = 4_000;

/** A positive safe integer a Postgres INTEGER column takes. */
export function isPgInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= PG_INTEGER_MAX;
}

/**
 * The Spoonacular id to store, or null. A search result (a GalleyMeal) has
 * one only when it came from Spoonacular; a stored row (a recipe or a meal
 * plan) only when its column holds a value Postgres would take.
 */
export function realSpoonacularId(
    ref: { id?: unknown; source?: unknown } | { spoonacular_id?: unknown } | null | undefined,
): number | null {
    if (!ref) return null;
    if ('spoonacular_id' in ref) return isPgInteger(ref.spoonacular_id) ? ref.spoonacular_id : null;
    const meal = ref as { id?: unknown; source?: unknown };
    return meal.source === 'spoonacular' && isPgInteger(meal.id) ? meal.id : null;
}

export function isUuid(value: unknown): value is string {
    return typeof value === 'string' && UUID.test(value);
}

/**
 * A stable numeric display key for a recipe known by its uuid (React keys,
 * the search de-dupe). Never sent to the database: it is offset past the
 * INTEGER range, so it can never pass for a Spoonacular id either.
 */
export function uiKeyFromUuid(uuid: string): number {
    // Server rows are untyped at runtime: never throw on a missing id.
    const text = String(uuid ?? '');
    const hex = text.replace(/-/g, '').slice(0, 12);
    let key = 0x811c9dc5;
    if (/^[0-9a-f]{12}$/i.test(hex)) {
        key = parseInt(hex, 16);
    } else {
        // Not a uuid: a 32-bit FNV-1a of the text, still stable.
        for (let index = 0; index < text.length; index += 1) {
            key = Math.imul(key ^ text.charCodeAt(index), 0x01000193) >>> 0;
        }
    }
    return PG_INTEGER_MAX + 1 + key;
}

/**
 * A recipe's stored directions as numbered steps: a JSON RecipeStep[] (what
 * Spoonacular and community recipes store), or plain text with one step per
 * line (what the Galley's own recipe editor stores). Blank lines are dropped;
 * text that starts with '[' but is not a JSON array stays text.
 */
export function parseRecipeSteps(text: string | null | undefined): RecipeStep[] {
    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
        try {
            const parsed: unknown = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
                return parsed.slice(0, MAX_STEPS).flatMap((candidate, index) => {
                    const entry = candidate as { number?: unknown; step?: unknown } | string | null;
                    const raw = typeof entry === 'string' ? entry : entry?.step;
                    const step = typeof raw === 'string' ? raw.trim().slice(0, MAX_STEP_LENGTH) : '';
                    if (!step) return [];
                    const number =
                        typeof entry === 'object' && entry && isPgInteger(entry.number) ? entry.number : index + 1;
                    return [{ number, step }];
                });
            }
        } catch {
            // Not JSON: plain text that happens to start with '['.
        }
    }
    return trimmed
        .split(/\r?\n/)
        .map((line) => line.trim().slice(0, MAX_STEP_LENGTH))
        .filter(Boolean)
        .slice(0, MAX_STEPS)
        .map((step, index) => ({ number: index + 1, step }));
}

/**
 * The id of `owner`'s copy of another sailor's recipe: an RFC 9562 version 8
 * uuid from SHA-256 of `thalassa:recipes:copy:v1:<owner|anonymous>:<source>`,
 * with the byte layout LocalEngineHoursService.engineHoursRowId uses. Two
 * phones copying the same recipe write the same row, and the server's
 * ON CONFLICT DO NOTHING keeps one. The version nibble also tells a copy from
 * a recipe written in the Galley (v4).
 */
export async function recipeCopyId(owner: string | null | undefined, sourceId: string): Promise<string> {
    const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(`thalassa:recipes:copy:v1:${owner || 'anonymous'}:${sourceId}`),
    );
    const bytes = new Uint8Array(digest).slice(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
