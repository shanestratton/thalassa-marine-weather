/** Public chart proxy. Fixed reviewed GIF slots only; no target URL input,
 * credentials, redirects, PDF/SVG, or access to the private release proxy. */
import { synopticChart } from '../services/weather/synopticCharts';
import { readChartBytes } from '../services/weather/synopticChartBytes';
export const config = { runtime: 'edge' };
const headers = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, OPTIONS',
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'cross-origin',
};
export default async function handler(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    const url = new URL(request.url);
    const ids = url.searchParams.getAll('id');
    const chart = ids.length === 1 ? synopticChart(ids[0]) : undefined;
    if (
        request.method !== 'GET' ||
        [...url.searchParams.keys()].some((key) => key !== 'id') ||
        !chart?.url ||
        chart.direct
    )
        return new Response('Unknown chart', { status: 400, headers: { ...headers, 'cache-control': 'no-store' } });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    let upstreamStatus = 0;
    try {
        const response = await fetch(chart.url, {
            signal: controller.signal,
            redirect: 'error',
            credentials: 'omit',
            headers: { Accept: chart.mime, 'User-Agent': 'Thalassa/1.2 (+https://www.thalassawx.app)' },
        });
        upstreamStatus = response.status;
        const bytes = await readChartBytes(response, chart.mime);
        return new Response(bytes.buffer as ArrayBuffer, {
            headers: {
                ...headers,
                'content-type': chart.mime,
                'cache-control': 'public, max-age=900',
                'content-length': String(bytes.length),
            },
        });
    } catch {
        return new Response('Official chart unavailable', {
            status: 502,
            headers: {
                ...headers,
                'cache-control': 'no-store',
                // Public fixed-source status only; never an exception, URL or
                // provider credential. Distinguish an outage from bad bytes.
                'x-thalassa-upstream-status': String(upstreamStatus),
            },
        });
    } finally {
        clearTimeout(timer);
    }
}
