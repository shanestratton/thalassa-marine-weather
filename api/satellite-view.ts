/** New fixed-source display proxy. Separate server admission remains OFF until reviewed image/clock/licence readback. */
import {
    parseSatelliteTimes,
    satelliteImageTarget,
    satelliteMetadataUrl,
    satelliteViewProduct,
    SATELLITE_IMAGE_MAX,
    SATELLITE_METADATA_MAX,
    SATELLITE_VIEW_PRODUCTS,
    type SatelliteViewBox,
    type SatelliteViewProduct,
} from '../services/weather/satelliteViewContract.ts';
import {
    awaitSatelliteOperation,
    readSatelliteResponse,
    validateSatellitePng,
} from '../services/weather/satelliteViewBytes.ts';
const HEADERS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,OPTIONS',
    'access-control-expose-headers': 'x-thalassa-listed-time,x-thalassa-satellite-product,x-thalassa-satellite-window',
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'cross-origin',
    'cache-control': 'no-store',
};
async function times(product: SatelliteViewProduct, signal: AbortSignal) {
    const now = Date.now();
    const result = await readSatelliteResponse(
        satelliteMetadataUrl(product, now),
        'xml',
        SATELLITE_METADATA_MAX,
        signal,
    );
    return parseSatelliteTimes(new TextDecoder('utf-8', { fatal: true }).decode(result.bytes), product, now);
}
export type SatelliteQuota = (request: Request, signal: AbortSignal) => Promise<Response | null>;
export function createSatelliteViewHandler(
    enabled: () => boolean,
    quota?: SatelliteQuota,
): (request: Request) => Promise<Response> {
    return async (request: Request): Promise<Response> => {
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: HEADERS });
        if (!enabled()) return new Response('Sharper satellite is not enabled', { status: 503, headers: HEADERS });
        const params = new URL(request.url).searchParams;
        const product = satelliteViewProduct(params.get('product')),
            action = params.get('action');
        const allowed =
            action === 'times' ? ['product', 'action'] : ['product', 'action', 'time', 'bbox', 'width', 'height'];
        if (
            request.method !== 'GET' ||
            !product ||
            !['times', 'image'].includes(action ?? '') ||
            [...params.keys()].some((key) => !allowed.includes(key)) ||
            allowed.some((key) => params.getAll(key).length !== 1)
        )
            return new Response('Unknown satellite view', { status: 400, headers: HEADERS });
        let imageRequest: { target: string; box: SatelliteViewBox; width: number; height: number } | null = null;
        if (action === 'image') {
            try {
                const parts = (params.get('bbox') ?? '').split(',');
                if (
                    parts.length !== 4 ||
                    parts.some((part) => !/^-?\d{1,3}(?:\.\d{1,6})?$/.test(part)) ||
                    !/^[1-9]\d{0,3}$/.test(params.get('width') ?? '') ||
                    !/^[1-9]\d{0,3}$/.test(params.get('height') ?? '')
                )
                    throw new Error('Malformed image window');
                const box = parts.map(Number) as unknown as SatelliteViewBox,
                    width = Number(params.get('width')),
                    height = Number(params.get('height'));
                const iso = params.get('time')!;
                const target = satelliteImageTarget(
                    product,
                    { iso, timeMs: Date.parse(iso), daily: SATELLITE_VIEW_PRODUCTS[product].daily },
                    box,
                    width,
                    height,
                );
                imageRequest = { target, box, width, height };
            } catch {
                return new Response('Invalid satellite frame/window', { status: 400, headers: HEADERS });
            }
        }
        const controller = new AbortController(),
            abort = () => controller.abort(request.signal.reason);
        request.signal.addEventListener('abort', abort, { once: true });
        if (request.signal.aborted) abort();
        const deadline = setTimeout(() => controller.abort(new Error('Satellite request deadline')), 25000);
        try {
            if (quota) {
                const timer = setTimeout(() => controller.abort(new Error('Satellite quota deadline')), 8000);
                try {
                    const rejection = await awaitSatelliteOperation(
                        quota(request, controller.signal),
                        controller.signal,
                        (late) => {
                            void late?.body?.cancel().catch(() => undefined);
                        },
                    );
                    controller.signal.throwIfAborted();
                    if (rejection) {
                        const headers = new Headers(rejection.headers);
                        for (const [key, value] of Object.entries(HEADERS)) headers.set(key, value);
                        return new Response(rejection.body, { status: rejection.status, headers });
                    }
                } catch {
                    return new Response('Satellite quota unavailable', { status: 503, headers: HEADERS });
                } finally {
                    clearTimeout(timer);
                }
            }
            const listed = await times(product, controller.signal);
            if (action === 'times') return Response.json(listed, { headers: HEADERS });
            const frame = listed.frames.find((frame) => frame.iso === params.get('time'));
            if (!frame || !imageRequest)
                return new Response('Satellite frame/window is not listed', { status: 400, headers: HEADERS });
            const { target, box, width, height } = imageRequest;
            const { bytes } = await readSatelliteResponse(target, 'image/png', SATELLITE_IMAGE_MAX, controller.signal);
            validateSatellitePng(bytes, width, height);
            // Reduce dropped-frame nearest-value mismatches with another membership read.
            // This remains a metadata-listed clock, not an embedded image acquisition clock.
            const current = await times(product, controller.signal);
            if (!current.frames.some((item) => item.iso === frame.iso))
                throw new Error('Satellite listed frame retired');
            controller.signal.throwIfAborted();
            return new Response(new Uint8Array(bytes).buffer, {
                headers: {
                    ...HEADERS,
                    'content-type': 'image/png',
                    'content-length': String(bytes.byteLength),
                    'x-thalassa-listed-time': frame.iso,
                    'x-thalassa-satellite-product': product,
                    'x-thalassa-satellite-window': `${box.join(',')}:${width}x${height}`,
                },
            });
        } catch {
            return new Response('Satellite view unavailable', { status: 502, headers: HEADERS });
        } finally {
            clearTimeout(deadline);
            request.signal.removeEventListener('abort', abort);
        }
    };
}
const enabled = () =>
    (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env
        ?.SATELLITE_VIEW_ENABLED === 'true';
export const handler = createSatelliteViewHandler(enabled);
export default { fetch: handler };
