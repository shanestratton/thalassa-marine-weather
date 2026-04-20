/**
 * Global type declarations for environment variables and window extensions.
 * Eliminates the need for `(process as any).env` and `(window as any).__xyz` casts.
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
        // Background Geolocation
        VITE_TRANSISTOR_LICENSE_KEY?: string;
        // Spoonacular
        VITE_SPOONACULAR_KEY?: string;
    }
}

// --- WINDOW EXTENSIONS ---
// Eliminates `(window as any).__thalassaPinView` etc. across the codebase

interface ThalassaWindow {
    /** Pin drop coordinates shared between ChatMessageList → MapHub */
    __thalassaPinView?: { lat: number; lng: number };
    /** MapLibre GL instance (set by map components) */
    mapboxgl?: typeof import('mapbox-gl');
    /** Leaflet instance (set by TrackMapViewer) */
    L?: typeof import('leaflet');
    /** Wind particle debug info */
    __windDebug?: {
        frame: number;
        hasWind: boolean;
        timelineLen: number;
        dataBounds: { north: number; south: number; east: number; west: number };
        gridBounds: { north: number; south: number; east: number; west: number };
        globalMode: boolean;
        trail0: Array<{ x: number; y: number; spd: number; a: number }>;
        sample: Array<{ x: number; y: number; age: number }>;
        wind0: { u: number; v: number };
        cam?: {
            zoom: number;
            center: number[];
            bearing: number;
            pitch: number;
            isMoving: boolean;
            isZooming: boolean;
            isEasing: boolean;
        } | null;
        particleCount?: number;
        fps?: number;
        dataPoints?: number;
        bounds?: { minLat: number; maxLat: number; minLon: number; maxLon: number };
    };
    /** Chat keyboard cleanup callback */
    __chatKbCleanup?: () => void;
    /** Web Speech API (vendor-prefixed) */
    SpeechRecognition?: typeof SpeechRecognition;
    webkitSpeechRecognition?: typeof SpeechRecognition;
}

// Merge with global Window

interface Window extends ThalassaWindow {}

// --- ERROR TYPE UTILITIES ---

/** Type guard for errors with HTTP status codes (Supabase, fetch, etc.) */
interface HttpError extends Error {
    status?: number;
    statusCode?: number;
    code?: string;
}

/** Safely extract HTTP status from an unknown error */
declare function isHttpError(err: unknown): err is HttpError;
