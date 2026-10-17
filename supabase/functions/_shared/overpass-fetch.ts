import { ownedOperationForQuery } from '../../../services/osm/ownedOverpassContract.ts';
import { fetchOwnedOsmFromWx, OWN_OSM_ORIGIN } from './owned-osm-upstream.ts';

/** Private owned service only. No public mirror rotation or source fallback. */
export const OVERPASS_ENDPOINTS = [OWN_OSM_ORIGIN + '/osm/query'] as const;
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
    ) {
        throw new Error('incomplete or invalid response');
    }
    return { elements: value.elements };
}

/** Existing server-generated recipe; arbitrary caller QL cannot cross the Edge.
 * Byte/body/cancel deadline remains20s and no failed result becomes empty data. */
export async function fetchOverpassDocument(
    query: string,
    signal?: AbortSignal,
    fetcher: typeof fetch = fetch,
    env: (name: string) => string | undefined = (name) => typeof Deno === 'undefined' ? undefined : Deno.env.get(name),
): Promise<OverpassDocument & { sourceAt: string }> {
    const document = await fetchOwnedOsmFromWx(ownedOperationForQuery(query), env, signal, fetcher);
    return { ...parseOverpassDocument(JSON.stringify(document)), sourceAt: document.thalassaSource.sourceAt };
}

/** Do not reuse a nearby rounded bbox: it may omit the next berth/obstacle.
 * v6 also excludes old HTTP-200 partial/error results from the cache. */
export function overlayCacheKey(bbox: [number, number, number, number]): string {
    return `v7_owned_${bbox.join('_')}`;
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
