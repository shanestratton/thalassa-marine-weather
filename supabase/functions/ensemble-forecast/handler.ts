import { ensembleCoordinates, isEnsembleProduct, reduceEnsemble } from '../../../utils/ensembleForecast.ts';
import { readJsonObject, readResponseTextLimited } from '../_shared/http-security.ts';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};
const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: {
            ...CORS,
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
        },
    });
export interface EnsemblePorts {
    authorize(req: Request): Promise<Response | null>;
    key(): string | undefined;
    fetch: typeof fetch;
    now(): number;
}
/** One fixed product/location; no caller-controlled host, member list, time range or credential. */
export async function handleEnsemble(req: Request, ports: EnsemblePorts): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'POST') return reply({ error: 'POST required' }, 405);
    const denied = await ports.authorize(req);
    if (denied) {
        const headers = new Headers(denied.headers);
        Object.entries(CORS).forEach(([key, value]) => headers.set(key, value));
        return new Response(denied.body, { status: denied.status, headers });
    }
    const body = await readJsonObject(req, 512);
    if (
        !body || Object.keys(body).some((key) => !['product', 'latitude', 'longitude'].includes(key)) ||
        !isEnsembleProduct(body.product) || !ensembleCoordinates(body.latitude, body.longitude)
    ) return reply({ error: 'Invalid ensemble request' }, 400);
    const key = ports.key();
    if (!key) return reply({ error: 'Ensemble service unavailable' }, 503);
    const product = body.product;
    const url = new URL(
        product === 'ifs'
            ? 'https://customer-ensemble-api.open-meteo.com/v1/ensemble'
            : 'https://customer-seasonal-api.open-meteo.com/v1/seasonal',
    );
    url.search = new URLSearchParams({
        latitude: String(body.latitude),
        longitude: String(body.longitude),
        models: product === 'ifs' ? 'ecmwf_ifs025_ensemble' : 'ecmwf_ec46',
        hourly: 'wind_speed_10m,wind_gusts_10m',
        wind_speed_unit: 'kn',
        timeformat: 'unixtime',
        timezone: 'GMT',
        cell_selection: 'sea',
        forecast_days: product === 'ifs' ? '15' : '46',
        apikey: key,
        ...(product === 'ifs' ? { temporal_resolution: 'native' } : {}),
    }).toString();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    req.signal.addEventListener('abort', cancel, { once: true });
    if (req.signal.aborted) cancel();
    const deadline = setTimeout(cancel, 15000);
    try {
        const upstream = await ports.fetch(url, {
            signal: controller.signal,
            redirect: 'error',
            headers: { Accept: 'application/json' },
        });
        if (!upstream.ok) {
            await upstream.body?.cancel();
            return reply({
                error: upstream.status === 401 || upstream.status === 403
                    ? 'Ensemble access unavailable with the configured weather credential'
                    : 'Ensemble upstream unavailable',
            }, 503);
        }
        const raw = await readResponseTextLimited(upstream, 2 * 1024 * 1024);
        if (raw === null || controller.signal.aborted) return reply({ error: 'Ensemble upstream unavailable' }, 503);
        const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
        const sha256 = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
        const forecast = reduceEnsemble(
            JSON.parse(raw),
            product,
            body.latitude,
            body.longitude as number,
            ports.now(),
            sha256,
        );
        if (controller.signal.aborted) return reply({ error: 'Ensemble request cancelled' }, 503);
        return reply(forecast);
    } catch {
        // Never log credential-bearing URLs, upstream bodies or provider error text.
        return reply({ error: 'Ensemble member data unavailable' }, 503);
    } finally {
        clearTimeout(deadline);
        req.signal.removeEventListener('abort', cancel);
    }
}
