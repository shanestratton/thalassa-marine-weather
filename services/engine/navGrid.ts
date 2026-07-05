/**
 * Inshore Router Engine — navigability grid build, cache, snapping & CCL.
 * Carved out of inshoreRouterEngine.ts (module split, 2026-06-24).
 */
import type { Feature, LineString, MultiLineString, Polygon, MultiPolygon, Point, Position } from 'geojson';
import { M_PER_DEG_LAT, BLOCKED, UNKNOWN_OPEN, CAUTION, ENGINE_DEBUG, engineLog } from './constants';
import type { InshoreLayers, RelaxZone, NavGrid } from './types';
import { mPerDegLon, haversineM, rasterizePolygonCells, bresenhamCells, latLonToGrid } from './geometry';
import { computeCentreFactor } from './aStar';

/**
 * Process-wide cache for buildNavGrid output. Keyed by the inputs that
 * deterministically produce a grid. Grid build is the routing pipeline's
 * dominant cost (20+ s for the Brisbane test case at 50 m resolution) so
 * even simple memoisation lets repeated routes against the same cell
 * pack skip everything except A* (which is ~50 ms).
 *
 * Cache key composition:
 *   - bbox, resolutionM, draftM, safetyM, obstructionBufferM (route params)
 *   - feature-counts-per-layer signature (cheap fingerprint of the merged
 *     layer data; sufficient given the layer data is deterministic upstream
 *     from cell-pack + Supabase nav markers + iOS-side pairing)
 *
 * The signature is best-effort — distinct layer payloads with matching
 * feature counts would collide. Fine for now; tighten with a content hash
 * if we ever hit it.
 *
 * Hard size cap of 5 grids (≈1 MB at 200×400×4 bytes) to bound memory.
 */
export interface CachedNavGrid {
    grid: NavGrid;
    ts: number;
}
export const navGridCache = new Map<string, CachedNavGrid>();
export const NAV_GRID_CACHE_MAX = 5;

export function relaxZonesKey(relaxZones: RelaxZone[]): string {
    if (relaxZones.length === 0) return 'none';
    return relaxZones.map((z) => `${z.lat.toFixed(3)},${z.lon.toFixed(3)},${Math.round(z.radiusM)}`).join('|');
}

export function navGridCacheKey(
    layers: InshoreLayers,
    bbox: [number, number, number, number],
    resolutionM: number,
    draftM: number,
    safetyM: number,
    obstructionBufferM: number,
    relaxedLndare: boolean,
    relaxZones: RelaxZone[],
    routeProfile: 'safest' | 'tideAssist' = 'safest',
): string {
    const sig = [
        layers.LNDARE?.features.length ?? 0,
        layers.DEPARE?.features.length ?? 0,
        layers.OBSTRN?.features.length ?? 0,
        layers.WRECKS?.features.length ?? 0,
        layers.UWTROC?.features.length ?? 0,
        layers.FAIRWY?.features.length ?? 0,
        layers.DRGARE?.features.length ?? 0,
        layers.BOYLAT?.features.length ?? 0,
        layers.BCNLAT?.features.length ?? 0,
        layers.COASTLINE?.features.length ?? 0,
        layers.CANAL?.features.length ?? 0,
        layers.NAVLINE?.features.length ?? 0,
    ].join(',');
    // NTM zones need more than a count: a superseding notice can ship the same
    // number of zones with different surveyed depths, and acking toggles the
    // set — key on count + notice keys + depth sum so no stale grid survives.
    const ntmFeats = layers.NTMZONE?.features ?? [];
    const ntmSig =
        ntmFeats.length === 0
            ? '0'
            : `${ntmFeats.length}:${ntmFeats
                  .map((f) => {
                      const p = f.properties as { depthM?: number; _noticeKey?: string } | null;
                      return `${p?._noticeKey ?? '?'}@${p?.depthM ?? '?'}`;
                  })
                  .join('|')}`;
    return `${bbox.join(',')}_${resolutionM}_${draftM}_${safetyM}_${obstructionBufferM}_${relaxedLndare ? 'relaxed' : 'strict'}_rz${relaxZonesKey(relaxZones)}_${routeProfile}_${sig}_ntm${ntmSig}`;
}

/**
 * READ-ONLY cache lookup for the Phase 12 shadow router: returns the
 * already-built grid for these exact params, or null — it NEVER builds.
 * The shadow must never pay a synchronous grid build on the main thread
 * (the adversarial review measured a guaranteed miss for fine-pass
 * results: the fine bbox at 50 m is a key no live path ever builds, and
 * the orphan entry would evict a hot grid from the 5-slot LRU). A null
 * here becomes a reasoned 'grid-not-cached' report, never silent work.
 */
export function getCachedNavGrid(
    layers: InshoreLayers,
    bbox: [number, number, number, number],
    resolutionM: number,
    draftM: number,
    safetyM: number,
    obstructionBufferM: number,
    relaxedLndare: boolean = false,
    relaxZones: RelaxZone[] = [],
): NavGrid | null {
    const key = navGridCacheKey(
        layers,
        bbox,
        resolutionM,
        draftM,
        safetyM,
        obstructionBufferM,
        relaxedLndare,
        relaxZones,
    );
    const cached = navGridCache.get(key);
    if (!cached) return null;
    cached.ts = Date.now();
    return cached.grid;
}

export function buildNavGridCached(
    layers: InshoreLayers,
    bbox: [number, number, number, number],
    resolutionM: number,
    draftM: number,
    safetyM: number,
    obstructionBufferM: number,
    relaxedLndare: boolean = false,
    relaxZones: RelaxZone[] = [],
    routeProfile: 'safest' | 'tideAssist' = 'safest',
): { grid: NavGrid; cacheHit: boolean } {
    const key = navGridCacheKey(
        layers,
        bbox,
        resolutionM,
        draftM,
        safetyM,
        obstructionBufferM,
        relaxedLndare,
        relaxZones,
        routeProfile,
    );
    const cached = navGridCache.get(key);
    if (cached) {
        cached.ts = Date.now();
        return { grid: cached.grid, cacheHit: true };
    }
    const grid = buildNavGrid(
        layers,
        bbox,
        resolutionM,
        draftM,
        safetyM,
        obstructionBufferM,
        relaxedLndare,
        relaxZones,
        routeProfile,
    );
    if (navGridCache.size >= NAV_GRID_CACHE_MAX) {
        let oldestKey: string | null = null;
        let oldestTs = Infinity;
        for (const [k, v] of navGridCache) {
            if (v.ts < oldestTs) {
                oldestTs = v.ts;
                oldestKey = k;
            }
        }
        if (oldestKey) navGridCache.delete(oldestKey);
    }
    navGridCache.set(key, { grid, ts: Date.now() });
    return { grid, cacheHit: false };
}

/**
 * Build a navigability grid for the given bbox, draft, and resolution.
 * Time complexity is roughly O(featureCount × cellsPerFeatureBbox).
 * Polygons rasterize in their bbox slice rather than the whole grid.
 */
