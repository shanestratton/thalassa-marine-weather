import { createSatelliteViewHandler, type SatelliteQuota } from '../../../api/satellite-view.ts';

export const SATELLITE_PUBLIC_QUOTA = Object.freeze({
    bucket: 'satellite_view_public',
    limit: 120,
    windowSeconds: 3600,
});
const HEADERS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, OPTIONS',
    'cache-control': 'no-store',
};
/** Exact public display path. The core validates every query before quota or provider access. */
export function createPublicSatelliteViewHandler(
    enabled: () => boolean,
    quota: SatelliteQuota,
): (request: Request) => Promise<Response> {
    const handle = createSatelliteViewHandler(enabled, quota);
    return (request) => {
        const url = new URL(request.url);
        if (
            !/^\/(?:functions\/v1\/)?satellite-view$/.test(url.pathname) || url.hash ||
            request.headers.has('range')
        ) {
            return Promise.resolve(new Response('Unsupported satellite path', { status: 400, headers: HEADERS }));
        }
        if (request.method !== 'GET' && request.method !== 'OPTIONS') {
            return Promise.resolve(new Response('GET or OPTIONS required', { status: 405, headers: HEADERS }));
        }
        return handle(request);
    };
}
