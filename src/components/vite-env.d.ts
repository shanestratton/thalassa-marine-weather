declare module '*.css';
declare module '*.png';
declare module '*.svg';
declare module '*.jpeg';
declare module '*.jpg';

interface ImportMetaEnv {
    readonly VITE_MAPBOX_ACCESS_TOKEN: string;
    /** Fleet-feed relay URL (Railway worker /fleet-feed). Absent = AIS sharing inert. */
    readonly VITE_FLEET_FEED_URL?: string;
    readonly VITE_SUPABASE_URL: string;
    readonly VITE_SUPABASE_KEY: string;
    readonly VITE_SUPABASE_ANON_KEY?: string;
    readonly VITE_DISTANCE_TOOLS_KEY: string;
    readonly VITE_OWM_API_KEY: string;
    readonly VITE_SENTRY_DSN: string;
    readonly VITE_APP_VERSION: string;
    readonly VITE_LINZ_API_KEY: string;
    readonly VITE_CMEMS_CURRENTS_ENABLED: string;
    readonly VITE_CMEMS_WAVES_ENABLED: string;
    readonly VITE_CMEMS_SST_ENABLED: string;
    readonly VITE_CMEMS_CHL_ENABLED: string;
    readonly VITE_CMEMS_SEAICE_ENABLED: string;
    readonly VITE_CMEMS_MLD_ENABLED: string;
    readonly VITE_MPA_ENABLED: string;
    /** Base URL for /api/* proxies when running native (iOS / Android).
     *  Not used on web (relative /api/* resolves via Vite proxy or Vercel). */
    readonly VITE_NATIVE_API_BASE: string;
    /** Dev override: when 'true', useEntitlement always returns true so
     *  gated pages (Galley / Diary etc.) render normally
     *  without needing to juggle subscription tier in dev tools. */
    readonly VITE_GRANT_ALL_FEATURES: string;
    /** Explicit development/test/demo-only opt-in for the bundled Savannah
     * ENC preview. Production code rejects the flag even when set. */
    readonly VITE_ENABLE_ENC_DEMO_SAMPLES?: string;
    /** Compile-time release gate for native Sign in with Apple. Keep unset or
     *  false until the complete server-side token lifecycle is live. */
    readonly VITE_APPLE_SIGN_IN_ENABLED?: string;
    readonly VITE_APPLE_MUSIC_ENABLED?: string;
    /** Compile-time release gate for the shelved Apple Watch bridge. */
    readonly VITE_APPLE_WATCH_ENABLED?: string;
    readonly VITE_GOOGLE_SIGN_IN_ENABLED?: string;
    /** Compile-time public-beta hold for destructive account deletion. Keep
     *  false until durable server fencing, deployment, and live smoke pass. */
    readonly VITE_ACCOUNT_DELETION_ENABLED?: string;
    /** Cloudflare Worker URL for the Deepgram WebSocket proxy.
     *  e.g. https://thalassa-deepgram-proxy.thalassacalypso.workers.dev */
    readonly VITE_DEEPGRAM_PROXY_URL: string;
    /** Google OAuth 2.0 Client ID (iOS app type) used by Calypso's
     *  Gmail integration. PKCE flow, no client secret. Falls back to
     *  empty string when undefined → integration shows "not configured". */
    readonly VITE_GOOGLE_OAUTH_CLIENT_ID: string;
    /** Development-only explicit opt-in for the private wx-server. Public
     *  beta production builds force this off. */
    readonly VITE_WX_SERVER_ENABLED?: string;
    /** Development-only wx-server endpoint. There is no production fallback. */
    readonly VITE_WX_SERVER_BASE: string;

    // Standard Vite Environment Variables
    readonly BASE_URL: string;
    readonly MODE: string;
    readonly DEV: boolean;
    readonly PROD: boolean;
    readonly SSR: boolean;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}

// Augment the global NodeJS namespace to type process.env correctly.
declare namespace NodeJS {
    interface ProcessEnv {
        MAPBOX_ACCESS_TOKEN: string;
        SUPABASE_URL: string;
        SUPABASE_KEY: string;
        [key: string]: string | undefined;
    }
}
