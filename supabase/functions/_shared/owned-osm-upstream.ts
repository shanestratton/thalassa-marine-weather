import {
    OWN_OSM_MAX_BYTES,
    type OwnedOsmDocument,
    type OwnedOsmRequest,
    parseOwnedOsmDocument,
    parseOwnedOsmRequest,
} from '../../../services/osm/ownedOverpassContract.ts';

/** Proposed ingress, unavailable until independently admitted and configured.
 * Never substitute a public interpreter or a private tailnet address.
 */
export const OWN_OSM_ORIGIN = 'https://wx-data.thalassawx.app';
export const OWN_OSM_DEADLINE_MS = 20_000;
const cancelled = () => new DOMException('OSM intent retired', 'AbortError');
export async function fetchOwnedOsmFromWx(
    operation: OwnedOsmRequest,
    env: (name: string) => string | undefined,
    signal?: AbortSignal,
    fetcher: typeof fetch = fetch,
): Promise<OwnedOsmDocument> {
    const input = parseOwnedOsmRequest(operation);
    const origin = env('THALASSA_WX_OSM_ORIGIN'), token = env('THALASSA_WX_OSM_TOKEN');
    if (!input || origin !== OWN_OSM_ORIGIN || !token || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
        throw new Error('Owned OSM source unconfigured or operation refused');
    }
    if (signal?.aborted) throw cancelled();
    const controller = new AbortController();
    let rejectDeadline!: (reason: Error) => void;
    const interrupted = new Promise<never>((_, reject) => {
        rejectDeadline = reject;
    });
    const cancel = () => {
        controller.abort();
        rejectDeadline(cancelled());
    };
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => {
        controller.abort();
        rejectDeadline(new Error('Owned OSM deadline'));
    }, OWN_OSM_DEADLINE_MS);
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
        return await Promise.race([
            (async () => {
                response = await fetcher(origin + '/osm/query', {
                    method: 'POST',
                    redirect: 'error',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json',
                        Authorization: `Bearer ${token}`,
                    },
                    body: JSON.stringify(input),
                    signal: controller.signal,
                });
                if (
                    !response.ok || controller.signal.aborted || !response.body ||
                    Number(response.headers.get('content-length')) > OWN_OSM_MAX_BYTES
                ) {
                    void response.body?.cancel().catch(() => undefined);
                    throw new Error('Owned OSM unavailable');
                }
                reader = response.body.getReader();
                const chunks: Uint8Array[] = [];
                let total = 0;
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    total += value.byteLength;
                    if (total > OWN_OSM_MAX_BYTES || controller.signal.aborted) {
                        throw new Error('Owned OSM body refused');
                    }
                    chunks.push(value);
                }
                if (controller.signal.aborted) throw cancelled();
                const raw = new Uint8Array(total);
                let at = 0;
                for (const chunk of chunks) {
                    raw.set(chunk, at);
                    at += chunk.byteLength;
                }
                return parseOwnedOsmDocument(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)), input);
            })(),
            interrupted,
        ]);
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        controller.abort();
        if (reader) {
            const active = reader;
            void active.cancel().then(() => active.releaseLock()).catch(() => undefined);
        }
        if (response?.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
    }
}
