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

/**
 * Atmosphere layers — mutual exclusion within group.
 *
 * 'pressure' left this group 2026-08-02: isobars are a line overlay, not a
 * field, so they STACK on wind/rain instead of replacing them (the
 * Windy-style wind+isobar synoptic read). Its radial-menu item is a plain
 * toggle now; removing it from this list is what stops selecting wind/rain
 * from switching the isobars off.
 */
export const ATMOSPHERE_LAYERS: WeatherLayer[] = ['rain', 'wind', 'velocity', 'temperature', 'clouds'];

/**
 * The framing zoom each forecast overlay claims when switched on.
 *
 * PER LAYER, because these fields are not read at the same scale. Currents
 * retain the tighter z7.5 local frame.
 *
 * RAIN OPENS AT z5 — its regional frame. Shane tried z8 on 2026-08-22 and
 * moved it back the next day while comparing layouts, so treat this number as
 * a dial he is still turning rather than a settled decision.
 *
 * The one hard constraint on that dial: RainViewer's native tiles stop at
 * RAINVIEWER_NATIVE_MAX_ZOOM (7). At z5 the radar is real data at native
 * resolution. Past z7 Mapbox overzooms the z7 image — safe and deliberate
 * (the source maxzoom is capped precisely so overzoom happens instead of the
 * provider serving its "Zoom Level Not Supported" error tile) but it buys a
 * closer VIEW, not more detail, and beyond z8 it is just magnifying the same
 * pixels. A test keeps this within one step of that ceiling.
 *
 * WIND OPENS LOCAL AT z9 (Shane 2026-08-22), reversing the z3 synoptic frame
 * he asked for on 2026-07-26. Two reasons, and the second is why it was worth
 * changing:
 *
 *  1. What a skipper wants first is the wind where the boat is. Panning out to
 *     the synoptic picture is a deliberate second question, and scrolling out
 *     is cheap; scrolling IN to find your own harbour is not.
 *  2. It is also the fix for "wind is slow". WindDataController picks its grid
 *     from the camera: at z9 it serves the punter-centred fine grid
 *     (FINE_GRID_HALF_SPAN_DEG = 2°, already warmed on boot), while z3 forced
 *     the wide coarse grid — a far larger fetch before anything could paint.
 *     Wind was slow BECAUSE it opened synoptic, so framing local buys the
 *     speed as a side effect rather than needing a separate optimisation.
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
    // Wind and rain both open at z7 (Shane 2026-08-24). Wind was z9, which is
    // a harbour frame — too tight to read a system moving through; rain was z5,
    // wide enough that a cell you care about is a smudge. z7 is the regional
    // read both actually want, and it matches the multi-layer frame below, so
    // stacking a second overlay no longer moves the camera at all.
    wind: 7,
    velocity: 7,
    currents: 7.5,
    rain: 7,
    pressure: 2.0,
    // Temperature and cloud both open at z4 (Shane 2026-08-23). Broad
    // fields — a sea-surface temperature gradient or a cloud band is a
    // regional read, not a harbour one — and z4 is comfortably inside
    // OpenWeatherMap's native tile range (see TILE_SOURCE_MAX_ZOOM), so
    // what draws there is real data rather than an upscale.
    temperature: 4,
    clouds: 4,
};

/**
 * Source-level zoom ceiling per raster tile layer.
 *
 * Mapbox requests NATIVE tiles up to a source's maxzoom and only overzooms
 * (upscales the deepest real tile) beyond it. Everything here used to sit at
 * 18, which meant that past a provider's actual data resolution the app kept
 * asking for tiles that carry no new information — and the count quadruples
 * per level, so a z12 view fetched 64 tiles where one z9 tile stretched
 * locally would have looked identical. On cellular that is 64 round trips
 * against 1.
 *
 * Measured on OpenWeatherMap clouds_new, same location, 2026-08-23:
 * z4 71 kB, z6 40 kB, z9 6.5 kB, z10 1.8 kB, z12 1.5 kB. The content
 * collapses past z9, which is where OWM documents its weather rasters
 * ending. Capping there costs nothing visible — the paint already sets
 * raster-resampling 'linear' precisely so an overzoomed tile stays smooth,
 * a comment that was describing behaviour the maxzoom:18 prevented.
 *
 * This is the same rule RainViewer already follows here via
 * RAINVIEWER_NATIVE_MAX_ZOOM; it simply had not been applied to the OWM
 * layers.
 */
