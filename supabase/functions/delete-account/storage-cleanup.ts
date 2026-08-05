/**
 * Exhaustive, retry-safe cleanup primitives for account deletion.
 *
 * Storage is drained in fixed-size first pages instead of being accumulated in
 * memory or capped. Removing each page before asking for the next one means a
 * timed-out Edge invocation still makes durable progress, while every error is
 * surfaced before the auth user can be deleted.
 */

export const STORAGE_LIST_PAGE_SIZE = 100;
export const STORAGE_REMOVE_BATCH_SIZE = 100;
export const RECIPE_ID_PAGE_SIZE = 500;
export const MAX_STORAGE_LIST_PASSES_PER_INVOCATION = 512;
export const MAX_RECIPE_PAGES_PER_TABLE_PER_INVOCATION = 128;

const MAX_IDENTICAL_STORAGE_PASSES = 3;

export interface CleanupError {
    message: string;
}

export interface StorageEntry {
    name: string;
    id?: string | null;
    metadata?: Record<string, unknown> | null;
}

export interface StorageListOptions {
    limit: number;
    offset: number;
    sortBy: { column: 'name'; order: 'asc' };
}

export interface StorageBucketGateway {
    list(
        prefix: string,
        options: StorageListOptions,
    ): PromiseLike<{ data: readonly StorageEntry[] | null; error: CleanupError | null }>;
    remove(paths: readonly string[]): PromiseLike<{ error: CleanupError | null }>;
}

export type RecipeTable = 'recipes' | 'community_recipes';

export interface RecipeIdRow {
    id: unknown;
}

export interface RecipeMediaGateway {
    listOwnedRecipeIds(
        table: RecipeTable,
        userId: string,
        afterId: string | null,
        limit: number,
    ): PromiseLike<{ data: readonly RecipeIdRow[] | null; error: CleanupError | null }>;
    removeRecipePhotos(paths: readonly string[]): PromiseLike<{ error: CleanupError | null }>;
    deleteOwnedRecipeRows(
        table: RecipeTable,
        userId: string,
        ids: readonly string[],
    ): PromiseLike<{ data: readonly RecipeIdRow[] | null; error: CleanupError | null }>;
}

export interface StorageDrainOptions {
    /** Test/support override; production uses a bounded per-invocation budget. */
    maxListPasses?: number;
}

export interface RecipeDrainOptions {
    /** Test/support override; processed rows are deleted, so retries resume. */
    maxPagesPerTable?: number;
}

