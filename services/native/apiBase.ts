/**
 * apiBase — platform-aware base URL for `/api/*` Vercel edge proxies.
 *
 * Why this exists: every map layer that fetches from a CMEMS pipeline
 * (currents/waves/sst/chl/seaice/mld), the MPA overlay, and the Xweather
 * tile proxy all hit `/api/*` paths. On the deployed web app those paths
 * resolve via Vercel edge functions. On the native Capacitor iOS app,
 * relative `/api/*` requests have nowhere to go — there's no Vercel
 * between the app and the GitHub Release / Xweather upstream — so they
 * 404 and the layers silently fail to load.
 *
 * Fix: rewrite the base to point at the production Vercel deployment
 * when running native. The Vercel URL is configurable via
 * `VITE_NATIVE_API_BASE` so beta builds can target a preview deploy.
 *
 * Web behaviour is unchanged — relative `/api/*` continues to work
 * identically for `npm run dev` (Vite proxy) and Vercel production.
 */

import { Capacitor } from '@capacitor/core';

/** Production fallback if VITE_NATIVE_API_BASE isn't set. Matches the
 *  current Vercel deployment URL — bump this if the project moves. */
const DEFAULT_NATIVE_BASE = 'https://thalassawx.vercel.app/api';

function resolveBase(): string {
    // Web (npm run dev OR Vercel production OR PWA install) — relative
    // path goes through Vite proxy in dev, through Vercel rewrites in prod.
    if (Capacitor.getPlatform() === 'web') {
        return '/api';
    }
    // Native iOS / Android / desktop — relative paths don't resolve.
    // Use the configured production URL.
    try {
        const fromEnv = import.meta.env?.VITE_NATIVE_API_BASE;
        if (fromEnv && typeof fromEnv === 'string' && fromEnv.length > 0) {
            // Trim trailing slash so callers can append `/sst/manifest.json` cleanly.
            return fromEnv.replace(/\/$/, '');
        }
    } catch {
        /* SSR / non-Vite context — fall through */
    }
    return DEFAULT_NATIVE_BASE;
}

/**
 * Base URL for our /api/* edge proxies.
 *   Web  → '/api'                                  (relative; proxied)
 *   iOS  → 'https://thalassawx.vercel.app/api'     (or VITE_NATIVE_API_BASE)
 *
 * Use as a prefix:  `${API_BASE}/sst/manifest.json`
 */
export const API_BASE = resolveBase();
