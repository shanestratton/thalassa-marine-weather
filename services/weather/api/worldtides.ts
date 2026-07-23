import { CapacitorHttp } from '@capacitor/core';
import { createLogger } from '../../../utils/createLogger';
import { WorldTidesResponse } from '../../../types';
import { piCache } from '../../PiCacheService';
import { getAuthenticatedFunctionHeaders } from '../../supabaseAuth';
const log = createLogger('Tides');

/**
 * fetchWorldTides — Tide Extremes via Supabase Edge Proxy
 *
 * Supabase Edge Function `proxy-tides` keeps the paid key server-side.
 * The client never falls back to a bundled WorldTides credential.
 */

/** Get Supabase URL for Edge Function calls */
function getSupabaseUrl(): string {
    if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) {
        return import.meta.env.VITE_SUPABASE_URL;
    }
    return '';
}

/** Get Supabase anon key for Edge Function auth */
function getSupabaseKey(): string {
    if (typeof import.meta !== 'undefined') {
        return import.meta.env?.VITE_SUPABASE_ANON_KEY || import.meta.env?.VITE_SUPABASE_KEY || '';
    }
    return '';
}

// ── PRIMARY: Supabase Edge Proxy ──────────────────────────────

async function fetchViaProxy(lat: number, lon: number, days: number): Promise<WorldTidesResponse | null> {
    const supabaseUrl = getSupabaseUrl();
    const supabaseKey = getSupabaseKey();

    if (!supabaseUrl || !supabaseKey) {
        log.warn('[proxy] No Supabase config — skipping proxy');
        return null;
    }

    const url = `${supabaseUrl}/functions/v1/proxy-tides`;
    const payload = { lat, lon, days };
    let headers: Record<string, string>;
    try {
        headers = await getAuthenticatedFunctionHeaders();
    } catch {
        headers = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${supabaseKey}`,
            apikey: supabaseKey,
        };
    }

    try {
        // Use CapacitorHttp (native networking) — consistent with other Supabase
        // proxy calls and avoids WKWebView fetch quirks on iOS
        let status: number;
        let data: Record<string, unknown>;

        try {
            const res = await CapacitorHttp.post({
                url,
                headers,
                data: payload,
            });
            status = res.status;
            data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
        } catch (_capacitorErr: unknown) {
            // Fallback: native fetch (web/dev where CapacitorHttp unavailable)
            const res = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload),
            });
            status = res.status;
            data = await res.json();
        }

        if (status !== 200) {
            log.warn(`[proxy] HTTP ${status}:`, data);
            return null;
        }

        if (!data || data.error) {
            log.warn('[proxy] API error:', data?.error);
            return null;
        }

        log.info(`[proxy] OK — ${(data.extremes as unknown[])?.length ?? '?'} extremes`);
        return processResponse(data, lat, lon);
    } catch (e) {
        log.warn('[proxy] Fetch failed:', e);
        return null;
    }
}

// ── Response Processing ───────────────────────────────────────

function processResponse(data: Record<string, unknown>, lat: number, lon: number): WorldTidesResponse {
    const typedData = data as Record<string, unknown> & {
        station?: string | { name?: string };
        atlasLatitude?: number;
        atlasLongitude?: number;
    };

    let stationInfo;
    if (typedData.station) {
        const name =
            typeof typedData.station === 'string' ? typedData.station : typedData.station.name || 'Unknown Station';
        stationInfo = {
            name,
            lat: typedData.atlasLatitude || lat,
            lon: typedData.atlasLongitude || lon,
        };
    } else {
        stationInfo = {
            name: `WorldTides Virtual (${lat.toFixed(2)}, ${lon.toFixed(2)})`,
            lat: typedData.atlasLatitude || lat,
            lon: typedData.atlasLongitude || lon,
        };
    }

    return { ...data, station: stationInfo } as WorldTidesResponse;
}

// ── PUBLIC API ────────────────────────────────────────────────

export const fetchWorldTides = async (
    lat: number,
    lon: number,
    days: number = 14,
): Promise<WorldTidesResponse | null> => {
    // 0. Try Pi Cache first (instant from local SQLite)
    if (piCache.isAvailable()) {
        try {
            const result = await piCache.fetch<WorldTidesResponse>(
                '/api/tides/predictions',
                { lat, lon, days },
                async () => null as unknown as WorldTidesResponse,
            );
            if (result.source !== 'direct' && result.data?.extremes?.length) {
                // Normalize station info — Pi forwards raw WorldTides data where
                // `station` is a bare string. processResponse turns it into
                // `{ name, lat, lon }` so downstream consumers get a real name
                // instead of the "WorldTides Station" fallback.
                return processResponse(result.data as unknown as Record<string, unknown>, lat, lon);
            }
        } catch {
            // Pi failed — fall through
        }
    }

    // 1. Try Supabase Edge proxy first (key stays server-side)
    const proxyResult = await fetchViaProxy(lat, lon, days);
    if (proxyResult) return proxyResult;

    return null;
};
