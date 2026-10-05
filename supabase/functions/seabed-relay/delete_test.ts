// "Delete my soundings" against a fake Supabase that pages like the real one:
// PostgREST answers at most 1000 rows, storage.list at most `limit` entries.
// Fictional owner ids only.
import { deleteAllSoundings, type DeleteClient } from './deleteAll.ts';

function assertEquals(actual: unknown, expected: unknown, note = ''): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) return;
    throw new Error(`${note} expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}

const OWNER = '00000000-0000-4000-8000-000000000001';
const CSB = '00000000-0000-4000-8000-0000000000aa';
const MAX_ROWS = 1000;

function fakeSupabase(indexed: number, orphans: number, failRemove = false) {
    const events: string[] = [];
    const objects = new Set<string>();
    let index: { owner_id: string; object_path: string }[] = [];
    for (let i = 0; i < indexed; i++) {
        const path = `${OWNER}/${CSB}/2030/i${String(i).padStart(5, '0')}.csv.gz`;
        objects.add(path);
        index.push({ owner_id: OWNER, object_path: path });
    }
    for (let i = 0; i < orphans; i++) objects.add(`${OWNER}/${CSB}/2031/o${String(i).padStart(5, '0')}.csv.gz`);

    const client: DeleteClient = {
        from(table: string) {
            const filters: Array<(row: Record<string, unknown>) => boolean> = [];
            let mode: 'select' | 'delete' | 'update' = 'select';
            let limit = Infinity;
            const builder = {
                select: () => builder,
                update: () => ((mode = 'update'), builder),
                delete: () => ((mode = 'delete'), builder),
                eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), builder),
                in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), builder),
                order: () => builder,
                limit: (n: number) => ((limit = n), builder),
                then(resolve: (v: unknown) => unknown) {
                    if (table === 'seabed_platforms') {
                        events.push('platform-off');
                        return Promise.resolve({ error: null }).then(resolve);
                    }
                    const match = (r: Record<string, unknown>) => filters.every((f) => f(r));
                    if (mode === 'delete') {
                        events.push('index-delete');
                        index = index.filter((r) => !match(r));
                        return Promise.resolve({ error: null }).then(resolve);
                    }
                    const data = index.filter(match).slice(0, Math.min(limit, MAX_ROWS));
                    return Promise.resolve({ data, error: null }).then(resolve);
                },
            };
            return builder;
        },
        storage: {
            from: () => ({
                list: (prefix: string, opts: { limit: number; offset?: number }) => {
                    const depth = prefix.split('/').length;
                    const names = new Set<string>();
                    const files = new Map<string, boolean>();
                    for (const path of objects) {
                        if (!path.startsWith(`${prefix}/`)) continue;
                        const parts = path.split('/');
                        names.add(parts[depth]);
                        files.set(parts[depth], parts.length === depth + 1);
                    }
                    const sorted = [...names].sort();
                    const page = sorted.slice(opts.offset ?? 0, (opts.offset ?? 0) + Math.min(opts.limit, 100));
                    return Promise.resolve({
                        data: page.map((name) => ({ name, id: files.get(name) ? `id-${name}` : null })),
                        error: null,
                    });
                },
                remove: (paths: string[]) => {
                    events.push('objects-remove');
                    if (failRemove) return Promise.resolve({ data: null, error: { message: 'storage is down' } });
                    for (const p of paths) objects.delete(p);
                    return Promise.resolve({ data: paths.map((name) => ({ name })), error: null });
                },
            }),
        },
    };
    return { client, objects, events, index: () => index };
}

Deno.test('deletes every object and index row, past every page limit, after switching logging off', async () => {
    const fake = fakeSupabase(2500, 1200);
    const out = await deleteAllSoundings(fake.client, OWNER, 'seabed-soundings');
    assertEquals(out.ok, true);
    assertEquals(fake.objects.size, 0, 'objects left');
    assertEquals(fake.index().length, 0, 'index rows left');
    assertEquals(fake.events[0], 'platform-off', 'switched off first');
    assertEquals(out.ok && out.removed, 3700);
});

Deno.test('an index row stays while its object could not be removed', async () => {
    const fake = fakeSupabase(10, 0, true);
    const out = await deleteAllSoundings(fake.client, OWNER, 'seabed-soundings');
    assertEquals(out.ok, false);
    assertEquals(fake.index().length, 10);
    assertEquals(fake.events.includes('index-delete'), false);
});
