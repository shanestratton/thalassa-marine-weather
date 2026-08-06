import {
    drainExactStorageManifest,
    drainStoragePrefix,
    MAX_RECIPE_PAGES_PER_TABLE_PER_INVOCATION,
    MAX_STORAGE_LIST_PASSES_PER_INVOCATION,
    RECIPE_ID_PAGE_SIZE,
    type RecipeMediaGateway,
    type RecipeTable,
    removeAllRecipePhotos,
    STORAGE_LIST_PAGE_SIZE,
    STORAGE_REMOVE_BATCH_SIZE,
    type StorageBucketGateway,
    type StorageEntry,
    type StorageListOptions,
    type StorageManifestGateway,
    type StorageManifestItem,
} from './storage-cleanup.ts';
import { runAccountDeletionWorkflow } from './workflow.ts';

function assert(condition: unknown, message = 'Assertion failed'): asserts condition {
    if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
    const actualJson = JSON.stringify(actual);
    const expectedJson = JSON.stringify(expected);
    if (actualJson !== expectedJson) {
        throw new Error(`Expected ${expectedJson}, received ${actualJson}`);
    }
}

async function assertRejects(operation: () => Promise<unknown>, expectedMessage: string): Promise<void> {
    try {
        await operation();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        assert(
            message.includes(expectedMessage),
            `Expected rejection containing "${expectedMessage}", received "${message}"`,
        );
        return;
    }
    throw new Error(`Expected rejection containing "${expectedMessage}"`);
}

class StorageHarness implements StorageBucketGateway {
    readonly objects: Set<string>;
    readonly listCalls: Array<{ prefix: string; options: StorageListOptions }> = [];
    readonly removeCalls: string[][] = [];
    failListAt: number | null = null;
    failRemoveAt: number | null = null;
    removeAtMost: number | null = null;

    constructor(paths: Iterable<string>) {
        this.objects = new Set(paths);
    }

    list(
        prefix: string,
        options: StorageListOptions,
    ): Promise<{ data: readonly StorageEntry[] | null; error: { message: string } | null }> {
        this.listCalls.push({ prefix, options });
        if (this.failListAt === this.listCalls.length) {
            return Promise.resolve({ data: null, error: { message: 'list backend unavailable' } });
        }

        const prefixWithSlash = prefix ? `${prefix}/` : '';
        const entries = new Map<string, StorageEntry>();
        for (const path of this.objects) {
            if (!path.startsWith(prefixWithSlash)) continue;
            const remainder = path.slice(prefixWithSlash.length);
            if (!remainder) continue;
            const slash = remainder.indexOf('/');
            if (slash >= 0) {
                const name = remainder.slice(0, slash);
                entries.set(name, { name, id: null, metadata: null });
            } else {
                entries.set(remainder, { name: remainder, id: `object:${path}`, metadata: null });
            }
        }

        const page = [...entries.values()]
            .sort((left, right) => left.name.localeCompare(right.name))
            .slice(options.offset, options.offset + options.limit);
        return Promise.resolve({ data: page, error: null });
    }

    remove(paths: readonly string[]): Promise<{ error: { message: string } | null }> {
        this.removeCalls.push([...paths]);
        if (this.failRemoveAt === this.removeCalls.length) {
            return Promise.resolve({ error: { message: 'remove backend unavailable' } });
        }

        const removable = this.removeAtMost === null ? paths : paths.slice(0, this.removeAtMost);
        for (const path of removable) this.objects.delete(path);
        return Promise.resolve({ error: null });
    }
}

Deno.test('account storage cleanup drains nested prefixes and more than 20,000 objects in bounded pages', async () => {
    const direct = Array.from({ length: 25_137 }, (_, index) => `owner/file-${String(index).padStart(6, '0')}.bin`);
    const paths = [...direct, 'owner/a/b/zero-byte.dat', 'owner/a/c/photo.jpg', 'owner/z/deep/voice.m4a'];
    const storage = new StorageHarness(paths);

    await drainStoragePrefix(storage, 'private-media', 'owner');

    assertEquals(storage.objects.size, 0);
    assert(storage.listCalls.length > 250, 'Expected multiple fixed-size list pages');
    assert(
        storage.listCalls.every(
            ({ options }) => options.limit === STORAGE_LIST_PAGE_SIZE && options.offset === 0,
        ),
        'Cleanup must repeatedly drain the first page so deletion cannot create offset gaps',
    );
    assert(storage.removeCalls.length > 250, 'Expected multiple remove batches');
    assert(
        storage.removeCalls.every((batch) => batch.length > 0 && batch.length <= STORAGE_REMOVE_BATCH_SIZE),
        'Storage remove batch exceeded its limit',
    );
    assertEquals(storage.removeCalls.flat().length, paths.length);
});