export function isMissingResource(message: string): boolean {
    return /bucket not found|could not find (?:the )?(?:table|relation)|relation ["']?[\w.]+["']? does not exist|\bPGRST205\b|\b42P01\b/i
        .test(
            message,
        );
}

function entryPath(prefix: string, entry: StorageEntry, bucket: string): string {
    if (
        typeof entry.name !== 'string' ||
        entry.name.length === 0 ||
        /[\\/\u0000-\u001f\u007f]/.test(entry.name)
    ) {
        throw new Error(`Could not enumerate ${bucket}/${prefix}: Storage returned an invalid object name`);
    }
    return prefix ? `${prefix}/${entry.name}` : entry.name;
}

function pageSignature(prefix: string, entries: readonly StorageEntry[], bucket: string): string {
    return entries
        .map((entry) => {
            const kind = entry.id == null && entry.metadata == null ? 'd' : 'f';
            return `${kind}:${entryPath(prefix, entry, bucket)}`;
        })
        .join('\n');
}

async function removeStorageBatch(
    storage: StorageBucketGateway,
    bucket: string,
    paths: readonly string[],
): Promise<void> {
    for (let index = 0; index < paths.length; index += STORAGE_REMOVE_BATCH_SIZE) {
        const batch = paths.slice(index, index + STORAGE_REMOVE_BATCH_SIZE);
        const { error } = await storage.remove(batch);
        // A missing object or concurrently removed bucket is verified by the
        // next list. Every other failure aborts account deletion immediately.
        if (error && !isMissingResource(error.message)) {
            throw new Error(`Could not remove ${bucket} account media: ${error.message}`);
        }
    }
}

/**
 * Drain every real object below a virtual Storage prefix.
 *
 * Supabase folders are virtual list entries (null id and metadata), so they
 * are recursively drained and then disappear. The first page is requested
 * again after each pass: this avoids offset-skips as objects are removed and
 * also catches objects that arrive during a long cleanup. A backend that says
 * removal succeeded without making progress fails closed instead of looping
 * until the Edge runtime kills the request.
 */
export async function drainStoragePrefix(
    storage: StorageBucketGateway,
    bucket: string,
    prefix: string,
    options: StorageDrainOptions = {},
): Promise<void> {
    const budget = {
        remaining: options.maxListPasses ?? MAX_STORAGE_LIST_PASSES_PER_INVOCATION,
    };
    if (!Number.isSafeInteger(budget.remaining) || budget.remaining <= 0) {
        throw new Error('Storage cleanup requires a positive list-pass budget');
    }
    await drainStoragePrefixWithinBudget(storage, bucket, prefix, budget);
}

async function drainStoragePrefixWithinBudget(
    storage: StorageBucketGateway,
    bucket: string,
    prefix: string,
    budget: { remaining: number },
): Promise<void> {
    let previousSignature: string | null = null;
    let identicalPasses = 0;

    while (true) {
        if (budget.remaining <= 0) {
            throw new Error(
                `Could not finish ${bucket}/${prefix}: Storage cleanup invocation budget reached; retry to resume`,
            );
        }
        budget.remaining -= 1;
        const { data, error } = await storage.list(prefix, {
            limit: STORAGE_LIST_PAGE_SIZE,
            offset: 0,
            sortBy: { column: 'name', order: 'asc' },
        });
        if (error) {
            if (isMissingResource(error.message)) return;
            throw new Error(`Could not enumerate ${bucket}/${prefix}: ${error.message}`);
        }

        if (!Array.isArray(data)) {
            throw new Error(`Could not enumerate ${bucket}/${prefix}: Storage returned no verifiable listing`);
        }
        const entries = data;
        if (entries.length === 0) return;
        if (entries.length > STORAGE_LIST_PAGE_SIZE) {
            throw new Error(`Could not enumerate ${bucket}/${prefix}: Storage exceeded the requested page size`);
        }

        const signature = pageSignature(prefix, entries, bucket);
        if (signature === previousSignature) {
            identicalPasses += 1;
            if (identicalPasses >= MAX_IDENTICAL_STORAGE_PASSES) {
                throw new Error(`Could not remove ${bucket}/${prefix}: Storage cleanup made no progress`);
            }
        } else {
            previousSignature = signature;
            identicalPasses = 0;
        }

        const files = new Set<string>();
        const folders = new Set<string>();
        for (const entry of entries) {
            const path = entryPath(prefix, entry, bucket);
            if (entry.id == null && entry.metadata == null) folders.add(path);
            else files.add(path);
        }

        await removeStorageBatch(storage, bucket, [...files]);
        for (const folder of folders) {
            await drainStoragePrefixWithinBudget(storage, bucket, folder, budget);
        }
    }
}

function recipeIdsFromPage(
    table: RecipeTable,
    rows: readonly RecipeIdRow[],
): string[] {
    const ids: string[] = [];
    for (const row of rows) {
        if (typeof row.id !== 'string' || row.id.length === 0) {
            throw new Error(`Could not enumerate ${table} recipe media: Database returned an invalid recipe id`);
        }
        const previous = ids.at(-1) ?? null;
        if (previous !== null && row.id.localeCompare(previous) <= 0) {
            throw new Error(`Could not enumerate ${table} recipe media: Recipe pagination did not advance`);
        }
        ids.push(row.id);
    }
    return ids;
}

async function removeRecipePhotoBatch(gateway: RecipeMediaGateway, paths: readonly string[]): Promise<void> {
    for (let index = 0; index < paths.length; index += STORAGE_REMOVE_BATCH_SIZE) {
        const { error } = await gateway.removeRecipePhotos(paths.slice(index, index + STORAGE_REMOVE_BATCH_SIZE));
        if (error && !isMissingResource(error.message)) {
            throw new Error(`Could not remove recipe media: ${error.message}`);
        }
    }
}

async function deleteProcessedRecipeRows(
    gateway: RecipeMediaGateway,
    table: RecipeTable,
    userId: string,
    ids: readonly string[],
): Promise<void> {
    const { data, error } = await gateway.deleteOwnedRecipeRows(table, userId, ids);
    if (error) throw new Error(`Could not delete processed ${table} recipes: ${error.message}`);
    if (!Array.isArray(data)) {
        throw new Error(`Could not delete processed ${table} recipes: Database returned no verifiable rows`);
    }
    const deleted = new Set(data.map((row) => row.id).filter((id): id is string => typeof id === 'string'));
    if (deleted.size !== ids.length || ids.some((id) => !deleted.has(id))) {
        throw new Error(`Could not delete processed ${table} recipes: Database did not delete the whole page`);
    }
}

/**
 * Remove owner-scoped and pre-migration root recipe photos from both current
 * recipe tables. Each successfully cleaned page of rows is deleted before the
 * next first-page read. That makes progress durable across hosted Edge time
 * limits and means a retry resumes instead of replaying an unbounded keyset.
 */
export async function removeAllRecipePhotos(
    gateway: RecipeMediaGateway,
    userId: string,
    options: RecipeDrainOptions = {},
): Promise<void> {
    const maxPages = options.maxPagesPerTable ?? MAX_RECIPE_PAGES_PER_TABLE_PER_INVOCATION;
    if (!Number.isSafeInteger(maxPages) || maxPages <= 0) {
        throw new Error('Recipe cleanup requires a positive page budget');
    }

    for (const table of ['recipes', 'community_recipes'] as const) {
        let pages = 0;
        let previousPageSignature: string | null = null;

        while (true) {
            if (pages >= maxPages) {
                throw new Error(
                    `Could not finish ${table} recipe media: cleanup invocation budget reached; retry to resume`,
                );
            }
            const { data, error } = await gateway.listOwnedRecipeIds(table, userId, null, RECIPE_ID_PAGE_SIZE);
            if (error) {
                throw new Error(`Could not enumerate ${table} recipe media: ${error.message}`);
            }

            if (!Array.isArray(data)) {
                throw new Error(`Could not enumerate ${table} recipe media: Database returned no verifiable rows`);
            }
            const rows = data;
            if (rows.length === 0) break;
            if (rows.length > RECIPE_ID_PAGE_SIZE) {
                throw new Error(`Could not enumerate ${table} recipe media: Database exceeded the requested page size`);
            }

            const ids = recipeIdsFromPage(table, rows);
            const pageSignature = ids.join('\n');
            if (pageSignature === previousPageSignature) {
                throw new Error(`Could not enumerate ${table} recipe media: Recipe pagination did not advance`);
            }
            previousPageSignature = pageSignature;
            const paths = ids.flatMap((id) => [`${userId}/${id}.jpg`, `${id}.jpg`]);
            await removeRecipePhotoBatch(gateway, paths);
            await deleteProcessedRecipeRows(gateway, table, userId, ids);
            pages += 1;
            if (rows.length < RECIPE_ID_PAGE_SIZE) break;
        }
    }
}
