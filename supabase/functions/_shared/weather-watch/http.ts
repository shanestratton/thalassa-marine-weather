import { jsonResponse, readResponseTextLimited, requireServiceRolePost } from '../http-security.ts';
import { CONVECTIVE_MODELS } from '../../../../utils/convective.ts';
import type { WeatherWatchFeature } from '../../../../utils/weatherWatch.ts';
import { runWeatherWatch, type WatchWork, type WeatherWatchDeps } from './runner.ts';
export interface WatchEnvironment {
    get(name: string): string | undefined;
}
const uuid = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value);
/** Timeout includes streamed response body. All destinations fixed in this module. */
async function jsonFetch(
    url: URL,
    init: RequestInit,
    fetcher: typeof fetch,
    maxBytes: number,
    timeoutMs = 5000,
): Promise<unknown> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetcher(url, { ...init, redirect: 'error', signal: controller.signal });
        if (!response.ok || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
            await response.body?.cancel();
            throw new Error('Upstream unavailable');
        }
        const text = await readResponseTextLimited(response, maxBytes);
        if (text === null) throw new Error('Response limit');
        return text.trim() ? JSON.parse(text) : null;
    } finally {
        clearTimeout(timer);
    }
}
export function weatherWatchDependencies(env: WatchEnvironment, fetcher = fetch, now = Date.now): WeatherWatchDeps {
    const root = env.get('SUPABASE_URL'), key = env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!root || !key) throw new Error('Database unavailable');
    const origin = new URL(root);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/') {
        throw new Error('Database configuration');
    }
    const headers = { apikey: key, authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
    const rpc = (name: string, body: unknown) =>
        jsonFetch(
            new URL(`/rest/v1/rpc/${name}`, origin),
            { method: 'POST', headers, body: JSON.stringify(body) },
            fetcher,
            512_000,
        );
    return {
        now,
        async work(feature, after, limit) {
            const result = await rpc('weather_watch_work', { p_feature: feature, p_after: after, p_limit: limit });
            if (
                !Array.isArray(result) || result.length > 16 ||
                !result.every((row) => row && uuid(row.boat_id) && uuid(row.owner_id) && uuid(row.revision))
            ) throw new Error('Invalid work');
            return result as WatchWork[];
        },
        async forecasts(cell) {
            if (!/^-?\d{1,5}_-?\d{1,5}$/.test(cell)) throw new Error('Invalid cell');
            // Explicitly authorized coarse interests persist while the phone
            // is closed. Acquisition remains the existing publisher's job.
            if (await rpc('announce_wx_cell', { p_cell: cell }) !== true) throw new Error('Cell interest unavailable');
            const url = new URL('/rest/v1/wx_point_forecasts', origin);
            url.search = new URLSearchParams({
                select: 'cell_id,model,run_at,payload',
                cell_id: `eq.${cell}`,
                model: `in.(${CONVECTIVE_MODELS.map((id) => `wx2:${id}`).join(',')})`,
                limit: '3',
            }).toString();
            const result = await jsonFetch(url, { headers }, fetcher, 2_000_000);
            if (!Array.isArray(result) || result.length > 3) throw new Error('Invalid forecasts');
            return result;
        },
        async rain(lat, lon) {
            const token = env.get('RAINBOW_API_KEY');
            if (!token) throw new Error('Nowcast unavailable');
            if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
                throw new Error('Invalid point');
            }
            const url = new URL(`https://api.rainbow.ai/nowcast/v1/precip-global/${lon.toFixed(4)}/${lat.toFixed(4)}`);
            // Current Rainbow docs support this header. Token never enters a URL or log.
            const body = await jsonFetch(
                url,
                { headers: { 'Ocp-Apim-Subscription-Key': token } },
                fetcher,
                256_000,
                15_000,
            );
            return { body, retrievedAt: now() };
        },
        async official(owner, lat, lon) {
            try {
                const matched = await rpc('official_alerts_watch_match', { p_points: [{ k: 1, lat, lon }] });
                if (
                    !Array.isArray(matched) || matched.length > 1 || !matched.length ||
                    !Array.isArray(matched[0].alert_ids)
                ) return { live: false, delivered: [] };
                const ids = matched[0].alert_ids;
                if (
                    ids.length > 64 || !ids.every((id: unknown) =>
                        typeof id === 'number' && Number.isSafeInteger(id) && id > 0
                    ) || !ids.length
                ) return { live: false, delivered: [] };
                const url = new URL('/rest/v1/official_alerts', origin);
                url.search = new URLSearchParams({
                    select: 'id,provider_id,infos,expires_at',
                    id: `in.(${ids.join(',')})`,
                    limit: '64',
                }).toString();
                const alerts = await jsonFetch(url, { headers }, fetcher, 512_000);
                if (!Array.isArray(alerts) || alerts.length > 64) return { live: false, delivered: [] };
                const deliveries = new URL('/rest/v1/official_alert_deliveries', origin);
                deliveries.search = new URLSearchParams({
                    select: 'alert_id',
                    user_id: `eq.${owner}`,
                    alert_id: `in.(${ids.join(',')})`,
                    limit: '128',
                }).toString();
                const receipts = await jsonFetch(deliveries, { headers }, fetcher, 32_000);
                const delivered = new Set(Array.isArray(receipts) ? receipts.map((row) => row.alert_id) : []);
                const live = alerts.filter((row) =>
                    row && typeof row.provider_id === 'string' && Array.isArray(row.infos) &&
                    (row.expires_at === null ||
                        (typeof row.expires_at === 'string' && Date.parse(row.expires_at) > now()))
                );
                return {
                    live: live.length > 0,
                    delivered: live.filter((row) => delivered.has(row.id)).map((row) => ({
                        id: row.id,
                        provider: row.provider_id,
                        infos: row.infos,
                    })),
                };
            } catch {
                return { live: false, delivered: [] };
            }
        },
        async claim(input) {
            return (await rpc('weather_watch_claim', input)) === true;
        },
        async tick(feature, success) {
            await rpc('weather_watch_tick', { p_feature: feature, p_success: success });
        },
    };
}
/** Service-only fixed cron entry. It accepts neither user positions nor provider URLs. */
export function createWeatherWatchHandler(
    features: readonly WeatherWatchFeature[],
    env: WatchEnvironment,
    deps?: WeatherWatchDeps,
) {
    return async (req: Request): Promise<Response> => {
        const refusal = requireServiceRolePost(req, env.get('SUPABASE_SERVICE_ROLE_KEY'));
        if (refusal) return refusal;
        try {
            if (new URL(req.url).search) return jsonResponse({ error: 'No query parameters' }, 400);
            const text = await readResponseTextLimited(new Response(req.body), 512);
            if (text === null || (text.trim() && text.trim() !== '{}')) {
                return jsonResponse({ error: 'Empty object required' }, 400);
            }
            const actual = deps ?? weatherWatchDependencies(env);
            const results = [];
            for (const feature of features) results.push({ feature, ...await runWeatherWatch(feature, actual) });
            return jsonResponse({ schema: 1, results }, results.every((row) => row.complete) ? 200 : 503);
        } catch {
            return jsonResponse({ error: 'Weather watch unavailable' }, 503);
        }
    };
}
