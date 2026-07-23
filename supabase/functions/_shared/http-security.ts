export const JSON_SECURITY_HEADERS: Record<string, string> = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
};

export function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...JSON_SECURITY_HEADERS, ...extraHeaders },
    });
}

/**
 * Cron functions are privileged service-role entry points, not browser APIs.
 * They must fail before doing any work unless the request is exactly the
 * configured POST + service-role bearer pair.
 */
export function requireServiceRolePost(req: Request, serviceRoleKey: string | undefined): Response | null {
    if (req.method !== 'POST') {
        return jsonResponse({ error: 'POST required' }, 405, { Allow: 'POST' });
    }
    if (!serviceRoleKey) {
        return jsonResponse({ error: 'Server authorization is not configured' }, 500);
    }
    if (req.headers.get('authorization') !== `Bearer ${serviceRoleKey}`) {
        return jsonResponse({ error: 'Unauthorized' }, 401, {
            'WWW-Authenticate': 'Bearer',
        });
    }
    return null;
}

export function parseCoordinate(value: unknown, axis: 'lat' | 'lon'): number | null {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
    const bound = axis === 'lat' ? 90 : 180;
    return Number.isFinite(parsed) && Math.abs(parsed) <= bound ? parsed : null;
}

export function parseBoundedNumber(value: unknown, min: number, max: number): number | null {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
    return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

export function parseBoundedInteger(value: unknown, min: number, max: number): number | null {
    const parsed = parseBoundedNumber(value, min, max);
    return parsed !== null && Number.isInteger(parsed) ? parsed : null;
}

export interface GeoBounds {
    north: number;
    south: number;
    east: number;
    west: number;
    latSpan: number;
    lonSpan: number;
}

export function parseGeoBounds(value: Record<string, unknown>): GeoBounds | null {
    const north = parseCoordinate(value.north, 'lat');
    const south = parseCoordinate(value.south, 'lat');
    const east = parseCoordinate(value.east, 'lon');
    const west = parseCoordinate(value.west, 'lon');
    if (north === null || south === null || east === null || west === null || north <= south) return null;

    const latSpan = north - south;
    if (east === west) return null;
    let lonSpan = east - west;
    if (lonSpan <= 0) lonSpan += 360;
    if (!Number.isFinite(lonSpan) || lonSpan <= 0 || lonSpan > 360) return null;
    return { north, south, east, west, latSpan, lonSpan };
}

export function parseForecastHours(
    value: unknown,
    fallback: readonly number[],
    maxItems: number,
    maxHour: number,
): number[] | null {
    if (value === undefined) return [...fallback];
    if (!Array.isArray(value) || value.length < 1 || value.length > maxItems) return null;
    const parsed = value.map((hour) => parseBoundedInteger(hour, 0, maxHour));
    if (parsed.some((hour) => hour === null)) return null;
    return [...new Set(parsed as number[])].sort((a, b) => a - b);
}

export async function readJsonObject(req: Request, maxBytes = 16_384): Promise<Record<string, unknown> | null> {
    const declaredLength = Number(req.headers.get('content-length') || '0');
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return null;
    if (!req.body) return null;

    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel().catch(() => undefined);
                return null;
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    if (total === 0) return null;

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    const text = new TextDecoder().decode(bytes);

    try {
        const value: unknown = JSON.parse(text);
        return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

export async function fetchWithTimeout(
    input: string | URL | Request,
    init: RequestInit = {},
    timeoutMs = 12_000,
): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const upstreamSignal = init.signal;
    const abortFromUpstream = () => controller.abort();
    upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true });

    try {
        return await fetch(input, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timer);
        upstreamSignal?.removeEventListener('abort', abortFromUpstream);
    }
}

export async function readResponseTextLimited(response: Response, maxBytes = 1_000_000): Promise<string | null> {
    const declaredLength = Number(response.headers.get('content-length') || '0');
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        return null;
    }
    if (!response.body) return '';

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel().catch(() => undefined);
                return null;
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }

    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder().decode(output);
}

export async function readResponseArrayBufferLimited(
    response: Response,
    maxBytes = 12_000_000,
): Promise<ArrayBuffer | null> {
    const declaredLength = Number(response.headers.get('content-length') || '0');
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        return null;
    }
    if (!response.body) return new ArrayBuffer(0);

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel().catch(() => undefined);
                return null;
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }

    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return output.buffer;
}

/** Accept JSON media types, including registered `+json` structured suffixes. */
export function isJsonContentType(value: string | null): boolean {
    if (!value) return false;
    const mediaType = value.split(';', 1)[0].trim().toLowerCase();
    return mediaType === 'application/json' || /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+\+json$/.test(mediaType);
}

/**
 * Read and parse a bounded upstream JSON object.
 *
 * A successful paid-provider response must advertise JSON, fit the streaming
 * byte cap, parse cleanly, and have an object (not array/null) at its root.
 */
export async function readResponseJsonObjectLimited(
    response: Response,
    maxBytes = 1_000_000,
): Promise<Record<string, unknown> | null> {
    if (!isJsonContentType(response.headers.get('content-type'))) {
        await response.body?.cancel().catch(() => undefined);
        return null;
    }
    const text = await readResponseTextLimited(response, maxBytes);
    if (text === null || text.length === 0) return null;
    try {
        const value: unknown = JSON.parse(text);
        return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

/** Refuse HTML/error documents masquerading as a successful PNG response. */
export function hasPngSignature(value: ArrayBuffer): boolean {
    const bytes = new Uint8Array(value, 0, Math.min(value.byteLength, 8));
    return (
        bytes.length === 8 &&
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47 &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a
    );
}

/** Refuse non-WebP content masquerading behind an image/webp media type. */
export function hasWebpSignature(value: ArrayBuffer): boolean {
    const bytes = new Uint8Array(value, 0, Math.min(value.byteLength, 12));
    return (
        bytes.length === 12 &&
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
    );
}
