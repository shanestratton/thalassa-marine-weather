import { rateLimiter } from '../../utils/rateLimiter';

/**
 * Check rate limit for an API before making a request.
 * Returns true if the request is allowed, false if rate-limited.
 *
 * @example
 *   if (!checkRateLimit('stormglass')) {
 *       console.warn('Stormglass rate limit exceeded');
 *       return null;
 *   }
 */
export function checkRateLimit(api: string): boolean {
    return rateLimiter.acquire(api);
}

export { rateLimiter };

/**
 * API Key Resolution
 *
 * Architecture:
 * - WorldTides, StormGlass, Gemini: Keys live in Supabase Secrets and
 *   are never resolved in client code.
 * - Mapbox, Transistor: Client-side SDK keys (secured by domain/device)
 * - Supabase: Anon key (secured by RLS)
 * - Open-Meteo: Commercial key lives only in the proxy-openmeteo Edge Function
 */

export const getApiKey = (): string | null => {
    // Compatibility shim for old diagnostics. StormGlass is proxy-only.
    return null;
};

export const getWorldTidesKey = () => {
    // Compatibility shim. WorldTides is proxy-only.
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
    if (!key) return 'PROXY';
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
    return 'Mode: Supabase Edge Proxy (key server-side)';
};

export const checkStormglassStatus = async (): Promise<{
    status: 'OK' | 'ERROR' | 'MISSING_KEY';
    message: string;
    code?: number;
}> => {
    // Do not spend paid quota (or expose a secret) just to paint Settings.
    // Real proxy failures are reported by the weather request that encounters
    // them.
    return { status: 'OK', message: 'Server-side proxy' };
};