export function buildNavGrid(
    layers: InshoreLayers,
    bbox: [number, number, number, number],
    resolutionM: number,
    draftM: number,
    safetyM: number,
    obstructionBufferM: number,
    /**
     * When true, ALL LNDARE cells become CAUTION (high-cost 500×
     * traversable) instead of BLOCKED, grid-wide. Reserved for the
     * destination-disconnected last-resort retry — the rare case where a
     * chart's mainland LNDARE polygon includes a river course without a
     * proper hole and strict routing finds NO path at all. A* still
     * prefers real water (8×) over relaxed land (40×) so it only crosses
     * land where no water route exists.
     */
    relaxedLndare: boolean = false,
    /**
     * Bounded zones within which LNDARE/coastline relax to CAUTION even
     * when `relaxedLndare` is false. Used by the far-snap retry to thread
     * the charted-land barrier islanding an endpoint (Newport) while
     * keeping every mid-route mainland cell hard-blocked. Empty = no
     * localized relaxation.
     */
    relaxZones: RelaxZone[] = [],
    /**
     * 'tideAssist' populates grid.tideAssist (caution cells wet at LAT with
     * requiredRise ≤ 1.8 m priced 10× by A*) — the EXPLICIT "shortest" route
     * profile. 'safest' (default) leaves the mask absent. Part of the cache key.
     */
    routeProfile: 'safest' | 'tideAssist' = 'safest',
): NavGrid {
    // Per-pass timing — a single Newport→Brisbane build was clocked at
    // 37.8 s and accounted for 97% of the route compute. Without per-
    // pass numbers we can't tell which polygon scanner is the
    // bottleneck (DEPARE has 1500+ polygons but small grids; LNDARE has
    // 200 polygons but huge bboxes; OBSTRN is 500+ points; FAIRWY is
    // moderate). The summary at the bottom of this function logs the
    // breakdown so the optimisation target is data-driven.
    const buildT0 = Date.now();
    const passTimings: Record<string, number> = {};
    const featureCounts: Record<string, number> = {};
    const markPass = (label: string, start: number, featureCount: number): void => {
        passTimings[label] = Date.now() - start;
        featureCounts[label] = featureCount;
    };

    const [minLon, minLat, maxLon, maxLat] = bbox;
    const midLat = (minLat + maxLat) / 2;
    const mPerLon = mPerDegLon(midLat);

    // Cell size in degrees, sized to the configured meter resolution.
    const dLon = resolutionM / mPerLon;
    const dLat = resolutionM / M_PER_DEG_LAT;
    const width = Math.max(1, Math.ceil((maxLon - minLon) / dLon));
    const height = Math.max(1, Math.ceil((maxLat - minLat) / dLat));

    const cells = new Float32Array(width * height);
    cells.fill(UNKNOWN_OPEN); // permissive default — see header doc
    // DEPARE-only verdict per cell (NaN = no DEPARE coverage): the depth the
    // chart's depth areas assign here, IGNORING a later LNDARE override. Lets
    // the synthetic lateral-mark ribbon (Pass 4) restore charted water that
    // LNDARE *bleed* falsely hard-blocked — un-blocking the buoyed channel
    // WITHOUT faking depth, and never touching real land (NaN → stays blocked).
    const depareVerdict = new Float32Array(width * height).fill(NaN);
    // Real charted depth (shallowest DRVAL1) of shallow-for-draft cells — the
    // value the CAUTION sentinel erases from `cells`/`depareVerdict`. Exported on
    // the grid for the Phase 7 tide-window annotation; routing never reads it.
    const shallowDepthM = new Float32Array(width * height).fill(NaN);
    // Cells under a low-clearance structure (a fixed bridge this vessel's air
    // draft can't make) — impassable ABSOLUTELY: no rescue, relax, or carve
    // pass may ever re-open them. Exported on the grid so the component-bridge
    // and endpoint carves can refuse to tunnel.
    const clearanceBarred = new Uint8Array(width * height);
    const preferred = new Uint8Array(width * height);
    // Per-cell "protected" flag: 1 = a DEPARE (chart S-57 OR authoritative
    // OSM engineered water) claimed this cell as deep, so the LNDARE pass
    // doesn't hard-block it. Generic OSM `natural=water` and bathymetry-
    // derived DEPARE do NOT get this protection — LNDARE beats them.
    const protectedCells = new Uint8Array(width * height);
    // Per-cell "wet-at-LAT chart claim": 1 = an S-57 DEPARE band with
    // DRVAL1 > 0 covered this cell — shallow for this keel (CAUTION) but
    // genuinely WATER at chart datum. Pass 2 uses it to resolve
    // LNDARE-vs-wet-chart-water conflicts (generalised overview-band
    // coastline painted over a finer cell's charted river — the Mooloolah
    // wharf→bar mile): conflict cells stay CAUTION and become protected so
    // the Pass-6 buffer can't seal the river shut. Never set by drying
    // bands (DRVAL1 ≤ 0) — a charted drying spit defers to land paint.
    const wetChartClaim = new Uint8Array(width * height);
    // Cells where the wet claim actually RESOLVED a land conflict (a subset
    // of wetChartClaim). Exposed as grid.wetConflict: routable mid-route at
    // 40× caution, but endpoint snapping must PREFER honest water — a
    // geocoded suburb pin snapping straight onto a conflict creek turned the
    // Mooloolaba canal estates into a phantom departure highway (device
    // screenshot 2026-07-02).
    const wetConflict = new Uint8Array(width * height);
    // Per-cell "OSM-vouched water" flag: 1 = the protection above came
    // from an OSM-authoritative source (marina/canal/dock/river) or an
    // OSM canal carve — NOT from a chart S-57 DEPARE. Used by Pass 2 to
    // tell apart the two protected cases when a chart LNDARE collides:
    //   • OSM-vouched (Newport canals, Brisbane River LNDARE-bleed) → keep
    //     clean navigable; OSM is the trusted source over chunky LNDARE.
    //   • chart-DEPARE-only (a coarse overview-cell landmask bulging over a
    //     finer-survey deep channel — e.g. Tangalooma Roads off Moreton
    //     Island) → the two chart layers DISAGREE, so flag CAUTION (red)
    //     rather than draw confident clean water over charted land.
    const osmWaterCells = new Uint8Array(width * height);
    // Per-cell "injected nearshore canal water" flag (see NavGrid.injectedCanal).
    // The Mapbox-water DEPARE fill (_source==='mapbox-water') we injected for
    // routing, RESTRICTED (after the LNDARE passes) to cells with charted LAND
    // within MARINA_NEAR_CELLS — i.e. the canal CHANNEL bounded by the marina lots,
    // NOT the open-bay part of the ~4 km crop (land far away). The canal is often
    // charted as a COARSE ENC DEPARE (reads deep ⇒ tier-3), so the discriminator
    // is narrowness/land-proximity, NOT ENC-gap. Bounding it keeps the canal's
    // tier-1 span short (fits the fine length cap, small fine grid). Kept separate
    // from osmWaterCells (broader, drives the LNDARE-conflict logic).
    const injectedCanalCells = new Uint8Array(width * height);
    // Per-cell "hard blocked" flag: 1 = blocked by LNDARE (land) or a
    // point obstruction (OBSTRN / WRECKS / UWTROC). A cell merely
    // blocked by a shallow DEPARE band has hardBlocked = 0. Pass 4
    // (FAIRWY) and Pass 5 (paired channel midpoints) are allowed to
    // RESCUE a shallow-blocked cell back to navigable — a marked
    // channel is navigable water by definition — but must never
    // override a hard-blocked cell (actual land / charted hazard).
    const hardBlocked = new Uint8Array(width * height);
    // LAND-only subset of hardBlocked (LNDARE / coastline / coastal buffer —
    // never point-hazard buffers). See NavGrid.landBlocked.
    const landBlocked = new Uint8Array(width * height);
    const grid: NavGrid = { width, height, minLon, minLat, dLon, dLat, cells, preferred, landBlocked };

    // Capture grid-build setup time separately. Anything north of a
    // few ms here points to wasted re-work (we already pay for this on
    // each call — buildNavGridCached is a separate concern).
    markPass('setup', buildT0, width * height);

    // Localized LNDARE relaxation mask. A cell with relaxMask[idx]===1
    // gets CAUTION instead of BLOCKED in the LNDARE (Pass 2) and
    // coastline (Pass 2b) passes, and is exempt from the Pass 6 buffer —
    // so a far-snapped endpoint can thread the charted-land barrier that
    // islands it, flagged red, while every cell OUTSIDE the zone stays
    // hard-blocked. This is the bounded replacement for the old
    // grid-wide `relaxedLndare` far-snap retry, which let A* cut straight
    // across the mainland. Building the mask is O(cells inside the
    // zones) — a few thousand cells per zone, cheap.
    const relaxMask = new Uint8Array(width * height);
    for (const z of relaxZones) {
        const dLatR = z.radiusM / M_PER_DEG_LAT;
        const dLonR = z.radiusM / mPerLon;
        const zx0 = Math.max(0, Math.floor((z.lon - dLonR - minLon) / dLon));
        const zx1 = Math.min(width - 1, Math.ceil((z.lon + dLonR - minLon) / dLon));
        const zy0 = Math.max(0, Math.floor((z.lat - dLatR - minLat) / dLat));
        const zy1 = Math.min(height - 1, Math.ceil((z.lat + dLatR - minLat) / dLat));
        for (let y = zy0; y <= zy1; y++) {
            const cellLat = minLat + (y + 0.5) * dLat;
            for (let x = zx0; x <= zx1; x++) {
                const cellLon = minLon + (x + 0.5) * dLon;
                if (haversineM(cellLat, cellLon, z.lat, z.lon) > z.radiusM) continue;
                relaxMask[y * width + x] = 1;
            }
        }
    }

    // Helper to convert a polygon bbox to grid coordinate range.
    const polyToCellRange = (
        polyBbox: [number, number, number, number],
    ): { x0: number; x1: number; y0: number; y1: number } => {
        const x0 = Math.max(0, Math.floor((polyBbox[0] - minLon) / dLon));
        const x1 = Math.min(width - 1, Math.ceil((polyBbox[2] - minLon) / dLon));
        const y0 = Math.max(0, Math.floor((polyBbox[1] - minLat) / dLat));
        const y1 = Math.min(height - 1, Math.ceil((polyBbox[3] - minLat) / dLat));
        return { x0, x1, y0, y1 };
    };

    // ── Pass 1: DEPARE — assign depth values + flag authoritative ───
    // Done first so a subsequent LNDARE pass overrides shallow water
    // with land-block on cells where both apply (rare but possible).
    //
    // A DEPARE feature whose source is "authoritative engineered
    // water" (OSM marina basin, dock, canal, landuse=basin) also sets
    // `protectedCells[idx] = 1`. The LNDARE pass below skips those
    // cells — they're real water that the boat needs even if a chunky
    // bathymetry-derived LNDARE polygon happens to cover them. Generic
    // `natural=water` and plain bathymetry-derived DEPARE bands do NOT
    // get protection; if LNDARE says it's land, they get blocked.
    const isAuthoritativeDepare = (props: Record<string, unknown> | null): boolean => {
        if (!props) return false;
        const leisure = props['leisure'];
        // `landuse=basin` and `water=basin` REMOVED from the authoritative
        // whitelist (2026-05-14). Suburban OSM tags inland stormwater
        // retention ponds and drainage basins with these tags; on the
        // Redcliffe Peninsula (Newport→Brisbane bbox) there are dozens
        // of them, each unblocking a phantom 3-4 m DEPARE corridor across
        // land. Real marina basins are tagged `leisure=marina` (kept).
        // Real navigable canals are tagged `waterway=canal` (also kept).
        const waterway = props['waterway'];
        const water = props['water'];
        const natural = props['natural'];
        const harbour = props['harbour'];
        return (
            leisure === 'marina' ||
            waterway === 'dock' ||
            waterway === 'canal' ||
            waterway === 'fairway' ||
            waterway === 'river' ||
            waterway === 'riverbank' ||
            // `water=*` subtags for marina contexts (Newport canals use
            // these for the side arms branching off the main basin)
            water === 'canal' ||
            water === 'harbour' ||
            water === 'marina' ||
            water === 'dock' ||
            water === 'river' ||
            water === 'lake' ||
            // OsmRouteOverlayService injects natural=water polygons into
            // DEPARE for rivers / harbours / basins. They're OSM-derived
            // navigable water — authoritative to override LNDARE-bleed.
            natural === 'water' ||
            harbour === 'yes'
        );
    };
    const depare = layers.DEPARE?.features ?? [];
    const tPassDepare = Date.now();
    for (const f of depare) {
        const g = f.geometry;
        if (g.type !== 'Polygon' && g.type !== 'MultiPolygon') continue;
        const props = f.properties as Record<string, unknown> | null;
        const drval1 = props?.['DRVAL1'];
        // S-57 DRVAL1 is positive depth in meters.
        const drval1Num = typeof drval1 === 'number' ? drval1 : null;
        if (drval1Num == null) continue; // no depth → nothing to do
        // Chart-source DEPARE (acronym='DEPARE' from senc-extractor) is
        // hydrographic-survey data. With the Eulerian ring fix (2026-05-19)
        // these polygons now have proper outer rings — they no longer
        // bleed across the coastline as the triangle-soup did. So trust
        // them to win against LNDARE on overlap (e.g. marina basins where
        // chart has a tiny DEPARE inside a chunky mainland LNDARE).
        // OSM-derived DEPARE (no acronym) still uses the old OSM-tag gate
        // (Scarborough peninsula safeguard).
        const isS57Depare = typeof props?.acronym === 'string';
        // OSM-vouched = authoritative water that is NOT a chart S-57 DEPARE
        // (marina/canal/dock/river injected by OsmRouteOverlayService). These
        // keep clean navigable even under a chunky LNDARE; chart-DEPARE-only
        // protection that collides with chart LNDARE is flagged CAUTION instead.
        const osmVouched = !isS57Depare && isAuthoritativeDepare(props);
        const authoritative = isS57Depare || osmVouched;
        const shallow = drval1Num < draftM + safetyM;
        // INJECTED nearshore canal water we added for routing (Mapbox vector
        // water over the endpoint crops). Tagged regardless of the shallow/deep
        // branch so a deep-draft vessel (where 5 m reads shallow) still marks
        // the canal — it's a canal either way, just caution-flagged if shallow.
        const isMapboxWater = props?.['_source'] === 'mapbox-water';

        // Scanline-rasterize the polygon and apply cell updates inside
        // the per-cell callback. ~25× faster than the old "per cell,
        // pointInGeometry" loop on real DEPARE shapes (50+ vertex
        // bathymetry contours covering 50×50+ cell ranges).
        rasterizePolygonCells(grid, g, (x, y) => {
            const idx = y * width + x;

            // Tag injected Mapbox canal water (both branches) → tier-1 + fine pass.
            // Narrowed to the actual channel after the LNDARE passes (see below).
            if (isMapboxWater) injectedCanalCells[idx] = 1;

            // Record the DEPARE-only verdict (independent of any later LNDARE
            // hard-block), tracking the shallowest real depth or CAUTION — so
            // Pass 4 can restore charted water under LNDARE bleed for a marked
            // channel without fabricating depth.
            const prevV = depareVerdict[idx];
            if (shallow) {
                if (Number.isNaN(prevV)) depareVerdict[idx] = CAUTION;
                // Keep the REAL charted depth the CAUTION sentinel erases
                // (shallowest wins) — the tide-window annotator's requiredRise
                // input. Recorded regardless of protectedCells: the chart's
                // depth claim is true either way, consumers key off cautionMask.
                if (Number.isNaN(shallowDepthM[idx]) || drval1Num < shallowDepthM[idx]) {
                    shallowDepthM[idx] = drval1Num;
                }
            } else if (Number.isNaN(prevV) || prevV === CAUTION || drval1Num < prevV) {
                depareVerdict[idx] = drval1Num;
            }

            if (shallow) {
                // Shallow water — mark CAUTION (soft-block) UNLESS an
                // authoritative engineered-water DEPARE already
                // claimed this cell. Coarse public bathymetry (30 m
                // AusBathyTopo) can't resolve dredged marina basins /
                // canals or shallow tidal approaches: it reads them
                // at the shallow surrounding-terrain depth. CAUTION
                // keeps the cell *navigable* (A* may route through it
                // at a steep cost, the renderer draws it red) instead
                // of hard-BLOCKED — so canal estates and shallow
                // approaches route end-to-end with an honest "verify
                // depth" flag rather than the route snapping
                // kilometres to the nearest surveyed-deep water.
                // protectedCells guard keeps the outcome order-
                // independent: once authoritative water claims a
                // cell, no shallow band downgrades it.
                if (protectedCells[idx] !== 1) {
                    cells[idx] = CAUTION;
                }
                // Wet-at-LAT S-57 cells (DRVAL1 > 0: shallow for this keel but
                // genuinely WATER at chart datum) are recorded in wetChartClaim
                // so Pass 2 can resolve LNDARE-vs-wet-chart-water conflicts
                // (the Mooloolah sealed-river bug, 2026-07-02). Recorded here,
                // ACTED ON only where land paint actually collides: the broad
                // protect-all-wet-shallow knob was tried first and regressed
                // the Tangalooma golden +7.5% / Rivergate caution 3.7× by
                // perturbing the land buffer and centring EDT everywhere — the
                // conflict-scoped form leaves every non-conflict grid
                // byte-identical. Drying bands (DRVAL1 ≤ 0) never claim: where
                // the chart says the bottom dries, land paint keeps authority
                // — the Mooloolaba beach spit stays a spit.
                if (isS57Depare && drval1Num > 0) wetChartClaim[idx] = 1;
            } else {
                // Deep enough for this vessel.
                const prior = cells[idx];
                if (Number.isNaN(prior)) {
                    // Cell hard-blocked by an earlier pass — only an
                    // authoritative DEPARE un-blocks it.
                    if (authoritative) cells[idx] = drval1Num;
                } else if (prior === UNKNOWN_OPEN || prior === CAUTION || drval1Num < prior) {
                    // Upgrade an unknown / caution cell to real depth,
                    // or track the shallowest known real depth.
                    cells[idx] = drval1Num;
                }
                if (authoritative) protectedCells[idx] = 1;
                if (osmVouched) osmWaterCells[idx] = 1;
            }
        });
    }

    markPass('pass1-DEPARE', tPassDepare, depare.length);

    // ── Pass 1b: OSM canal LineStrings — carve navigable corridors ───
    // The inverse of the Pass 2b coastline strip. Each waterway=canal/
    // fairway/dock LineString (a dredged-channel centreline) is
    // Bresenham-rasterised as a 1-cell NAVIGABLE corridor: cells set to
    // a safe depth and flagged protected. Runs BEFORE Pass 2 (LNDARE),
    // Pass 2b (coastline) and Pass 6 (LNDARE buffer) so the protected
    // flag makes all three skip these cells — the corridor survives even
    // where chart LNDARE tessellates the canal banks as land.
    //
    // Newport Marina 2026-05-20: the marina basin polygon (OSM
    // leisure=marina) is captured as authoritative water, but the
    // ~600 m exit channel out to Hays Inlet is a waterway=canal
    // LineString. Without this pass it was dropped, the canal estate
    // was a 349-cell isolated component, and the origin tap snapped 2 km
    // out into Bramble Bay. Carving the channel connects the estate to
    // the bay so the route starts where the user actually tapped.
    const canalFeatures = layers.CANAL?.features ?? [];
    const tPassCanal = Date.now();
    const canalDepth = Math.max(draftM + safetyM, 5.0);
    for (const f of canalFeatures) {
        const g = f.geometry;
        if (!g) continue;
        let lineRings: Position[][] = [];
        if (g.type === 'LineString') lineRings = [(g as LineString).coordinates];
        else if (g.type === 'MultiLineString') lineRings = (g as MultiLineString).coordinates;
        else continue;
        for (const coords of lineRings) {
            for (let i = 0; i < coords.length - 1; i++) {
                const [lon0, lat0] = coords[i];
                const [lon1, lat1] = coords[i + 1];
                const gx0 = Math.floor((lon0 - minLon) / dLon);
                const gy0 = Math.floor((lat0 - minLat) / dLat);
                const gx1 = Math.floor((lon1 - minLon) / dLon);
                const gy1 = Math.floor((lat1 - minLat) / dLat);
                for (const c of bresenhamCells(gx0, gy0, gx1, gy1)) {
                    if (c.x < 0 || c.y < 0 || c.x >= width || c.y >= height) continue;
                    const idx = c.y * width + c.x;
                    // Carve to a safe navigable depth unless an earlier
                    // pass already claimed real (deeper) water here.
                    if (Number.isNaN(cells[idx]) || cells[idx] < 0 || cells[idx] === UNKNOWN_OPEN) {
                        cells[idx] = canalDepth;
                    }
                    protectedCells[idx] = 1;
                    osmWaterCells[idx] = 1; // OSM canal carve — keep clean under LNDARE
                    // NB: deliberately NOT flagged injectedCanal. The OSM carve is a
                    // thin 1-cell centreline that already routes fine and is baked
                    // into the Newport + seaway corpus baselines; only the
                    // WIDE Mapbox-water fill (which reads tier-3 + notnarrow) needs
                    // the tier-1 + forced-fine treatment.
                }
            }
        }
    }
    markPass('pass1b-canal', tPassCanal, canalFeatures.length);

    // ── Pass 2: LNDARE — block land cells, except authoritative water ─
    // Earlier conflict rule was "DEPARE > 0 beats LNDARE", which let
    // ANY DEPARE feature override LNDARE — including bathymetry-derived
    // deep bands that happened to cover the actual peninsula, and
    // misclassified `natural=water` OSM polygons. The route then
    // crossed straight over land (Scarborough peninsula bug).
    //
    // New rule: LNDARE blocks cells unconditionally UNLESS the DEPARE
    // pass flagged them `protectedCells[idx] = 1`. That flag is only
    // set for OSM features tagged `leisure=marina`, `landuse=basin`,
    // `waterway=dock`, or `waterway=canal` — authoritative engineered
    // water that we trust over any chunky LNDARE. Other DEPARE sources
    // (plain `natural=water`, plain bathymetry contours) lose to LNDARE
    // on overlap, which is the safer "stay in the wet" default the
    // user asked for.
    //
    // Trade-off: marinas/canals stay reachable; misclassified inland
    // water polygons stop creating phantom navigable land. The right
    // long-term fix is OSM coastline as LNDARE so the land polygons
    // are accurate sub-10 m instead of 60 m-pixel chunky.
    const lndare = layers.LNDARE?.features ?? [];
    const tPassLndare = Date.now();
    for (const f of lndare) {
        const g = f.geometry;
        if (g.type !== 'Polygon' && g.type !== 'MultiPolygon') continue;
        // NO rogue filter on LNDARE: real chart-source LNDARE for narrow
        // land features (Redcliffe peninsula, river banks) naturally has
        // long-edge fan triangles that LOOK rogue but are correctly
        // covering the elongated polygon. Filtering them leaves big gaps
        // (peninsula's rcid 4500 had 49% of its 3146 triangles flagged as
        // rogue by edge/aspect heuristics) and A* threads through. Better
        // to over-block (LNDARE bleeds across rivers → some water shows
        // as land) and rely on S-57 DEPARE authoritative override in
        // pass 1 to un-block actual surveyed water.
        rasterizePolygonCells(grid, g, (x, y) => {
            const idx = y * width + x;
            if (protectedCells[idx]) {
                // This cell was claimed as deep water by a DEPARE pass, yet a
                // chart LNDARE polygon also covers it. Two sub-cases:
                //   • OSM-vouched water (Newport canals, Brisbane River
                //     LNDARE-bleed) → trust OSM, keep clean navigable.
                //   • chart-S57-DEPARE only → the chart's own DEPARE and
                //     LNDARE layers DISAGREE here (typically a coarse
                //     overview-cell landmask bulging over a finer-survey deep
                //     channel — Tangalooma Roads off Moreton Island). Don't
                //     present confident clean water over charted land:
                //     downgrade to CAUTION so the renderer flags it red and
                //     A* only crosses it absent an all-water alternative.
                //     hardBlocked stays 0 so the route can still reach a
                //     destination that genuinely sits in such a conflict zone.
                if (osmWaterCells[idx] !== 1 && cells[idx] >= 0) {
                    cells[idx] = CAUTION;
                }
                return;
            }
            if (wetChartClaim[idx] === 1) {
                // LNDARE-vs-WET-chart-water conflict — the shallow sibling of
                // the deep conflict above, same doctrine: the chart's own
                // layers disagree (typically a coarse overview-cell landmask
                // bulging over a finer cell's charted river — 1:90k paints the
                // whole Mooloolah wharf→bar mile as coastline over the harbour
                // cell's D2-5). Keep the honest CAUTION the DEPARE pass set
                // (red, 40×, tide-chipped) instead of erasing charted water,
                // and protect it so the coastline strip and the Pass-6 land
                // buffer can't seal the 2-cell-wide river shut — without this,
                // routes out of Mooloolaba exited over the drying beach spit
                // at 120× because the charted front door didn't exist in the
                // grid. Conflict-scoped ON PURPOSE: protecting ALL wet-shallow
                // chart water regressed the Tangalooma golden +7.5% and
                // Rivergate caution 3.7× by perturbing the buffer and centring
                // EDT everywhere; this branch leaves every non-conflict grid
                // byte-identical. Fixture: tests/engine/wetChartProtection.
                protectedCells[idx] = 1;
                wetConflict[idx] = 1;
                return;
            }
            if (relaxedLndare || relaxMask[idx] === 1) {
                // CAUTION-mode: A* can traverse at 500× cost. Don't set
                // hardBlocked so FAIRWY/DRGARE rescue still applies.
                if (cells[idx] === UNKNOWN_OPEN) cells[idx] = CAUTION;
            } else {
                cells[idx] = BLOCKED;
                hardBlocked[idx] = 1;
                landBlocked[idx] = 1;
            }
        });
    }

    markPass('pass2-LNDARE', tPassLndare, lndare.length);

    // ── Pass 2b: OSM coastline (lines) — block the thin land/water boundary ─
    // Rasterises each natural=coastline LineString with Bresenham so cells
    // touched by the coast boundary are hardBlocked. Plugs gaps in chart
    // LNDARE polygons — Newport canal-estate islands have working chart
    // LNDARE for the suburb perimeter but no polygon for the small island
    // between the marina canal and Bramble Bay, so A* threaded straight
    // from the canal exit NE to the bay across "navigable" cells. With
    // the coastline strip blocked, the Bresenham line-of-sight check in
    // smoothPath now sees those cells as blocked and forces A* through
    // the actual canal/bay corridor.
    //
    // Same `protectedCells` guard as Pass 2 so engineered water
    // (leisure=marina, waterway=dock/canal) stays passable across a
    // coastline alignment mistake. Same relaxedLndare bypass so the
    // disconnected-destination retry isn't choked by coastline gaps.
    const coastline = layers.COASTLINE?.features ?? [];
    const tPassCoast = Date.now();
    let coastCellsBlocked = 0;
    for (const f of coastline) {
        const g = f.geometry;
        if (!g) continue;
        let lineRings: Position[][] = [];
        if (g.type === 'LineString') lineRings = [(g as LineString).coordinates];
        else if (g.type === 'MultiLineString') lineRings = (g as MultiLineString).coordinates;
        else continue;
        for (const coords of lineRings) {
            for (let i = 0; i < coords.length - 1; i++) {
                const [lon0, lat0] = coords[i];
                const [lon1, lat1] = coords[i + 1];
                const gx0 = Math.floor((lon0 - minLon) / dLon);
                const gy0 = Math.floor((lat0 - minLat) / dLat);
                const gx1 = Math.floor((lon1 - minLon) / dLon);
                const gy1 = Math.floor((lat1 - minLat) / dLat);
                for (const c of bresenhamCells(gx0, gy0, gx1, gy1)) {
                    if (c.x < 0 || c.y < 0 || c.x >= width || c.y >= height) continue;
                    const idx = c.y * width + c.x;
                    if (protectedCells[idx]) continue;
                    if (relaxedLndare || relaxMask[idx] === 1) {
                        if (cells[idx] === UNKNOWN_OPEN) cells[idx] = CAUTION;
                    } else {
                        cells[idx] = BLOCKED;
                        hardBlocked[idx] = 1;
                        landBlocked[idx] = 1;
                        coastCellsBlocked++;
                    }
                }
            }
        }
    }
    markPass('pass2b-coastline', tPassCoast, coastline.length);

    // ── Pass 2c: OSM marina berth rows (finger pontoons) — hard-block ─
    // man_made=pier/pontoon + floating=yes (layers.BERTH). Unlike Pass 2/2b
    // these IGNORE the protectedCells guard: a pontoon is a physical
    // structure even inside marina-authoritative water, and carving it is the
    // whole point — the marina leg then rides the fairway between berth rows
    // instead of the geometric centre of the basin (which drove over the
    // pens, Mooloolaba 2026-07-05).
    //
    // FINE RESOLUTION ONLY. At the coarse 50 m grid the finger rows (~15-30 m
    // apart) collapse into one solid block that would SEAL the basin and
    // disconnect the route; so the coarse grid keeps reading the marina as a
    // single navigable blob for the approach, and only the fine marina grid
    // (routeMarina, ~12 m) carves the lanes. If a too-aggressive carve ever
    // disconnects the fine leg, routeMarina returns null → the span falls back
    // to today's coarse slice, so this can only improve a marina, never break
    // a route.
    const cellSizeM = dLat * M_PER_DEG_LAT;
    const berthFeatures = layers.BERTH?.features ?? [];
    const tPassBerth = Date.now();
    let berthCellsBlocked = 0;
    if (cellSizeM < 20 && berthFeatures.length > 0) {
        const blockBerthCell = (x: number, y: number): void => {
            if (x < 0 || y < 0 || x >= width || y >= height) return;
            const idx = y * width + x;
            cells[idx] = BLOCKED;
            hardBlocked[idx] = 1;
            landBlocked[idx] = 1;
            berthCellsBlocked++;
        };
        for (const f of berthFeatures) {
            const g = f.geometry;
            if (!g) continue;
            if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
                rasterizePolygonCells(grid, g, (x, y) => blockBerthCell(x, y));
            } else if (g.type === 'LineString' || g.type === 'MultiLineString') {
                const lineRings: Position[][] =
                    g.type === 'LineString' ? [(g as LineString).coordinates] : (g as MultiLineString).coordinates;
                for (const coords of lineRings) {
                    for (let i = 0; i < coords.length - 1; i++) {
                        const gx0 = Math.floor((coords[i][0] - minLon) / dLon);
                        const gy0 = Math.floor((coords[i][1] - minLat) / dLat);
                        const gx1 = Math.floor((coords[i + 1][0] - minLon) / dLon);
                        const gy1 = Math.floor((coords[i + 1][1] - minLat) / dLat);
                        for (const c of bresenhamCells(gx0, gy0, gx1, gy1)) blockBerthCell(c.x, c.y);
                    }
                }
            }
        }
    }
    markPass('pass2c-berth', tPassBerth, berthCellsBlocked);

    // ── Pass 3: point obstructions — block radius around each ──────
    // obstnBlocked marks every cell a hazard (OBSTRN/WRECKS/UWTROC) claimed,
    // INDEPENDENTLY of landBlocked — the land-conflict reopens (NTM survey
    // zones, chart transits) key off "landBlocked ∧ DEPARE claim" and must
    // never resurrect a cell that is ALSO a wreck buffer just because land
    // paint and a depth band overlap it too (adversarial-review finding #7).
    const obstnBlocked = new Uint8Array(width * height);
    const blockPointBuffer = (lat: number, lon: number): void => {
        const dLatBuf = obstructionBufferM / M_PER_DEG_LAT;
        const dLonBuf = obstructionBufferM / mPerLon;
        const x0 = Math.max(0, Math.floor((lon - dLonBuf - minLon) / dLon));
        const x1 = Math.min(width - 1, Math.ceil((lon + dLonBuf - minLon) / dLon));
        const y0 = Math.max(0, Math.floor((lat - dLatBuf - minLat) / dLat));
        const y1 = Math.min(height - 1, Math.ceil((lat + dLatBuf - minLat) / dLat));
        for (let y = y0; y <= y1; y++) {
            const cellLat = minLat + (y + 0.5) * dLat;
            for (let x = x0; x <= x1; x++) {
                const cellLon = minLon + (x + 0.5) * dLon;
                const dM = haversineM(cellLat, cellLon, lat, lon);
                if (dM <= obstructionBufferM) {
                    cells[y * width + x] = BLOCKED;
                    hardBlocked[y * width + x] = 1;
                    obstnBlocked[y * width + x] = 1;
                }
            }
        }
    };

    const handlePointFeature = (f: Feature): void => {
        if (!f.geometry) return;
        // Pair-wings (Step 4.5, masterplan Phase 3) travel in OBSTRN but are
        // NOT obstructions: Pass 5c rasterises them to CAUTION + preferred=0.
        // Hard-blocking them here would turn a mispair into no-path instead
        // of a red wiggle.
        if ((f.properties as { _class?: string } | null)?._class === 'pair-wing') return;
        // Low-clearance structures (a fixed bridge the vessel's air draft
        // can't make — injected by the orchestrator when airDraft exceeds the
        // curated clearance). LAND for this vessel: blocked + hardBlocked +
        // clearanceBarred, and the barred flag makes every rescue/carve pass
        // (chart FAIRWY/DRGARE keys-back, component bridge carve, endpoint
        // carve) refuse to tunnel it.
        const isClearanceBar = (f.properties as { _class?: string } | null)?._class === 'low-clearance';
        if (f.geometry.type === 'Point') {
            const [lon, lat] = (f.geometry as Point).coordinates;
            blockPointBuffer(lat, lon);
        } else if (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon') {
            // For polygon obstructions, treat the polygon area itself as blocked.
            rasterizePolygonCells(grid, f.geometry as Polygon | MultiPolygon, (x, y) => {
                const idx = y * width + x;
                cells[idx] = BLOCKED;
                hardBlocked[idx] = 1;
                obstnBlocked[idx] = 1;
                if (isClearanceBar) clearanceBarred[idx] = 1;
            });
        }
    };

    const tPassPoints = Date.now();
    const obstrnFeatures = layers.OBSTRN?.features ?? [];
    const wrecksFeatures = layers.WRECKS?.features ?? [];
    const uwtrocFeatures = layers.UWTROC?.features ?? [];
    for (const f of obstrnFeatures) handlePointFeature(f);
    for (const f of wrecksFeatures) handlePointFeature(f);
    for (const f of uwtrocFeatures) handlePointFeature(f);
    markPass('pass3-points', tPassPoints, obstrnFeatures.length + wrecksFeatures.length + uwtrocFeatures.length);

    // ── Pass 4: FAIRWY + DRGARE — mark preferred channel cells ─────
    // We don't change the navigability of these cells (a navigable cell
    // stays navigable, a blocked cell stays blocked — fairways CAN
    // overlap with shallow flats at low tide, and the chart's DEPARE
    // pass is the authoritative source for "is there enough depth").
    // We just flag cells that fall inside a marked channel so the A*
    // cost function can prefer them.
    let ribbonUnblockedCells = 0; // synthetic mark-ribbon cells un-blocked from LNDARE bleed (DEPARE-vouched)
    const markChannelPreference = (f: Feature): void => {
        if (!f.geometry || (f.geometry.type !== 'Polygon' && f.geometry.type !== 'MultiPolygon')) return;
        const g = f.geometry as Polygon | MultiPolygon;
        const rescueDepth = Math.max(draftM + safetyM, 5.0);
        // S-57 charted features carry an `acronym` property (e.g. 'DRGARE',
        // 'FAIRWY') set by senc-extractor's geojsonEmitter. OSM-derived
        // mock channels don't. A chart-authoritative dredged area or
        // fairway is *surveyed navigable water* — when it overlaps an
        // LNDARE polygon (which happens on real ENC charts because the
        // SENC's GLU-tessellated LNDARE primitives can span across
        // river concavities), the DRGARE/FAIRWY is the truth.
        //
        // This is the inverse of the 2026-05-14 Scarborough peninsula
        // fix: that fix locked LNDARE down so bathymetry-derived DEPARE
        // couldn't unblock real land. Chart DRGARE/FAIRWY are a different
        // signal class — they exist because a harbour authority surveyed
        // and dredged the channel, so they get the keys back. OSM-derived
        // channel features (no `acronym`) still respect LNDARE's hard-block.
        //
        // EXTENSION (2026-05-19): OSM water polygons tagged `water=river`
        // or `harbour=yes` and wider than ~200 m are promoted to this
        // chart-authoritative class via `_promotePreferred` set in
        // InshoreRouter.ts. Without this, the Brisbane River shipping
        // channel cells (which sit inside an over-bleeding mainland
        // LNDARE polygon on the AU SENC) couldn't be rescued by their
        // own OSM water tag, and A* would route through Bramble Bay
        // shallows instead of along the river. The promotion is gated
        // on tag + minimum width to keep suburban ponds out.
        const props = f.properties as Record<string, unknown> | null;
        const isChartAuthoritative = typeof props?.acronym === 'string' || props?._promotePreferred === true;
        // The synthetic lateral-mark ribbon (chain-ordered port/starboard
        // midpoints from InshoreRouter Step 5). NOT a surveyed chart fairway,
        // so it must not fabricate depth. But where it overlaps cells the
        // chart's OWN DEPARE calls water, it restores that verdict to un-block
        // LNDARE *bleed* (the AU SENC blocks the bay channel under a coastal
        // land polygon) — the offline equivalent of a charted fairway. Cells
        // with no DEPARE coverage are real land and stay blocked.
        const isMarkRibbon = props?._class === 'synthetic-channel-segment';
        rasterizePolygonCells(grid, g, (x, y) => {
            const idx = y * width + x;
            // A low-clearance bar (fixed bridge) is impassable for this vessel
            // — not even a chart-authoritative FAIRWY/DRGARE gets the keys back.
            if (clearanceBarred[idx] === 1) return;
            preferred[idx] = 1;
            const blockedOrShallow = Number.isNaN(cells[idx]) || cells[idx] < 0;
            if (!blockedOrShallow) return;
            if (isMarkRibbon) {
                // Restore the chart's DEPARE verdict (real depth, or CAUTION
                // if genuinely shallow) ONLY where LNDARE bleed hard-blocked
                // charted water. No DEPARE here → real land → leave blocked.
                // Honest: a shallow marked channel stays CAUTION (red), it is
                // never fabricated into deep water.
                const v = depareVerdict[idx];
                if (hardBlocked[idx] === 1 && !Number.isNaN(v)) {
                    cells[idx] = v;
                    ribbonUnblockedCells++;
                }
                return;
            }
            // Chart DRGARE/FAIRWY rescues hard-blocked cells too —
            // LNDARE polygons on ENC charts span river concavities, and
            // the dredged-channel polygon is the authoritative "this is
            // navigable" overlay. OSM channels still respect hardBlocked.
            if (hardBlocked[idx] === 1 && !isChartAuthoritative) return;
            cells[idx] = rescueDepth;
        });
    };
    const tPassFairwy = Date.now();
    const fairwyFeatures = layers.FAIRWY?.features ?? [];
    const drgareFeatures = layers.DRGARE?.features ?? [];
    for (const f of fairwyFeatures) markChannelPreference(f);
    for (const f of drgareFeatures) markChannelPreference(f);
    markPass('pass4-FAIRWY+DRGARE', tPassFairwy, fairwyFeatures.length + drgareFeatures.length);
    if (ENGINE_DEBUG)
        engineLog.warn(
            `pass4: lateral-mark ribbon un-blocked ${ribbonUnblockedCells} LNDARE-bleed cells (DEPARE-vouched, honest depth)`,
        );

    // ── Pass 5: Lateral markers → preferred-cell radius ─────────────
    // When the iOS side pairs port+starboard markers and emits the
    // midpoint as a BOYLAT Point with `_pairDistanceM` on it, we use
    // that distance to size the preferred radius — capping it at
    // half the pair distance so the preferred zone never extends
    // past either marker. Without this cap a 80 m radius around a
    // midpoint of a narrow (e.g. 100 m) pair leaks 30 m past the
    // marker on the shore side, and A* threads the route on the
    // wrong side of the green marker. User flagged this at the
    // Scarborough peninsula bend on 2026-05-12.
    //
    // For markers without `_pairDistanceM` (raw beacons / buoys
    // outside the paired pipeline), we fall back to the default
    // 80 m radius — those are best-effort hints, not pair midpoints.
    const MARKER_CHANNEL_RADIUS_DEFAULT_M = 80;
    const MARKER_CHANNEL_RADIUS_MIN_M = 15;
    const MARKER_CHANNEL_PAIR_MARGIN_M = 5;
    const markMarkerRadius = (f: Feature): void => {
        if (!f.geometry || f.geometry.type !== 'Point') return;
        const [lon, lat] = (f.geometry as Point).coordinates;

        const pairDistM = (f.properties as { _pairDistanceM?: number } | null)?._pairDistanceM;

        // Only the iOS-paired channel midpoints (which carry
        // `_pairDistanceM`) generate preferred-cell zones. Pack-level
        // BOYLAT/BCNLAT features (from OSM seamarks via the pack
        // generator) get NO preferred zone. Why:
        //
        //   • A paired midpoint really IS a channel — the boat passes
        //     between two markers, so attracting A* to the area
        //     between them is correct.
        //   • A pack-level OSM beacon_lateral is a single point on a
        //     real chart. It might be a paired channel marker OR a
        //     SOLO reef-edge marker (Scarborough Reef beacon is the
        //     canonical example, confirmed via Navionics 2026-05-13).
        //     If it's solo, the 80 m preferred radius around the
        //     marker becomes an *attractor* drawing A* right onto the
        //     reef instead of pushing it seaward. We can't tell from
        //     the pack data alone which it is, so we treat ALL pack-
        //     level laterals as no-op rather than as attractors.
        //
        // Cost of being wrong: if a real channel pair exists in the
        // pack data without an iOS-side pairing record, A* won't see
        // it as preferred. That's fine — A* still routes through deep
        // water, just without an explicit channel bias.
        if (typeof pairDistM !== 'number' || pairDistM <= 0) {
            return;
        }
        const radius = Math.max(
            MARKER_CHANNEL_RADIUS_MIN_M,
            Math.min(MARKER_CHANNEL_RADIUS_DEFAULT_M, pairDistM / 2 - MARKER_CHANNEL_PAIR_MARGIN_M),
        );

        const dLatBuf = radius / M_PER_DEG_LAT;
        const dLonBuf = radius / mPerLon;
        const x0 = Math.max(0, Math.floor((lon - dLonBuf - minLon) / dLon));
        const x1 = Math.min(width - 1, Math.ceil((lon + dLonBuf - minLon) / dLon));
        const y0 = Math.max(0, Math.floor((lat - dLatBuf - minLat) / dLat));
        const y1 = Math.min(height - 1, Math.ceil((lat + dLatBuf - minLat) / dLat));
        for (let y = y0; y <= y1; y++) {
            const cellLat = minLat + (y + 0.5) * dLat;
            for (let x = x0; x <= x1; x++) {
                const cellLon = minLon + (x + 0.5) * dLon;
                const dM = haversineM(cellLat, cellLon, lat, lon);
                if (dM <= radius) {
                    const idx = y * width + x;
                    preferred[idx] = 1;
                    // Rescue shallow-blocked cells inside a paired
                    // channel midpoint zone — same rationale as the
                    // FAIRWY pass: the boat passes between the two
                    // markers, so this is navigable channel water even
                    // where coarse bathymetry reads it shallow. Never
                    // override a hard-blocked cell (LNDARE / hazard).
                    if ((Number.isNaN(cells[idx]) || cells[idx] < 0) && hardBlocked[idx] !== 1) {
                        // Rescue a hard-blocked OR caution-marked cell to
                        // real navigable depth — the marked channel is
                        // authoritative over both a shallow bathymetry
                        // reading and a coastline-buffer over-reach.
                        cells[idx] = Math.max(draftM + safetyM, 5.0);
                    }
                }
            }
        }
    };
    const tPassMarkers = Date.now();
    const boylatFeatures = layers.BOYLAT?.features ?? [];
    const bcnlatFeatures = layers.BCNLAT?.features ?? [];
    for (const f of boylatFeatures) markMarkerRadius(f);
    for (const f of bcnlatFeatures) markMarkerRadius(f);
    markPass('pass5-markers', tPassMarkers, boylatFeatures.length + bcnlatFeatures.length);

    // ── Pass 5b: OSM navigation lines → preferred channel corridor ───
    // Charted leading/transit lines (seamark navigation_line) are the
    // dredged-channel centreline ships steer along. Bresenham-rasterise
    // each into a ~3-cell-wide PREFERRED corridor and rescue shallow
    // (CAUTION) / unknown cells along it to navigable depth — so A* is
    // attracted onto the marked channel AND can ride it through bars the
    // 30 m bathymetry reads as too shallow. Never touches hardBlocked
    // (real land / charted hazard) cells. Runs after Pass 2 (LNDARE, so
    // hardBlocked is set) and before Pass 6 (buffer skips preferred cells,
    // so the corridor isn't sealed). The Brisbane River mouth bar is the
    // canonical case: the dredged cut isn't in chart FAIRWY and the
    // lateral markers are too sparse to stitch, but OSM has it as
    // navigation_line — without this the route cut a red CAUTION diagonal
    // straight across the bar instead of riding the channel.
    const navlineFeatures = layers.NAVLINE?.features ?? [];
    const tPassNavline = Date.now();
    const navDepth = Math.max(draftM + safetyM, 5.0);
    const NAVLINE_BRUSH_CELLS = 1; // 1-cell Chebyshev radius → ~3-cell (≈150 m) wide corridor
    let navlineCellsMarked = 0;
    let transitReopened = 0;
    const stampNavlineCell = (cx: number, cy: number, chartTransit: boolean): void => {
        for (let dy = -NAVLINE_BRUSH_CELLS; dy <= NAVLINE_BRUSH_CELLS; dy++) {
            for (let dx = -NAVLINE_BRUSH_CELLS; dx <= NAVLINE_BRUSH_CELLS; dx++) {
                const nx = cx + dx;
                const ny = cy + dy;
                if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                const idx = ny * width + nx;
                if (hardBlocked[idx] === 1) {
                    // OSM/community navigation lines never carve blocked cells
                    // (the Dart Harbour community-edit lesson). A CHART transit
                    // (S-57 NAVLNE, acronym-gated — the hydrographer's own
                    // leading line) resolves the familiar LNDARE-vs-charted-
                    // water conflict: the 1:90k landmask paints the Tangalooma
                    // sand bar over the same chart's (0-2 m) band AND its own
                    // 072.5°/031° dog-leg transit through it — the official
                    // "line up the leads" approach (IALA pilotage). Land paint
                    // loses to the transit ONLY where a DEPARE band claims the
                    // cell; DEPARE-less real land, obstructions/wrecks (no
                    // landBlocked) and air-draft bridge bars stay shut.
                    const landConflict =
                        chartTransit &&
                        landBlocked[idx] === 1 &&
                        clearanceBarred[idx] !== 1 &&
                        obstnBlocked[idx] !== 1 && // a wreck under land paint stays a wreck
                        !Number.isNaN(depareVerdict[idx]);
                    if (!landConflict) continue;
                    hardBlocked[idx] = 0;
                    landBlocked[idx] = 0;
                    cells[idx] = CAUTION; // rescued below like any corridor cell
                    protectedCells[idx] = 1; // Pass 6 must not re-seal the transit
                    transitReopened++;
                }
                preferred[idx] = 1; // attract A* onto the marked channel
                if (cells[idx] < 0 || cells[idx] === UNKNOWN_OPEN) {
                    // Rescue a shallow-reading (CAUTION) or unknown cell on
                    // the charted channel to navigable — the leading line
                    // IS the dredged deep water.
                    cells[idx] = navDepth;
                    navlineCellsMarked++;
                }
            }
        }
    };
    for (const f of navlineFeatures) {
        const g = f.geometry;
        if (!g) continue;
        // Chart S-57 NAVLNE carries the extractor's acronym; OSM seamark
        // navigation lines don't. Only the chart transit may reopen land
        // conflicts above.
        const chartTransit = (f.properties as { acronym?: string } | null)?.acronym === 'NAVLNE';
        let lineRings: Position[][] = [];
        if (g.type === 'LineString') lineRings = [(g as LineString).coordinates];
        else if (g.type === 'MultiLineString') lineRings = (g as MultiLineString).coordinates;
        else continue;
        for (const coords of lineRings) {
            for (let i = 0; i < coords.length - 1; i++) {
                const [lon0, lat0] = coords[i];
                const [lon1, lat1] = coords[i + 1];
                const gx0 = Math.floor((lon0 - minLon) / dLon);
                const gy0 = Math.floor((lat0 - minLat) / dLat);
                const gx1 = Math.floor((lon1 - minLon) / dLon);
                const gy1 = Math.floor((lat1 - minLat) / dLat);
                for (const c of bresenhamCells(gx0, gy0, gx1, gy1)) {
                    stampNavlineCell(c.x, c.y, chartTransit);
                }
            }
        }
    }
    markPass('pass5b-navline', tPassNavline, navlineFeatures.length);
    if (ENGINE_DEBUG && navlineFeatures.length > 0) {
        console.warn(
            `[inshoreEngine] NAVLINE: ${navlineFeatures.length} navigation lines → ${navlineCellsMarked} channel cells rescued/preferred${transitReopened > 0 ? ` (${transitReopened} land-conflict cells reopened by chart transits)` : ''}`,
        );
    }

    // ── Pass 5c: pair-wings → outboard CAUTION ──────────────────────
    // Masterplan §3 Phase 3. Each accepted port/stbd pair carries two
    // `_class:'pair-wing'` rectangles extending OUTBOARD from its marks
    // (Step 4.5 in InshoreRouter; geometry in services/pairWings.ts —
    // matches the scorecard's audit wings). Rasterised to CAUTION +
    // preferred=0 so passing outside a mark costs 500× — the cost-level
    // encoding of "the gate is BETWEEN the marks".
    //
    // Ordering is load-bearing: AFTER Pass 5 marker radii and Pass 5b's
    // ribbon/navline rescue, so neither can re-clean a wing cell on
    // channels narrower than ~2× the preferred radius. Never touches
    // hardBlocked or NaN cells (a mispaired wing must degrade the route
    // to a red wiggle, not carve land or create no-path).
    const tPassWings = Date.now();
    let wingCellsMarked = 0;
    let wingFeatureCount = 0;
    for (const f of layers.OBSTRN?.features ?? []) {
        const props = f.properties as { _class?: string; _spine?: [number, number][] } | null;
        if (props?._class !== 'pair-wing') continue;
        const spine = props._spine;
        if (!spine || spine.length < 2) continue;
        wingFeatureCount++;
        // Stamp the wing's SPINE via Bresenham — the 30 m-wide polygon can
        // straddle zero cell centres on a 50–100 m grid, so the spine is the
        // rasterisation contract (same reasoning as the NAVLINE pass). But
        // only poison cells whose CENTRE is strictly OUTBOARD of the mark:
        // Bresenham's first cell contains the mark itself, and at 100 m
        // resolution that cell is often the gate's edge — stamping it
        // caution-stripes the very gate the wing exists to protect.
        const [markLon, markLat] = spine[0];
        const [endLon, endLat] = spine[spine.length - 1];
        const mPerLonW = M_PER_DEG_LAT * Math.cos((markLat * Math.PI) / 180);
        const wx = (endLon - markLon) * mPerLonW;
        const wy = (endLat - markLat) * M_PER_DEG_LAT;
        const wLen = Math.hypot(wx, wy);
        if (wLen < 1) continue;
        const uxW = wx / wLen;
        const uyW = wy / wLen;
        const gx0 = Math.floor((markLon - minLon) / dLon);
        const gy0 = Math.floor((markLat - minLat) / dLat);
        const gx1 = Math.floor((endLon - minLon) / dLon);
        const gy1 = Math.floor((endLat - minLat) / dLat);
        for (const c of bresenhamCells(gx0, gy0, gx1, gy1)) {
            if (c.x < 0 || c.y < 0 || c.x >= width || c.y >= height) continue;
            const idx = c.y * width + c.x;
            if (hardBlocked[idx] === 1 || Number.isNaN(cells[idx])) continue; // never touch land/blocked
            // Outboard test: project the cell CENTRE onto the wing axis.
            const cLon = minLon + (c.x + 0.5) * dLon;
            const cLat = minLat + (c.y + 0.5) * dLat;
            const s = (cLon - markLon) * mPerLonW * uxW + (cLat - markLat) * M_PER_DEG_LAT * uyW;
            if (s <= 0) continue; // centre inboard of (or at) the mark — the gate's own cell
            if (cells[idx] === CAUTION && preferred[idx] === 0) continue; // already stamped
            cells[idx] = CAUTION;
            preferred[idx] = 0;
            wingCellsMarked++;
        }
    }
    markPass('pass5c-wings', tPassWings, wingFeatureCount);
    if (ENGINE_DEBUG && wingFeatureCount > 0) {
        engineLog.warn(`pass5c: ${wingFeatureCount} pair-wings → ${wingCellsMarked} outboard CAUTION cells`);
    }

    // ── Pass 6: LNDARE 1-cell buffer ─────────────────────────────────
    // ── NTM pass: Notice-to-Mariners surveyed-depth overrides ─────────
    // Acknowledged + current notice survey zones (services/ntmRouting.ts)
    // stamp their surveyed least depth over whatever the chart said — a
    // days-old hydrographic survey outranks the ENC edition in BOTH
    // directions (the Mooloolah entrance: ENC says drying −1.6 where the
    // 1 Jul survey says 1.4–2.5 m; the same survey says 1.4 m where the
    // ENC's band claims 2–5 m). Ordering is load-bearing:
    //   • AFTER LNDARE/coastline/obstruction/wing passes — a survey zone
    //     NEVER carves land or a hard block; if the hand-transcribed polygon
    //     clips a breakwater, the breakwater wins. Within a zone the survey
    //     overwrites synthetic wings (real survey beats derived caution).
    //   • BEFORE the Pass-6 land buffer, with stamped cells PROTECTED — the
    //     survey is authoritative water evidence, so a surveyed entrance
    //     channel a cell or two wide (the Mooloolah mouth: ~120 m between
    //     breakwaters ≈ 2 cells) must not be buffered shut like anonymous
    //     caution water. Without the pack the buffer behaves exactly as
    //     before.
    //   • BEFORE the tideAssist mask, which then reads the OVERRIDDEN
    //     shallowDepthM — assist eligibility follows the survey.
    // Sub-floor cells stay CAUTION (red, tide-chipped); ntmRiseM records the
    // survey's requiredRise so cellCostMultiplier grades the caution price —
    // the router prefers the deepest surveyed water without any zone ever
    // being "preferred" (doctrine: survey data changes DEPTH, not preference).
    {
        const ntmZones = (layers.NTMZONE?.features ?? []).filter((f) => {
            const p = f.properties as { _class?: string; depthM?: number } | null;
            const g = f.geometry;
            return (
                p?._class === 'ntm-survey' &&
                typeof p.depthM === 'number' &&
                p.depthM > 0 && // a drying survey is never injected as water
                !!g &&
                (g.type === 'Polygon' || g.type === 'MultiPolygon')
            );
        });
        if (ntmZones.length > 0) {
            const tPassNtm = Date.now();
            const floorM = draftM + safetyM;
            // Lazy: a big-corridor grid is ~10 MB of Float32 for a handful of
            // stamped cells — only allocate once a zone actually stamps.
            let ntmRiseM: Float32Array | null = null;
            const riseArr = (): Float32Array => (ntmRiseM ??= new Float32Array(width * height).fill(Number.NaN));
            let stamped = 0;
            let reopened = 0;
            // Stamp in array order — the pack lists its deepest/most-specific
            // corridor LAST so overlaps resolve to the corridor's depth.
            for (const f of ntmZones) {
                const depthM = (f.properties as { depthM: number }).depthM;
                rasterizePolygonCells(grid, f.geometry as Polygon | MultiPolygon, (x, y) => {
                    const idx = y * width + x;
                    if (hardBlocked[idx] === 1 || Number.isNaN(cells[idx])) {
                        // The LNDARE-vs-DEPARE conflict class, resolved by the
                        // survey: an overview-band cell's GENERALISED land paint
                        // (1:90k draws the Mooloolah entrance as coastline)
                        // survives scale-shadow because the landmass polygon is
                        // never fully inside the fine cell's bbox — and Pass 2
                        // blocks the harbour cell's own D2-5 water under it. If
                        // a finer chart claimed ANY depth here (depareVerdict)
                        // and MSQ surveyed water here LAST WEEK, land paint
                        // loses. Reopen is land-conflict ONLY: obstructions and
                        // wrecks (hardBlocked without landBlocked) and air-draft
                        // bridge bars (clearanceBarred) can never reopen, and a
                        // DEPARE-less breakwater stays land.
                        const landConflict =
                            landBlocked[idx] === 1 &&
                            clearanceBarred[idx] !== 1 &&
                            obstnBlocked[idx] !== 1 && // a wreck under land paint stays a wreck
                            !Number.isNaN(depareVerdict[idx]);
                        if (!landConflict) return;
                        hardBlocked[idx] = 0;
                        landBlocked[idx] = 0;
                        reopened++;
                    }
                    shallowDepthM[idx] = depthM;
                    protectedCells[idx] = 1; // survey = authoritative water evidence
                    if (depthM >= floorM) {
                        cells[idx] = depthM;
                        // rise 0 (NOT NaN): "surveyed, no tide needed". The cost
                        // fn's preferred short-circuit treats 0 like NaN (flat
                        // 1.0×), but the keelMargin sampler can now tell a
                        // deep-STAMPED cell from an unstamped one — without
                        // this it fell back to the superseded chart edition
                        // under deep zone cells (review finding #3).
                        riseArr()[idx] = 0;
                    } else {
                        cells[idx] = CAUTION;
                        riseArr()[idx] = floorM - depthM;
                    }
                    stamped++;
                });
            }
            if (ntmRiseM) grid.ntmRiseM = ntmRiseM;
            markPass('passNTM-survey-override', tPassNtm, ntmZones.length);
            engineLog.warn(
                `[ntmRouting] NTM pass stamped ${stamped} cell(s) from ${ntmZones.length} survey zone(s)${reopened > 0 ? ` (${reopened} land-conflict cell(s) reopened by the survey)` : ''}`,
            );
        }
    }

    // The scanline rasterizer marks cells whose centre is inside an
    // LNDARE polygon. Cells along the polygon boundary whose centre is
    // OUTSIDE but pixels overlap stay navigable — A* can then thread a
    // 50m water sliver hugging the coastline that visually looks like
    // crossing land (verified on AU OC-61-10ENB5 Newport → Pinkenba
    // 2026-05-19). Add a 1-cell skin so cells adjacent to any LNDARE-
    // blocked cell are also blocked.
    //
    // Runs LAST so `preferred` flags from FAIRWY/DRGARE (pass 4) and
    // marker-pair midpoints (pass 5) are already set — those cells are
    // skipped to keep charted channels open. Also skips real-depth cells
    // (chart DEPARE claimed them as deep water). Skipped entirely in
    // relaxedLndare mode where the whole point is to thread "land" cells.
    if (!relaxedLndare) {
        const tPassBuffer = Date.now();
        const lndareSeed = new Uint8Array(width * height);
        for (let i = 0; i < cells.length; i++) {
            if (hardBlocked[i] === 1) lndareSeed[i] = 1;
        }
        let bufferedCount = 0;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = y * width + x;
                if (lndareSeed[idx] === 1) continue;
                if (preferred[idx] === 1) continue;
                // Don't re-seal a localized relax corridor: cells inside a
                // relax zone are intentionally CAUTION (the barrier we're
                // threading red); buffering them shut would re-island the
                // far-snapped endpoint we're trying to reach.
                if (relaxMask[idx] === 1) continue;
                const prior = cells[idx];
                if (prior > 0) continue; // chart DEPARE-claimed deep water

                // 2026-05-20: also skip cells that are 8-adjacent to any
                // protectedCells (OSM marina/canal/water or chart S57
                // DEPARE). This dilates protection by one cell so that
                // narrow water passages at marina exits don't get sealed
                // by the buffer.
                //
                // The Newport Marina case: chart LNDARE tessellates the
                // canal banks at 50m resolution but the actual marina exit
                // channel is 60-100m wide. The OSM marina polygon protects
                // cells inside the marina basin, but cells just outside the
                // basin (the exit channel itself) are CAUTION water that
                // Pass 6 was buffering shut. Result: Newport canal interior
                // was a 349-cell isolated component, origin tap snapped 2 km
                // away to the big bay component, the visible route appeared
                // to start 2 km from where the user tapped.
                //
                // By exempting cells adjacent to protected ones, the
                // exit-channel buffer is suppressed and the canal connects
                // to the bay through its natural opening. Pass 2 LNDARE
                // still blocks the actual land cells unconditionally —
                // only the 1-cell skin around them is relaxed near
                // protected water.
                let adjacentToProtected = false;
                for (let dy = -1; dy <= 1 && !adjacentToProtected; dy++) {
                    for (let dx = -1; dx <= 1 && !adjacentToProtected; dx++) {
                        if (dx === 0 && dy === 0) continue;
                        const nx = x + dx;
                        const ny = y + dy;
                        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                        if (protectedCells[ny * width + nx] === 1) adjacentToProtected = true;
                    }
                }
                if (adjacentToProtected) continue;

                let neighborBlocked = false;
                for (let dy = -1; dy <= 1 && !neighborBlocked; dy++) {
                    for (let dx = -1; dx <= 1 && !neighborBlocked; dx++) {
                        if (dx === 0 && dy === 0) continue;
                        const nx = x + dx;
                        const ny = y + dy;
                        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                        if (lndareSeed[ny * width + nx] === 1) neighborBlocked = true;
                    }
                }
                if (neighborBlocked) {
                    cells[idx] = BLOCKED;
                    hardBlocked[idx] = 1;
                    landBlocked[idx] = 1;
                    bufferedCount++;
                }
            }
        }
        markPass('pass6-LNDARE-buffer', tPassBuffer, bufferedCount);
    }

    // ── No-water-evidence mask (see NavGrid.unvouched) ───────────────
    // Computed AFTER every pass so any rescue/promotion above counts as
    // evidence. Derived purely from this build's inputs, so it caches
    // with the grid — no cache-key change.
    {
        const tPassUnvouched = Date.now();
        const unvouched = new Uint8Array(width * height);
        let unvouchedCount = 0;
        for (let idx = 0; idx < cells.length; idx++) {
            if (
                cells[idx] === UNKNOWN_OPEN &&
                preferred[idx] === 0 &&
                Number.isNaN(depareVerdict[idx]) &&
                osmWaterCells[idx] === 0 &&
                protectedCells[idx] === 0
            ) {
                unvouched[idx] = 1;
                unvouchedCount++;
            }
        }
        grid.unvouched = unvouched;
        markPass('unvouched-mask', tPassUnvouched, unvouchedCount);
    }
    grid.shallowDepthM = shallowDepthM;
    grid.clearanceBarred = clearanceBarred;
    grid.wetConflict = wetConflict;
    // Exposed only when endpoint relax zones softened land — the relax-retry
    // acceptance uses it to catch a route circumventing a low-clearance
    // bridge overland (relax-carved cells near a clearanceBarred cell).
    if (relaxZones.length > 0) grid.relaxMask = relaxMask;
    if (routeProfile === 'tideAssist') {
        // Tide-recoverable caution cells: wet at LAT (charted depth > 0) and
        // within a normal tide's reach of the keel margin. Computed AFTER all
        // passes so rescues/carves have settled; drying cells excluded by the
        // s > 0 gate; blocked cells excluded by cells < 0 (NaN compares false).
        const TIDE_ASSIST_MAX_RISE_M = 1.8;
        const floorM = draftM + safetyM;
        const ta = new Uint8Array(width * height);
        let assistCells = 0;
        for (let i = 0; i < cells.length; i++) {
            if (cells[i] < 0) {
                const s = shallowDepthM[i];
                if (!Number.isNaN(s) && s > 0 && floorM - s <= TIDE_ASSIST_MAX_RISE_M) {
                    ta[i] = 1;
                    assistCells++;
                }
            }
        }
        grid.tideAssist = ta;
        if (assistCells > 0)
            engineLog.warn(`[tideAssist] profile active — ${assistCells} recoverable caution cells at 10×`);
    }
    // Narrow the injected-canal mask to the actual CHANNEL: keep only cells with
    // charted LAND (landBlocked, set by the LNDARE passes above) within
    // MARINA_NEAR_CELLS. A canal channel is bounded by the marina lots a cell or
    // two away; open bay in the ~4 km nearshore crop has land far off and is
    // dropped — so the canal's tier-1 span stays the channel, fits the fine length
    // cap, and the fine grid stays small. (No-op when no cell is near land, e.g.
    // a fully open crop, and on test/fixture grids with no injected cells.)
    const MARINA_NEAR_CELLS = 6; // ~300 m at 50 m: keeps the canal + immediate approach
    if (landBlocked.some((v) => v === 1)) {
        for (let idx = 0; idx < injectedCanalCells.length; idx++) {
            if (!injectedCanalCells[idx]) continue;
            const cx = idx % width;
            const cy = (idx / width) | 0;
            let nearLand = false;
            for (let dy = -MARINA_NEAR_CELLS; dy <= MARINA_NEAR_CELLS && !nearLand; dy++) {
                const ny = cy + dy;
                if (ny < 0 || ny >= height) continue;
                for (let dx = -MARINA_NEAR_CELLS; dx <= MARINA_NEAR_CELLS; dx++) {
                    const nx = cx + dx;
                    if (nx < 0 || nx >= width) continue;
                    if (landBlocked[ny * width + nx] === 1) {
                        nearLand = true;
                        break;
                    }
                }
            }
            if (!nearLand) injectedCanalCells[idx] = 0;
        }
    }
    // Ride the injected-canal mask on the grid (derived purely from this build's
    // inputs, like unvouched — no cache-key change). Tier-3 classification + the
    // forced fine pass read it.
    grid.injectedCanal = injectedCanalCells;

    // Mark-governed mask — cells where a PAIRED channel midpoint defines the line.
    // Centring is suppressed here so the marks (fairlead / gate-following) keep
    // sole authority over the centreline; a geometric pull would fight gate
    // discipline. Sized to the channel's OWN width (the pair distance, floored so
    // it bridges the gap between mark stations) so it blankets the marked channel
    // without reaching distant unmarked water. Only PAIRED midpoints govern — a
    // solo OSM beacon is a no-op (matching Pass 5's reef-edge caution), so an
    // unmarked canal/marina has an all-zero mask and centres fully.
    const markGoverned = new Uint8Array(width * height);
    const CENTRE_SUPPRESS_MIN_RADIUS_M = 200;
    // Only a NARROW marked channel suppresses centring: there the geometric mid-line
    // differs from the staggered gate-midpoint line, so centring would fight gate
    // discipline (the seamanship fixtures). On a WIDE channel the two coincide, so
    // we let centring run — else a curved wide main channel (the Newport main
    // channel) has centring suppressed AND fairlead declining, leaving the route to
    // cut the bend onto the bank.
    // 400 m ties to the fine-pass narrowness boundary (isCanalNarrow ≈ 8 cells at
    // 50 m): a ≤400 m channel is "narrow" and the fine centreline pass centres it
    // regardless, so suppression there is harmless; a >400 m channel is the wide
    // coarse-routed main channel that needs centring. Comfortably above the
    // seamanship fixtures' widest pair (~362 m), so those stay suppressed.
    const MARK_SUPPRESS_MAX_PAIR_M = 400;
    const governMark = (f: Feature): void => {
        if (!f.geometry || f.geometry.type !== 'Point') return;
        const pairDistM = (f.properties as { _pairDistanceM?: number } | null)?._pairDistanceM;
        if (typeof pairDistM !== 'number' || pairDistM <= 0 || pairDistM > MARK_SUPPRESS_MAX_PAIR_M) return;
        const [lon, lat] = (f.geometry as Point).coordinates;
        const radius = Math.max(CENTRE_SUPPRESS_MIN_RADIUS_M, pairDistM);
        const dLatBuf = radius / M_PER_DEG_LAT;
        const dLonBuf = radius / mPerLon;
        const x0 = Math.max(0, Math.floor((lon - dLonBuf - minLon) / dLon));
        const x1 = Math.min(width - 1, Math.ceil((lon + dLonBuf - minLon) / dLon));
        const y0 = Math.max(0, Math.floor((lat - dLatBuf - minLat) / dLat));
        const y1 = Math.min(height - 1, Math.ceil((lat + dLatBuf - minLat) / dLat));
        for (let y = y0; y <= y1; y++) {
            const cellLat = minLat + (y + 0.5) * dLat;
            for (let x = x0; x <= x1; x++) {
                const cellLon = minLon + (x + 0.5) * dLon;
                if (haversineM(cellLat, cellLon, lat, lon) <= radius) markGoverned[y * width + x] = 1;
            }
        }
    };
    for (const f of layers.BOYLAT?.features ?? []) governMark(f);
    for (const f of layers.BCNLAT?.features ?? []) governMark(f);
    grid.markGoverned = markGoverned;

    // Medial-axis centring multiplier — computed LAST so the navigable mask
    // reflects every carve/relaxation/block above. Read by aStar + cellCostAt to
    // bow the route to mid-channel in UNMARKED water (the wall-hug cure). Derived
    // purely from this build's cells + marks, like the masks above — no cache-key
    // change.
    grid.centreFactor = computeCentreFactor(grid, markGoverned);

    // Shore skin (2026-07-03, Point Cartwright): on OPEN COAST, never price
    // the cell touching the rocks the same as the water one cell out. Chart
    // DEPARE often runs deep right to the LNDARE edge on headlands, so Pass
    // 6's buffer (correctly — `prior > 0`) never seals those cells; A* then
    // rides the land-adjacent cell and the smoothed line passes metres off
    // charted rock (measured 7 m at -26.67688,153.14007 rounding Point
    // Cartwright). SURCHARGE — never block — the 1-cell skin against land,
    // folded into centreFactor so aStar, cellCostAt, the smoother and the
    // acceptance gates all price it identically and nothing can re-straighten
    // a leg back onto the shore. A* stands off whenever open water exists;
    // where the skin is the only way through, the route still goes (2× cost,
    // not a wall) — connectivity is untouchable by construction. Exemptions
    // keep every confined/vouched water class at its tuned price:
    //   confined     — two-sided water (rivers, canals, the Tangalooma
    //                  gutter): centring owns lateral placement there, and
    //                  skinning both banks would inflate the whole reach;
    //   preferred    — channels/gates/transits are vouched water;
    //   markGoverned — gate-governed cells near paired marks (the wrong-side-
    //                  temptation zone: repelling from shore at a headland
    //                  gate must not shove the route to the wrong side);
    //   relaxMask    — localized relax corridors thread land intentionally;
    //   caution/land — non-navigable cells already price their own risk.
    {
        const SHORE_SKIN_FACTOR = 2.0;
        const tShoreSkin = Date.now();
        const confinedMask = grid.confined;
        const centreFactorArr = grid.centreFactor;
        let skinned = 0;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = y * width + x;
                if (!(cells[idx] >= 0)) continue; // NaN land + caution excluded
                if (preferred[idx] === 1) continue;
                if (relaxMask[idx] === 1) continue;
                if (markGoverned[idx] === 1) continue;
                if (confinedMask && confinedMask[idx] === 1) continue;
                let touchesLand = false;
                for (let dy = -1; dy <= 1 && !touchesLand; dy++) {
                    for (let dx = -1; dx <= 1 && !touchesLand; dx++) {
                        if (dx === 0 && dy === 0) continue;
                        const nx = x + dx;
                        const ny = y + dy;
                        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                        if (hardBlocked[ny * width + nx] === 1) touchesLand = true;
                    }
                }
                if (!touchesLand) continue;
                centreFactorArr[idx] *= SHORE_SKIN_FACTOR;
                skinned++;
            }
        }
        markPass('pass6b-shoreSkin', tShoreSkin, skinned);
    }

    // Per-pass breakdown — surfaces which polygon scanner is the hot
    // path. Format: pass=Nms(F features) so the eye can pair time
    // against feature count at a glance.
    const buildTotal = Date.now() - buildT0;
    const breakdown = Object.entries(passTimings)
        .map(([k, v]) => `${k}=${v}ms(${featureCounts[k]}f)`)
        .join(' ');
    if (ENGINE_DEBUG)
        console.warn(
            `[inshoreEngine] buildNavGrid total=${buildTotal}ms grid=${width}x${height}(${(width * height).toLocaleString()}cells) — ${breakdown}`,
        );

    return grid;
}

