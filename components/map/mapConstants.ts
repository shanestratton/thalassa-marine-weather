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
    | 'mld';
// 'wind-gusts' / 'visibility' / 'cape' removed 2026-04-22 with the
// Xweather decommission. Add back when GFS-derived replacements ship.

/** Sea State layers — mutual exclusion within group */
export const SEA_STATE_LAYERS: WeatherLayer[] = ['waves', 'currents', 'sst', 'chl', 'seaice', 'mld'];
/** Atmosphere layers — mutual exclusion within group */
export const ATMOSPHERE_LAYERS: WeatherLayer[] = ['rain', 'wind', 'velocity', 'temperature', 'clouds', 'pressure'];

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

// Xweather decommissioned 2026-04-22. Quota economics didn't work out
// (single dev session burnt through the daily allowance, next subscription
// tier was extraordinarily expensive). Replacements:
//   - Lightning  → Blitzortung WebSocket (services/weather/api/blitzortungLightning.ts)
//   - Squall     → NOAA GOES IR + RainViewer radar (next iteration)
//   - Sea state  → already on CMEMS pipelines (currents/waves/sst/chl/seaice/mld)
//   - Atmosphere → wind-gusts/visibility/CAPE no longer surfaced; can derive
//                  from GFS / Open-Meteo in a future session if needed
//
// Keeping a stub for backward compatibility with anything that still calls
// getTileUrl('waves') etc. — returns undefined which the caller handles
// (typically by skipping the layer mount). The CMEMS WebGL layers don't
// route through getTileUrl at all so they keep working.

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

    // Sea State (waves/currents/sst/chl/seaice/mld) — these are NOT served
    // via getTileUrl. They use dedicated WebGL custom layers fed by the
    // CMEMS THCU binary pipelines (services/weather/api/{name}Grid.ts
    // → components/map/{Name}RasterLayer.ts). Returning undefined here is
    // correct — those layers mount themselves separately.
    //
    // Atmosphere (wind-gusts / visibility / cape) — no current backend.
    // Xweather decommissioned; CMEMS doesn't include these. Returning
    // undefined hides them from the layer-stack picker.
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
