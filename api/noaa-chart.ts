/** Fixed public NOAA display services. No upstream URL, key or boat position input. */
const ROOT = 'https://gis.charttools.noaa.gov/arcgis/rest/services/MCS/';
const MAX_BYTES = 1024 * 1024;
const headers = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, OPTIONS',
    'cross-origin-resource-policy': 'cross-origin',
    'x-content-type-options': 'nosniff',
};
export function noaaTileUrl(url: URL): string | null {
    if ([...url.searchParams.keys()].some((k) => !['style', 'z', 'x', 'y'].includes(k))) return null;
    const values = ['style', 'z', 'x', 'y'].map((k) => url.searchParams.getAll(k));
    if (values.some((v) => v.length !== 1)) return null;
    const [style, zs, xs, ys] = values.map((v) => v[0]);
    if (!['paper', 'ecdis'].includes(style) || ![zs, xs, ys].every((s) => /^(0|[1-9]\d*)$/.test(s))) return null;
    const [z, x, y] = [zs, xs, ys].map(Number),
        n = 2 ** z;
    if (z < 3 || z > 18 || x >= n || y >= n) return null;
    const extent = 20037508.342789244,
        span = (2 * extent) / n;
    const bbox = [-extent + x * span, extent - (y + 1) * span, -extent + (x + 1) * span, extent - y * span];
    const result = new URL(
        `${ROOT}${style === 'paper' ? 'NOAAChartDisplay' : 'ENCOnline'}/MapServer/exts/MaritimeChartService/MapServer/export`,
    );
    result.search = new URLSearchParams({
        bbox: bbox.join(','),
        bboxSR: '3857',
        imageSR: '3857',
        size: '256,256',
        format: 'png',
        transparent: 'true',
        f: 'image',
    }).toString();
    return result.toString();
}
async function png(response: Response, signal: AbortSignal) {
    if (!response.ok || !/^image\/png(?:;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error('Invalid chart image');
    }
    const declared = response.headers.get('content-length');
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) throw new Error('Oversized chart image');
    const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            signal.throwIfAborted();
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BYTES) throw new Error('Oversized chart image');
            chunks.push(value);
        }
    } finally {
        await reader.cancel().catch(() => undefined);
    }
    const data = new Uint8Array(size);
    let at = 0;
    for (const part of chunks) {
        data.set(part, at);
        at += part.byteLength;
    }
    const signature = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82];
    if (size < 33 || !signature.every((b, i) => data[i] === b)) throw new Error('Not a PNG');
    const view = new DataView(data.buffer);
    if (view.getUint32(16) !== 256 || view.getUint32(20) !== 256) throw new Error('Unexpected chart dimensions');
    return data;
}
export async function handler(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    const target = noaaTileUrl(new URL(request.url));
    if (request.method !== 'GET' || !target)
        return new Response('Unknown chart tile', {
            status: 400,
            headers: { ...headers, 'cache-control': 'no-store' },
        });
    const controller = new AbortController(),
        timeout = setTimeout(() => controller.abort(), 12000);
    try {
        const response = await fetch(target, {
            redirect: 'manual',
            credentials: 'omit',
            signal: controller.signal,
            headers: { Accept: 'image/png', 'User-Agent': 'Thalassa/1.2 (+https://www.thalassawx.app)' },
        });
        const data = await png(response, controller.signal);
        return new Response(data.buffer, {
            headers: {
                ...headers,
                'content-type': 'image/png',
                'content-length': String(data.byteLength),
                'cache-control': 'public,max-age=3600',
            },
        });
    } catch {
        return new Response('NOAA display service unavailable', {
            status: 502,
            headers: { ...headers, 'cache-control': 'no-store' },
        });
    } finally {
        clearTimeout(timeout);
    }
}
// Vercel's documented fetch entrypoint, default Node runtime (same as synoptic).
export default { fetch: handler };
