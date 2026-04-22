/**
 * Map constants and types used across MapHub sub-modules.
 */

// ── Types ──────────────────────────────────────────────────────

export interface MapHubProps {
    mapboxToken?: string;
    homePort?: string;
    onLocationSelect?: (lat: number, lon: number, name?: string) => void;
    /** Override default zoom level (default: 8) */
    initialZoom?: number;
    /** Override map style URL (default: navigation-night-v1) */
    mapStyle?: string;
    /** Remove large country/place labels for a cleaner look */
    minimalLabels?: boolean;
    /** Embedded mode: no overlays, no interactions, static centered view */
    embedded?: boolean;
    /** Override center coordinates (for embedded mode) */
    center?: { lat: number; lon: number };
    lat?: number;
    lon?: number;
    /** Picker mode: single tap selects a location, reverse geocodes, and calls onLocationSelect */
    pickerMode?: boolean;
    /** Label shown in the picker banner (e.g. "Select Origin") */
    pickerLabel?: string;
}

export type WeatherLayer =
    | 'none'
    | 'rain'
    | 'wind'
    | 'temperature'
    | 'clouds'
    | 'pressure'
    | 'sea'
    | 'satellite'
    | 'velocity'
    // Sea State
    | 'waves'
    | 'currents'
    | 'sst'
    | 'chl'
    | 'seaice'
    | 'mld'
    // Atmosphere (Xweather)
    | 'wind-gusts'
    | 'visibility'
    | 'cape';

/** Sea State layers — mutual exclusion within group */
export const SEA_STATE_LAYERS: WeatherLayer[] = ['waves', 'currents', 'sst', 'chl', 'seaice', 'mld'];
/** Atmosphere layers — mutual exclusion within group */
export const ATMOSPHERE_LAYERS: WeatherLayer[] = [
    'rain',
    'wind',
    'velocity',
    'wind-gusts',
    'temperature',
    'clouds',
    'pressure',
    'visibility',
    'cape',
];

// ── Tile sources ──
function getOwmKey(): string {
    try {
        const env = import.meta.env;
        if (env?.VITE_OWM_API_KEY) return env.VITE_OWM_API_KEY;
    } catch {
        /* SSR / non-Vite context */
    }
    return '';
}

/** Whether Xweather tile layers are wired up. The actual creds live
 *  server-side and never reach the client — this flag just gates
 *  whether the URL builder returns proxied paths. */
function isXweatherEnabled(): boolean {
    try {
        // VITE_XWEATHER_CLIENT_ID is fine to keep public — it's just an
        // identifier, no auth power on its own. Use it as the gate so
        // existing dev configs keep working without an additional env var.
        const id = import.meta.env?.VITE_XWEATHER_CLIENT_ID;
        return Boolean(id);
    } catch {
        /* SSR / non-Vite context */
        return false;
    }
}

export const STATIC_TILES: Record<string, string> = {
    sea: 'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png',
    satellite: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
};

/** Get tile URL for a layer — includes dynamic OWM-keyed layers */
export function getTileUrl(layer: string): string | undefined {
    if (STATIC_TILES[layer]) return STATIC_TILES[layer];
    const owmKey = getOwmKey();
    if (!owmKey) return undefined;
    if (layer === 'temperature') return `https://tile.openweathermap.org/map/temp_new/{z}/{x}/{y}.png?appid=${owmKey}`;
    if (layer === 'clouds') return `https://tile.openweathermap.org/map/clouds_new/{z}/{x}/{y}.png?appid=${owmKey}`;

    // Xweather tile layers — always proxied through `/api/xweather/`
    // so the client_secret stays server-side. See api/xweather/[...path].ts.
    if (isXweatherEnabled()) {
        const xwBase = '/api/xweather';
        // Sea State
        if (layer === 'waves') return `${xwBase}/wave-heights/{z}/{x}/{y}/current.png`;
        if (layer === 'currents') return `${xwBase}/ocean-currents/{z}/{x}/{y}/current.png`;
        if (layer === 'sst') return `${xwBase}/sst/{z}/{x}/{y}/current.png`;
        // Atmosphere
        if (layer === 'wind-gusts') return `${xwBase}/wind-gusts/{z}/{x}/{y}/current.png`;
        if (layer === 'visibility') return `${xwBase}/visibility/{z}/{x}/{y}/current.png`;
        if (layer === 'cape') return `${xwBase}/cape/{z}/{x}/{y}/current.png`;
    }

    return undefined;
}

// Wind speed → monochrome color (matches GLSL palette in WindGLEngine)
export function getWindColor(kts: number): string {
    if (kts < 5) return 'rgba(30, 35, 45, 0.85)'; // Calm - near-black
    if (kts < 10) return 'rgba(50, 55, 65, 0.85)'; // Light - dark slate
    if (kts < 15) return 'rgba(75, 78, 85, 0.85)'; // Gentle - mid slate
    if (kts < 20) return 'rgba(100, 103, 108, 0.85)'; // Moderate - grey
    if (kts < 25) return 'rgba(130, 130, 133, 0.85)'; // Fresh - light grey
    if (kts < 34) return 'rgba(140, 102, 76, 0.90)'; // Strong - muted amber
    if (kts < 48) return 'rgba(166, 76, 71, 0.90)'; // Gale - muted coral
    return 'rgba(178, 64, 76, 0.90)'; // Storm+ - warm red
}

/* Animation keyframes moved to index.css */