/**
 * BFS outward from (lat, lon) to find the nearest cell that satisfies
 * `accept`. Returns null if nothing within `maxRadiusCells` matches.
 *
 * Two-flavor wrapper to support both:
 *   - "find nearest navigable cell" (used to snap origin)
 *   - "find nearest cell in the origin's connected component"
 *     (used to snap destination, prevents "wrong pond" failures)
 */
export function snapWithPredicate(
    grid: NavGrid,
    lat: number,
    lon: number,
    maxRadiusCells: number,
    accept: (cellIdx: number) => boolean,
): { x: number; y: number } | null {
    const start = latLonToGrid(grid, lat, lon);
    if (start.x < 0 || start.y < 0 || start.x >= grid.width || start.y >= grid.height) {
        return null;
    }
    if (accept(start.y * grid.width + start.x)) return start;

    const visited = new Uint8Array(grid.width * grid.height);
    visited[start.y * grid.width + start.x] = 1;
    let frontier: { x: number; y: number; r: number }[] = [{ x: start.x, y: start.y, r: 0 }];

    while (frontier.length) {
        const next: typeof frontier = [];
        for (const { x, y, r } of frontier) {
            if (r > maxRadiusCells) return null;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    if (dx === 0 && dy === 0) continue;
                    const nx = x + dx;
                    const ny = y + dy;
                    if (nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.height) continue;
                    const idx = ny * grid.width + nx;
                    if (visited[idx]) continue;
                    visited[idx] = 1;
                    if (accept(idx)) return { x: nx, y: ny };
                    next.push({ x: nx, y: ny, r: r + 1 });
                }
            }
        }
        frontier = next;
    }
    return null;
}

