/**
 * A small in-memory stand-in for the Supabase client, for the sightings
 * tests: the sightings table, the photo bucket, the public RPC and realtime.
 * Each call is recorded in `calls` so tests can assert order. Errors are
 * injected per operation.
 */
type Row = Record<string, unknown>;
type DbError = { code?: string; message: string } | null;

export interface FakeSupabaseState {
    rows: Map<string, Row>;
    objects: Map<string, Blob>;
    calls: string[];
    sessionUserId: string | null;
    insertErrors: DbError[];
    updateErrors: DbError[];
    deleteErrors: DbError[];
    selectErrors: DbError[];
    uploadErrors: Array<{ message: string; statusCode?: string } | null>;
    rpcResult: { data: unknown; error: DbError };
    rpcCalls: Array<{ name: string; args: Record<string, unknown> }>;
    onInsert: ((row: Row) => Promise<void> | void) | null;
    channels: Array<{
        name: string;
        filter: Record<string, unknown> | null;
        handler: ((payload: unknown) => void) | null;
        removed: boolean;
    }>;
}

export function newFakeState(): FakeSupabaseState {
    return {
        rows: new Map(),
        objects: new Map(),
        calls: [],
        sessionUserId: null,
        insertErrors: [],
        updateErrors: [],
        deleteErrors: [],
        selectErrors: [],
        uploadErrors: [],
        rpcResult: { data: [], error: null },
        rpcCalls: [],
        onInsert: null,
        channels: [],
    };
}

export function fakeSupabase(state: FakeSupabaseState) {
    const table = (name: string) => {
        let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
        let payload: Row | null = null;
        const filters: Array<(row: Row) => boolean> = [];
        let limit = Infinity;
        let wantRows = false;
        const builder = {
            select: (_cols?: string) => {
                if (op !== 'select') wantRows = true;
                return builder;
            },
            insert: (row: Row) => {
                op = 'insert';
                payload = row;
                return builder;
            },
            update: (row: Row) => {
                op = 'update';
                payload = row;
                return builder;
            },
            delete: () => {
                op = 'delete';
                return builder;
            },
            eq: (column: string, value: unknown) => {
                filters.push((row) => row[column] === value);
                return builder;
            },
            in: (column: string, values: unknown[]) => {
                filters.push((row) => values.includes(row[column]));
                return builder;
            },
            gte: (column: string, value: unknown) => {
                filters.push((row) => String(row[column]) >= String(value));
                return builder;
            },
            not: (column: string, operator: string, value: unknown) => {
                if (operator === 'is' && value === null) {
                    filters.push((row) => row[column] !== null && row[column] !== undefined);
                }
                return builder;
            },
            order: () => builder,
            limit: (n: number) => {
                limit = n;
                return builder;
            },
            then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
                run().then(resolve, reject),
        };
        const matching = () => [...state.rows.values()].filter((row) => filters.every((f) => f(row)));
        const run = async (): Promise<{ data: unknown; error: DbError }> => {
            state.calls.push(`${name}.${op}`);
            if (op === 'insert') {
                const error = state.insertErrors.shift() ?? null;
                if (error) return { data: null, error };
                const row = payload as Row;
                if (state.rows.has(String(row.id)))
                    return { data: null, error: { code: '23505', message: 'duplicate key' } };
                await state.onInsert?.(row);
                state.rows.set(String(row.id), {
                    ...row,
                    created_at: '2026-08-14T01:21:00.000Z',
                    updated_at: '2026-08-14T01:21:00.000Z',
                });
                return { data: null, error: null };
            }
            if (op === 'update') {
                const error = state.updateErrors.shift() ?? null;
                if (error) return { data: null, error };
                const hit = matching();
                for (const row of hit) Object.assign(row, payload);
                return { data: wantRows ? hit.map((r) => ({ id: r.id })) : null, error: null };
            }
            if (op === 'delete') {
                const error = state.deleteErrors.shift() ?? null;
                if (error) return { data: null, error };
                for (const row of matching()) state.rows.delete(String(row.id));
                return { data: null, error: null };
            }
            const error = state.selectErrors.shift() ?? null;
            if (error) return { data: null, error };
            return { data: matching().slice(0, limit), error: null };
        };
        return builder;
    };

    return {
        auth: {
            getSession: async () => ({
                data: { session: state.sessionUserId ? { user: { id: state.sessionUserId } } : null },
                error: null,
            }),
        },
        from: table,
        storage: {
            from: (bucket: string) => ({
                upload: async (path: string, blob: Blob, _options?: unknown) => {
                    state.calls.push(`${bucket}.upload ${path}`);
                    const error = state.uploadErrors.shift() ?? null;
                    if (error) return { data: null, error };
                    if (state.objects.has(path)) {
                        return { data: null, error: { message: 'The resource already exists', statusCode: '409' } };
                    }
                    state.objects.set(path, blob);
                    return { data: { path }, error: null };
                },
                remove: async (paths: string[]) => {
                    state.calls.push(`${bucket}.remove ${paths.join(',')}`);
                    for (const path of paths) state.objects.delete(path);
                    return { data: [], error: null };
                },
                createSignedUrl: async (path: string, seconds: number) => ({
                    data: state.objects.has(path)
                        ? { signedUrl: `https://storage.invalid/${path}?ttl=${seconds}` }
                        : null,
                    error: state.objects.has(path) ? null : { message: 'not found' },
                }),
            }),
        },
        rpc: async (name: string, args: Record<string, unknown>) => {
            state.rpcCalls.push({ name, args });
            return state.rpcResult;
        },
        channel: (channelName: string) => {
            const entry = {
                name: channelName,
                filter: null as Record<string, unknown> | null,
                handler: null as ((p: unknown) => void) | null,
                removed: false,
            };
            state.channels.push(entry);
            const channel = {
                on: (_type: string, filter: Record<string, unknown>, handler: (payload: unknown) => void) => {
                    entry.filter = filter;
                    entry.handler = handler;
                    return channel;
                },
                subscribe: () => channel,
                __entry: entry,
            };
            return channel;
        },
        removeChannel: async (channel: { __entry: { removed: boolean } }) => {
            channel.__entry.removed = true;
            return 'ok';
        },
    };
}
