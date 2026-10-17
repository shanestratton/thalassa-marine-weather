import { outboundFetch } from './outboundHttp.js';
import { supabaseEdgeUrl, supabaseHeaders, type ProxyConfig } from './proxy.js';
import {
    OWN_OSM_MAX_BYTES,
    parseOwnedOsmDocument,
    parseOwnedOsmRequest,
    type OwnedOsmRequest,
    type OwnedOsmDocument,
} from './ownedOsmContract.js';
import type { OverpassRequest, OverpassReply } from './services/osm.js';
import { ownedOperationForQuery } from './ownedOsmContract.js';

/** Only the byte/status reader actually consumed here. Both undici's pinned
 * outbound reply and Node's standards Response implement this interface. */
interface OwnedReply {
    ok: boolean;
    headers: { get(name: string): string | null };
    body: {
        cancel(): Promise<unknown>;
        getReader(): {
            read(): Promise<{ done: boolean; value?: Uint8Array }>;
            cancel(): Promise<unknown>;
        };
    } | null;
}
export type OwnedOsmFetch = (...args: Parameters<typeof outboundFetch>) => Promise<OwnedReply>;

/** Pi uses its existing public Supabase credential, never the gateway's
 * private server key. DNS pins, redirects and private-host refusal remain in
 * outboundFetch. Configuration is the live server object, not a stale env copy.
 */
export async function fetchOwnedOsmEdge(
    config: ProxyConfig,
    operation: OwnedOsmRequest,
    signal?: AbortSignal,
    fetcher: OwnedOsmFetch = outboundFetch,
): Promise<OwnedOsmDocument> {
    const input = parseOwnedOsmRequest(operation);
    if (!input || !config.supabaseAnonKey || signal?.aborted) throw new Error('Owned OSM context unavailable');
    const controller = new AbortController();
    let reader: { cancel(): Promise<unknown> } | undefined;
    let reject!: (reason: Error) => void;
    const retired = new Promise<never>((_, no) => {
        reject = no;
    });
    const cancel = () => {
        controller.abort();
        reject(new Error('Owned OSM request retired'));
    };
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, 25_000);
    try {
        return await Promise.race([
            (async () => {
                const response = await fetcher(supabaseEdgeUrl(config, 'owned-overpass'), {
                    method: 'POST',
                    headers: { ...supabaseHeaders(config), 'Content-Type': 'application/json' },
                    body: JSON.stringify(input),
                    signal: controller.signal,
                });
                if (
                    !response.ok ||
                    controller.signal.aborted ||
                    !response.body ||
                    Number(response.headers.get('content-length')) > OWN_OSM_MAX_BYTES
                ) {
                    void response.body?.cancel().catch(() => undefined);
                    throw new Error('Owned OSM unavailable');
                }
                const activeReader = response.body.getReader();
                reader = activeReader;
                const chunks: Uint8Array[] = [];
                let total = 0;
                try {
                    while (true) {
                        const { done, value } = await activeReader.read();
                        if (done) break;
                        if (!value) throw new Error('Owned OSM stream chunk missing');
                        total += value.byteLength;
                        if (total > OWN_OSM_MAX_BYTES || controller.signal.aborted)
                            throw new Error('Owned OSM body refused');
                        chunks.push(value);
                    }
                    if (controller.signal.aborted) throw new Error('Owned OSM retired');
                    const raw = Buffer.concat(chunks, total);
                    return parseOwnedOsmDocument(
                        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)),
                        input,
                    );
                } finally {
                    void activeReader.cancel().catch(() => undefined);
                }
            })(),
            retired,
        ]);
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        controller.abort();
        if (reader) void reader.cancel().catch(() => undefined);
    }
}

export async function fetchOwnedOverlayReply(config: ProxyConfig, request: OverpassRequest): Promise<OverpassReply> {
    const query = new URLSearchParams(request.body).get('data');
    if (!query) throw new Error('Missing bounded overlay recipe');
    const operation = ownedOperationForQuery(query);
    if (operation.kind !== 'overlay') throw new Error('Wrong overlay operation');
    const document = await fetchOwnedOsmEdge(config, operation, request.signal);
    return {
        ok: true,
        status: 200,
        sourceAt: Date.parse(document.thalassaSource.sourceAt),
        text: async () => JSON.stringify(document),
    };
}
