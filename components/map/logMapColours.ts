/**
 * The Log page's map colours, one truth for both of its maps (Mapbox GL on
 * Relief + Sat: the little map since 125-13a, the big track map since
 * 125-13b). No map library here, so anything can import it.
 *
 * Glow + core, matching the chart-page tracer and the public page (Shane
 * 2026-07-23: the old white-cased hairline "looked like shit"). Violet is the
 * route being followed or planned, sky-blue the track actually sailed; each
 * glow is its core's own hue, so it reads as light off the line.
 */
export const FOLLOWED_ROUTE_GLOW = '#a78bfa';
export const FOLLOWED_ROUTE_CORE = '#c4b5fd';
export const TRACK_GLOW = '#38bdf8';
export const TRACK_CORE = '#7dd3fc';
export const START_DOT = '#34d399';
export const END_DOT = '#ef4444';
/** The live boat: cyan with a soft halo. */
export const BOAT_DOT = '#00f0ff';
