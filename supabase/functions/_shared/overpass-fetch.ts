import { readResponseTextLimited } from './http-security.ts';

// Independent OSM instances. Private.coffee is the current canonical endpoint
// of the Kumi service already used by Thalassa. Do not forward a user's bearer,
// change identity headers to evade rejection, or retry one host in a loop.
export const OVERPASS_ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
] as const;
export const OVERPASS_ATTEMPT_MS = 20_000;
export const OVERPASS_MAX_BYTES = 20_000_000;
export const OVERPASS_MAX_ELEMENTS = 25_000;

export interface OverpassDocument {
    elements: unknown[];
}

/** A 200 response can contain an Overpass runtime error and partial elements.
 * Those must never be cached or treated as a complete obstacle inventory. */
export function parseOverpassDocument(text: string): OverpassDocument {
    let value: Record<string, unknown>;
    try {
        value = JSON.parse(text);
    } catch {
        throw new Error('invalid JSON');
    }
    if (
        !value ||
        !Array.isArray(value.elements) ||
        value.elements.length > OVERPASS_MAX_ELEMENTS ||
        (value.remark !== undefined && value.remark !== '') ||
        value.elements.some((el) => !el || typeof el !== 'object' || !['way', 'relation'].includes(el.type))
    )
        throw new Error('incomplete or invalid response');
    return { elements: value.elements };
}

const cancelled = () => new DOMException('Overlay request cancelled.', 'AbortError');

/** At most two attempts, with a deadline covering headers AND body. Only the
 * exact same query is retried; missing data is never replaced by empty data. */
export async function fetchOverpassDocument(
    query: string,
    signal?: AbortSignal,
    fetcher: typeof fetch = fetch,
): Promise<OverpassDocument> {
    const failures: string[] = [];
    for (const endpoint of OVERPASS_ENDPOINTS) {
        if (signal?.aborted) throw cancelled();
        const controller = new AbortController();
        let rejectAttempt!: (e: Error) => void;
        let response: Response | undefined;
        let timedOut = false;
        const interrupted = new Promise<never>((_, reject) => {
            rejectAttempt = reject;
        });
        const cancel = () => {
            controller.abort();
            rejectAttempt(cancelled());
        };
        signal?.addEventListener('abort', cancel, { once: true });
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
            rejectAttempt(new Error('timeout'));
        }, OVERPASS_ATTEMPT_MS);
        try {
            return await Promise.race([
                (async () => {
                    response = await fetcher(endpoint, {
                        method: 'POST',
                        redirect: 'error',
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded',
                            Accept: 'application/json',
                            'User-Agent': 'thalassa-osm-overlay/1.0 (https://thalassawx.app)',
                        },
                        body: 'data=' + encodeURIComponent(query),
                        signal: controller.signal,
                    });
                    if (controller.signal.aborted) {
                        void response.body?.cancel().catch(() => undefined);
                        throw cancelled();
                    }
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    const text = await readResponseTextLimited(response, OVERPASS_MAX_BYTES);
                    if (controller.signal.aborted) throw cancelled();
                    if (text === null) throw new Error('response too large');
                    return parseOverpassDocument(text);
                })(),
                interrupted,
            ]);
        } catch {
            if (signal?.aborted) throw cancelled();
            // Logs contain status/reason only, never the bbox, query, bearer or
            // upstream HTML (which may echo the user's requested location).
            const reason = timedOut
                ? 'timeout'
                : response
                  ? response.ok
                      ? 'incomplete or invalid response'
                      : `HTTP ${response.status}`
                  : 'network error';
            failures.push(reason);
            console.warn(`[osm-overlay] ${new URL(endpoint).hostname}: ${reason}`);
            // A malformed query will be malformed on the other instance too.
            if (response?.status === 400) throw new Error('Overpass rejected the query');
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', cancel);
            controller.abort();
            if (response?.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
        }
    }
    throw new Error(`Overpass unavailable (${failures.join('; ')})`);
}

/** Do not reuse a nearby rounded bbox: it may omit the next berth/obstacle.
 * v6 also excludes old HTTP-200 partial/error results from the cache. */
export function overlayCacheKey(bbox: [number, number, number, number]): string {
    return `v6_${bbox.join('_')}`;
}

export const OVERLAY_FIELDS = [
    'water',
    'reef',
    'coastline',
    'marina',
    'breakwater',
    'aeroway',
    'canalLines',
    'navLines',
    'berths',
] as const;

export function isOverlayPayload(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const payload = value as Record<string, { type?: string; features?: unknown[] }>;
    return OVERLAY_FIELDS.every(
        (key) => payload[key]?.type === 'FeatureCollection' && Array.isArray(payload[key].features),
    );
}

export function overlayUnavailableResponse(cors: Record<string, string>): Response {
    return new Response(
        JSON.stringify({
            code: 'OVERLAY_UPSTREAM_UNAVAILABLE',
            error: 'Canal water and obstacle detail is temporarily unavailable. Please try again.',
        }),
        {
            status: 503,
            headers: {
                ...cors,
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store',
                'Retry-After': '30',
                'X-Overlay-Cache': 'error',
            },
        },
    );
}
