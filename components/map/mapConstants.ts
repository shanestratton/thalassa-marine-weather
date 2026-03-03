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

export type WeatherLayer = 'none' | 'rain' | 'wind' | 'temperature' | 'clouds' | 'pressure' | 'sea' | 'satellite' | 'velocity';

// ── Free tile sources (no API key required) ──
export const STATIC_TILES: Record<string, string> = {
    sea: 'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png',
    satellite: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
};

// Wind speed → monochrome color (matches GLSL palette in WindGLEngine)
export function getWindColor(kts: number): string {
    if (kts < 5) return 'rgba(30, 35, 45, 0.85)';     // Calm - near-black
    if (kts < 10) return 'rgba(50, 55, 65, 0.85)';    // Light - dark slate
    if (kts < 15) return 'rgba(75, 78, 85, 0.85)';    // Gentle - mid slate
    if (kts < 20) return 'rgba(100, 103, 108, 0.85)';  // Moderate - grey
    if (kts < 25) return 'rgba(130, 130, 133, 0.85)';  // Fresh - light grey
    if (kts < 34) return 'rgba(140, 102, 76, 0.90)';   // Strong - muted amber
    if (kts < 48) return 'rgba(166, 76, 71, 0.90)';    // Gale - muted coral
    return 'rgba(178, 64, 76, 0.90)';                   // Storm+ - warm red
}

// CSS keyframes for pin/location animations
export const MAP_ANIMATIONS_CSS = `
    @keyframes pinBounce {
        0% { transform: rotate(-45deg) translateY(-20px) scale(0.5); opacity: 0; }
        60% { transform: rotate(-45deg) translateY(2px) scale(1.1); }
        100% { transform: rotate(-45deg) translateY(0) scale(1); opacity: 1; }
    }
    @keyframes locPulse {
        0% { box-shadow: 0 0 0 0 rgba(59,130,246,0.5); }
        70% { box-shadow: 0 0 0 10px rgba(59,130,246,0); }
        100% { box-shadow: 0 0 0 0 rgba(59,130,246,0); }
    }
    .loc-dot {
        width: 8px; height: 8px; border-radius: 50%;
        background: #3b82f6; border: 1.5px solid #fff;
        animation: locPulse 2s infinite;
        box-shadow: 0 0 0 0 rgba(59,130,246,0.5);
    }
`;