export function snapToNavigable(
    grid: NavGrid,
    lat: number,
    lon: number,
    maxRadiusCells: number,
): { x: number; y: number } | null {
    return snapWithPredicate(grid, lat, lon, maxRadiusCells, (idx) => !Number.isNaN(grid.cells[idx]));
}

/**
 * Label every connected component of navigable cells in the grid.
 *
 * Returns `labels` (Int32Array, -1 for blocked cells, 0+ for component
 * ID) and `sizes` (Map of label → cell count).
 *
 * Why this exists: at coarse bathymetry resolutions (GMRT 60m, GEBCO
 * 460m) a coastal origin point often snaps into a tiny 2-5 cell pocket
 * — a marina basin, mud-flat puddle, or single deeper pixel — that's
 * surrounded by shallow blocked cells and disconnected from the main
 * bay. Without component awareness the snap finds the closest navigable
 * cell, which is exactly that wrong pocket. With it we can demand the
 * snap target sits in a sizeable water body before accepting it.
 *
 * One pass through the grid, O(cells). Cheap compared to grid build.
 */
export function labelConnectedComponents(grid: NavGrid): { labels: Int32Array; sizes: Map<number, number> } {
    const total = grid.width * grid.height;
    const labels = new Int32Array(total);
    labels.fill(-1);
    const sizes = new Map<number, number>();
    const queue = new Int32Array(total);
    let nextLabel = 0;

    for (let seed = 0; seed < total; seed++) {
        if (labels[seed] !== -1) continue;
        if (Number.isNaN(grid.cells[seed])) continue;

        const labelId = nextLabel++;
        labels[seed] = labelId;
        queue[0] = seed;
        let qHead = 0;
        let qTail = 1;

        while (qHead < qTail) {
            const idx = queue[qHead++];
            const x = idx % grid.width;
            const y = Math.floor(idx / grid.width);
            for (let dy = -1; dy <= 1; dy++) {
                const ny = y + dy;
                if (ny < 0 || ny >= grid.height) continue;
                for (let dx = -1; dx <= 1; dx++) {
                    if (dx === 0 && dy === 0) continue;
                    const nx = x + dx;
                    if (nx < 0 || nx >= grid.width) continue;
                    const nIdx = ny * grid.width + nx;
                    if (labels[nIdx] !== -1) continue;
                    if (Number.isNaN(grid.cells[nIdx])) continue;
                    labels[nIdx] = labelId;
                    queue[qTail++] = nIdx;
                }
            }
        }
        sizes.set(labelId, qTail);
    }
    return { labels, sizes };
}
