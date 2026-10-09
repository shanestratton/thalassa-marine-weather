/**
 * The columns the LIVE database's Galley tables have, for fake PostgREST
 * servers (126-B2b review). PostgREST refuses a write whose JSON names a
 * column the table does not have (PGRST204, HTTP 400), and the outbox sends
 * every key of a queued payload. A fake that accepts any key proved "one
 * cycle pushes everything" while live refused every recipes write.
 *
 * Read-only probe of information_schema.columns on live, 2026-10-10 (column
 * names only). Live public.recipes predates 20260322090000, whose CREATE
 * TABLE IF NOT EXISTS never ran there: it has no spoonacular_id and no
 * source_url. 20261010145000_recipes_live_schema_alignment.sql adds both
 * (a no-op on a database built from the migrations).
 */

const LIVE_COLUMNS: Record<string, readonly string[]> = {
    recipes: [
        'id',
        'user_id',
        'title',
        'instructions',
        'image_url',
        'ready_in_minutes',
        'servings',
        'ingredients',
        'tags',
        'visibility',
        'is_favorite',
        'created_at',
        'updated_at',
        'is_custom',
    ],
    meal_plans: [
        'id',
        'user_id',
        'voyage_id',
        'recipe_id',
        'spoonacular_id',
        'title',
        'planned_date',
        'meal_slot',
        'servings_planned',
        'ingredients',
        'status',
        'cook_started_at',
        'completed_at',
        'leftovers_saved',
        'notes',
        'created_at',
        'updated_at',
    ],
};

/** What 20261010145000_recipes_live_schema_alignment.sql adds to live. */
const ALIGNMENT_COLUMNS: Record<string, readonly string[]> = {
    recipes: ['spoonacular_id', 'source_url'],
};

/**
 * 'live': the live tables today. 'aligned': live once the alignment migration
 * is pushed (the shape every database built from the migrations has).
 */
export type GalleySchema = 'live' | 'aligned';

export function galleyColumns(table: string, schema: GalleySchema): readonly string[] | null {
    const live = LIVE_COLUMNS[table];
    if (!live) return null;
    return schema === 'aligned' ? [...live, ...(ALIGNMENT_COLUMNS[table] ?? [])] : live;
}

/** PostgREST's refusal of a key the table has no column for, or null. Tables not listed here are not checked. */
export function unknownColumnError(
    table: string,
    row: Record<string, unknown>,
    schema: GalleySchema,
): { code: string; message: string } | null {
    const columns = galleyColumns(table, schema);
    if (!columns) return null;
    const missing = Object.keys(row).find((key) => !columns.includes(key));
    if (!missing) return null;
    return {
        code: 'PGRST204',
        message: `Could not find the '${missing}' column of '${table}' in the schema cache`,
    };
}
