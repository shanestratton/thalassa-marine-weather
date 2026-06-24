/**
 * Inshore Router Engine — shared constants, sentinels & logger.
 * Carved out of inshoreRouterEngine.ts (module split, 2026-06-24). Leaf module:
 * imports nothing from siblings, so every other engine module can depend on it.
 */
import { createLogger } from '../../utils/createLogger';

export const engineLog = createLogger('inshoreEngine');
// Verbose routing diagnostics (per-component dumps, cell-state traces,
// phase timings, bridge/snap reasoning). Gated OFF for production: the
// minifier dead-code-eliminates `if (ENGINE_DEBUG)` so neither the logs
// NOR their (sometimes expensive grid-walking) compute ship. Flip to
// true locally to debug a route. Operational fallback logs (destination-
// disconnected relax, far-snap retry) stay unconditional below.
export const ENGINE_DEBUG = false;

export const M_PER_DEG_LAT = 111_320;

/**
 * Cell state encoded as a single Float32 value:
 *   NaN   = blocked (land / shallow / obstruction)
 *   ≥0    = navigable, value is depth in meters (0 = unknown but open)
 */
export const BLOCKED = Number.NaN;
export const UNKNOWN_OPEN = 0;
// CAUTION: soft-blocked. The cell reads too shallow for this vessel in
// our (coarse, public) bathymetry — but it is NOT land and NOT a
// charted hazard. A* MAY route through it, at a steep cost penalty, so
// it only does when there is no real-water path. Segments of the
// output that cross CAUTION cells are flagged in `cautionMask` so the
// renderer can draw them red — "our data says shallow here, skipper
// verifies". This is what lets canal estates (Newport) and shallow
// tidal approaches route end-to-end instead of snapping kilometres to
// the nearest surveyed-deep water. Negative sentinel so it's distinct
// from BLOCKED (NaN), UNKNOWN_OPEN (0), and any real depth (>= 0).
export const CAUTION = -1;

/**
 * Refusal threshold for unchartedPolicy 'strict': the longest contiguous
 * run of no-evidence cells the final polyline may cross, in metres. 1 NM —
 * generous against false positives (ogr2ogr sliver gaps between DEPARE
 * bands are 1-3 cells ≈ 50-150 m and merely flag red; marina basins are
 * OSM-vouched; the endpoint carve vouches 60 m around each tap) while any
 * genuine chart-coverage hole is tens of kilometres (Bribie: a 32.7 NM
 * route with ~0% evidence). One knob, one fixture: inshoreRouter.uncharted.
 */
export const UNCHARTED_MAX_RUN_M = 1852;
