import { CapacitorHttp } from '@capacitor/core';
import { createLogger } from '../../../utils/createLogger';
import { getWorldTidesKey } from '../keys';
import { WorldTidesResponse } from '../../../types';
import { piCache } from '../../PiCacheService';
const log = createLogger('Tides');

/**
 * fetchWorldTides — Tide Extremes via Supabase Edge Proxy
 *
 * Primary path: Supabase Edge Function `proxy-tides` (key stays server-side)
 * Fallback 1: Direct CapacitorHttp (iOS native, bypasses CORS — uses client key)
 * Fallback 2: Native fetch (dev/web — uses client key)
 *
 * The fallback paths exist so the app works even if Supabase Edge is down
 * or during local development without the Edge Function deployed.
 */

const DIRECT_URL = 'https://www.worldtides.info/api/v3';

// ── HARD RATE LIMITER ──────────────────────────────────────────
// Max 10 calls per hour, persisted across app restarts.
// Only applies to DIRECT calls (not proxy). Proxy has its own server-side limits.
const WT_RATE_KEY = 'thalassa_wt_rate_v1';
const MAX_CALLS_PER_HOUR = 10;

function isRateLimited(): boolean {
    try {
        const raw = localStorage.getItem(WT_RATE_KEY);
        const timestamps: number[] = raw ? JSON.parse(raw) : [];
        const oneHourAgo = Date.now() - 3600_000;
        const recent = timestamps.filter((t) => t > oneHourAgo);
        return recent.length >= MAX_CALLS_PER_HOUR;
    } catch (e) {
        log.warn('[worldtides]', e);
        return false;
    }
}

function recordCall(): void {
    try {
        const raw = localStorage.getItem(WT_RATE_KEY);
        const timestamps: number[] = raw ? JSON.parse(raw) : [];
        const oneHourAgo = Date.now() - 3600_000;
        const recent = timestamps.filter((t) => t > oneHourAgo);
        recent.push(Date.now());
        localStorage.setItem(WT_RATE_KEY, JSON.stringify(recent));
    } catch (e) {
        log.warn('[worldtides] localStorage full — proceed anyway:', e);
    }
}

/** Get Supabase URL for Edge Function calls */
function getSupabaseUrl(): string {
    if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) {
        return import.meta.env.VITE_SUPABASE_URL;
    }
    return '';
}

/** Get Supabase anon key for Edge Function auth */
function getSupabaseKey(): string {
    if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_KEY) {
        return import.meta.env.VITE_SUPABASE_KEY;
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

    try {
        // Use CapacitorHttp (native networking) — consistent with other Supabase
        // proxy calls and avoids WKWebView fetch quirks on iOS
        let status: number;
        let data: Record<string, unknown>;

        try {
            const res = await CapacitorHttp.post({
                url,
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${supabaseKey}`,
                    apikey: supabaseKey,
                },
                data: payload,
            });
            status = res.status;
            data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
        } catch (_capacitorErr: unknown) {
            // Fallback: native fetch (web/dev where CapacitorHttp unavailable)
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${supabaseKey}`,
                    apikey: supabaseKey,
                },
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

// ── FALLBACK: Direct API Call ─────────────────────────────────

async function fetchDirect(lat: number, lon: number, days: number): Promise<WorldTidesResponse | null> {
    const key = getWorldTidesKey();
    if (!key) return null;

    if (isRateLimited()) {
        return null;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    today.setDate(today.getDate() - 1);
    const start = Math.floor(today.getTime() / 1000);

    const url = `${DIRECT_URL}?extremes&lat=${lat}&lon=${lon}&days=${days}&datum=LAT&stationDistance=100&start=${start}&key=${key}`;

    try {
        // Try CapacitorHttp first (native iOS/Android — no CORS)
        const res = await CapacitorHttp.get({ url });
        if (res.status === 200 && res.data) {
            recordCall();
            return processResponse(res.data, lat, lon);
        } else {
            const _errorBody = typeof res.data === 'object' ? JSON.stringify(res.data) : String(res.data);
            return null;
        }
    } catch (e) {
        log.warn('[worldtides]', e);
        // Fallback: native fetch (web/dev)
        try {
            const nativeRes = await fetch(url);
            const nativeData = await nativeRes.json();
            if (nativeData && !nativeData.error) {
                recordCall();
                return nativeData as WorldTidesResponse;
            }
        } catch (e) {
            log.warn('[worldtides]', e);
            // Both methods failed
        }
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
            if (result.source !== 'direct' && result.data) return result.data;
        } catch {
            // Pi failed — fall through
        }
    }

    // 1. Try Supabase Edge proxy first (key stays server-side)
    const proxyResult = await fetchViaProxy(lat, lon, days);
    if (proxyResult) return proxyResult;

    // 2. Fallback: Direct API call (key in client bundle)
    return fetchDirect(lat, lon, days);
};
