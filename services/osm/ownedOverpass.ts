import { supabase, supabaseAnonKey, supabaseUrl } from '../supabase';
import { satelliteModeActive } from '../networkPolicy';
import { withDeadline } from '../../utils/deadline';
import {
    OWN_OSM_MAX_BYTES,
    ownedOperationForQuery,
    parseOwnedOsmDocument,
    type OwnedOsmDocument,
} from './ownedOverpassContract';

/** Fixed own Edge operation, no endpoint choice/public fallback or position
 * persistence. A missing gateway/database remains an unavailable reference.
 */
export async function fetchOwnedOverpass(
    query: string,
    options: {
        signal?: AbortSignal;
        timeoutMs?: number;
        reached?: () => void;
    } = {},
): Promise<OwnedOsmDocument> {
    const operation = ownedOperationForQuery(query);
    const { signal, reached } = options;
    const timeoutMs = options.timeoutMs ?? 25_000;
    if (
        !supabaseUrl ||
        !supabaseAnonKey ||
        signal?.aborted ||
        satelliteModeActive() ||
        (typeof navigator !== 'undefined' && navigator.onLine === false) ||
        !Number.isFinite(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > 30_000
    )
        throw new Error('Owned OSM paused/unconfigured');
    const controller = new AbortController();
    let rejectRetired!: (reason: Error) => void;
    const retired = new Promise<never>((_, reject) => {
        rejectRetired = reject;
    });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let sent = false,
        counted = false;
    const count = () => {
        if (!counted) {
            counted = true;
            reached?.();
        }
    };
    const cancel = () => {
        controller.abort();
        rejectRetired(new Error('OSM intent retired'));
    };
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => {
        if (sent && !signal?.aborted) count();
        cancel();
    }, timeoutMs);
    try {
        return await withDeadline(
            Promise.race([
                (async () => {
                    let bearer = supabaseAnonKey;
                    if (supabase) {
                        const { data } = await supabase.auth.getSession();
                        if (data.session?.access_token && (data.session.expires_at ?? 0) * 1000 > Date.now() + 30_000)
                            bearer = data.session.access_token;
                    }
                    if (
                        controller.signal.aborted ||
                        satelliteModeActive() ||
                        (typeof navigator !== 'undefined' && navigator.onLine === false)
                    )
                        throw new Error('OSM intent retired');
                    sent = true;
                    const response = await fetch(`${supabaseUrl}/functions/v1/owned-overpass`, {
                        method: 'POST',
                        redirect: 'error',
                        headers: {
                            'Content-Type': 'application/json',
                            apikey: supabaseAnonKey,
                            Authorization: `Bearer ${bearer}`,
                        },
                        body: JSON.stringify(operation),
                        signal: controller.signal,
                    });
                    count();
                    if (
                        !response.ok ||
                        controller.signal.aborted ||
                        !response.body ||
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
                        if (total > OWN_OSM_MAX_BYTES || controller.signal.aborted)
                            throw new Error('Owned OSM body refused');
                        chunks.push(value);
                    }
                    if (controller.signal.aborted) throw new Error('OSM intent retired');
                    const raw = new Uint8Array(total);
                    let offset = 0;
                    for (const chunk of chunks) {
                        raw.set(chunk, offset);
                        offset += chunk.byteLength;
                    }
                    return parseOwnedOsmDocument(
                        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)),
                        operation,
                    );
                })(),
                retired,
            ]),
            timeoutMs,
            'owned OSM reference',
        );
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        controller.abort();
        if (reader) {
            const active = reader;
            void active
                .cancel()
                .then(() => active.releaseLock())
                .catch(() => undefined);
        }
    }
}
