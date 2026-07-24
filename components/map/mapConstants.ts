/**
 * Map constants and types used across MapHub sub-modules.
 */

import { windBandForKt } from './windRamp';

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
    /**
     * Passage-planning surface: keep the planning chart, navigation marks and
     * route furniture, but suppress every optional browsing overlay without
     * changing the Chart page's persisted selections.
     */
    cleanPlanningMap?: boolean;
    /** Hide the Route Tracer button/panel — for host pages with their own
     *  bottom CTA (the Plan page's "Slide to Calculate Route" sat exactly
     *  under the tracer button, Shane 2026-07-08). */
    hideTracer?: boolean;
    /** Override center coordinates (for embedded mode) */
    center?: { lat: number; lon: number };
    lat?: number;
    lon?: number;
    /** Picker mode: single tap selects a location, reverse geocodes, and calls onLocationSelect */
    pickerMode?: boolean;
    /** Label shown in the picker banner (e.g. "Select Origin") */
    pickerLabel?: string;
}

/**
 * Chart browsing and passage planning share MapHub, but they must not share
 * optional overlay visibility. Keep this as a pure derivation so entering Plan
 * can never erase the skipper's persisted Chart choices.
 */
export function shouldSuppressChartOverlays(
    cleanPlanningMap: boolean,
    tracing: boolean,
    showingPassage: boolean,
): boolean {
    return cleanPlanningMap || tracing || showingPassage;
}

/**
 * The nautical chart key is planning furniture, not a Chart-page overlay.
 * The Plan journey owns both RoutePlanner's clean map and the tracer surface
 * it hands off to. Do not use the broader planning classification: a computed
 * passage can also be displayed on Chart without opening the Plan tracer.
 */
export function shouldShowPlanChartKey(
    cleanPlanningMap: boolean,
    planTracerActive: boolean,
    embedded: boolean,
    pickerMode: boolean,
    pinView: boolean,
): boolean {
    return (cleanPlanningMap || planTracerActive) && !embedded && !pickerMode && !pinView;
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
/**
 * Sea-state layers PARKED from the chart page's layer pickers (Shane
 * 2026-07-18: "remove MLD, sea ice, waves from the charts page"). Waves
 * duplicate the sea-state read the passage tools already give; Sea Ice and MLD
 * are polar/oceanographic and have no bearing on a Queensland coastal passage.
 *
 * ONE list, consumed by every picker — the pickers are duplicated (the radial
 * helm fan and the overlay drawer both enumerate these), and hand-copied layer
 * lists in this codebase have drifted twice this week. Empty it to restore.
 * The layer keys and CMEMS plumbing stay wired; this only hides the controls.
 */
export const PARKED_SEA_LAYERS: WeatherLayer[] = ['waves', 'seaice', 'mld'];
export const isParkedLayer = (k: WeatherLayer): boolean => PARKED_SEA_LAYERS.includes(k);

/** Atmosphere layers — mutual exclusion within group */
export const ATMOSPHERE_LAYERS: WeatherLayer[] = ['rain', 'wind', 'velocity', 'temperature', 'clouds', 'pressure'];

/**
 * The framing zoom each forecast overlay claims when switched on.
 *
 * PER LAYER, because these fields are not read at the same scale. Wind opens
 * at z5 for a broad regional read (Shane 2026-07-24); its controller
 * deliberately uses the wide-viewport grid at that scale. Currents and rain
 * retain the tighter z7.5 local frame.
 *
 * PRESSURE is the exception and gets 2.0 (Shane 2026-07-22). Isobars are a
 * SYNOPTIC read: the useful question is where the high and the low sit and
 * which way the gradient runs across a whole sea area. At 7.5 you are inside
 * one isobar band looking at a couple of parallel lines, which tells you
 * nothing a wind arrow does not.
 *
 * 'velocity' is the legacy alias for wind — both keys must appear or the edge
 * is undetectable whenever the layer is stored under the older name.
 *
 * LIVES HERE, not in MapHub, so every layer's framing decision has one source
 * of truth. MapHub consumes the full table; useWeatherLayers additionally
 * derives pressure's minZoom floor from its entry. When those pressure values
 * disagreed, Mapbox clamped easeTo at call time and the tap looked ineffective.
 */
export const LAYER_FRAME_ZOOM: Partial<Record<WeatherLayer, number>> = {
    wind: 5,
    velocity: 5,
    currents: 7.5,
    rain: 7.5,
    pressure: 2.0,
};

/** Resolve the first active overlay's authoritative framing zoom. */
export function getActiveLayerFrameZoom(activeLayers: ReadonlySet<WeatherLayer>): number | undefined {
    for (const layer of Object.keys(LAYER_FRAME_ZOOM) as WeatherLayer[]) {
        if (activeLayers.has(layer)) return LAYER_FRAME_ZOOM[layer];
    }
    return undefined;
}

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

/**
 * Wind speed → the colour of its speed label.
 *
 * ONE RAMP FOR THE WHOLE WIND LAYER. This used to be its own monochrome scale:
 * near-black, dark slate, mid slate, grey, light grey, and only THEN amber and
 * red. Which meant everything from a drifter to a 25-knot reefing breeze — the
 * entire range anyone actually sails in — came out as one of five greys, and
 * you had to read the number to know whether you were looking at a nice day or
 * a hard one (Shane 2026-07-23: "make the wind colors more colourful and easily
 * identify strong wind from light wind").
 *
 * It now defers to windRamp, the same band table the particle field and the
 * legend already use. So a 22-knot label is the exact orange of the 22-knot
 * particles streaming past it and of the legend block beside them, and the
 * edges land where a skipper steers: 20 kt reef, 34 kt the true Beaufort F8
 * gale line. Those bands are also cross-family hue flips at 20/30/34, so the
 * read survives protanopia and deuteranopia — a grey ramp never did more than
 * survive it, because it never said anything in the first place.
 *
 * Returns a solid hex, not the old 0.85 alpha: a translucent chip let the chart
 * beneath it muddy the very hue that is doing the work.
 */
export function getWindColor(kts: number): string {
    return windBandForKt(kts).hex;
}

/* Animation keyframes moved to index.css */
