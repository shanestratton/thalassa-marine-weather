import { lightningPosition, reduceXweatherLightning } from '../../../services/weather/api/licensedLightningContract.ts';
import { readJsonObject, readResponseTextLimited } from '../_shared/http-security.ts';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};
const reply = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
        status,
        headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
export interface LightningPorts {
    authorize(request: Request): Promise<Response | null>;
    /** Shared atomic daily/burst reservations. False/unknown never reaches the paid reader. */
    reserve(): Promise<boolean>;
    /** Both licensed display AND notifications must be approved for this product, with an expiry. */
    admission(): { clientId: string; secret: string; expiresAt: number; display: boolean; push: boolean } | null;
    fetch: typeof fetch;
    now(): number;
}
/** Explicit one-point licensed read. No polling, pagination, fallback, arbitrary host or provider URL logging. */
export async function handleLicensedLightning(request: Request, ports: LightningPorts): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'POST') return reply({ error: 'POST required' }, 405);
    const denied = await ports.authorize(request);
    if (denied) {
        return new Response(denied.body, {
            status: denied.status,
            headers: { ...CORS, ...Object.fromEntries(denied.headers) },
        });
    }
    const body = await readJsonObject(request, 256);
    if (
        !body || Object.keys(body).some((k) => !['latitude', 'longitude'].includes(k)) ||
        !lightningPosition(body.latitude, body.longitude)
    ) return reply({ error: 'Invalid lightning location' }, 400);
    const license = ports.admission(), now = ports.now();
    if (
        !license || license.display !== true || license.push !== true ||
        !Number.isSafeInteger(license.expiresAt) || license.expiresAt <= now ||
        license.expiresAt > now + 366 * 86400_000 || !license.clientId || !license.secret
    ) {
        return reply({ error: 'Licensed lightning is not available' }, 503);
    }
    const url = new URL('https://data.api.xweather.com/lightning/closest');
    url.search = new URLSearchParams({
        p: `${body.latitude},${body.longitude}`,
        radius: '37.04km',
        from: '-5minutes',
        limit: '1000',
        format: 'json',
        client_id: license.clientId,
        client_secret: license.secret,
    }).toString();
    const abort = new AbortController(), cancel = () => abort.abort();
    request.signal.addEventListener('abort', cancel, { once: true });
    if (request.signal.aborted) cancel();
    const deadline = setTimeout(cancel, 10_000);
    try {
        if (abort.signal.aborted) return reply({ error: 'Licensed lightning unavailable' }, 503);
        if (await ports.reserve() !== true) {
            return reply({ error: 'Licensed lightning request budget unavailable' }, 429);
        }
        const beforeRead = ports.admission();
        if (
            abort.signal.aborted || !beforeRead || beforeRead.display !== true || beforeRead.push !== true ||
            beforeRead.clientId !== license.clientId || beforeRead.secret !== license.secret ||
            beforeRead.expiresAt !== license.expiresAt || ports.now() >= license.expiresAt
        ) {
            return reply({ error: 'Licensed lightning unavailable' }, 503);
        }
        const response = await ports.fetch(url, {
            redirect: 'error',
            signal: abort.signal,
            headers: { Accept: 'application/json' },
        });
        if (response.status !== 200) {
            await response.body?.cancel();
            return reply({ error: 'Licensed lightning unavailable' }, 503);
        }
        const raw = await readResponseTextLimited(response, 512 * 1024);
        if (raw === null || abort.signal.aborted) return reply({ error: 'Licensed lightning unavailable' }, 503);
        const result = reduceXweatherLightning(JSON.parse(raw), body.latitude, body.longitude as number, ports.now());
        const current = ports.admission();
        if (
            abort.signal.aborted || !current || current.display !== true || current.push !== true ||
            current.clientId !== license.clientId || current.secret !== license.secret ||
            current.expiresAt !== license.expiresAt || ports.now() >= license.expiresAt
        ) {
            return reply({ error: 'Licensed lightning unavailable' }, 503);
        }
        return reply(result);
    } catch {
        return reply({ error: 'Licensed lightning unavailable' }, 503);
    } finally {
        clearTimeout(deadline);
        request.signal.removeEventListener('abort', cancel);
    }
}