Deno.test('account storage cleanup keeps draining after a successful response removes only part of a page', async () => {
    const paths = Array.from({ length: 263 }, (_, index) => `owner/file-${String(index).padStart(4, '0')}`);
    const storage = new StorageHarness(paths);
    storage.removeAtMost = 37;

    await drainStoragePrefix(storage, 'private-media', 'owner');

    assertEquals(storage.objects.size, 0);
    assert(storage.removeCalls.length > Math.ceil(paths.length / STORAGE_REMOVE_BATCH_SIZE));
});

Deno.test('account storage cleanup fails on list and remove errors after preserving completed progress', async () => {
    const paths = Array.from({ length: 250 }, (_, index) => `owner/file-${String(index).padStart(4, '0')}`);

    const listFailure = new StorageHarness(paths);
    listFailure.failListAt = 2;
    await assertRejects(
        () => drainStoragePrefix(listFailure, 'private-media', 'owner'),
        'Could not enumerate private-media/owner: list backend unavailable',
    );
    assertEquals(listFailure.objects.size, 150);

    const removeFailure = new StorageHarness(paths);
    removeFailure.failRemoveAt = 2;
    await assertRejects(
        () => drainStoragePrefix(removeFailure, 'private-media', 'owner'),
        'Could not remove private-media account media: remove backend unavailable',
    );
    assertEquals(removeFailure.objects.size, 150);
});

Deno.test('account storage cleanup fails closed when successful remove responses make no progress', async () => {
    const storage = new StorageHarness(['owner/private.jpg']);
    storage.removeAtMost = 0;

    await assertRejects(
        () => drainStoragePrefix(storage, 'private-media', 'owner'),
        'Storage cleanup made no progress',
    );
    assertEquals(storage.objects.size, 1);
});

Deno.test('account storage cleanup accepts an absent bucket but does not mask a generic not-found backend failure', async () => {
    const missingBucket: StorageBucketGateway = {
        list: () => Promise.resolve({ data: null, error: { message: 'Bucket not found' } }),
        remove: () => Promise.resolve({ error: null }),
    };
    await drainStoragePrefix(missingBucket, 'retired-media', 'owner');

    const ambiguousFailure: StorageBucketGateway = {
        list: () => Promise.resolve({ data: null, error: { message: 'Storage upstream was not found' } }),
        remove: () => Promise.resolve({ error: null }),
    };
    await assertRejects(
        () => drainStoragePrefix(ambiguousFailure, 'private-media', 'owner'),
        'Storage upstream was not found',
    );
});

Deno.test('account storage cleanup rejects unverifiable listings and unsafe returned child names', async () => {
    const nullListing: StorageBucketGateway = {
        list: () => Promise.resolve({ data: null, error: null }),
        remove: () => Promise.resolve({ error: null }),
    };
    await assertRejects(
        () => drainStoragePrefix(nullListing, 'private-media', 'owner'),
        'Storage returned no verifiable listing',
    );

    for (const invalidName of ['other/folder', 'other\\folder', 'control\u0000name']) {
        let removeRan = false;
        const invalidEntry: StorageBucketGateway = {
            list: () => Promise.resolve({ data: [{ name: invalidName, id: 'object' }], error: null }),
            remove: () => {
                removeRan = true;
                return Promise.resolve({ error: null });
            },
        };
        await assertRejects(
            () => drainStoragePrefix(invalidEntry, 'private-media', 'owner'),
            'Storage returned an invalid object name',
        );
        assert(!removeRan, `Invalid child ${JSON.stringify(invalidName)} reached Storage remove`);
    }
});

Deno.test('account storage cleanup treats dot segments as opaque object names inside the exact prefix', async () => {
    const storage = new StorageHarness(['owner/.', 'owner/..', 'owner/ordinary.jpg', 'sibling/.']);

    await drainStoragePrefix(storage, 'private-media', 'owner');

    assertEquals([...storage.objects], ['sibling/.']);
    const removed = storage.removeCalls.flat();
    assert(removed.includes('owner/.'));
    assert(removed.includes('owner/..'));
    assert(!removed.includes('sibling/.'));
});

