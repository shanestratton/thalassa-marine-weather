import { aromeDomain } from '../../../services/weather/aromeDomains.ts';
import { type AromePointForecast, parseAromePoint } from '../../../services/weather/aromePointContract.ts';
import { readResponseTextLimited } from './http-security.ts';

/** Proposed owned ingress; this is not a claim that DNS/tunnel or native
 * ingest is deployed. No tailnet address or public provider is a fallback.
 */
export const AROME_OWN_ORIGIN = 'https://wx-data.thalassawx.app';
export const AROME_UPSTREAM_MS = 10_000;
export const AROME_RESPONSE_BYTES = 64 * 1024;

export async function fetchAromeFromWx(
    model: string,
    point: { lat: number; lon: number },
    env: (name: string) => string | undefined,
    fetcher: typeof fetch = fetch,
    now: () => number = Date.now,
): Promise<AromePointForecast> {
    const domain = aromeDomain(model);
    const origin = env('THALASSA_WX_REGIONAL_ORIGIN');
    const token = env('THALASSA_WX_REGIONAL_TOKEN');
    if (!domain || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)) {
        throw new Error('Unreviewed regional request');
    }
    const [south, north, west, east] = domain.region;
    if (point.lat < south || point.lat > north || point.lon < west || point.lon > east) {
        throw new Error('Outside regional domain');
    }
    if (origin !== AROME_OWN_ORIGIN || !token || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
        throw new Error('Own regional source unavailable');
    }
    const controller = new AbortController();
    let response: Response | undefined;
    let rejectDeadline!: (error: Error) => void;
    const deadline = new Promise<never>((_, reject) => {
        rejectDeadline = reject;
    });
    const timer = setTimeout(() => {
        controller.abort();
        rejectDeadline(new Error('Own regional source deadline'));
    }, AROME_UPSTREAM_MS);
    try {
        return await Promise.race([
            (async () => {
                response = await fetcher(`${origin}/regional/arome`, {
                    method: 'POST',
                    redirect: 'error',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json',
                        Authorization: `Bearer ${token}`,
                    },
                    body: JSON.stringify({ schema: 1, model, ...point, cellSelection: 'sea' }),
                    signal: controller.signal,
                });
                if (!response.ok || controller.signal.aborted) throw new Error('Own regional source unavailable');
                const text = await readResponseTextLimited(response, AROME_RESPONSE_BYTES);
                if (text === null || controller.signal.aborted) throw new Error('Own regional response refused');
                const admitted = parseAromePoint(JSON.parse(text), model, point, now());
                if (!admitted) throw new Error('Original regional sea-cell cohort unqualified');
                return admitted;
            })(),
            deadline,
        ]);
    } finally {
        clearTimeout(timer);
        controller.abort();
        if (response?.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
    }
}
