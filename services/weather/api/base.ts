import { CapacitorHttp } from '@capacitor/core';
import { piCache } from '../../PiCacheService';

// ── StormGlass API Client ─────────────────────────────────────
// Routes ALL requests through the Supabase Edge Function proxy
// (`proxy-stormglass`). The API key stays server-side in Supabase
// Secrets — never exposed in the client bundle.
//
// The proxy accepts: POST { path, params }
// and forwards to https://api.stormglass.io/v2/{path}?{params}

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_KEY || '';
const PROXY_URL = `${SUPABASE_URL}/functions/v1/proxy-stormglass`;

/**
 * Fetch from StormGlass via the Supabase Edge Function proxy.
 * The `apiKey` parameter is IGNORED — the proxy injects the key server-side.
 * We keep the parameter for backward compatibility with callers.
 */
export const fetchSG = async <T>(
    endpoint: string,
    params: Record<string, string | number>,
    _apiKey?: string, // Unused — proxy has the key
): Promise<T> => {
    const cleanEndpoint = endpoint.replace(/^\/+/, '');

    // Convert params to Record<string, string> for the proxy
    const stringParams: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) {
        stringParams[k] = String(v);
    }

    // ── Pi Cache shortcut (disabled 2026-04-24) ──────────────────
    // Pi's /api/weather/stormglass endpoint currently only forwards
    // { lat, lon } — it drops the endpoint path and param list that
    // StormGlass's `weather/point` call actually needs. Response shape
    // then differs from { hours: StormGlassHour[] }, and downstream
    // `hours[0]` access in transformers.ts throws. Symptom seen in
    // prod as: "[index] StormGlass failed: undefined is not an object
    // (evaluating 'e[0]')" — which silently zeroed out wave, period,
    // swell, currents, CAPE, water temp across the whole Glass page.
    //
    // Until the Pi route is rewritten to accept & forward full SG
    // endpoint + params, skip the Pi entirely and go direct to the
    // Supabase edge function. Same SG quota impact either way — the
    // Pi only saved a network hop, not an SG call.

    const body = JSON.stringify({
        path: cleanEndpoint,
        params: stringParams,
    });

    try {
        // 1. Try CapacitorHttp (native iOS/Android — bypasses CORS)
        const res = await CapacitorHttp.post({
            url: PROXY_URL,
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
                apikey: SUPABASE_ANON_KEY,
            },
            data: body,
        });

        if (!res) {
            throw new Error('SG_NO_RESPONSE: CapacitorHttp returned null/undefined');
        }

        if (res.status !== 200) {
            if (res.status === 402 || res.status === 429) {
                // Forward quota info from proxy response
                const _quotaRemaining = res.headers?.['x-quota-remaining'];
                const _quotaTotal = res.headers?.['x-quota-total'];
                throw new Error(`SG_QUOTA: ${res.status} - ${JSON.stringify(res.data)}`);
            }
            throw new Error(`SG_HTTP_${res.status}: ${JSON.stringify(res.data)}`);
        }

        if (!res.data) {
            throw new Error('SG_NO_DATA: Response status 200 but no data');
        }

        // Log quota for monitoring
        const quotaRemaining = res.headers?.['x-quota-remaining'];
        if (quotaRemaining) {
            /* best effort */
        }

        return res.data as T;
    } catch (e: unknown) {
        // 2. Fallback: Browser fetch (dev server / web)
        try {
            const res = await fetch(PROXY_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
                    apikey: SUPABASE_ANON_KEY,
                },
                body,
            });

            if (!res.ok) {
                const responseBody = await res.text();
                if (res.status === 402 || res.status === 429) {
                    throw new Error(`SG_QUOTA: ${res.status} - ${responseBody}`);
                }
                throw new Error(`SG_HTTP_FETCH_${res.status}: ${responseBody}`);
            }

            // Log quota from headers
            const quotaRemaining = res.headers.get('x-quota-remaining');
            if (quotaRemaining) {
                /* best effort */
            }

            return (await res.json()) as T;
        } catch (fetchErr: unknown) {
            throw fetchErr;
        }
    }
};