class RecipeHarness implements RecipeMediaGateway {
    readonly rows: Record<RecipeTable, string[]>;
    readonly listCalls: Array<{ table: RecipeTable; afterId: string | null; limit: number }> = [];
    readonly removeCalls: string[][] = [];
    failListAt: number | null = null;
    failRemoveAt: number | null = null;
    missingTable: RecipeTable | null = null;

    constructor(rows: Record<RecipeTable, string[]>) {
        this.rows = rows;
    }

    listOwnedRecipeIds(
        table: RecipeTable,
        _userId: string,
        afterId: string | null,
        limit: number,
    ): Promise<{ data: Array<{ id: string }> | null; error: { message: string } | null }> {
        this.listCalls.push({ table, afterId, limit });
        if (table === this.missingTable) {
            return Promise.resolve({ data: null, error: { message: `Could not find the table '${table}'` } });
        }
        if (this.failListAt === this.listCalls.length) {
            return Promise.resolve({ data: null, error: { message: 'recipe list backend unavailable' } });
        }
        const ids = this.rows[table].filter((id) => afterId === null || id.localeCompare(afterId) > 0).slice(0, limit);
        return Promise.resolve({ data: ids.map((id) => ({ id })), error: null });
    }

    removeRecipePhotos(paths: readonly string[]): Promise<{ error: { message: string } | null }> {
        this.removeCalls.push([...paths]);
        if (this.failRemoveAt === this.removeCalls.length) {
            return Promise.resolve({ error: { message: 'recipe remove backend unavailable' } });
        }
        return Promise.resolve({ error: null });
    }

    deleteOwnedRecipeRows(
        table: RecipeTable,
        _userId: string,
        ids: readonly string[],
    ): Promise<{ data: Array<{ id: string }>; error: { message: string } | null }> {
        const deleted = new Set(ids);
        this.rows[table] = this.rows[table].filter((id) => !deleted.has(id));
        return Promise.resolve({ data: ids.map((id) => ({ id })), error: null });
    }
}

