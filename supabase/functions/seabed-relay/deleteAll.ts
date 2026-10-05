/**
 * "Delete my soundings": every object and index row of one account, with the
 * switch off FIRST, so no new batch lands while they go.
 *
 * Paged all the way: PostgREST answers at most max_rows (1000 on the hosted
 * project) and storage.list a page at a time, so a season of hourly batches
 * is more than one answer. An index row is deleted only once its object has
 * been removed, so a failure part-way leaves nothing unfindable: the next
 * "Delete" picks up where this one stopped. Objects whose index row never
 * landed are found by walking {owner}/{csb}/{year}/. The index is walked once
 * more at the end for a batch that was in flight when the switch went off.
 */

/** supabase-js builders are thenables, not Promises; typed loosely on purpose (see who.ts). */
export interface DeleteClient {
    // deno-lint-ignore no-explicit-any
    from(table: string): any;
    storage: {
        // deno-lint-ignore no-explicit-any
        from(bucket: string): any;
    };
}

export type DeleteOutcome = { ok: true; removed: number } | { ok: false; error: string };

const INDEX_PAGE = 500;
const LIST_PAGE = 1000;
const REMOVE_CHUNK = 100;
/** A season of hourly batches is ~9 pages; this many means something is not going away. */
const MAX_PAGES = 2_000;

class DeleteFailure extends Error {}

export async function deleteAllSoundings(admin: DeleteClient, ownerId: string, bucket: string): Promise<DeleteOutcome> {
    const storage = admin.storage.from(bucket);
    let removed = 0;

    const removeObjects = async (paths: string[]) => {
        for (let i = 0; i < paths.length; i += REMOVE_CHUNK) {
            const chunk = paths.slice(i, i + REMOVE_CHUNK);
            const { error } = await storage.remove(chunk);
            if (error) throw new DeleteFailure('Could not remove every sounding file; try again');
            removed += chunk.length;
        }
    };

    /** Indexed batches, a page at a time: object first, then its index row. */
    const drainIndex = async () => {
        for (let page = 0; page < MAX_PAGES; page++) {
            const { data, error } = await admin
                .from('seabed_batches')
                .select('object_path')
                .eq('owner_id', ownerId)
                .order('object_path')
                .limit(INDEX_PAGE);
            if (error) throw new DeleteFailure('Could not list your soundings');
            const paths = ((data ?? []) as { object_path?: unknown }[])
                .map((row) => row.object_path)
                .filter((p): p is string => typeof p === 'string');
            if (!paths.length) return;
            await removeObjects(paths);
            const gone = await admin.from('seabed_batches').delete().eq('owner_id', ownerId).in('object_path', paths);
            if (gone.error) throw new DeleteFailure('Could not remove the sounding index; try again');
        }
        throw new DeleteFailure('The sounding index did not empty; try again');
    };

    /** Every entry under a prefix, page after page until a page comes back empty. */
    const listAll = async (prefix: string) => {
        const out: { name: string; id: string | null }[] = [];
        for (let page = 0; page < MAX_PAGES; page++) {
            const { data, error } = await storage.list(prefix, { limit: LIST_PAGE, offset: out.length });
            if (error) throw new DeleteFailure('Could not list your sounding files');
            const entries = (data ?? []) as { name: string; id: string | null }[];
            if (!entries.length) return out;
            out.push(...entries);
        }
        throw new DeleteFailure('Your sounding files did not list to the end; try again');
    };

    try {
        const off = await admin.from('seabed_platforms').update({ enabled: false }).eq('owner_id', ownerId);
        if (off.error) throw new DeleteFailure('Could not switch logging off; try again');
        await drainIndex();
        const orphans: string[] = [];
        for (const platform of await listAll(ownerId)) {
            for (const year of await listAll(`${ownerId}/${platform.name}`)) {
                for (const file of await listAll(`${ownerId}/${platform.name}/${year.name}`)) {
                    if (file.id) orphans.push(`${ownerId}/${platform.name}/${year.name}/${file.name}`);
                }
            }
        }
        await removeObjects(orphans);
        await drainIndex();
        return { ok: true, removed };
    } catch (err) {
        return { ok: false, error: err instanceof DeleteFailure ? err.message : 'Could not delete your soundings' };
    }
}