export const TILE_SOURCE_MAX_ZOOM: Partial<Record<WeatherLayer, number>> = {
    // NOT capped: OpenSeaMap seamarks are genuine detail all the way in, and
    // they are the one layer here a skipper reads at berthing zoom.
    sea: 18,
    temperature: 9,
    clouds: 9,
    waves: 9,
    currents: 9,
    sst: 9,
};

/** Ceiling for a raster tile source, defaulting to full depth. */
export function tileSourceMaxZoom(layer: WeatherLayer): number {
    return TILE_SOURCE_MAX_ZOOM[layer] ?? 18;
}

/**
 * How far OUT each layer may be pinched — a DIFFERENT question from where it
 * opens, and the two must not share a number.
 *
 * They did. Wind's floor was `Math.max(LAYER_FRAME_ZOOM.wind, 3)`, which was
 * correct only because the framing zoom happened to also be 3. Moving the
 * frame to z9 silently moved the floor to z9 as well, so wind's z3–z9 range
 * collapsed to exactly z9 and the chart would not zoom out at all (Shane,
 * 2026-08-22: "now it is stuck at zoom 9").
 *
 * Opening frame and zoom range are independent decisions:
 *   wind     — opens LOCAL at z9, still pinches out to z3 for the synoptic read
 *   pressure — opens at its widest, so frame and floor genuinely are one value
 *
 * Pressure therefore still DERIVES from the frame, which is deliberate: those
 * two halves disagreed once and the floor silently won, making the framing ease
 * look like it never fired (Shane 2026-07-23). Wind gets its own number
 * because for wind they are honestly different.
 */
export const LAYER_MIN_ZOOM: Partial<Record<WeatherLayer, number>> = {
    wind: 3,
    velocity: 3,
    pressure: LAYER_FRAME_ZOOM.pressure,
};

/**
 * The frame for a STACK rather than a single overlay (Shane 2026-08-24).
 *
 * Per-layer frames are chosen for that layer read alone, and they disagree —
 * pressure opens synoptic at z2, temperature and cloud at z4. Once the AIR
 * layers can all be up together (they stopped being mutually exclusive on the
 * same day) whichever one you happened to tap last would otherwise dictate the
 * camera for the whole stack, so adding cloud to wind threw away the frame you
 * were working in. One shared frame for any combination removes the question.
 */
export const MULTI_LAYER_FRAME_ZOOM = 7;

/** Resolve the first active overlay's authoritative framing zoom. */
export function getActiveLayerFrameZoom(activeLayers: ReadonlySet<WeatherLayer>): number | undefined {
    if (activeLayers.size > 1) return MULTI_LAYER_FRAME_ZOOM;
    for (const layer of Object.keys(LAYER_FRAME_ZOOM) as WeatherLayer[]) {
        if (activeLayers.has(layer)) return LAYER_FRAME_ZOOM[layer];
    }
    return undefined;
}

/**
 * What zoom should the camera take when `newlyOn` has just come up?
 *
 * More than one overlay active means the stack frame wins regardless of which
 * layer was tapped — including combinations that have no frame of their own
 * (cloud + temperature), which previously left the camera wherever it was.
 */
export function frameZoomForSelection(
    activeLayers: ReadonlySet<WeatherLayer>,
    newlyOn: WeatherLayer,
): number | undefined {
    if (activeLayers.size > 1) return MULTI_LAYER_FRAME_ZOOM;
    return LAYER_FRAME_ZOOM[newlyOn];
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
