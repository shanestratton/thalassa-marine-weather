import { proxyReleaseAsset } from '../../../api/_releaseAssetProxy.ts';

export const FORECAST_PUBLIC_QUOTA = Object.freeze({
    bucket: 'forecast_assets_public',
    limit: 120,
    windowSeconds: 3600,
});
const QUOTA_TIMEOUT_MS = 8_000;
const PATH =
    /^\/(?:functions\/v1\/)?forecast-assets\/(gfs-atmos|ifs-pressure|ssh)\/(manifest-v2\.json|g-\d{8}T\d{6}Z-[0-9a-f]{12}-h\d{3}\.bin)$/;
type Dataset = 'gfs-atmos' | 'ifs-pressure' | 'ssh';
type Quota = (request: Request, signal: AbortSignal) => Promise<Response | null>;
const CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'If-None-Match',
    'access-control-allow-methods': 'GET, OPTIONS',
};
function failure(status: number, message: string): Response {
    return new Response(message, { status, headers: { ...CORS, 'cache-control': 'no-store' } });
}
function quotaResponse(response: Response): Response {
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(CORS)) headers.set(key, value);
    headers.set('cache-control', 'no-store');
    return new Response(response.body, { status: response.status, headers });
}

/** The only public admission path; quota authority is server-owned, never a user JWT. */
export function createForecastAssetsHandler(quota: Quota): (request: Request) => Promise<Response> {
    return async (request) => {
        if (request.method !== 'GET' && request.method !== 'OPTIONS') return failure(405, 'GET or OPTIONS required');
        const url = new URL(request.url);
        const path = url.pathname.match(PATH);
        if (!path || url.search || url.hash) return failure(400, 'Unsupported public forecast path');
        if (request.headers.has('range')) return failure(400, 'Range requests are not supported');
        const dataset = path[1] as Dataset;
        if (request.method === 'OPTIONS') return proxyReleaseAsset(request, dataset);
        const controller = new AbortController();
        const abort = () => controller.abort(request.signal.reason);
        if (request.signal.aborted) abort();
        else request.signal.addEventListener('abort', abort, { once: true });
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let rejectAbort: (() => void) | undefined;
        try {
            controller.signal.throwIfAborted();
            const retired = new Promise<never>((_, reject) => {
                rejectAbort = () => reject(controller.signal.reason);
                controller.signal.addEventListener('abort', rejectAbort, { once: true });
            });
            timeout = setTimeout(() => controller.abort(new Error('Public quota timed out')), QUOTA_TIMEOUT_MS);
            const rejection = await Promise.race([quota(request, controller.signal), retired]);
            clearTimeout(timeout);
            controller.signal.removeEventListener('abort', rejectAbort!);
            controller.signal.throwIfAborted();
            if (rejection) return quotaResponse(rejection);
            // Forward only the complete-object validator. Client cookies, user JWTs,
            // API keys and proxy IP headers never reach the public release transport.
            const headers = new Headers();
            const validator = request.headers.get('if-none-match');
            if (validator) headers.set('if-none-match', validator);
            return await proxyReleaseAsset(new Request(url, { headers, signal: controller.signal }), dataset);
        } catch {
            return failure(503, 'Public forecast quota or request unavailable');
        } finally {
            clearTimeout(timeout);
            if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort);
            request.signal.removeEventListener('abort', abort);
        }
    };
}