function recipeId(index: number): string {
    return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

Deno.test('recipe media cleanup drains and deletes bounded first pages from both current recipe tables', async () => {
    const ownerId = '11111111-1111-4111-8111-111111111111';
    const recipes = Array.from({ length: 10_251 }, (_, index) => recipeId(index));
    const communityRecipes = Array.from({ length: 10_113 }, (_, index) => recipeId(index + 20_000));
    const gateway = new RecipeHarness({ recipes, community_recipes: communityRecipes });

    await removeAllRecipePhotos(gateway, ownerId);

    assert(gateway.listCalls.every(({ limit }) => limit === RECIPE_ID_PAGE_SIZE));
    for (const table of ['recipes', 'community_recipes'] as const) {
        const calls = gateway.listCalls.filter((call) => call.table === table);
        assert(calls.length > 20, `Expected paginated ${table} reads`);
        assert(calls.every((call) => call.afterId === null), `Expected repeated first-page reads for ${table}`);
        assertEquals(gateway.rows[table].length, 0);
    }
    assert(gateway.removeCalls.every((batch) => batch.length <= STORAGE_REMOVE_BATCH_SIZE));
    const removedPaths = gateway.removeCalls.flat();
    assertEquals(removedPaths.length, (recipes.length + communityRecipes.length) * 2);
    assert(removedPaths.includes(`${ownerId}/${recipes[0]}.jpg`));
    assert(removedPaths.includes(`${recipes[0]}.jpg`));
    assert(removedPaths.includes(`${ownerId}/${communityRecipes.at(-1)}.jpg`));
    assert(removedPaths.includes(`${communityRecipes.at(-1)}.jpg`));
});

Deno.test('recipe media cleanup fails closed on missing active tables and partial list/remove failures', async () => {
    const ownerId = '11111111-1111-4111-8111-111111111111';

    const missingActiveTable = new RecipeHarness({ recipes: [], community_recipes: [recipeId(1)] });
    missingActiveTable.missingTable = 'recipes';
    await assertRejects(
        () => removeAllRecipePhotos(missingActiveTable, ownerId),
        "Could not find the table 'recipes'",
    );
    assertEquals(missingActiveTable.removeCalls.length, 0);

    const listFailure = new RecipeHarness({ recipes: [recipeId(1)], community_recipes: [] });
    listFailure.failListAt = 1;
    await assertRejects(
        () => removeAllRecipePhotos(listFailure, ownerId),
        'Could not enumerate recipes recipe media: recipe list backend unavailable',
    );
    assertEquals(listFailure.removeCalls.length, 0);

    const removeFailure = new RecipeHarness({ recipes: [recipeId(1)], community_recipes: [] });
    removeFailure.failRemoveAt = 1;
    await assertRejects(
        () => removeAllRecipePhotos(removeFailure, ownerId),
        'Could not remove recipe media: recipe remove backend unavailable',
    );
});

Deno.test('recipe media cleanup fails closed when row deletion does not verify the whole cleaned page', async () => {
    const ownerId = '11111111-1111-4111-8111-111111111111';
    const repeatedId = recipeId(1);
    const gateway: RecipeMediaGateway = {
        listOwnedRecipeIds: () => Promise.resolve({ data: [{ id: repeatedId }], error: null }),
        removeRecipePhotos: () => Promise.resolve({ error: null }),
        deleteOwnedRecipeRows: () => Promise.resolve({ data: [], error: null }),
    };

    await assertRejects(
        () => removeAllRecipePhotos(gateway, ownerId),
        'Database did not delete the whole page',
    );
});

Deno.test('recipe media cleanup rejects a null success payload instead of treating it as empty', async () => {
    const gateway: RecipeMediaGateway = {
        listOwnedRecipeIds: () => Promise.resolve({ data: null, error: null }),
        removeRecipePhotos: () => Promise.resolve({ error: null }),
        deleteOwnedRecipeRows: () => Promise.resolve({ data: [], error: null }),
    };

    await assertRejects(
        () => removeAllRecipePhotos(gateway, '11111111-1111-4111-8111-111111111111'),
        'Database returned no verifiable rows',
    );
});

Deno.test('storage cleanup stops at a per-invocation budget and a retry resumes durable progress', async () => {
    const storage = new StorageHarness(
        Array.from({ length: 250 }, (_, index) => `owner/file-${String(index).padStart(4, '0')}`),
    );

    await assertRejects(
        () => drainStoragePrefix(storage, 'private-media', 'owner', { maxListPasses: 2 }),
        'cleanup invocation budget reached; retry to resume',
    );
    assertEquals(storage.objects.size, 50);
    await drainStoragePrefix(storage, 'private-media', 'owner');
    assertEquals(storage.objects.size, 0);
    assert(MAX_STORAGE_LIST_PASSES_PER_INVOCATION > 2);
});

Deno.test('recipe cleanup deletes each cleaned page before a budget failure and resumes on retry', async () => {
    const ownerId = '11111111-1111-4111-8111-111111111111';
    const recipes = Array.from({ length: RECIPE_ID_PAGE_SIZE + 37 }, (_, index) => recipeId(index));
    const gateway = new RecipeHarness({ recipes, community_recipes: [] });

    await assertRejects(
        () => removeAllRecipePhotos(gateway, ownerId, { maxPagesPerTable: 1 }),
        'cleanup invocation budget reached; retry to resume',
    );
    assertEquals(gateway.rows.recipes.length, 37);
    const firstPassPaths = gateway.removeCalls.flat().length;

    await removeAllRecipePhotos(gateway, ownerId, { maxPagesPerTable: 2 });
    assertEquals(gateway.rows.recipes.length, 0);
    assertEquals(gateway.removeCalls.flat().length - firstPassPaths, 37 * 2);
    assert(MAX_RECIPE_PAGES_PER_TABLE_PER_INVOCATION > 2);
});

Deno.test('a storage cleanup failure reaches the deletion workflow and prevents auth deletion', async () => {
    const storage = new StorageHarness(['owner/private.jpg']);
    storage.failRemoveAt = 1;
    let authDeletionRan = false;

    await assertRejects(
        () =>
            runAccountDeletionWorkflow({
                revokeAppleCredential: () => Promise.resolve(false),
                drainStorage: async () => {
                    await drainStoragePrefix(storage, 'private-media', 'owner');
                    return { complete: true, processed: 1 };
                },
                scrubSurvivors: () => Promise.resolve(),
                markAuthDeleting: () => Promise.resolve(),
                deleteAuthUser: () => {
                    authDeletionRan = true;
                    return Promise.resolve();
                },
                completeDeletion: () => Promise.resolve(),
            }),
        'remove backend unavailable',
    );
    assert(!authDeletionRan, 'Auth deletion must not run after incomplete storage cleanup');
});

class ExactManifestHarness implements StorageManifestGateway {
    readonly pending = new Map<string, StorageManifestItem>();
    readonly objects = new Map<string, Set<string>>();
    readonly removeCalls: Array<{ bucket: string; paths: string[] }> = [];
    failRemove = false;
    shortCheckpoint = false;

    constructor(items: readonly StorageManifestItem[]) {
        for (const item of items) {
            this.pending.set(`${item.bucketId}\u0000${item.objectName}`, item);
            const bucket = this.objects.get(item.bucketId) ?? new Set<string>();
            bucket.add(item.objectName);
            this.objects.set(item.bucketId, bucket);
        }
    }

    listPending(limit: number): Promise<{ data: readonly StorageManifestItem[]; error: null }> {
        return Promise.resolve({ data: [...this.pending.values()].slice(0, limit), error: null });
    }

    remove(bucket: string, paths: readonly string[]): Promise<{ error: { message: string } | null }> {
        this.removeCalls.push({ bucket, paths: [...paths] });
        if (this.failRemove) return Promise.resolve({ error: { message: 'storage backend unavailable' } });
        const objects = this.objects.get(bucket);
        for (const path of paths) objects?.delete(path);
        return Promise.resolve({ error: null });
    }

    markRemoveRequested(
        items: readonly StorageManifestItem[],
    ): Promise<{ data: readonly StorageManifestItem[]; error: null }> {
        const marked = this.shortCheckpoint ? items.slice(0, -1) : items;
        for (const item of marked) this.pending.delete(`${item.bucketId}\u0000${item.objectName}`);
        return Promise.resolve({ data: marked, error: null });
    }
}

Deno.test('exact account Storage manifest drains mixed buckets and checkpoints every accepted path', async () => {
    const items = [
        { bucketId: 'diary-photos', objectName: 'owner/nested/a.jpg' },
        { bucketId: 'recipe-photos', objectName: 'legacy-root.jpg' },
        { bucketId: 'diary-photos', objectName: 'owner/b.jpg' },
    ];
    const gateway = new ExactManifestHarness(items);

    const result = await drainExactStorageManifest(gateway);

    assertEquals(result, { complete: true, processed: 3 });
    assertEquals(gateway.pending.size, 0);
    assert([...gateway.objects.values()].every((objects) => objects.size === 0));
    assertEquals(gateway.removeCalls.map((call) => call.bucket).sort(), ['diary-photos', 'recipe-photos']);
});

Deno.test('exact account Storage manifest preserves retry progress at its invocation budget', async () => {
    const items = Array.from({ length: 205 }, (_, index) => ({
        bucketId: 'diary-photos',
        objectName: `owner/photo-${String(index).padStart(4, '0')}.jpg`,
    }));
    const gateway = new ExactManifestHarness(items);

    assertEquals(await drainExactStorageManifest(gateway, { maxPages: 2 }), { complete: false, processed: 200 });
    assertEquals(gateway.pending.size, 5);
    assertEquals(await drainExactStorageManifest(gateway, { maxPages: 1 }), { complete: false, processed: 5 });
    assertEquals(await drainExactStorageManifest(gateway, { maxPages: 1 }), { complete: true, processed: 0 });
});

Deno.test('exact account Storage manifest fails closed before checkpoint on remove or verification failure', async () => {
    const item = { bucketId: 'diary-photos', objectName: 'owner/private.jpg' };
    const removeFailure = new ExactManifestHarness([item]);
    removeFailure.failRemove = true;
    await assertRejects(
        () => drainExactStorageManifest(removeFailure),
        'Could not remove diary-photos account media',
    );
    assertEquals(removeFailure.pending.size, 1);

    const checkpointFailure = new ExactManifestHarness([item]);
    checkpointFailure.shortCheckpoint = true;
    await assertRejects(
        () => drainExactStorageManifest(checkpointFailure),
        'checkpoint did not verify the whole batch',
    );
    assertEquals(checkpointFailure.pending.size, 1);
});
