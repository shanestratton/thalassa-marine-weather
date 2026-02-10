/**
 * Global type declarations for environment variables.
 * Eliminates the need for `(process as any).env` casts throughout the codebase.
 */

declare namespace NodeJS {
    interface ProcessEnv {
        // Supabase
        SUPABASE_URL?: string;
        SUPABASE_KEY?: string;
        // AI
        API_KEY?: string;
        GEMINI_API_KEY?: string;
        // Weather
        STORMGLASS_API_KEY?: string;
        OPEN_METEO_API_KEY?: string;
        // Maps
        MAPBOX_ACCESS_TOKEN?: string;
        WORLD_TIDES_API_KEY?: string;
    }
}
