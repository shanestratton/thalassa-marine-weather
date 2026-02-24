
import { CapacitorHttp } from '@capacitor/core';
import { getErrorMessage } from '../../utils/logger';

/**
 * API Key Resolution
 *
 * Architecture:
 * - WorldTides, StormGlass, Gemini: Keys live in Supabase Secrets,
 *   accessed via Edge Function proxies. Client-side keys are only
 *   used as a fallback if the proxy is unavailable.
 * - Mapbox, Transistor: Client-side SDK keys (secured by domain/device)
 * - Supabase: Anon key (secured by RLS)
 * - Open-Meteo: Commercial API with generous limits
 */

export const getApiKey = () => {
    // StormGlass key — check env var (for direct fallback only)
    if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_STORMGLASS_API_KEY) {
        return import.meta.env.VITE_STORMGLASS_API_KEY;
    }
    if (typeof process !== 'undefined' && process.env && process.env.VITE_STORMGLASS_API_KEY && process.env.VITE_STORMGLASS_API_KEY.length > 20) {
        return process.env.VITE_STORMGLASS_API_KEY;
    }
    // No hardcoded fallback — key lives in Supabase Secrets
    return null;
};

export const getOpenMeteoKey = () => {
    if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_OPEN_METEO_API_KEY) {
        return import.meta.env.VITE_OPEN_METEO_API_KEY;
    }
    return null;
};

export const getWorldTidesKey = () => {
    // WorldTides key — check env var (for direct fallback only)
    if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_WORLDTIDES_API_KEY) {
        return import.meta.env.VITE_WORLDTIDES_API_KEY;
    }
    if (typeof process !== 'undefined' && process.env && process.env.VITE_WORLDTIDES_API_KEY && process.env.VITE_WORLDTIDES_API_KEY.length > 10) {
        return process.env.VITE_WORLDTIDES_API_KEY;
    }
    // No hardcoded fallback — key lives in Supabase Secrets
    return null;
};

export const getMapboxKey = () => {
    if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_MAPBOX_ACCESS_TOKEN) {
        return import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;
    }
    return null;
};

export const getApiKeySuffix = () => {
    const key = getApiKey();
    if (!key) return "PROXY";
    return `...${key.slice(-4)}`;
};

export const isStormglassKeyPresent = () => {
    // Always true — key lives in Supabase Secrets, accessed via proxy-stormglass
    return true;
};

export const isWorldTidesKeyPresent = () => {
    // Always true now — proxy provides the key server-side
    return true;
};

// Returns RAW string for debugging UI
export const debugStormglassConnection = async (): Promise<string> => {
    const key = getApiKey();
    if (!key) return "Mode: Supabase Edge Proxy (key server-side)";

    const url = 'https://api.stormglass.io/v2/weather/point?lat=0&lng=0&params=windSpeed';
    try {
        const options = {
            url: url,
            headers: { 'Authorization': key }
        };
        const res = await CapacitorHttp.get(options);

        const headers = res.headers;
        let quotaInfo = "";
        if (headers && headers['x-quota-remaining']) {
            quotaInfo = ` | Quota: ${headers['x-quota-remaining']}/${headers['x-quota-total']}`;
        }

        if (res.status === 200) return `Success: Connected (direct)${quotaInfo}`;
        if (res.status === 402 || res.status === 429) return `Error: Quota Exceeded${quotaInfo}`;
        if (res.status === 401 || res.status === 403) return "Error: Invalid API Key";
        return `Error: HTTP ${res.status}`;
    } catch (e: unknown) {
        return `Error: Network Fail (${getErrorMessage(e)})`;
    }
};

export const checkStormglassStatus = async (): Promise<{ status: 'OK' | 'ERROR' | 'MISSING_KEY', message: string, code?: number }> => {
    const key = getApiKey();
    if (!key) return { status: 'OK', message: 'Using Supabase Edge Proxy' };

    try {
        const options = {
            url: 'https://api.stormglass.io/v2/weather/point?lat=58.5&lng=17.8&params=windSpeed&start=2024-01-01&end=2024-01-01',
            headers: { 'Authorization': key }
        };
        const res = await CapacitorHttp.get(options);

        if (res.status === 200) return { status: 'OK', message: 'Service Operational' };
        return { status: 'ERROR', message: `HTTP ${res.status}`, code: res.status };
    } catch (e: unknown) {
        return { status: 'ERROR', message: getErrorMessage(e) };
    }
};
