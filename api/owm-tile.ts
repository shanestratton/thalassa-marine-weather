/**
 * Server-only OpenWeatherMap raster proxy.
 *
 * The browser/native bundle receives only this bounded same-app URL. The OWM
 * credential remains in Vercel's runtime environment as OWM_API_KEY and is
 * appended only to the pinned upstream request.
 */

export const config = { runtime: 'edge' };

export const OWM_TILE_MAX_ZOOM = 9;
export const OWM_TILE_MAX_BYTES = 2 * 1024 * 1024;
export const OWM_TILE_TIMEOUT_MS = 8_000;

const OWM_TILE_LAYERS = {
    clouds: 'clouds_new',
    temperature: 'temp_new',
} as const;

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CORS_HEADERS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
    'cross-origin-resource-policy': 'cross-origin',
    'x-content-type-options': 'nosniff',
} as const;

function errorResponse(status: number, allowMethods = false): Response {
    return new Response('Weather tile unavailable', {
        status,
        headers: {
            ...CORS_HEADERS,
            ...(allowMethods ? { allow: 'GET, HEAD, OPTIONS' } : {}),
            'cache-control': 'no-store',
            'content-type': 'text/plain; charset=utf-8',
            'referrer-policy': 'no-referrer',
        },
    });
}

function exactQueryValue(url: URL, name: string): string | null {
    const values = url.searchParams.getAll(name);
    return values.length === 1 ? values[0] : null;
}

function integerCoordinate(value: string | null): number | null {
    if (value === null || !/^(?:0|[1-9]\d*)$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

function validTileRequest(url: URL): { layer: keyof typeof OWM_TILE_LAYERS; z: number; x: number; y: number } | null {
    const allowedNames = new Set(['layer', 'z', 'x', 'y']);
    if ([...url.searchParams.keys()].some((name) => !allowedNames.has(name))) return null;

    const layer = exactQueryValue(url, 'layer');
    const z = integerCoordinate(exactQueryValue(url, 'z'));
    const x = integerCoordinate(exactQueryValue(url, 'x'));
    const y = integerCoordinate(exactQueryValue(url, 'y'));
    if (layer === null || !Object.hasOwn(OWM_TILE_LAYERS, layer) || z === null || x === null || y === null) return null;
    if (z > OWM_TILE_MAX_ZOOM) return null;
    const width = 2 ** z;
    if (x >= width || y >= width) return null;
    return { layer: layer as keyof typeof OWM_TILE_LAYERS, z, x, y };
}

function hasPngSignature(bytes: Uint8Array): boolean {
    return (
        bytes.byteLength >= PNG_SIGNATURE.byteLength && PNG_SIGNATURE.every((value, index) => bytes[index] === value)
    );
}

async function cancelBody(response: Response): Promise<void> {
    try {
        await response.body?.cancel('OWM tile rejected');
    } catch {
        // Rejection is already fail-closed; cancellation is best-effort cleanup.
    }
}

async function readBoundedPng(response: Response, signal: AbortSignal): Promise<Uint8Array> {
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null) {
        const bytes = Number(declaredLength);
        if (!Number.isSafeInteger(bytes) || bytes < PNG_SIGNATURE.byteLength || bytes > OWM_TILE_MAX_BYTES) {
            await cancelBody(response);
            throw new Error('Invalid OWM tile length');
        }
    }
    if (!response.body) throw new Error('Missing OWM tile body');

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            if (signal.aborted) throw new Error('OWM tile request aborted');
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > OWM_TILE_MAX_BYTES) {
                await reader.cancel('OWM tile too large');
                throw new Error('OWM tile too large');
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    if (!hasPngSignature(bytes)) throw new Error('Invalid OWM tile signature');
    return bytes;
}

export default async function handler(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: { ...CORS_HEADERS, 'access-control-max-age': '86400', 'cache-control': 'public, max-age=86400' },
        });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return errorResponse(405, true);

    const tile = validTileRequest(new URL(request.url));
    if (tile === null) return errorResponse(400);
    const apiKey = process.env.OWM_API_KEY?.trim();
    if (!apiKey) return errorResponse(503);

    const upstream = new URL(
        `https://tile.openweathermap.org/map/${OWM_TILE_LAYERS[tile.layer]}/${tile.z}/${tile.x}/${tile.y}.png`,
    );
    upstream.searchParams.set('appid', apiKey);

    const controller = new AbortController();
    const abortFromClient = () => controller.abort(request.signal.reason);
    if (request.signal.aborted) abortFromClient();
    else request.signal.addEventListener('abort', abortFromClient, { once: true });
    const deadline = setTimeout(() => controller.abort(new Error('OWM tile timeout')), OWM_TILE_TIMEOUT_MS);

    try {
        const response = await fetch(upstream, {
            method: 'GET',
            redirect: 'error',
            signal: controller.signal,
            headers: { accept: 'image/png' },
        });
        if (response.status !== 200) {
            await cancelBody(response);
            return errorResponse(502);
        }
        if ((response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase() !== 'image/png') {
            await cancelBody(response);
            return errorResponse(502);
        }
        const bytes = await readBoundedPng(response, controller.signal);
        const headers = {
            ...CORS_HEADERS,
            'cache-control': 'public, max-age=300, s-maxage=1800, stale-while-revalidate=3600',
            'content-type': 'image/png',
            'referrer-policy': 'no-referrer',
        };
        const responseBody = new Uint8Array(bytes.byteLength);
        responseBody.set(bytes);
        return new Response(request.method === 'HEAD' ? null : responseBody.buffer, { status: 200, headers });
    } catch {
        return errorResponse(502);
    } finally {
        clearTimeout(deadline);
        request.signal.removeEventListener('abort', abortFromClient);
    }
}
