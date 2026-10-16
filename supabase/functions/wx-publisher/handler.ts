import {
    cellCentre,
    InputError,
    MAX_BODY_BYTES,
    MAX_ROWS,
    MODELS,
    object,
    rawStoredModel,
    storedModel,
    validateRow,
    validCursor,
} from './contract.ts';

export interface PublisherOptions {
    tokenHash: string;
    restBase: string;
    serviceKey: string;
    fetch: typeof fetch;
    now?: () => number;
}
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
function reply(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers });
}
export async function tokenHash(token: string): Promise<string> {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
async function authorised(request: Request, expected: string): Promise<boolean> {
    const token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('Authorization') || '')?.[1];
    if (!token) return false;
    const got = await tokenHash(token);
    let different = 0;
    for (let i = 0; i < 64; i++) different |= got.charCodeAt(i) ^ expected.charCodeAt(i);
    return different === 0;
}
async function boundedText(body: ReadableStream<Uint8Array> | null, max: number): Promise<string> {
    if (!body) return '';
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > max) {
                await reader.cancel();
                throw new InputError('Body too large');
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
export async function handlePublisherRequest(request: Request, options: PublisherOptions): Promise<Response> {
    if (!/^[a-f0-9]{64}$/.test(options.tokenHash)) return reply({ error: 'Publisher not configured' }, 503);
    if (!(await authorised(request, options.tokenHash))) return reply({ error: 'Unauthorised' }, 401);
    if (request.method !== 'POST') return reply({ error: 'POST required' }, 405);
    if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json'))
        return reply({ error: 'JSON required' }, 415);
    if (Number(request.headers.get('Content-Length')) > MAX_BODY_BYTES) return reply({ error: 'Body too large' }, 413);
    if (!options.serviceKey || !/^https:\/\/[a-z0-9]+\.supabase\.co\/rest\/v1\/?$/.test(options.restBase))
        return reply({ error: 'Publisher unavailable' }, 503);
    const now = (options.now || Date.now)();
    const activeSince = new Date(now - 3 * 86400_000).toISOString();
    const rest = async (
        table: 'wx_subscriptions' | 'wx_point_forecasts',
        params: Record<string, string>,
        method = 'GET',
        body?: unknown,
        prefer?: string,
    ): Promise<Record<string, unknown>[]> => {
        const url = new URL(options.restBase.replace(/\/$/, '') + '/' + table);
        for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
        const response = await options.fetch(url.toString(), {
            method,
            headers: {
                apikey: options.serviceKey,
                Authorization: `Bearer ${options.serviceKey}`,
                'Content-Type': 'application/json',
                ...(prefer ? { Prefer: prefer } : {}),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            redirect: 'error',
            signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) throw new Error('Database request failed');
        const data: unknown = JSON.parse(await boundedText(response.body, 2 * MAX_BODY_BYTES));
        if (!Array.isArray(data) || !data.every(object)) throw new Error('Invalid database response');
        return data;
    };
    try {
        let body: unknown;
        try {
            body = JSON.parse(await boundedText(request.body, MAX_BODY_BYTES));
        } catch (error) {
            if (error instanceof InputError) return reply({ error: error.message }, 413);
            throw new InputError('Invalid JSON');
        }
        if (!object(body)) throw new InputError('Invalid request');
        if (body.action === 'work') {
            if (Object.keys(body).some((key) => !['action', 'after', 'limit'].includes(key)))
                throw new InputError('Unexpected work field');
            if (body.after !== undefined && body.after !== null && !validCursor(body.after))
                throw new InputError('Invalid cursor');
            const limit = body.limit === undefined ? 64 : body.limit;
            if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 64)
                throw new InputError('Invalid page size');
            const subscriptions = await rest('wx_subscriptions', {
                select: 'cell_id',
                last_seen_at: `gte.${activeSince}`,
                order: 'cell_id.asc',
                limit: String(limit),
                ...(body.after ? { cell_id: `gt.${body.after}` } : {}),
            });
            const cells = subscriptions.flatMap((row) => {
                const centre = cellCentre(row.cell_id);
                return centre
                    ? [{ cell_id: row.cell_id as string, ...centre, runs: {} as Record<string, string> }]
                    : [];
            });
            if (cells.length) {
                const versions = await rest('wx_point_forecasts', {
                    select: 'cell_id,model,run_at',
                    cell_id: `in.(${cells.map((row) => row.cell_id).join(',')})`,
                    model: `in.(${Object.keys(MODELS).map(storedModel).join(',')})`,
                    limit: '384',
                });
                for (const row of versions) {
                    const cell = cells.find((cell) => cell.cell_id === row.cell_id);
                    const model = rawStoredModel(row.model);
                    if (cell && model && typeof row.run_at === 'string') cell.runs[model] = row.run_at;
                }
            }
            return reply({
                schema_version: 2,
                generated_at: new Date(now).toISOString(),
                models: MODELS,
                cells,
                next_cursor: subscriptions.length === limit ? subscriptions[subscriptions.length - 1]?.cell_id : null,
            });
        }
        if (
            body.action !== 'publish' ||
            !Array.isArray(body.rows) ||
            body.rows.length < 1 ||
            body.rows.length > MAX_ROWS
        )
            throw new InputError('Expected 1–16 publication rows');
        if (Object.keys(body).some((key) => !['action', 'rows'].includes(key)))
            throw new InputError('Unexpected publication field');
        const rows = body.rows.map((row) => validateRow(row, now));
        const keys = rows.map((row) => row.cell_id + '/' + row.model);
        if (new Set(keys).size !== keys.length) throw new InputError('Duplicate publication row');
        const subscriptions = await rest('wx_subscriptions', {
            select: 'cell_id',
            cell_id: `in.(${[...new Set(rows.map((row) => row.cell_id))].join(',')})`,
            last_seen_at: `gte.${activeSince}`,
            limit: '16',
        });
        const active = new Set(subscriptions.map((row) => row.cell_id));
        if (rows.some((row) => !active.has(row.cell_id))) throw new InputError('Cell is not currently subscribed');
        const results: Record<string, unknown>[] = [];
        // Insert-ignore first closes the absent-row race; conditional PATCH
        // then advances an existing row only if its stored run is older.
        for (let i = 0; i < rows.length; i += 4) {
            const batch = await Promise.all(
                rows.slice(i, i + 4).map(async (row) => {
                    const stored = { ...row, model: storedModel(row.model), published_at: new Date(now).toISOString() };
                    const inserted = await rest(
                        'wx_point_forecasts',
                        { on_conflict: 'cell_id,model', select: 'cell_id,model,run_at' },
                        'POST',
                        stored,
                        'resolution=ignore-duplicates,return=representation',
                    );
                    let status = 'inserted';
                    if (!inserted.length) {
                        const patched = await rest(
                            'wx_point_forecasts',
                            {
                                cell_id: `eq.${row.cell_id}`,
                                model: `eq.${stored.model}`,
                                run_at: `lt.${row.run_at}`,
                                select: 'cell_id,model,run_at',
                            },
                            'PATCH',
                            { run_at: row.run_at, payload: row.payload, published_at: stored.published_at },
                            'return=representation',
                        );
                        status = patched.length ? 'updated' : 'unchanged';
                    }
                    return { cell_id: row.cell_id, model: row.model, run_at: row.run_at, status };
                }),
            );
            results.push(...batch);
        }
        return reply({ schema_version: 2, results });
    } catch (error) {
        if (error instanceof InputError) return reply({ error: error.message }, 400);
        // Never echo database errors, submitted payloads, credentials or headers.
        return reply({ error: 'Publisher temporarily unavailable; retry safely' }, 503);
    }
}
