import { digest, type ExportPorts, readExportedBatch } from './core.ts';
import { jsonResponse } from '../_shared/http-security.ts';

export interface ExportOptions {
    enabled: boolean;
    tokenHash: string;
    origin: string;
    serviceKey: string;
    fetch: typeof fetch;
    now?: () => number;
}
const uuid = (v: unknown): v is string =>
    typeof v === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f\d]{64}$/.test(v);
let active = 0, period = 0, uses = 0;
export async function boundedBytes(
    stream: ReadableStream<Uint8Array> | null,
    cap: number,
    signal: AbortSignal,
): Promise<Uint8Array> {
    if (!stream) throw Error('Body missing');
    const reader = stream.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    const cancel = () => {
        void reader.cancel().catch(() => undefined);
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
        for (;;) {
            if (signal.aborted) throw Error('Aborted');
            const { done, value } = await reader.read();
            if (signal.aborted) throw Error('Aborted');
            if (done) break;
            size += value.byteLength;
            if (size > cap) {
                await reader.cancel();
                throw Error('Body limit');
            }
            chunks.push(value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
        }
        return bytes;
    } finally {
        signal.removeEventListener('abort', cancel);
        reader.releaseLock();
    }
}
const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
export async function handleCrowdExport(request: Request, options: ExportOptions): Promise<Response> {
    if (
        !options.enabled || !hash(options.tokenHash) || !options.serviceKey ||
        !/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(options.origin)
    ) return jsonResponse({ error: 'Crowd export unavailable' }, 503);
    const token = /^Bearer ([a-f\d]{64})$/.exec(request.headers.get('authorization') ?? '')?.[1];
    if (!token) return jsonResponse({ error: 'Unauthorized' }, 401);
    const got = await digest(new TextEncoder().encode(token));
    let difference = 0;
    for (let i = 0; i < 64; i++) difference |= got.charCodeAt(i) ^ options.tokenHash.charCodeAt(i);
    if (difference) return jsonResponse({ error: 'Unauthorized' }, 401);
    if (request.method !== 'POST') return jsonResponse({ error: 'POST required' }, 405);
    if (request.headers.get('content-type') !== 'application/json') {
        return jsonResponse({ error: 'JSON required' }, 415);
    }
    const now = options.now ?? Date.now, start = now();
    if (start < period || start - period >= 3600000) {
        period = start;
        uses = 0;
    }
    if (active >= 2 || uses >= 128) return jsonResponse({ error: 'Worker quota unavailable' }, 429);
    active++;
    uses++;
    const abort = new AbortController(), retire = () => abort.abort();
    request.signal.addEventListener('abort', retire, { once: true });
    if (request.signal.aborted) retire();
    const timer = setTimeout(retire, 20000);
    try {
        const body: unknown = JSON.parse(decode(await boundedBytes(request.body, 2048, abort.signal)));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('Invalid body');
        const input = body as Record<string, unknown>;
        if (!['map', 'dcdb'].includes(String(input.purpose))) throw Error('Purpose missing');
        const purpose = input.purpose as 'map' | 'dcdb';
        const rpc = async (name: string, args: unknown) => {
            const response = await options.fetch(options.origin + '/rest/v1/rpc/' + name, {
                method: 'POST',
                redirect: 'error',
                signal: abort.signal,
                headers: {
                    apikey: options.serviceKey,
                    Authorization: 'Bearer ' + options.serviceKey,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(args),
            });
            if (!response.ok) {
                await response.body?.cancel();
                throw Error('Source unavailable');
            }
            return JSON.parse(decode(await boundedBytes(response.body, 32768, abort.signal))) as unknown;
        };
        if (input.action === 'work') {
            if (
                Object.keys(input).some((key) => !['action', 'purpose', 'after'].includes(key)) ||
                (input.after != null && !uuid(input.after))
            ) throw Error('Invalid cursor');
            const result = await rpc('list_crowd_sounding_candidates', {
                p_purpose: purpose,
                p_after: input.after ?? null,
            });
            if (!result || typeof result !== 'object' || Array.isArray(result)) throw Error('Invalid page');
            const page = result as Record<string, unknown>;
            if (
                page.schema !== 1 || !Array.isArray(page.ids) || page.ids.length > 32 || !page.ids.every(uuid) ||
                new Set(page.ids).size !== page.ids.length || typeof page.hasMore !== 'boolean' ||
                (page.nextCursor !== null && (!uuid(page.nextCursor) || page.nextCursor !== page.ids.at(-1)))
            ) throw Error('Invalid page');
            if (abort.signal.aborted) throw Error('Aborted');
            return jsonResponse(page);
        }
        if (
            !['read', 'check'].includes(String(input.action)) || Object.keys(input).some((key) =>
                !['action', 'purpose', 'batchId', 'sourceKey'].includes(key)
            ) ||
            (input.action === 'check' && !hash(input.sourceKey))
        ) throw Error('Invalid action');
        const ports: ExportPorts = {
            now,
            candidate: (id, kind) => rpc('read_crowd_sounding_candidate', { p_batch_id: id, p_purpose: kind }),
            object: async (path, signal) => {
                const url = options.origin + '/storage/v1/object/authenticated/seabed-soundings/' +
                    path.split('/').map(encodeURIComponent).join('/');
                const response = await options.fetch(url, {
                    redirect: 'error',
                    signal,
                    headers: { apikey: options.serviceKey, Authorization: 'Bearer ' + options.serviceKey },
                });
                if (!response.ok) {
                    await response.body?.cancel();
                    throw Error('Original unavailable');
                }
                return boundedBytes(response.body, 2097152, signal);
            },
            inflate: async (bytes, signal) =>
                decode(
                    await boundedBytes(
                        new ReadableStream<BufferSource>({
                            start(controller) {
                                controller.enqueue(new Uint8Array(bytes));
                                controller.close();
                            },
                        }).pipeThrough(new DecompressionStream('gzip')),
                        2097152,
                        signal,
                    ),
                ),
        };
        const result = await readExportedBatch(input.batchId, purpose, ports, abort.signal);
        if (abort.signal.aborted) throw Error('Aborted');
        if (input.action === 'check') {
            if (input.sourceKey !== result.sourceKey) return jsonResponse({ error: 'Source retired' }, 409);
            return jsonResponse({
                schema: 1,
                sourceKey: result.sourceKey,
                checkedAt: result.checkedAt,
                expiresAt: result.expiresAt,
            });
        }
        return jsonResponse(result);
    } catch {
        return jsonResponse({ error: 'Current qualified private source unavailable' }, 409);
    } finally {
        clearTimeout(timer);
        request.signal.removeEventListener('abort', retire);
        abort.abort();
        active--;
    }
}
