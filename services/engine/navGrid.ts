/**
 * Inshore Router Engine — navigability grid build, cache, snapping & CCL.
 * Carved out of inshoreRouterEngine.ts (module split, 2026-06-24).
 */
import type { Feature, LineString, MultiLineString, MultiPoint, Polygon, MultiPolygon, Point, Position } from 'geojson';
import { M_PER_DEG_LAT, BLOCKED, UNKNOWN_OPEN, CAUTION, ENGINE_DEBUG, engineLog } from './constants';
import type { InshoreLayers, RelaxZone, NavGrid, TideBarrier, TideCeiling } from './types';
import { mPerDegLon, haversineM, rasterizePolygonCells, bresenhamCells, latLonToGrid, geometryBbox } from './geometry';
import { computeCentreFactor } from './aStar';
import { navLineLeads } from '../leadingLine';
import {
    bandNeverDries,
    compareSurveyRanks,
    finerBandBeatsLand,
    landRankKey,
    overviewLandYields,
    tiedSurveyRank,
} from '../enc/scaleShadow';
import { isS57ChartProps, readS57 } from '../enc/types';
import { isAuthoritativeOsmWater } from './chartWaterEvidence';
import { tideCeilingLookup } from './tideCeiling';

/** A charted hazard's VALSOU (m; NaN when none), read exactly as the final
 *  audit reads it (safetyAudit hazardBufferSegments). */
const hazardValsouM = (props: Record<string, unknown> | null): number => {
    const raw = readS57(props, 'VALSOU');
    return typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
};

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
 * Byte-budget LRU, mirroring routeTracer's TRACER_LRU_BYTE_BUDGET. The old
 * cap was 5 ENTRIES under a "≈1 MB each" comment from the 200×400-cell era —
 * but a long route coarsens to 2.5M cells at 50-70 MB per grid, so five
 * entries could park ~350 MB of typed arrays in module scope for the rest of
 * the session (the Airlie Jetsam hunt, 2026-09-02). The incoming grid is
 * ALWAYS admitted — evicting everything else if need be — so a relax-retry
 * or replot of the SAME leg still hits.
 */
export interface CachedNavGrid {
    grid: NavGrid;
    ts: number;
    bytes: number;
}
export const navGridCache = new Map<string, CachedNavGrid>();
export const NAV_GRID_CACHE_MAX = 5;
export const NAV_GRID_CACHE_BYTE_BUDGET = 48 * 1024 * 1024;

/** Sum of every typed-array field on the grid — the resident cost of caching it. */
export function navGridBytes(grid: NavGrid): number {
    let total = 0;
    for (const value of Object.values(grid as unknown as Record<string, unknown>)) {
        if (ArrayBuffer.isView(value)) total += value.byteLength;
    }
    return total;
}

/** The cache key's part for the crossed bands a retry closed ('' when none):
 *  each band's extent, deepest value and rank (decision 11 fix-up,
 *  2026-10-01). */
function tideBarriersKey(barriers: readonly TideBarrier[]): string {
    return barriers
        .map(
            (b) =>
                `${b.open ? 'open' : ''}${geometryBbox(b.geometry)
                    .map((v) => v.toFixed(6))
                    .join(',')}@${b.deepestM}r${b.rank ?? 'u'}`,
        )
        .sort()
        .join('|');
}

/**
 * Evict oldest entries until the cache fits `targetBytes`. Exported so the
 * native memory-warning listener can dump the lot (target 0) when iOS says
 * the ceiling is close.
 */
export function trimNavGridCache(targetBytes = NAV_GRID_CACHE_BYTE_BUDGET): void {
    let total = 0;
    for (const v of navGridCache.values()) total += v.bytes;
    while (total > targetBytes && navGridCache.size > 0) {
        let oldestKey: string | null = null;
        let oldestTs = Infinity;
        for (const [k, v] of navGridCache) {
            if (v.ts < oldestTs) {
                oldestTs = v.ts;
                oldestKey = k;
            }
        }
        if (!oldestKey) break;
        total -= navGridCache.get(oldestKey)?.bytes ?? 0;
        navGridCache.delete(oldestKey);
    }
}

/**
 * Re-count a cached grid's resident bytes after the engine attached more to
 * it (the shallow clearance ring, w × h bytes — or an empty one where no
 * shallow band exists; round-3 fix-up, 2026-10-03), so the 48 MB budget reads
 * the grid as it now is, not the admission's reservation for the ring; then
 * trim the OTHER entries to fit (this one stays, as at admission).
 */
export function recountNavGridCacheEntry(grid: NavGrid): void {
    for (const [key, entry] of navGridCache) {
        if (entry.grid !== grid) continue;
        entry.bytes = navGridBytes(grid);
        navGridCache.delete(key);
        trimNavGridCache(Math.max(0, NAV_GRID_CACHE_BYTE_BUDGET - entry.bytes));
        navGridCache.set(key, entry);
        return;
    }
}

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
    routeProfile: 'safest' | 'tideAssist' | 'tideDirect' = 'safest',
    tideCeilings: readonly TideCeiling[] = [],
    tideBarriers: readonly TideBarrier[] = [],
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
        // The leads the grid reads: the pre-clip set when routeInshore's
        // entry clip left one (NAVLINE_GRID), so a caller holding the merged
        // layers (the seaway shadow's read-only lookup) keys the same grid.
        (layers.NAVLINE_GRID ?? layers.NAVLINE)?.features.length ?? 0,
    ].join(',');
    // Survey ranks need more than a count too (Phase 2a round-2 review,
    // 2026-09-30): a cell re-imported with its compilation scale — or ranked
    // and unranked copies of one layer set — has the same feature counts, and
    // the cached grid kept the old decision-1 verdicts for the session. An
    // order-sensitive hash of every land and depth band's `_scaleRank`.
    let rankSig = 0;
    for (const collection of [layers.LNDARE, layers.DEPARE, layers.DRGARE]) {
        for (const f of collection?.features ?? []) {
            const r = (f.properties as { _scaleRank?: unknown } | null)?._scaleRank;
            rankSig = (Math.imul(rankSig, 31) + (typeof r === 'number' ? r + 1 : 0)) | 0;
        }
        rankSig = (Math.imul(rankSig, 31) + 7) | 0;
    }
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
    // The highest tide per place (owner decision 11, 2026-10-01), quantised
    // as the build reads it: a grid that blocked water no tide clears at a
    // 2.5 m top must never serve a request with another top, or none.
    // …and the crossed bands the engine's retry closed (tideBarriers).
    const tideKey = tideCeilingLookup(tideCeilings).key;
    const barrierKey = tideKey ? tideBarriersKey(tideBarriers) : '';
    const tidePart = tideKey ? `_tide${tideKey}${barrierKey ? `_tb${barrierKey}` : ''}` : '';
    return `${bbox.join(',')}_${resolutionM}_${draftM}_${safetyM}_${obstructionBufferM}_${relaxedLndare ? 'relaxed' : 'strict'}_rz${relaxZonesKey(relaxZones)}_${routeProfile}_${sig}_r${rankSig}_ntm${ntmSig}${tidePart}`;
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
    tideCeilings: readonly TideCeiling[] = [],
    tideBarriers: readonly TideBarrier[] = [],
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
        'safest',
        tideCeilings,
        tideBarriers,
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
    routeProfile: 'safest' | 'tideAssist' | 'tideDirect' = 'safest',
    tideCeilings: readonly TideCeiling[] = [],
    tideBarriers: readonly TideBarrier[] = [],
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
        tideCeilings,
        tideBarriers,
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
        tideCeilings,
        tideBarriers,
    );
    // …with room for the shallow clearance ring (w × h bytes) the engine
    // attaches to the cached grid after it is admitted (inshoreRouterEngine
    // applyShallowClearanceRing; fix-up review, 2026-10-03: every entry was
    // undercounted by it).
    const bytes = navGridBytes(grid) + (grid.shallowRing ? 0 : grid.width * grid.height);
    // Make room by BYTES first (the incoming grid is always admitted), then
    // by entry count for the many-tiny-grids case.
    trimNavGridCache(Math.max(0, NAV_GRID_CACHE_BYTE_BUDGET - bytes));
    while (navGridCache.size >= NAV_GRID_CACHE_MAX) {
        let oldestKey: string | null = null;
        let oldestTs = Infinity;
        for (const [k, v] of navGridCache) {
            if (v.ts < oldestTs) {
                oldestTs = v.ts;
                oldestKey = k;
            }
        }
        if (!oldestKey) break;
        navGridCache.delete(oldestKey);
    }
    navGridCache.set(key, { grid, ts: Date.now(), bytes });
    return { grid, cacheHit: false };
}

/**
 * Which coastline parts lie on a CLOSED RING — an island. A part whose two
 * ends meet is one; so is every part of a chain whose ends all meet exactly
 * one other end (Overpass returns a large island's coastline as several ways
 * joined end to end at shared nodes, so the coordinates match exactly). Any
 * chain with a loose end is open: a stretch of mainland shore, or a closing
 * line across a river mouth.
 */
export function coastlineRingParts(parts: readonly Position[][]): boolean[] {
    const onRing = new Array<boolean>(parts.length).fill(false);
    const parent = parts.map((_, i) => i);
    const find = (i: number): number => {
        while (parent[i] !== i) {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        return i;
    };
    const ends = new Map<string, number[]>();
    const key = (p: Position): string => `${p[0]},${p[1]}`;
    parts.forEach((coords, i) => {
        const k0 = key(coords[0]);
        const k1 = key(coords[coords.length - 1]);
        if (k0 === k1) {
            onRing[i] = true;
            return;
        }
        for (const k of [k0, k1]) {
            const list = ends.get(k);
            if (list) list.push(i);
            else ends.set(k, [i]);
        }
    });
    for (const list of ends.values()) {
        for (let j = 1; j < list.length; j++) parent[find(list[j])] = find(list[0]);
    }
    const openChains = new Set<number>();
    for (const list of ends.values()) if (list.length !== 2) openChains.add(find(list[0]));
    parts.forEach((_, i) => {
        if (!onRing[i] && !openChains.has(find(i))) onRing[i] = true;
    });
    return onRing;
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
    routeProfile: 'safest' | 'tideAssist' | 'tideDirect' = 'safest',
    /**
     * The highest tide known per place (owner decision 11, 2026-10-01): water
     * whose charted bands' deepest value plus that tide is still short of
     * draft + safety is blocked (NavGrid.noTideClears). Empty: nothing is
     * proved, and the grid is exactly as without. Part of the cache key.
     */
    tideCeilings: readonly TideCeiling[] = [],
    /**
     * The charted bands a route crossed through water no tide clears with no
     * local way round them (the engine's retry, fix-up 2026-10-01): every
     * cell each one touches is closed where it is proved — a bar narrower
     * than a cell included, which the default build leaves open. Part of the
     * cache key.
     */
    tideBarriers: readonly TideBarrier[] = [],
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
    // UNCONDITIONAL on-device breadcrumb (2026-07-15 crash audit): the paired
    // START/DONE lines prove hang-vs-OOM in the Xcode console — a START with no
    // matching DONE = killed mid-synchronous-build; low estMB = HANG (watchdog),
    // hundreds of MB = OOM (jetsam). createLogger.warn is visible in prod.
    engineLog.warn(
        `buildNavGrid START ${width}×${height} cells=${width * height} estMB=${Math.round((width * height * 40) / 1e6)} res=${resolutionM}m`,
    );

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
    // genuinely WATER at chart datum. Pass 2b's closing-line test reads it.
    // Under chart land paint Pass 2 decides by scale instead (owner decision
    // 1, bandRank/bandState below: the Mooloolah wharf→bar mile is a finer
    // cell's river under the overview's coastline) and withdraws the claim
    // wherever the land paint stands. Never set by drying bands
    // (DRVAL1 ≤ 0) — a charted drying spit defers to land paint.
    const wetChartClaim = new Uint8Array(width * height);
    // Per-cell "CHARTED shallow water" claim (owner decision 7, round 2,
    // 2026-09-30): 1 = an S-57 band (DEPARE / DRGARE) shallower than
    // draft + safety but NEVER drying (charted DRVAL1 ≥ 0 — decision 1's
    // test, so a 0 m band counts where wetChartClaim's > 0 does not) owns the
    // cell at its finest survey. With decision-1 water it is the only caution
    // an ENDPOINT may sit in (grid.chartedShallow below): the route runs to a
    // pin there instead of stopping short at the last deep water. Reset with
    // the other depth claims when a finer survey claims the cell.
    const s57ShallowClaim = new Uint8Array(width * height);
    // Per-cell FINENESS RANK of the finest ranked DEPARE that claimed the
    // cell (see cellScaleRank). Whole-bbox scale-shadowing can't drop a
    // huge coarse polygon that pokes outside finer coverage; it then
    // fought the fine survey here, where shallowest-wins let a 1:90k
    // "dries 2 m" flats blob beat a 1:22k surveyed 2–5 m band (Newport
    // approach, 2026-07-11). Rule: a COARSER ranked feature contributes
    // nothing to a cell a finer ranked feature owns; the first FINER
    // claim resets the coarser DEPARE accumulation. Unranked features
    // (injected OSM/Mapbox water, curated) stay outside the rank system —
    // they merge exactly as before, protected by their own flags.
    // RANK_UNCLAIMED = no ranked feature has touched the cell yet.
    const RANK_UNCLAIMED = -32768;
    const depareRank = new Int16Array(width * height).fill(RANK_UNCLAIMED);
    // THE SHALLOWEST WINS at a survey tie (Phase 2a round-2 review,
    // 2026-09-30). Per cell, which S-57 surveys at the owning rank made a
    // shallow claim (s57ShallowAt) and which protected the cell as deep
    // (s57DeepAt): 0 none, S57_UNRANKED an unranked band, S57_RANKED a ranked
    // one. Two same-rank bands over the same ground, 6 m and 1 m, read 6 m in
    // either order: the deep band's own protection outranked a same-rank
    // shallow survey, and a deep band upgraded the shallow one's CAUTION. At a
    // RANKED tie (the same rank, or tied ranks) only a STRICTLY finer survey
    // protects a cell against a ranked shallow S-57 band now (OSM-vouched
    // water no longer does — round-3 review, below); the shallower band's
    // CAUTION stands. Reset with the other depth claims when a finer survey
    // claims the cell.
    //
    // It also ends an order-dependent hole: a later non-S-57, non-OSM deep
    // band — the GMRT public-bathymetry bands (grade D) the corridor captures
    // carry — upgraded a charted shallow S-57 band's CAUTION to deep (the
    // other order kept the CAUTION). It no longer does. That is what moves the
    // goldens (each measured in its own process): Newport → Rivergate
    // 22.47 → 23.22 NM, Newport → Tangalooma 19.91 → 20.35 NM, caution 13 → 18.
    //
    // Two UNRANKED S-57 bands (cells that do not say their scale) that
    // disagree: the SHALLOWEST wins too (Claude's call, round 3, told Shane
    // 2026-09-30 — not an owner decision) — the safe side: it only ever makes
    // water caution ('needs tide', amber on the leads), never blocks. The
    // round-2 fix-up had kept the old rule (a deep claim won) as a question
    // for him.
    //
    // A RANKED and an UNRANKED band that disagree: the shallowest wins as well
    // (round-3 review, 2026-09-30; the same call, told Shane). A ranked band used
    // to out-survey an unranked one either way, so a coarse 1:1.5M overview's
    // 0–30 m band upgraded a cell whose scale is unknown — which may be a
    // harbour survey — from its charted 1 m shoal to deep. Unknown fineness
    // already fails safe for land (decision 1); now it does for depth too. A
    // finer ranked band's reset (below) never wipes an unranked shallow claim
    // (unrankedShallow).
    //
    // OSM-vouched water is WATER, never DEPTH (round-3 review, 2026-09-30): it
    // still beats chart LAND paint (Pass 2 — the LNDARE-bleed case it is
    // trusted for), but never an S-57 band's shallow or drying claim. Its
    // synthetic 10 m (InshoreRouter's OSM injection) used to outrank the ENC
    // harbour cell's DEPARE -2.2..0 at the Brisbane River mouth in both feature
    // orders: ~2.9 km of every Newport → river route drew a yellow 'marked
    // channel' over ground that dries 2.2 m, with no red and no tide chip.
    const S57_UNRANKED = 1;
    const S57_RANKED = 2;
    const s57ShallowAt = new Uint8Array(width * height);
    const s57DeepAt = new Uint8Array(width * height);
    // Unranked S-57 shallow claims, kept through a finer ranked band's reset
    // (no rank to be out-surveyed by): their shallowest DRVAL1, and whether
    // any of them is wet at LAT (> 0) or never dries (≥ 0) — the wet and
    // decision-7 claims the reset also clears. Allocated on the first one.
    let unrankedShallowM: Float32Array | null = null;
    let unrankedShallowBits: Uint8Array | null = null;
    const UNRANKED_CLAIM = 1;
    const UNRANKED_WET = 2;
    const UNRANKED_NEVER_DRIES = 4;
    const UNRANKED_DRIES = 8;
    // An S-57 band at the owning survey charts the cell DRYING (DRVAL1 < 0) —
    // the chart's own claim, apart from shallowDepthM, which also takes in
    // non-chart bands (public bathymetry). Pass 2 reads it against OSM water
    // under land paint. Reset and restored with the other depth claims.
    const s57DryingAt = new Uint8Array(width * height);
    // WATER NO TIDE CLEARS (owner decision 11, Shane 2026-10-01): the DEEPEST
    // the cell's owning S-57 bands admit (DRVAL2), so the pass below can
    // prove water that even the place's highest tide cannot clear. Tracked
    // only when the request carries tide ceilings — without them the grid is
    // exactly as before. Ranked bands at the owning survey (reset when a
    // strictly finer survey claims the cell, like every depth claim here) and
    // unranked bands (never reset: their scale is unknown, so they own the
    // cell alongside, as the shallowest-wins rule has them) are kept apart;
    // a band with no DRVAL2 marks the cell unknown, and nothing is proved
    // there.
    const tideLookup = tideCeilingLookup(tideCeilings);
    const tideProof = tideLookup.size > 0;
    const rankedDeepestM = tideProof ? new Float32Array(width * height).fill(NaN) : null;
    const rankedDeepUnknown = tideProof ? new Uint8Array(width * height) : null;
    const unrankedDeepestM = tideProof ? new Float32Array(width * height).fill(NaN) : null;
    const unrankedDeepUnknown = tideProof ? new Uint8Array(width * height) : null;
    // Every S-57 depth band with its DRVAL2 and rank, for the pass below to
    // find the proved cells a band a tide clears still touches.
    const tideBands: { g: Polygon | MultiPolygon; drval2: number | null; rank: number | null }[] = [];
    // CHART WATER UNDER LAND PAINT (owner decision 1, 2026-09-30;
    // services/enc/scaleShadow.ts finerBandBeatsLand). Per cell, the finest
    // S-57 depth band (DEPARE or DRGARE) that covers it — `bandRank` — and
    // whether every band at that rank never dries (charted DRVAL1 ≥ 0):
    // BAND_WET, else BAND_NO. Pass 2 reads it against the finest land paint
    // on the cell: only a strictly FINER never-drying band beats it (shallow
    // water: CAUTION, never deep); a drying, undepthed, equal or coarser band
    // — or an unknown rank on either side — leaves the land paint standing.
    // Owner decision 12 (2026-10-02) is asked first: an overview or general
    // cell's land paint (band 1–2) over a detailed chart's (band 3+) BAND_WET
    // bands is no dispute at all. Unranked S-57 bands sit below every ranked
    // one, as in leadLandClip: they own a cell only when no ranked band covers
    // it, and then the rank is unknown (RANK_UNRANKED) and cannot beat
    // anything. Allocated only when there is land paint to read it against.
    const RANK_UNRANKED = -32767;
    const BAND_WET = 1;
    const BAND_NO = 2;
    const hasLandPaint = (layers.LNDARE?.features.length ?? 0) > 0;
    const bandRank = hasLandPaint ? new Int16Array(width * height).fill(RANK_UNCLAIMED) : null;
    const bandState = hasLandPaint ? new Uint8Array(width * height) : null;
    const claimBand = (idx: number, rank: number | null, neverDries: boolean): void => {
        if (!bandRank || !bandState) return;
        const held = bandRank[idx];
        if (rank === null) {
            // Unranked: owns the cell only if nothing else claimed it.
            if (held === RANK_UNCLAIMED) {
                bandRank[idx] = RANK_UNRANKED;
                bandState[idx] = BAND_NO;
            }
            return;
        }
        const cmp = held === RANK_UNCLAIMED || held === RANK_UNRANKED ? 1 : compareSurveyRanks(rank, held);
        if (cmp > 0) {
            bandRank[idx] = rank;
            bandState[idx] = neverDries ? BAND_WET : BAND_NO;
        } else if (cmp === 0) {
            // A TIE (the same rank, or one usage band where either rank is
            // known by its band alone — scaleShadow surveyRanksTie): both own
            // the cell, so a drying one makes it drying, and the rank kept is
            // the weaker claim (round-2 review, 2026-09-30: a CSCL-stamped
            // 2 m band outranked a name-only band-4 chart that dries there,
            // and the coarser land paint became water).
            bandRank[idx] = tiedSurveyRank(rank, held);
            if (!neverDries) bandState[idx] = BAND_NO;
        }
    };
    /** Decision 1: a finer never-drying band beats the land paint here. */
    const finerBandBeatsLandAt = (idx: number, landRank: number | null): boolean =>
        !!bandRank &&
        !!bandState &&
        bandState[idx] === BAND_WET &&
        bandRank[idx] !== RANK_UNRANKED &&
        finerBandBeatsLand(bandRank[idx], landRank);
    /** Decision 12: the finest land paint here is an overview or general
     * cell's, and the bands that own the cell are a detailed chart's that all
     * never dry — the dispute is ignored (scaleShadow overviewLandYields). A
     * subset of finerBandBeatsLandAt's cells. */
    const overviewLandYieldsAt = (idx: number, landRank: number): boolean =>
        !!bandRank &&
        !!bandState &&
        bandRank[idx] !== RANK_UNCLAIMED &&
        bandRank[idx] !== RANK_UNRANKED &&
        overviewLandYields(bandRank[idx], bandState[idx] === BAND_WET, landRank);
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
    // blocked by a shallow DEPARE band has hardBlocked = 0. No channel
    // pass rescues a cell any more: Pass 4 (FAIRWY / DRGARE), Pass 5
    // (paired channel midpoints) and Pass 5b (leads) only prefer (Phase 2a
    // review and round 2, 2026-09-30).
    const hardBlocked = new Uint8Array(width * height);
    // LAND-only subset of hardBlocked (LNDARE / coastline / coastal buffer —
    // never point-hazard buffers). See NavGrid.landBlocked.
    const landBlocked = new Uint8Array(width * height);
    // Land paint the relax zones (or the grid-wide relaxedLndare retry) let
    // through as CAUTION instead of blocking — still land for a lead (Pass
    // 5b). Allocated only when something can relax.
    const relaxedLand = relaxedLndare || relaxZones.length > 0 ? new Uint8Array(width * height) : null;
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
    // The authoritative-OSM-water test is shared with the final-route land
    // audit (services/engine/chartWaterEvidence.ts), so the two agree.
    //
    // S-57 DRGARE bands run through this pass too (Phase 2a review,
    // 2026-09-30): a dredged area's DRVAL1 IS its charted depth, so it is a
    // depth band like any DEPARE — finest survey wins, shallow reads CAUTION
    // with its real depth kept for the tide window, deep reads its own depth.
    // Pass 4 used to paint a 5 m "rescue depth" over every dredged area and
    // fairway instead (a 1.3 m DRGARE read 5 m for a 2.4 m keel); now it only
    // prefers them.
    const depare = [...(layers.DEPARE?.features ?? []), ...(layers.DRGARE?.features ?? [])];
    const tPassDepare = Date.now();
    for (const f of depare) {
        const g = f.geometry;
        if (g.type !== 'Polygon' && g.type !== 'MultiPolygon') continue;
        const props = f.properties as Record<string, unknown> | null;
        // Case-defensive (readS57): extractor cells carry DRVAL1, some ogr2ogr
        // conversions drval1.
        const drval1 = readS57(props, 'DRVAL1');
        // S-57 DRVAL1 is positive depth in meters.
        // A malformed/missing depth is not evidence of safe water. Treat the
        // polygon as chart-datum caution (0 m) so attacker-controlled or
        // corrupt feature metadata cannot bypass the conservative route
        // verdict by making this DEPARE disappear from the grid entirely.
        const drval1Num = typeof drval1 === 'number' && Number.isFinite(drval1) ? drval1 : 0;
        // Chart-source DEPARE (acronym='DEPARE' from senc-extractor) is
        // hydrographic-survey data. With the Eulerian ring fix (2026-05-19)
        // these polygons now have proper outer rings — they no longer
        // bleed across the coastline as the triangle-soup did. So trust
        // them to win against LNDARE on overlap (e.g. marina basins where
        // chart has a tiny DEPARE inside a chunky mainland LNDARE).
        // OSM-derived DEPARE (no acronym) still uses the old OSM-tag gate
        // (Scarborough peninsula safeguard).
        // …and so are the Pi's ogr2ogr .000 cells, which carry OBJL and no
        // acronym: one S-57 test for the grid, the land audit and the lead
        // land clip (services/enc/types.ts isS57ChartProps; Phase 2a round 2,
        // 2026-09-30 — matching the acronym alone made an ogr2ogr cell's bands
        // OSM-grade water here while the overlay read them as chart bands).
        const isS57Depare = isS57ChartProps(props);
        // OSM-vouched = authoritative water that is NOT a chart S-57 DEPARE
        // (marina/canal/dock/river injected by OsmRouteOverlayService). These
        // keep clean navigable even under a chunky LNDARE; chart-DEPARE-only
        // protection that collides with chart LNDARE is flagged CAUTION instead.
        const osmVouched = !isS57Depare && isAuthoritativeOsmWater(props);
        const authoritative = isS57Depare || osmVouched;
        const shallow = drval1Num < draftM + safetyM;
        // Fineness rank stamped at merge time (stampScaleRank) — undefined
        // for injected/unranked features, which bypass the rank system.
        const rank = typeof props?._scaleRank === 'number' ? (props._scaleRank as number) : null;
        // INJECTED nearshore canal water we added for routing (Mapbox vector
        // water over the endpoint crops). Tagged regardless of the shallow/deep
        // branch so a deep-draft vessel (where 5 m reads shallow) still marks
        // the canal — it's a canal either way, just caution-flagged if shallow.
        const isMapboxWater = props?.['_source'] === 'mapbox-water';
        const neverDries = bandNeverDries(typeof drval1 === 'number' ? drval1 : null);
        // Decision 11: the deepest this band admits (null: it does not say).
        const drval2Raw = tideProof && isS57Depare ? readS57(props, 'DRVAL2') : null;
        const drval2 = typeof drval2Raw === 'number' && Number.isFinite(drval2Raw) ? drval2Raw : null;
        if (tideProof && isS57Depare) tideBands.push({ g, drval2, rank });

        // Scanline-rasterize the polygon and apply cell updates inside
        // the per-cell callback. ~25× faster than the old "per cell,
        // pointInGeometry" loop on real DEPARE shapes (50+ vertex
        // bathymetry contours covering 50×50+ cell ranges).
        rasterizePolygonCells(grid, g, (x, y) => {
            const idx = y * width + x;

            // Tag injected Mapbox canal water (both branches) → tier-1 + fine pass.
            // Narrowed to the actual channel after the LNDARE passes (see below).
            if (isMapboxWater) injectedCanalCells[idx] = 1;

            // Decision 1's band claim (S-57 bands only; the raw DRVAL1, so a
            // missing or malformed depth never counts as never-drying).
            if (isS57Depare) claimBand(idx, rank, neverDries);

            // Finest-survey-wins (ranked features only): a coarser ranked
            // feature never writes into a cell a finer one owns; the first
            // strictly-finer claim resets the coarser DEPARE accumulation
            // so a crude overview band can't pre-poison it via shallowest-
            // wins. Unranked (injected) contributions are never reset —
            // resets only fire when superseding a RANKED claim.
            if (rank !== null) {
                const held = depareRank[idx];
                // A tie (scaleShadow surveyRanksTie) is neither finer nor
                // coarser: both bands own the cell, the shallowest wins below,
                // and the rank kept is the weaker claim (round 2, 2026-09-30).
                const cmp = held === RANK_UNCLAIMED ? 0 : compareSurveyRanks(rank, held);
                if (held !== RANK_UNCLAIMED) {
                    if (cmp < 0) return; // finer survey owns this cell
                    if (cmp > 0) {
                        depareVerdict[idx] = NaN;
                        shallowDepthM[idx] = NaN;
                        wetChartClaim[idx] = 0;
                        s57ShallowClaim[idx] = 0;
                        s57ShallowAt[idx] = 0;
                        s57DeepAt[idx] = 0;
                        s57DryingAt[idx] = 0;
                        if (rankedDeepestM && rankedDeepUnknown) {
                            rankedDeepestM[idx] = NaN;
                            rankedDeepUnknown[idx] = 0;
                        }
                        // A coarser S-57 band's own protection goes with its
                        // claim: kept, it let a coarse deep band outrank a
                        // finer shallow one whenever the coarse one came
                        // first — finest-survey-wins held in only one order
                        // (Phase 2a review, 2026-09-30). OSM-vouched water
                        // (osmWaterCells) is another source's claim and
                        // keeps its protection.
                        if (protectedCells[idx] === 1 && osmWaterCells[idx] !== 1) protectedCells[idx] = 0;
                        // Reset only DEPARE-derived navigability state;
                        // NaN (hard-block) and PROTECTED cell values
                        // (authoritative injected water) belong to other
                        // sources and stay.
                        if (!Number.isNaN(cells[idx]) && protectedCells[idx] !== 1) {
                            cells[idx] = UNKNOWN_OPEN;
                        }
                        // An unranked shallow claim is not out-surveyed by a
                        // finer RANKED band (its scale is unknown): it stands.
                        const bits = unrankedShallowBits?.[idx] ?? 0;
                        if (bits !== 0 && unrankedShallowM) {
                            s57ShallowAt[idx] = S57_UNRANKED;
                            shallowDepthM[idx] = unrankedShallowM[idx];
                            depareVerdict[idx] = CAUTION;
                            if (bits & UNRANKED_WET) wetChartClaim[idx] = 1;
                            if (bits & UNRANKED_NEVER_DRIES) s57ShallowClaim[idx] = 1;
                            if (bits & UNRANKED_DRIES) s57DryingAt[idx] = 1;
                            if (!Number.isNaN(cells[idx])) cells[idx] = CAUTION;
                        }
                    }
                }
                depareRank[idx] = held === RANK_UNCLAIMED || cmp > 0 ? rank : tiedSurveyRank(rank, held);
            }
            // Decision 11: every S-57 band that owns the cell bounds its
            // depth; the deepest of them is what a tide must beat.
            if (tideProof && isS57Depare) {
                const deepM = rank === null ? unrankedDeepestM! : rankedDeepestM!;
                const unknown = rank === null ? unrankedDeepUnknown! : rankedDeepUnknown!;
                if (drval2 === null) unknown[idx] = 1;
                else if (Number.isNaN(deepM[idx]) || drval2 > deepM[idx]) deepM[idx] = drval2;
            }
            // This band's S-57 tier (0: not an S-57 band) — see s57ShallowAt.
            const s57Tier = !isS57Depare ? 0 : rank === null ? S57_UNRANKED : S57_RANKED;
            // An S-57 shallow claim already here stands against every deeper
            // band that does not strictly out-survey it (a strictly finer
            // ranked band resets it above; a coarser one never gets this far):
            // an equal or tied ranked band, a ranked band against an unranked
            // claim or the reverse (either side unranked: the shallowest wins),
            // a non-S-57 band, and OSM-vouched water — which has no depth to
            // offer (round-3 review, 2026-09-30, above).
            const shallowStands = s57ShallowAt[idx] !== 0;

            // Record the DEPARE-only verdict (independent of any later LNDARE
            // hard-block), tracking the shallowest real depth or CAUTION — so
            // Pass 4 can restore charted water under LNDARE bleed for a marked
            // channel without fabricating depth.
            const prevV = depareVerdict[idx];
            if (shallow) {
                // An S-57 shallow claim is CAUTION whatever deeper claim was
                // here (the shallowest wins, as in `cells` below).
                if (Number.isNaN(prevV) || isS57Depare) depareVerdict[idx] = CAUTION;
                // Keep the REAL charted depth the CAUTION sentinel erases
                // (shallowest wins) — the tide-window annotator's requiredRise
                // input. Recorded regardless of protectedCells: the chart's
                // depth claim is true either way, consumers key off cautionMask.
                if (Number.isNaN(shallowDepthM[idx]) || drval1Num < shallowDepthM[idx]) {
                    shallowDepthM[idx] = drval1Num;
                }
            } else if (Number.isNaN(prevV) || (prevV === CAUTION && !shallowStands) || drval1Num < prevV) {
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
                // cell, no NON-chart shallow band downgrades it.
                // An S-57 shallow band always does (round-3 review,
                // 2026-09-30): no protection here outranks it — a strictly
                // finer ranked band would have returned above, so what is
                // here is a same-rank or tied band (the shallowest wins), a
                // band whose scale is unknown on either side (the shallowest
                // wins), or OSM-vouched water, which vouches for WATER against
                // land paint but has no depth. The protection itself stays, so
                // chart land paint still cannot block the cell (Pass 2).
                if (isS57Depare || protectedCells[idx] !== 1) {
                    cells[idx] = CAUTION;
                }
                if (s57Tier > s57ShallowAt[idx]) s57ShallowAt[idx] = s57Tier;
                if (isS57Depare && drval1Num < 0) s57DryingAt[idx] = 1;
                if (s57Tier === S57_UNRANKED) {
                    const m = (unrankedShallowM ??= new Float32Array(width * height).fill(NaN));
                    const b = (unrankedShallowBits ??= new Uint8Array(width * height));
                    if (Number.isNaN(m[idx]) || drval1Num < m[idx]) m[idx] = drval1Num;
                    b[idx] |=
                        UNRANKED_CLAIM |
                        (drval1Num > 0 ? UNRANKED_WET : 0) |
                        (neverDries ? UNRANKED_NEVER_DRIES : 0) |
                        (drval1Num < 0 ? UNRANKED_DRIES : 0);
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
                // The endpoint's charted-shallow claim (decision 7): the raw
                // DRVAL1, so an undepthed band never counts as never-drying.
                if (isS57Depare && neverDries) s57ShallowClaim[idx] = 1;
            } else {
                // Deep enough for this vessel.
                const prior = cells[idx];
                if (Number.isNaN(prior)) {
                    // Cell hard-blocked by an earlier pass — only an
                    // authoritative DEPARE un-blocks it.
                    if (authoritative) cells[idx] = drval1Num;
                } else if (prior === UNKNOWN_OPEN || (prior === CAUTION && !shallowStands) || drval1Num < prior) {
                    // Upgrade an unknown / caution cell to real depth,
                    // or track the shallowest known real depth — but never
                    // over a shallow S-57 claim this band does not strictly
                    // out-survey: at a tie the shallowest wins.
                    cells[idx] = drval1Num;
                }
                if (authoritative) protectedCells[idx] = 1;
                if (osmVouched) osmWaterCells[idx] = 1;
                if (s57Tier > s57DeepAt[idx]) s57DeepAt[idx] = s57Tier;
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
    // Cells a canal LINE carved (distinct from osmWaterCells, which also covers
    // water POLYGONS). The berth carve (Pass 2c) keeps a corridor around these
    // open so a curated marina fairway / canal exit is never re-blocked by a
    // pontoon that sits a cell away (wharf-start 2026-07-07).
    const canalLineCarved = new Uint8Array(width * height);
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
                    // pass already claimed real (deeper) water here — or an
                    // S-57 band charts it shallow or drying: the canal line
                    // says where the water is, not how deep (round-3 review,
                    // 2026-09-30, as for OSM water in Pass 1). It still
                    // protects the cell against land paint below.
                    if (
                        s57ShallowAt[idx] === 0 &&
                        (Number.isNaN(cells[idx]) || cells[idx] < 0 || cells[idx] === UNKNOWN_OPEN)
                    ) {
                        cells[idx] = canalDepth;
                    }
                    protectedCells[idx] = 1;
                    osmWaterCells[idx] = 1; // OSM canal carve — keep clean under LNDARE
                    canalLineCarved[idx] = 1; // protect this corridor from the berth carve
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
    //
    // Owner decision 1 (2026-09-30) replaces the S-57 half of that rule
    // with a scale test. Where chart S-57 water and chart land paint collide,
    // the land paint stands UNLESS the finest S-57 depth band on the cell is
    // charted at a strictly FINER scale than the finest land paint there and
    // never dries (DRVAL1 ≥ 0) — the coarse overview landmask bulging over a
    // finer cell's charted channel (Tangalooma Roads; the Mooloolah
    // wharf→bar mile). That cell is shallow WATER: honest CAUTION (red, 40×,
    // tide-chipped), never deep, protected so the coastline strip and the
    // Pass-6 buffer cannot seal it, and flagged wetConflict so endpoint
    // snapping prefers honest water. A drying or undepthed band, a band at
    // the same or a coarser scale, and an unknown rank on either side (an
    // unranked LNDARE, or only unranked bands) leave the land paint standing
    // — fail safe. The router's merges rank LNDARE, DEPARE and DRGARE
    // (InshoreRouter SCALE_RANKED_LAYERS), so production can make the
    // comparison; a layer set without ranks (the corridor fixtures) keeps all
    // of its land. OSM-vouched water (Newport canals, Brisbane River
    // LNDARE-bleed) keeps navigable under any land paint — except over an
    // S-57 band that dries (round-3 review, 2026-09-30, below).
    //
    // Two steps, so overlapping land paint resolves the same in any feature
    // order: first the finest land claim per cell (an unranked claim
    // poisons it — unknown), then one verdict per land cell.
    const lndare = layers.LNDARE?.features ?? [];
    const tPassLndare = Date.now();
    const LAND_NONE = RANK_UNCLAIMED;
    const LAND_UNRANKED = RANK_UNRANKED;
    const landRankAt = lndare.length > 0 ? new Int16Array(width * height).fill(LAND_NONE) : null;
    // Land paint decision 1 upheld over an S-57 band that claimed the cell as
    // water (before the decision: a CAUTION conflict cell). No later rescue
    // pass may reopen it as water it could not be before — see Pass 4's mark
    // ribbon. Allocated on the first such cell.
    let landUpheld: Uint8Array | null = null;
    // Decision-1 water whose finest band is deep enough for this keel (see
    // grid.chartedShallow). Allocated on the first such cell.
    let d1DeepBand: Uint8Array | null = null;
    for (const f of lndare) {
        const g = f.geometry;
        if (!landRankAt || !g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) continue;
        const props = f.properties as Record<string, unknown> | null;
        const rank = typeof props?._scaleRank === 'number' ? (props._scaleRank as number) : null;
        // The finest land claim is kept by its landRankKey: land paint known
        // by its usage band alone counts as that band's finest, so no band of
        // the same usage band can beat it (round 2, 2026-09-30).
        const landKey = rank === null ? 0 : landRankKey(rank);
        // NO rogue filter on LNDARE: real chart-source LNDARE for narrow
        // land features (Redcliffe peninsula, river banks) naturally has
        // long-edge fan triangles that LOOK rogue but are correctly
        // covering the elongated polygon. Filtering them leaves big gaps
        // (peninsula's rcid 4500 had 49% of its 3146 triangles flagged as
        // rogue by edge/aspect heuristics) and A* threads through. Better
        // to over-block (LNDARE bleeds across rivers → some water shows
        // as land) and rely on the chart's own finer survey (decision 1)
        // and OSM-vouched water to un-block actual surveyed water.
        rasterizePolygonCells(grid, g, (x, y) => {
            const idx = y * width + x;
            const held = landRankAt[idx];
            if (rank === null) landRankAt[idx] = LAND_UNRANKED;
            else if (held === LAND_NONE || (held !== LAND_UNRANKED && landKey > held)) landRankAt[idx] = landKey;
        });
    }
    if (landRankAt) {
        for (let idx = 0; idx < landRankAt.length; idx++) {
            const held = landRankAt[idx];
            if (held === LAND_NONE) continue;
            // OWNER DECISION 12 (Shane, 2026-10-02, "Trust the detailed
            // chart"): land paint from overview and general cells only
            // (usage band 1–2: the finest land claim here is one) over a
            // detailed chart's (band 3+) depth area that never dries is no
            // dispute — no decision-1 'charts disagree' caution, no
            // wetConflict, and the cell keeps the depth Pass 1 gave it from
            // the detailed chart (deep, or shallow CAUTION). Cid Harbour: the
            // 1:3,500,000 AU130120 paints it land, the 1:90,000 AU421148
            // charts 10–15 m. Every such cell is decision-1 water (a band-3+
            // band is strictly finer than band-1–2 land), and it keeps
            // decision 1's protection: the coastline strip and the Pass-6 land
            // skin seal it no more than they did (fix-up 2026-10-03: without
            // it the Newport canal mouth's charted 0 m cells were skinned shut
            // beside the band-4 land, and the Rivergate golden crossed 48.8 m
            // of charted land, Tangalooma 1.6 km). Over a detailed DRYING
            // band the land stands (decision 1, below). A detailed chart's own
            // land (an island the overview leaves out; the Brisbane River's
            // 1:90,000 coastline over the 1:12,000 survey) still goes to
            // decision 1, as does land of unknown scale.
            if (held !== LAND_UNRANKED && overviewLandYieldsAt(idx, held)) {
                protectedCells[idx] = 1;
                landRankAt[idx] = LAND_NONE;
                continue;
            }
            // OSM-vouched water (marina / canal / dock / river, or the canal
            // carve) under chart land paint: trust OSM, keep it navigable —
            // unchanged by decision 1 — UNLESS the chart's own S-57 band on
            // the cell dries (round-3 review, 2026-09-30). There the chart
            // says the same thing twice — land paint over a drying bank, which
            // decision 1 never lets a drying band beat — and OSM water, which
            // has no depth, is not evidence against it. It protected the
            // Brisbane River mouth's charted drying bank (ENB5 -2.2..0 under
            // the overview's land paint) and the routes crossed ~2.9 km of it;
            // measured after this rule, 30 m, and the river-mouth land sliver
            // the audit counted (Rivergate golden 47.1 m) is gone.
            const osmOverDrying = s57DryingAt[idx] === 1;
            if (protectedCells[idx] && osmWaterCells[idx] === 1 && !osmOverDrying) continue;
            if (finerBandBeatsLandAt(idx, held === LAND_UNRANKED ? null : held)) {
                // Decision 1: shallow water, never deep. A deep finer band
                // reads CAUTION here (the Tangalooma Roads doctrine); a
                // shallow one keeps the CAUTION and real depth Pass 1 set.
                // Only the DEEP kind is caution solely because of the coarse
                // land paint, and only it may hold a route's end (decision 7,
                // grid.chartedShallow below): its finest band is itself at
                // least draft + safety, with no ranked shallow claim tied
                // with it.
                if (cells[idx] >= draftM + safetyM && s57ShallowAt[idx] !== S57_RANKED) {
                    (d1DeepBand ??= new Uint8Array(width * height))[idx] = 1;
                }
                if (cells[idx] >= 0) cells[idx] = CAUTION;
                protectedCells[idx] = 1;
                wetConflict[idx] = 1;
                continue;
            }
            // Land. A deep S-57 band's Pass-1 protection (or its wet claim) is
            // withdrawn: the chart's own land paint stands over it, so no
            // later pass may read this cell as protected or wet water.
            const chartWater = protectedCells[idx] === 1 || wetChartClaim[idx] === 1;
            protectedCells[idx] = 0;
            wetChartClaim[idx] = 0;
            if (chartWater) (landUpheld ??= new Uint8Array(width * height))[idx] = 1;
            if (relaxedLndare || relaxMask[idx] === 1) {
                // CAUTION-mode: A* can traverse at the caution price, so a
                // far-snapped endpoint can thread it; not hardBlocked. Still
                // land to every lead and mark rescue (relaxedLand). Relaxed
                // land over a chart band is never deep either.
                if (cells[idx] === UNKNOWN_OPEN || (chartWater && cells[idx] > 0)) cells[idx] = CAUTION;
                if (relaxedLand) relaxedLand[idx] = 1;
            } else {
                cells[idx] = BLOCKED;
                hardBlocked[idx] = 1;
                landBlocked[idx] = 1;
            }
        }
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
    //
    // THE CLOSING-LINE EXEMPTION (Phase 1 review, then two final-review
    // passes, 2026-09-29). A coastline cell over an S-57 band that is WET at
    // chart datum (DRVAL1 > 0) gets Pass 2's doctrine — the layers
    // disagreeing, not land: it keeps the CAUTION the DEPARE pass set and is
    // protected, so a river-mouth or creek closing line cannot sever a charted
    // channel. Only a real closing line qualifies, and the test is the LINE'S
    // SHAPE, never the band under it: coastline-only land (a cay the overview
    // cell leaves out, a spit or mole, a pad reclaimed after the chart was
    // drawn) sits on the same band, so the band reads wet on both sides of the
    // land's own outline. Exempting those made them routable — 1.5x under
    // tideDirect, and 5 m preferred under any lead across them. A closing line
    // is all of:
    //   • an OSM natural=coastline line (a breakwater is a structure, always),
    //     NOT on a closed ring — a way whose ends meet, or ways that chain end
    //     to end back to the start, draw an island;
    //   • a STRETCH of it that leaves chart land and comes STRAIGHT back to
    //     chart land: the cells either side of the stretch along the line are
    //     LNDARE, every cell between is water Pass 2b would not block (the wet
    //     band, or water already protected), and no vertex strays more than a
    //     cell from the chord between the stretch's ends. A spit, a mole or a
    //     reclaimed pad drawn off the mainland is a U out and back, never
    //     straight; a coastline that leaves the grid or runs out onto uncharted
    //     or drying ground is not anchored;
    //   • with charted water on BOTH sides at every cell: the neighbours square
    //     to the line's own direction, found by walking the line a fixed
    //     distance either side (so vertex spacing cannot skew it), stepping
    //     over this stretch's own staircase only — never over another stretch
    //     of coastline, such as the far side of a spit.
    // A cell is exempt only when every line that touches it agrees; any other
    // cell blocks (or relaxes in a relax zone) exactly as before. Drying bands
    // never claim, so a coastline over one still blocks. An exempt cell stays
    // honest 40x CAUTION for good: no lead prefers it or rescues its depth
    // (Pass 5b, coastConflict).
    const coastline = layers.COASTLINE?.features ?? [];
    const tPassCoast = Date.now();
    // Pass 2b closing-line cells, allocated on the first one.
    let coastConflict: Uint8Array | null = null;
    if (coastline.length > 0) {
        const coastParts: Position[][] = [];
        const coastIsShore: boolean[] = [];
        for (const f of coastline) {
            const g = f.geometry;
            if (!g) continue;
            let lineRings: Position[][] = [];
            if (g.type === 'LineString') lineRings = [(g as LineString).coordinates];
            else if (g.type === 'MultiLineString') lineRings = (g as MultiLineString).coordinates;
            else continue;
            const shore = (f.properties as { natural?: unknown } | null)?.natural === 'coastline';
            for (const coords of lineRings) {
                if (coords.length < 2) continue;
                coastParts.push(coords);
                coastIsShore.push(shore);
            }
        }
        // Rings are chained from the shoreline ways only.
        const shoreIdx: number[] = [];
        coastParts.forEach((_, p) => {
            if (coastIsShore[p]) shoreIdx.push(p);
        });
        const shoreOnRing = coastlineRingParts(shoreIdx.map((p) => coastParts[p]));
        const mayClose = new Array<boolean>(coastParts.length).fill(false);
        shoreIdx.forEach((p, k) => {
            mayClose[p] = !shoreOnRing[k];
        });

        const COAST_HIT = 1;
        const COAST_CLOSING = 2;
        const COAST_LAND = 4;
        const coastFlag = new Uint8Array(width * height);
        const inGrid = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < width && y < height;
        const partCells = (coords: Position[], i: number) =>
            bresenhamCells(
                Math.floor((coords[i][0] - minLon) / dLon),
                Math.floor((coords[i][1] - minLat) / dLat),
                Math.floor((coords[i + 1][0] - minLon) / dLon),
                Math.floor((coords[i + 1][1] - minLat) / dLat),
            );
        for (const coords of coastParts) {
            for (let i = 0; i < coords.length - 1; i++) {
                for (const c of partCells(coords, i)) {
                    if (inGrid(c.x, c.y)) coastFlag[c.y * width + c.x] |= COAST_HIT;
                }
            }
        }

        // Every verdict below reads Pass 1/2 state only, so it does not depend
        // on the order the lines are drawn in.
        const chartLand = (idx: number): boolean => landBlocked[idx] === 1 || relaxedLand?.[idx] === 1;
        const overWetBand = (idx: number): boolean => wetChartClaim[idx] === 1 && protectedCells[idx] !== 1;
        const openWater = (idx: number): boolean => overWetBand(idx) || protectedCells[idx] === 1;

        // Line geometry in metres from the grid origin (a cell is resolutionM
        // on both axes), with the distance along the line at each vertex.
        interface CoastWalk {
            xs: Float64Array;
            ys: Float64Array;
            cum: Float64Array;
        }
        const walkOf = (coords: Position[]): CoastWalk => {
            const n = coords.length;
            const xs = new Float64Array(n);
            const ys = new Float64Array(n);
            const cum = new Float64Array(n);
            for (let v = 0; v < n; v++) {
                xs[v] = (coords[v][0] - minLon) * mPerLon;
                ys[v] = (coords[v][1] - minLat) * M_PER_DEG_LAT;
                if (v > 0) cum[v] = cum[v - 1] + Math.hypot(xs[v] - xs[v - 1], ys[v] - ys[v - 1]);
            }
            return { xs, ys, cum };
        };
        // The point `s` metres along the line, clamped to its ends.
        const pointAt = (w: CoastWalk, s: number): [number, number] => {
            const last = w.cum.length - 1;
            if (s <= 0) return [w.xs[0], w.ys[0]];
            if (s >= w.cum[last]) return [w.xs[last], w.ys[last]];
            let lo = 0;
            let hi = last;
            while (hi - lo > 1) {
                const mid = (lo + hi) >> 1;
                if (w.cum[mid] <= s) lo = mid;
                else hi = mid;
            }
            const len = w.cum[hi] - w.cum[lo];
            const t = len > 0 ? (s - w.cum[lo]) / len : 0;
            return [w.xs[lo] + (w.xs[hi] - w.xs[lo]) * t, w.ys[lo] + (w.ys[hi] - w.ys[lo]) * t];
        };
        const distToChord = (px: number, py: number, ax: number, ay: number, bx: number, by: number): number => {
            const dx = bx - ax;
            const dy = by - ay;
            const l2 = dx * dx + dy * dy;
            const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
            return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
        };

        // Each candidate line's cells in order along it (consecutive repeats
        // dropped), with the distance along the line at each and the stretch
        // (run) it belongs to.
        interface CoastStep {
            x: number;
            y: number;
            s: number;
            seg: number;
            run: number;
        }
        const NO_RUN = -1;
        // Which stretch owns each coastline cell: a closing stretch's id, or
        // OWNER_OTHER once anything else touches it (another stretch or line).
        const OWNER_OTHER = -2;
        const cellOwner = new Map<number, number>();
        const own = (idx: number, owner: number): void => {
            const held = cellOwner.get(idx);
            if (held === undefined) cellOwner.set(idx, owner);
            else if (held !== owner) cellOwner.set(idx, OWNER_OTHER);
        };
        const runs: Array<{ s0: number; s1: number }> = [];
        const walks: Array<CoastWalk | null> = coastParts.map(() => null);
        const seqs: Array<CoastStep[] | null> = coastParts.map(() => null);
        const stepIdx = (st: CoastStep | undefined): number => (st && inGrid(st.x, st.y) ? st.y * width + st.x : -1);
        for (let p = 0; p < coastParts.length; p++) {
            const coords = coastParts[p];
            if (!mayClose[p]) {
                for (let i = 0; i < coords.length - 1; i++) {
                    for (const c of partCells(coords, i)) {
                        if (inGrid(c.x, c.y)) own(c.y * width + c.x, OWNER_OTHER);
                    }
                }
                continue;
            }
            const w = walkOf(coords);
            const seq: CoastStep[] = [];
            for (let i = 0; i < coords.length - 1; i++) {
                const ax = w.xs[i];
                const ay = w.ys[i];
                const dx = w.xs[i + 1] - ax;
                const dy = w.ys[i + 1] - ay;
                const l2 = dx * dx + dy * dy;
                for (const c of partCells(coords, i)) {
                    const prev = seq[seq.length - 1];
                    if (prev && prev.x === c.x && prev.y === c.y) continue;
                    // Distance along the line: the cell centre projected onto
                    // this segment.
                    const cx = (c.x + 0.5) * resolutionM;
                    const cy = (c.y + 0.5) * resolutionM;
                    const t = l2 > 0 ? Math.max(0, Math.min(1, ((cx - ax) * dx + (cy - ay) * dy) / l2)) : 0;
                    seq.push({ x: c.x, y: c.y, s: w.cum[i] + t * Math.sqrt(l2), seg: i, run: NO_RUN });
                }
            }
            for (let k = 0; k < seq.length; ) {
                const first = stepIdx(seq[k]);
                if (first < 0 || !openWater(first)) {
                    k++;
                    continue;
                }
                let e = k;
                while (e + 1 < seq.length) {
                    const next = stepIdx(seq[e + 1]);
                    if (next < 0 || !openWater(next)) break;
                    e++;
                }
                // From chart land, straight back to chart land.
                const before = stepIdx(seq[k - 1]);
                const after = stepIdx(seq[e + 1]);
                let closing = before >= 0 && after >= 0 && chartLand(before) && chartLand(after);
                if (closing) {
                    const [ax, ay] = pointAt(w, seq[k].s);
                    const [bx, by] = pointAt(w, seq[e].s);
                    for (let v = seq[k].seg + 1; closing && v <= seq[e].seg; v++) {
                        if (w.cum[v] <= seq[k].s || w.cum[v] >= seq[e].s) continue;
                        if (distToChord(w.xs[v], w.ys[v], ax, ay, bx, by) > resolutionM) closing = false;
                    }
                }
                if (closing) {
                    const id = runs.length;
                    runs.push({ s0: seq[k].s, s1: seq[e].s });
                    for (let j = k; j <= e; j++) seq[j].run = id;
                }
                k = e + 1;
            }
            for (const st of seq) {
                const idx = stepIdx(st);
                if (idx >= 0) own(idx, st.run >= 0 ? st.run : OWNER_OTHER);
            }
            walks[p] = w;
            seqs[p] = seq;
        }

        // Charted water on this side: the first cell within two steps along
        // (ox, oy) that is not this stretch's own coastline.
        const wetSide = (x: number, y: number, ox: number, oy: number, run: number): boolean => {
            for (let k = 1; k <= 2; k++) {
                const sx = x + ox * k;
                const sy = y + oy * k;
                if (!inGrid(sx, sy)) return false;
                const s = sy * width + sx;
                if (coastFlag[s] & COAST_HIT) {
                    if (cellOwner.get(s) !== run) return false; // another stretch of coastline
                    continue;
                }
                if (chartLand(s)) return false;
                return wetChartClaim[s] === 1 || depareVerdict[s] > 0 || osmWaterCells[s] === 1;
            }
            return false;
        };
        for (let p = 0; p < coastParts.length; p++) {
            const seq = seqs[p];
            const w = walks[p];
            if (!seq || !w) {
                const coords = coastParts[p];
                for (let i = 0; i < coords.length - 1; i++) {
                    for (const c of partCells(coords, i)) {
                        if (inGrid(c.x, c.y)) coastFlag[c.y * width + c.x] |= COAST_LAND;
                    }
                }
                continue;
            }
            for (const st of seq) {
                const idx = stepIdx(st);
                if (idx < 0) continue;
                let closing = false;
                if (st.run >= 0 && cellOwner.get(idx) === st.run && overWetBand(idx)) {
                    // The line's own direction, walked a cell either side of
                    // this point and kept to the stretch (a stretch shorter
                    // than that takes the line either side of it).
                    const { s0, s1 } = runs[st.run];
                    let lo = Math.max(s0, st.s - resolutionM);
                    let hi = Math.min(s1, st.s + resolutionM);
                    if (hi - lo < resolutionM / 2) {
                        lo = st.s - resolutionM;
                        hi = st.s + resolutionM;
                    }
                    const [ax, ay] = pointAt(w, lo);
                    const [bx, by] = pointAt(w, hi);
                    const len = Math.hypot(bx - ax, by - ay);
                    if (len > 1e-6) {
                        // Cells are square in metres, so the unit normal
                        // rounds straight to a neighbour offset.
                        const ox = Math.round(-(by - ay) / len);
                        const oy = Math.round((bx - ax) / len);
                        closing =
                            (ox !== 0 || oy !== 0) &&
                            wetSide(st.x, st.y, ox, oy, st.run) &&
                            wetSide(st.x, st.y, -ox, -oy, st.run);
                    }
                }
                coastFlag[idx] |= closing ? COAST_CLOSING : COAST_LAND;
            }
        }
        for (let idx = 0; idx < coastFlag.length; idx++) {
            const flag = coastFlag[idx];
            if ((flag & COAST_HIT) === 0) continue;
            if (protectedCells[idx]) continue;
            if ((flag & COAST_LAND) === 0 && (flag & COAST_CLOSING) !== 0) {
                // A closing line across charted wet water: caution, protected.
                protectedCells[idx] = 1;
                wetConflict[idx] = 1;
                (coastConflict ??= new Uint8Array(width * height))[idx] = 1;
                continue;
            }
            if (relaxedLndare || relaxMask[idx] === 1) {
                if (cells[idx] === UNKNOWN_OPEN) cells[idx] = CAUTION;
                if (relaxedLand) relaxedLand[idx] = 1;
            } else {
                cells[idx] = BLOCKED;
                hardBlocked[idx] = 1;
                landBlocked[idx] = 1;
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
    // Carve at EVERY resolution. The Mooloolaba over-drive is a RIVERSIDE
    // marina reach routed by tier-2 fairlead on the COARSE grid — fairlead
    // validates its lateral-mark path against the grid land mask, so blocking
    // the berth cells there makes it decline over the pens and A* takes the open
    // channel. A fine-res-only carve never touched it. Endpoint reachability is
    // preserved by snapToNavigable (searches ~8 cells / a few hundred metres),
    // so a berth-start/berth-end still snaps out to the channel even if a tight
    // basin collapses to a solid block at 50 m. Where a carve would truly
    // disconnect a fine marina leg, routeMarina returns null → the span falls
    // back to its coarse slice, so this can only improve a marina, never break a
    // route.
    const berthFeatures = layers.BERTH?.features ?? [];
    const tPassBerth = Date.now();
    let berthCellsBlocked = 0;
    // Marked distinctly from landBlocked so the fine-canal gate can tell a
    // marina's finger-pontoon run apart from ordinary land (forces the fine
    // pass on a berth-dense span). Allocated only when berths exist.
    const berthBlocked = berthFeatures.length > 0 ? new Uint8Array(width * height) : undefined;
    if (berthFeatures.length > 0 && berthBlocked) {
        // Keep a corridor (the cell + its 8 neighbours) around any canal LINE
        // open — a curated marina fairway / canal exit must never be re-blocked
        // by a pontoon that rasterises a cell away.
        const nearCanalLine = (x: number, y: number): boolean => {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = x + dx;
                    const ny = y + dy;
                    if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                    if (canalLineCarved[ny * width + nx] === 1) return true;
                }
            }
            return false;
        };
        const blockBerthCell = (x: number, y: number): void => {
            if (x < 0 || y < 0 || x >= width || y >= height) return;
            if (nearCanalLine(x, y)) return; // never wall off a fairway/canal corridor
            const idx = y * width + x;
            cells[idx] = BLOCKED;
            hardBlocked[idx] = 1;
            landBlocked[idx] = 1;
            berthBlocked[idx] = 1;
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
    if (berthBlocked) grid.berthBlocked = berthBlocked;

    // ── Pass 3: point obstructions — block radius around each ──────
    // obstnBlocked marks every cell a hazard (OBSTRN/WRECKS/UWTROC) claimed,
    // INDEPENDENTLY of landBlocked — the land-conflict reopen (NTM survey
    // zones; chart transits did too until the Phase 1 review) keys off
    // "landBlocked ∧ DEPARE claim" and must
    // never resurrect a cell that is ALSO a wreck buffer just because land
    // paint and a depth band overlap it too (adversarial-review finding #7).
    const obstnBlocked = new Uint8Array(width * height);
    // markDiscBlocked: cells blocked by an IALA MARK-INFERENCE disc (the
    // oriented half-circles / point buffers synthesised from solo
    // laterals + cardinals), NOT by a charted obstruction. The A* cost
    // treats both as blocked — the robot stays conservative — but the
    // TRACER verdict must not call an inference "a charted hazard" over
    // charted 5-6 m water (Shane 2026-07-14, Skirmish Point: "it says
    // crossing a hazard?? but there are not").
    const markDiscBlocked = new Uint8Array(width * height);
    // furnitureHazardBlocked: cells a hazard with NO S-57 identity closed (an
    // OSM reef, an aeroway — router furniture other than a mark's disc or a
    // clearance bar). The final audit (hazardBufferSegments) reads charted
    // hazards only, so its clean verdict never clears these (fix-up,
    // 2026-10-03: shallowRuns names a charted keep-out cell HAZARD only where
    // the audit agrees). Allocated when such a feature exists.
    let furnitureHazardBlocked: Uint8Array | undefined;
    // deepHazardOnly: cells closed ONLY by charted hazards sounded deep enough
    // for this keel (VALSOU >= draft + UKC), which the final audit exempts
    // (safetyAudit hazardBufferSegments), so the engine never draws them red
    // for the hazard. tier2RedLoad weighs a hazard keep-out double, as "no
    // tide lifts a rock" — never these (fix-up review, 2026-10-03). Allocated
    // when such a hazard exists; any other claim on a cell clears it.
    let deepHazardOnly: Uint8Array | undefined;
    const claimHazardCell = (idx: number, isDeep: boolean): void => {
        if (isDeep) {
            if (obstnBlocked[idx] === 0) (deepHazardOnly ??= new Uint8Array(width * height))[idx] = 1;
        } else if (deepHazardOnly) deepHazardOnly[idx] = 0;
        obstnBlocked[idx] = 1;
    };
    const blockPointBuffer = (
        lat: number,
        lon: number,
        isMarkDisc: boolean,
        isFurniture = false,
        isDeep = false,
    ): void => {
        const dLatBuf = obstructionBufferM / M_PER_DEG_LAT;
        const dLonBuf = obstructionBufferM / mPerLon;
        const x0 = Math.max(0, Math.floor((lon - dLonBuf - minLon) / dLon));
        const x1 = Math.min(width - 1, Math.ceil((lon + dLonBuf - minLon) / dLon));
        const y0 = Math.max(0, Math.floor((lat - dLatBuf - minLat) / dLat));
        const y1 = Math.min(height - 1, Math.ceil((lat + dLatBuf - minLat) / dLat));
        // Every cell whose SQUARE the buffer disc touches — the cell holding
        // the hazard always among them (fix-up, 2026-09-30). Testing the cell
        // CENTRE against the 30 m buffer blocked nothing for a wreck at a cell
        // corner (a 50 m cell's half-diagonal is 35.4 m), and the route passed
        // 25 m from it.
        for (let y = y0; y <= y1; y++) {
            const cellLat = minLat + (y + 0.5) * dLat;
            const offLatM = Math.max(0, Math.abs(lat - cellLat) - dLat / 2) * M_PER_DEG_LAT;
            for (let x = x0; x <= x1; x++) {
                const cellLon = minLon + (x + 0.5) * dLon;
                const offLonM = Math.max(0, Math.abs(lon - cellLon) - dLon / 2) * mPerLon;
                const dM = Math.hypot(offLatM, offLonM);
                if (dM <= obstructionBufferM) {
                    cells[y * width + x] = BLOCKED;
                    hardBlocked[y * width + x] = 1;
                    claimHazardCell(y * width + x, isDeep);
                    if (isMarkDisc) markDiscBlocked[y * width + x] = 1;
                    if (isFurniture) (furnitureHazardBlocked ??= new Uint8Array(width * height))[y * width + x] = 1;
                }
            }
        }
    };
    // A charted hazard AREA's keep-out, the point rule's twin (router round 2
    // part 3, 2026-10-03): every cell whose SQUARE comes within the buffer of
    // one of its rings (holes included) — the centre-inside cells are the
    // rasteriser's. Only the area's own cells used to close, and the land skin
    // (Pass 6) is skipped beside deep water, so in open water a chord between
    // cell centres clipped foul ground: Coral Sea Marina → Daydream Island ran
    // 5.9 km through the NE corner of a 208 × 285 m OBSTRN area (CATOBS 6,
    // WATLEV 4) on AU421148, red, and the router still chose it. Measured
    // exactly, as safetyAudit hazardBufferSegments reads the area, per ring
    // edge over the cells of its padded box (a cheap centre-distance test
    // settles most of them).
    //
    // By the cell's size against the keep-out (fix-up review, 2026-10-03): a
    // square that touches the buffer closes the whole cell, so the ring grows
    // by up to a cell's diagonal — 70 m on a 50 m grid, 570 m on the 400 m
    // strict pre-check, where it closed 500–700 m passages between two foul
    // areas and the pre-check, trusted never to close more than the fine
    // grid, refused the route as 'uncharted-corridor' at once.
    //   • 'square' while a cell is no wider than twice the keep-out (the app's
    //     50 m grid at 60 m, the 10 m marina pass, the tracer): every open
    //     cell's whole square stays outside the buffer, so a line between
    //     open cell centres keeps it — the field fix above.
    //   • 'centre' up to four times the keep-out (a big route's coarsened
    //     grid): a cell closes when its centre lies within the buffer, so a
    //     passage wider than the buffer twice and a cell stays open; the final
    //     audit still names any line that comes inside it.
    //   • 'none' beyond that (the 400 m pre-check): the area's own cells only,
    //     as before part 3 — that grid measures uncharted water, nothing else.
    const areaRing: 'square' | 'centre' | 'none' =
        resolutionM <= 2 * obstructionBufferM ? 'square' : resolutionM <= 4 * obstructionBufferM ? 'centre' : 'none';
    const halfLonM = (dLon * mPerLon) / 2;
    const halfLatM = (dLat * M_PER_DEG_LAT) / 2;
    const halfDiagM = Math.hypot(halfLonM, halfLatM);
    /** Metres from the cell square centred at the origin to the segment p→q (metres from that centre). */
    const squareToSegmentM = (px: number, py: number, qx: number, qy: number): number => {
        // Liang–Barsky: does the segment enter the square at all?
        let t0 = 0;
        let t1 = 1;
        const ex = qx - px;
        const ey = qy - py;
        const clip = (p: number, q: number): boolean => {
            if (p === 0) return q >= 0;
            const r = q / p;
            if (p < 0) {
                if (r > t1) return false;
                if (r > t0) t0 = r;
            } else {
                if (r < t0) return false;
                if (r < t1) t1 = r;
            }
            return true;
        };
        if (
            clip(-ex, px + halfLonM) &&
            clip(ex, halfLonM - px) &&
            clip(-ey, py + halfLatM) &&
            clip(ey, halfLatM - py) &&
            t0 <= t1
        )
            return 0;
        // Disjoint: the nearest approach is an end to the square or a corner to the segment.
        const toSquare = (x: number, y: number): number =>
            Math.hypot(Math.max(Math.abs(x) - halfLonM, 0), Math.max(Math.abs(y) - halfLatM, 0));
        const l2 = ex * ex + ey * ey;
        const toSegment = (x: number, y: number): number => {
            const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - px) * ex + (y - py) * ey) / l2)) : 0;
            return Math.hypot(x - (px + t * ex), y - (py + t * ey));
        };
        return Math.min(
            toSquare(px, py),
            toSquare(qx, qy),
            toSegment(-halfLonM, -halfLatM),
            toSegment(halfLonM, -halfLatM),
            toSegment(halfLonM, halfLatM),
            toSegment(-halfLonM, halfLatM),
        );
    };
    let areaKeepOutCells = 0;
    const blockAreaKeepOut = (g: Polygon | MultiPolygon): void => {
        if (areaRing === 'none') return;
        const dLonBuf = obstructionBufferM / mPerLon;
        const dLatBuf = obstructionBufferM / M_PER_DEG_LAT;
        const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
        for (const poly of polys)
            for (const ring of poly)
                for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                    const [lonA, latA] = ring[j];
                    const [lonB, latB] = ring[i];
                    if (!Number.isFinite(lonA + latA + lonB + latB)) continue;
                    const x0 = Math.max(0, Math.floor((Math.min(lonA, lonB) - dLonBuf - minLon) / dLon));
                    const x1 = Math.min(width - 1, Math.floor((Math.max(lonA, lonB) + dLonBuf - minLon) / dLon));
                    const y0 = Math.max(0, Math.floor((Math.min(latA, latB) - dLatBuf - minLat) / dLat));
                    const y1 = Math.min(height - 1, Math.floor((Math.max(latA, latB) + dLatBuf - minLat) / dLat));
                    if (x0 > x1 || y0 > y1) continue;
                    for (let y = y0; y <= y1; y++) {
                        const cellLat = minLat + (y + 0.5) * dLat;
                        const py = (latA - cellLat) * M_PER_DEG_LAT;
                        const qy = (latB - cellLat) * M_PER_DEG_LAT;
                        for (let x = x0; x <= x1; x++) {
                            const idx = y * width + x;
                            // Closed already — unless only by a deep hazard,
                            // which this keep-out's claim must clear.
                            const held = obstnBlocked[idx] === 1;
                            if (held && deepHazardOnly?.[idx] !== 1) continue;
                            const cellLon = minLon + (x + 0.5) * dLon;
                            const px = (lonA - cellLon) * mPerLon;
                            const qx = (lonB - cellLon) * mPerLon;
                            // The centre's distance bounds the square's within half a diagonal.
                            const ex = qx - px;
                            const ey = qy - py;
                            const l2 = ex * ex + ey * ey;
                            const t = l2 > 0 ? Math.max(0, Math.min(1, (-px * ex - py * ey) / l2)) : 0;
                            const centreM = Math.hypot(px + t * ex, py + t * ey);
                            if (areaRing === 'centre') {
                                // Strictly inside, as the audit's own `< bufferM`.
                                if (centreM >= obstructionBufferM) continue;
                            } else {
                                if (centreM > obstructionBufferM + halfDiagM) continue;
                                if (
                                    centreM > obstructionBufferM &&
                                    squareToSegmentM(px, py, qx, qy) > obstructionBufferM
                                )
                                    continue;
                            }
                            if (held) {
                                deepHazardOnly![idx] = 0;
                                continue;
                            }
                            cells[idx] = BLOCKED;
                            hardBlocked[idx] = 1;
                            obstnBlocked[idx] = 1;
                            areaKeepOutCells++;
                        }
                    }
                }
    };

    // Charted deep enough for this vessel by the chart itself: an S-57 depth
    // area (DEPARE / DRGARE) owns the cell as deep, no S-57 band at the owning
    // survey charts it shallower, and nothing has blocked it (land paint
    // decision 1 upheld, a berth). OSM-vouched water has no depth to offer.
    // Decision-1 water whose finest band is deep enough (d1DeepBand) counts
    // too: the disc leaves it open and it stays what decision 1 made it —
    // caution, never deep.
    //
    // …and only inside a charted DREDGED AREA or FAIRWAY (S-57 DRGARE /
    // FAIRWY; review fix-up, 2026-10-01): the dredged river mouth the yield
    // was made for. Natural deep water on a solo lateral's inferred side is
    // exactly the strip between a reef-edge mark and its reef that the chart
    // may not show (the Scarborough pattern): it stays closed.
    const needForDeepM = draftM + safetyM;
    let dredgedOrFairway: Uint8Array | null = null;
    const inDredgedOrFairway = (idx: number): boolean => {
        if (!dredgedOrFairway) {
            const mask = new Uint8Array(width * height);
            for (const f of [...(layers.DRGARE?.features ?? []), ...(layers.FAIRWY?.features ?? [])]) {
                const g = f.geometry;
                if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) continue;
                if (!isS57ChartProps(f.properties as Record<string, unknown> | null)) continue;
                rasterizePolygonCells(grid, g as Polygon | MultiPolygon, (x, y) => {
                    mask[y * width + x] = 1;
                });
            }
            dredgedOrFairway = mask;
        }
        return dredgedOrFairway[idx] === 1;
    };
    const chartedDeepForVessel = (idx: number): boolean =>
        !Number.isNaN(cells[idx]) &&
        (d1DeepBand?.[idx] === 1 || (s57DeepAt[idx] !== 0 && s57ShallowAt[idx] === 0 && cells[idx] >= needForDeepM)) &&
        inDredgedOrFairway(idx);
    // Beyond the disc's inner reach (a cable, _innerKeepOutM) the CHART speaks
    // where it charts the water (2026-10-01 review fix-up): a cell an S-57
    // depth area owns that never dries keeps the chart's own verdict — deep,
    // or shallow and caution. Water no S-57 band charts (vouched only by OSM
    // or Mapbox, or unknown), drying and land stay closed to the full reach:
    // that is where an undrawn fringing reef would lie. Measured on the real
    // Brisbane cells: closing charted water out to 550–650 m from the
    // shipping channel's unpaired marks pushed the bay → Lytton route onto a
    // drying clip and refused it at a 2.5 m tide top.
    const chartedWaterForVessel = (idx: number): boolean =>
        !Number.isNaN(cells[idx]) &&
        (s57DeepAt[idx] !== 0 || s57ShallowAt[idx] !== 0 || d1DeepBand?.[idx] === 1) &&
        s57DryingAt[idx] === 0;
    let markDiscYieldedCells = 0;

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
        // Mark-inference features: the oriented half-discs + the raw
        // point-hazards they were built from. Blocked the same, but the
        // markDiscBlocked mask lets the tracer speak honestly about them.
        const cls = (f.properties as { _class?: string } | null)?._class;
        const isMarkDisc =
            cls === 'iala-oriented-hazard' || cls === 'direct-hazard' || cls === 'lateral-marker-as-hazard';
        const props = f.properties as Record<string, unknown> | null;
        const isCharted = isS57ChartProps(props);
        // Router furniture the final audit does not read (furnitureHazardBlocked).
        const isFurniture = !isMarkDisc && !isClearanceBar && !isCharted;
        // Charted deep enough for this keel: the audit exempts it (deepHazardOnly).
        const isDeep = isCharted && !isMarkDisc && !isClearanceBar && hazardValsouM(props) >= needForDeepM - 1e-9;
        if (f.geometry.type === 'Point') {
            const [lon, lat] = (f.geometry as Point).coordinates;
            blockPointBuffer(lat, lon, isMarkDisc, isFurniture, isDeep);
        } else if (f.geometry.type === 'MultiPoint') {
            // As the final audit reads one (hazardBufferSegments): each point its own keep-out.
            for (const [lon, lat] of (f.geometry as MultiPoint).coordinates)
                blockPointBuffer(lat, lon, isMarkDisc, isFurniture, isDeep);
        } else if (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon') {
            // A SOLO lateral's keep-out (its side inferred from the shore
            // bearing, InshoreRouter orientHazardsTowardLand) never closes a
            // charted dredged channel or fairway deep enough for this vessel
            // (2026-10-01): three such discs closed the dredged Brisbane River
            // mouth and sent the route over the West Banks. Within a cable of
            // the mark every other cell stays blocked; beyond it, water an
            // S-57 depth area charts and that never dries is the chart's, and
            // uncharted (vouched-only), drying and land cells stay blocked.
            const discProps = f.properties as {
                _yieldsToChartedDeep?: unknown;
                _innerKeepOutM?: unknown;
                _markerLat?: unknown;
                _markerLon?: unknown;
            } | null;
            const yieldsToDeep = isMarkDisc && discProps?._yieldsToChartedDeep === true;
            const innerM = typeof discProps?._innerKeepOutM === 'number' ? discProps._innerKeepOutM : Infinity;
            const markLat = typeof discProps?._markerLat === 'number' ? discProps._markerLat : NaN;
            const markLon = typeof discProps?._markerLon === 'number' ? discProps._markerLon : NaN;
            const hasInner = yieldsToDeep && Number.isFinite(innerM) && Number.isFinite(markLat + markLon);
            // A cell is in the inner reach when its centre is within it.
            const inInnerReach = (x: number, y: number): boolean => {
                if (!hasInner) return true;
                const dyM = (minLat + (y + 0.5) * dLat - markLat) * M_PER_DEG_LAT;
                const dxM = (minLon + (x + 0.5) * dLon - markLon) * mPerLon;
                return Math.hypot(dxM, dyM) <= innerM;
            };
            // For polygon obstructions, treat the polygon area itself as blocked.
            rasterizePolygonCells(grid, f.geometry as Polygon | MultiPolygon, (x, y) => {
                const idx = y * width + x;
                if (yieldsToDeep && (inInnerReach(x, y) ? chartedDeepForVessel(idx) : chartedWaterForVessel(idx))) {
                    markDiscYieldedCells++;
                    return;
                }
                cells[idx] = BLOCKED;
                hardBlocked[idx] = 1;
                claimHazardCell(idx, isDeep);
                if (isMarkDisc) markDiscBlocked[idx] = 1;
                if (isClearanceBar) clearanceBarred[idx] = 1;
                if (isFurniture) (furnitureHazardBlocked ??= new Uint8Array(width * height))[idx] = 1;
            });
            // A CHARTED area gets a point's keep-out round it. Router furniture
            // (mark discs, clearance bars, OSM reefs and aeroways) carries no
            // S-57 identity and keeps its own footprint, as the audit reads it.
            // Nor does an area the chart sounds deep enough for this keel
            // (VALSOU >= draft + UKC; fix-up review, 2026-10-03): the audit
            // exempts it, and its 60 m ring closed seven cells of the Brisbane
            // River's dredged fairway round 21 × 46 m of foul ground charted
            // 5.4 m (CATOBS 7), so a leg 40 m from it read "crosses a charted
            // hazard" while the route's line called it clear. Its own cells
            // close as before.
            if (!isMarkDisc && !isClearanceBar && isCharted && !isDeep)
                blockAreaKeepOut(f.geometry as Polygon | MultiPolygon);
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
    if (ENGINE_DEBUG && areaKeepOutCells > 0)
        engineLog.warn(
            `pass3: charted hazard areas' ${obstructionBufferM} m keep-out closed ${areaKeepOutCells} cell(s)`,
        );
    if (markDiscYieldedCells > 0)
        engineLog.warn(
            `pass3: solo-lateral keep-outs left ${markDiscYieldedCells} cell(s) open — a charted dredged channel or fairway deep enough (≥ ${needForDeepM.toFixed(1)} m) within a cable, or S-57-charted water that never dries beyond it`,
        );

    // ── Pass 4: FAIRWY + DRGARE — mark preferred channel cells ─────
    // A marked channel is PREFERRED (A* rides it at 1.0×, cellCostMultiplier)
    // and nothing more: it never changes a cell's navigability or depth. The
    // chart's depth bands are the authority for "is there enough water" — a
    // dredged area's own DRVAL1 among them (Pass 1) — and the land passes for
    // "is this land" (owner decision 1 in Pass 2). Fairways CAN overlap
    // shallow flats at low tide; a shallow cell here stays honest CAUTION
    // (red, 'needs tide', its real depth kept in shallowDepthM).
    //
    // Phase 2a review (2026-09-30): this pass used to write a 5 m "rescue
    // depth" into every shallow, blocked or land cell under a chart FAIRWY or
    // DRGARE, or an OSM water polygon promoted to one (`_promotePreferred`,
    // InshoreRouter) — land paint at any scale, decision-1 conflict water,
    // a charted wreck's buffer, a pontoon, and a 1.3 m dredged area for a
    // 2.4 m keel all read 5 m preferred water, and the final land audit could
    // not catch it (it counted any FAIRWY/DRGARE overlap as water). Owner
    // decisions: leads, fairways and dredged areas never override land,
    // hazards or depth. OSM-vouched water (the promoted river polygons are
    // also in DEPARE as natural=water) keeps clean navigable under land paint
    // through Pass 2's own rule, unchanged.
    //
    // The synthetic lateral-mark ribbon (chain-ordered port/starboard
    // midpoints from InshoreRouter Step 5) keeps its one narrow repair: where
    // LAND PAINT hard-blocked a cell the chart's own DEPARE calls water, it
    // restores that DEPARE verdict (real depth, or CAUTION if genuinely
    // shallow) — never fabricated depth, never a hazard buffer, never land
    // decision 1 upheld over an S-57 band.
    let ribbonUnblockedCells = 0; // synthetic mark-ribbon cells un-blocked from LNDARE bleed (DEPARE-vouched)
    // Cells ONLY a channel outline (here), a paired mark's disc (Pass 5) or a
    // lead's corridor (Pass 5b) made preferred: still no evidence of water for
    // the no-water-evidence mask (grid.unvouched, grid.leadOnlyPreferred).
    // Allocated on the first such cell.
    let leadOnlyPreferred: Uint8Array | null = null;
    const markChannelPreference = (f: Feature): void => {
        if (!f.geometry || (f.geometry.type !== 'Polygon' && f.geometry.type !== 'MultiPolygon')) return;
        const g = f.geometry as Polygon | MultiPolygon;
        const props = f.properties as Record<string, unknown> | null;
        const isMarkRibbon = props?._class === 'synthetic-channel-segment';
        rasterizePolygonCells(grid, g, (x, y) => {
            const idx = y * width + x;
            // A low-clearance bar (fixed bridge) is impassable for this vessel
            // — not even preferred.
            if (clearanceBarred[idx] === 1) return;
            preferred[idx] = 1;
            // A fairway, a dredged area's outline or the lateral-mark ribbon
            // says where the channel is, not that there is water (Phase 2a
            // round-2 review, 2026-09-30): a cell with no chart band, no OSM
            // water and no protection under it stays unvouched, as between a
            // pair of marks (Pass 5) or along a lead (Pass 5b). Preferring it
            // unconditionally let a strict route cross a 1.9 NM gap no chart
            // covers all green once the ribbon (or a FAIRWY) spanned it.
            if (Number.isNaN(depareVerdict[idx]) && osmWaterCells[idx] !== 1 && protectedCells[idx] !== 1) {
                (leadOnlyPreferred ??= new Uint8Array(width * height))[idx] = 1;
            }
            if (!isMarkRibbon) return;
            // Restore the chart's DEPARE verdict ONLY where land paint
            // hard-blocked charted water: landBlocked, and neither a hazard
            // buffer (Pass 3's obstnBlocked; a wreck in a buoyed channel is
            // still a wreck) nor a berth or pontoon (Pass 2c). No DEPARE here
            // → real land → leave blocked.
            // Land paint that owner decision 1 upheld over an S-57 band (a
            // band at the same or a coarser scale, or unranked) is land here
            // too: restoring the band's depth would make it deep water.
            if (!Number.isNaN(cells[idx])) return;
            const v = depareVerdict[idx];
            if (
                hardBlocked[idx] === 1 &&
                landBlocked[idx] === 1 &&
                obstnBlocked[idx] !== 1 &&
                berthBlocked?.[idx] !== 1 &&
                !Number.isNaN(v) &&
                landUpheld?.[idx] !== 1
            ) {
                cells[idx] = v;
                ribbonUnblockedCells++;
            }
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
    // A paired mark's disc (here) marks leadOnlyPreferred like Pass 4 and
    // Pass 5b: preferred, but no evidence of water.
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
                    // PREFER the gate — A* rides it at 1.0×
                    // (cellCostMultiplier's flat-preferred doctrine) — and
                    // nothing more (Phase 2a round 2, 2026-09-30). The disc
                    // used to write a 5 m "rescue depth" into every CAUTION
                    // or blocked cell between the marks that was not land or
                    // conflict water: a pair laid across a charted 1 m bank
                    // read 5 m preferred water for a 2.4 m keel. The marks
                    // say where the channel is, not how deep it is — the same
                    // rule Pass 4 and the Pass 5b lead brush now follow
                    // (channelsNeverDeepen.test.ts). A charted-shallow cell
                    // stays CAUTION with its real depth (shallowDepthM, the
                    // tide window's input); land, hazards and conflict water
                    // stay what they are; and an uncharted cell between the
                    // marks stays UNKNOWN — no evidence of water, so still
                    // unvouched under the strict uncharted policy
                    // (leadOnlyPreferred, shared with the lead brush).
                    if (preferred[idx] === 0) {
                        preferred[idx] = 1;
                        (leadOnlyPreferred ??= new Uint8Array(width * height))[idx] = 1;
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

    // ── Pass 5b: navigation lines (leads) → preferred channel corridor ─
    // Charted leading/transit lines (chart NAVLNE CATNAV 3; OSM seamark
    // navigation_line) are the channel centreline ships steer along.
    // Bresenham-rasterise each into a ~3-cell-wide PREFERRED corridor so A*
    // is attracted onto the marked channel and rides it — at the flat 1.0×
    // preferred cost, through a bar the bathymetry reads shallow too. It never
    // changes a cell's depth or navigability (Phase 2a review, 2026-09-30:
    // leads never override depth; unknown is never green): a shallow cell on
    // a lead stays red CAUTION with its charted depth for the tide window.
    // Never touches hardBlocked (real land / charted hazard) cells. Runs
    // after Pass 2 (LNDARE, so hardBlocked is set) and before Pass 6 (buffer
    // skips preferred cells, so the corridor isn't sealed). The Brisbane
    // River mouth bar is the canonical case: the dredged cut isn't in chart
    // FAIRWY and the lateral markers are too sparse to stitch, but OSM has it
    // as navigation_line — without the corridor the route cut a CAUTION
    // diagonal straight across the bar instead of riding the channel.
    //
    // LEADS ONLY (navLineLeads): a chart clearing line (NAVLNE CATNAV 1)
    // marks the edge of a danger and a transit (CATNAV 2) is a bearing —
    // neither may be preferred or reopen land here. Filtered
    // again at this pass so a direct grid build (the tracer) can never
    // stamp one, whatever assembled the layers.
    //
    // ON-WATER SPANS ONLY (Phase 1): a leading line is drawn on to its
    // leading marks, usually ashore (Newport NAVLNE 2379 runs ~1.1 km over
    // LNDARE). Only the stretch over water is a lead; the land extension no
    // longer stamps a corridor or reopens land-painted cells.
    //
    // "Over water" is THIS GRID's verdict, cell by cell (Phase 1 review,
    // 2026-09-29), not the S-57-only vector clip (leadLandClip) this pass
    // used first. The grid already decides land against more evidence than
    // the chart's own layers: the OSM canal carve (Pass 1b), OSM-vouched
    // water under LNDARE (Passes 1/2), wet chart claims under LNDARE or an
    // OSM coastline (Passes 2/2b). The vector clip ignored the OSM evidence
    // and cut the Newport entrance lead (NAVLNE 406/3035) with a ~590 m gap
    // exactly in the entrance channel — LNDARE, no S-57 DEPARE, but water in
    // the grid through the canal carve — and the production-shape routes
    // (chart leads + OSM overlay) were refused or crossed ~1 km of land. A
    // line cell is ashore when land paint still blocks it (landBlocked and
    // not since restored — the mark ribbon keeps landBlocked but restores a
    // DEPARE verdict), or when a relax zone let land paint
    // through as CAUTION: no corridor is stamped around it.
    // The pre-clip leads when routeInshore's entry clip left them
    // (NAVLINE_GRID): this pass clips against the grid's own verdict below.
    const navlineFeatures = navLineLeads((layers.NAVLINE_GRID ?? layers.NAVLINE)?.features ?? []);
    const leadCellAshore = (x: number, y: number): boolean => {
        if (x < 0 || y < 0 || x >= width || y >= height) return false;
        const idx = y * width + x;
        return (landBlocked[idx] === 1 && Number.isNaN(cells[idx])) || relaxedLand?.[idx] === 1;
    };
    const tPassNavline = Date.now();
    const NAVLINE_BRUSH_CELLS = 1; // 1-cell Chebyshev radius → ~3-cell (≈150 m) wide corridor
    let navlineCellsMarked = 0;
    const stampNavlineCell = (cx: number, cy: number): void => {
        for (let dy = -NAVLINE_BRUSH_CELLS; dy <= NAVLINE_BRUSH_CELLS; dy++) {
            for (let dx = -NAVLINE_BRUSH_CELLS; dx <= NAVLINE_BRUSH_CELLS; dx++) {
                const nx = cx + dx;
                const ny = cy + dy;
                if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                const idx = ny * width + nx;
                // A lead NEVER reopens a blocked cell — land paint, a hazard
                // buffer or a clearance bar (the Dart Harbour community-edit
                // lesson, and "leads never override land").
                //
                // Phase 1 review (2026-09-29): chart NAVLNE used to reopen
                // "land paint over a DEPARE band" cells here, for the
                // Tangalooma sand-bar transit. Clipping the line to water was
                // not enough: this 1-cell brush around each on-water cell
                // still reopened land-painted cells past the clip point and to
                // each side of it (+37.5 m at 25 m, +75 m at 50 m, +150 m at
                // 100 m), so a lead across a land-painted drying spit up to
                // 150 m wide (50 m grid) was reopened all the way across as
                // 5 m preferred water — and on the real newport-shane cells
                // 115 of the 126 cells it still reopened at 50 m had a
                // hard-land centre. The on-water span is already on water,
                // so the reopen is gone. Whether LNDARE painted over a 0 m
                // band is land or 'needs tide' is an owner question for
                // Phase 4, not a brush side effect.
                //
                // Land a relax zone let through as CAUTION (hardBlocked 0) is
                // still land to every brush cell, not only the centre (final
                // review 2026-09-29): a lead on water beside the canal carve's
                // relaxed banks stamped them 5 m preferred.
                //
                // A Pass 2b closing-line cell (an OSM coastline over a charted
                // wet band) is the two sources disagreeing, never a charted
                // channel: it stays the 40x red CAUTION it is without a lead,
                // neither preferred nor rescued to depth (final review, second
                // pass, 2026-09-29 — a lead across coastline-only land that
                // slipped through stamped it 5 m preferred, and tideDirect
                // crossed it with 0 caution legs).
                if (hardBlocked[idx] === 1 || leadCellAshore(nx, ny) || coastConflict?.[idx] === 1) continue;
                // PREFER the lead — A* rides it at 1.0× (cellCostMultiplier's
                // flat-preferred doctrine), so it follows the channel through
                // a bar exactly as before — and NOTHING more. The brush used
                // to rescue every CAUTION or UNKNOWN cell within a cell of a
                // lead to 5 m preferred water (Phase 2a review, 2026-09-30:
                // 12 of the 31 CATNAV-3 leads on the real newport-shane cells,
                // up to 199 cells a lead, including bands charted 0 m and
                // drying, and decision-1 conflict water), so the router drew
                // a clean deep route where the overlay said 'needs tide'.
                // Owner decisions: leads never override depth, and unknown is
                // never green. A charted-shallow cell stays CAUTION with its
                // real depth (shallowDepthM, the tide window's input);
                // decision-1 water stays conflict CAUTION; an uncharted cell
                // stays UNKNOWN — and a lead is no evidence of water depth, so
                // it stays unvouched under the strict uncharted policy
                // (leadOnlyPreferred below).
                if (preferred[idx] === 0) {
                    preferred[idx] = 1; // attract A* onto the marked channel
                    (leadOnlyPreferred ??= new Uint8Array(width * height))[idx] = 1;
                    navlineCellsMarked++;
                }
            }
        }
    };
    for (const f of navlineFeatures) {
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
                    if (leadCellAshore(c.x, c.y)) continue; // the land extension stamps nothing
                    stampNavlineCell(c.x, c.y);
                }
            }
        }
    }
    markPass('pass5b-navline', tPassNavline, navlineFeatures.length);
    if (ENGINE_DEBUG && navlineFeatures.length > 0) {
        console.warn(
            `[inshoreEngine] NAVLINE: ${navlineFeatures.length} navigation lines → ${navlineCellsMarked} channel cells preferred`,
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
    // Which CAUTION cells are a wing's (round 2, 2026-10-02: the route's
    // caution reasons must never read a wing's red as a shallow band's).
    let wingCaution: Uint8Array | undefined;
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
            (wingCaution ??= new Uint8Array(width * height))[idx] = 1;
            if (cells[idx] === CAUTION && preferred[idx] === 0) continue; // already stamped
            cells[idx] = CAUTION;
            preferred[idx] = 0;
            wingCellsMarked++;
        }
    }
    if (wingCaution) grid.wingCaution = wingCaution;
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
                (preferred[idx] === 0 || leadOnlyPreferred?.[idx] === 1) &&
                Number.isNaN(depareVerdict[idx]) &&
                osmWaterCells[idx] === 0 &&
                protectedCells[idx] === 0
            ) {
                unvouched[idx] = 1;
                unvouchedCount++;
            }
        }
        grid.unvouched = unvouched;
        if (leadOnlyPreferred) grid.leadOnlyPreferred = leadOnlyPreferred;
        markPass('unvouched-mask', tPassUnvouched, unvouchedCount);
    }
    // ── Water no tide clears (owner decision 11, 2026-10-01) ─────────
    // Shane: "ok avoid water no tide can clear". PROOF, not suspicion: a
    // caution cell an S-57 band charts shallow is proved unclearable only
    // when the DEEPEST value its owning bands admit (DRVAL2, tracked in
    // Pass 1) plus the highest tide known for its place is still short of
    // draft + safety. A 0–2 m band at a 2.5 m top is not (2 + 2.5 ≥ 2.9); a
    // −2.2..0 m drying band is (0 + 2.5 < 2.9). A band with no DRVAL2, a
    // place with no ceiling, water no S-57 band charts shallow and a current
    // NtM survey zone (a least depth, not a bound) prove nothing — they route
    // as before, decision 10's red and chip unchanged.
    //
    // A 50 m cell is classed by its centre, so a proved cell may still hold
    // water a tide clears: one that a band a tide clears TOUCHES (its ring
    // passes through the cell; a coarser survey's band under a finer one's
    // claim does not count) stays open (fix-up, 2026-10-01: a 30 m creek
    // through drying flats had no cell centre in it, every cell along it was
    // closed, and the route was refused for "the only way through" the flats).
    // Every other proved cell is blocked — NaN like land; the carves never
    // tunnel them (NavGrid.noTideClears). The engine holds the finished route
    // to the chart itself (tideCeiling classifyNoTideRuns): a clip, a creek's
    // local way, or a crossing that is refused — and then routed again with
    // the crossed bands closed (`tideBarriers`: every cell each one touches,
    // where it is proved).
    if (tideProof && rankedDeepestM && rankedDeepUnknown && unrankedDeepestM && unrankedDeepUnknown) {
        const tPassTide = Date.now();
        const needM = draftM + safetyM;
        const ntmRise = grid.ntmRiseM;
        const proved = new Uint8Array(width * height);
        let provedCount = 0;
        for (let y = 0; y < height; y++) {
            const cellLat = minLat + (y + 0.5) * dLat;
            for (let x = 0; x < width; x++) {
                const idx = y * width + x;
                if (!(cells[idx] < 0) || s57ShallowAt[idx] === 0) continue;
                if (ntmRise !== undefined && !Number.isNaN(ntmRise[idx])) continue;
                if (rankedDeepUnknown[idx] === 1 || unrankedDeepUnknown[idx] === 1) continue;
                const r = rankedDeepestM[idx];
                const u = unrankedDeepestM[idx];
                const deepest = Number.isNaN(r) ? u : Number.isNaN(u) ? r : Math.max(r, u);
                if (Number.isNaN(deepest)) continue;
                const tide = tideLookup.at(cellLat, minLon + (x + 0.5) * dLon);
                if (!tide || deepest + tide.highestM >= needM - 1e-6) continue;
                proved[idx] = 1;
                provedCount++;
            }
        }
        const gridMaxLon = minLon + width * dLon;
        const gridMaxLat = minLat + height * dLat;
        /** Each cell a band's rings pass through (Bresenham per edge, edges
         *  clear of the grid skipped). */
        const ringCells = (g: Polygon | MultiPolygon, visit: (idx: number) => void): void => {
            const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
            for (const poly of polys) {
                for (const ring of poly) {
                    for (let i = 0; i + 1 < ring.length; i++) {
                        const [ax, ay] = ring[i];
                        const [bx, by] = ring[i + 1];
                        if (Math.max(ax, bx) < minLon || Math.min(ax, bx) > gridMaxLon) continue;
                        if (Math.max(ay, by) < minLat || Math.min(ay, by) > gridMaxLat) continue;
                        const cellsOnEdge = bresenhamCells(
                            Math.floor((ax - minLon) / dLon),
                            Math.floor((ay - minLat) / dLat),
                            Math.floor((bx - minLon) / dLon),
                            Math.floor((by - minLat) / dLat),
                        );
                        for (const c of cellsOnEdge) {
                            if (c.x < 0 || c.y < 0 || c.x >= width || c.y >= height) continue;
                            visit(c.y * width + c.x);
                        }
                    }
                }
            }
        };
        /** A band's claim on a cell a strictly finer survey owns is not read. */
        const outSurveyed = (rank: number | null, idx: number): boolean =>
            rank !== null && depareRank[idx] !== RANK_UNCLAIMED && compareSurveyRanks(rank, depareRank[idx]) < 0;
        const tideAtCell = (idx: number) =>
            tideLookup.at(minLat + (Math.floor(idx / width) + 0.5) * dLat, minLon + ((idx % width) + 0.5) * dLon);
        // The bands proved the only way through (TideBarrier.open; 125-05
        // review fix-up, 2026-10-09): open wherever their claim is read —
        // inside each, and in every cell its rings pass through. Everything
        // else no tide clears stays closed, so the route through them takes
        // the deep way round everywhere else.
        let opened: Uint8Array | null = null;
        for (const b of tideBarriers) {
            if (!b.open) continue;
            const open = (idx: number): void => {
                if (!outSurveyed(b.rank, idx)) (opened ??= new Uint8Array(width * height))[idx] = 1;
            };
            rasterizePolygonCells(grid, b.geometry, (x, y) => open(y * width + x));
            ringCells(b.geometry, open);
        }
        let noTideClears: Uint8Array | null = null;
        let blockedCount = 0;
        let keptOpen = 0;
        let openedCount = 0;
        if (provedCount > 0) {
            // A band a tide clears (or whose depth it does not bound) that
            // touches a proved cell keeps it open.
            const touchedClearable = new Uint8Array(width * height);
            for (const b of tideBands) {
                ringCells(b.g, (idx) => {
                    if (proved[idx] !== 1 || touchedClearable[idx] === 1 || outSurveyed(b.rank, idx)) return;
                    if (b.drval2 !== null) {
                        const tide = tideAtCell(idx);
                        if (!tide || b.drval2 + tide.highestM < needM - 1e-6) return;
                    }
                    touchedClearable[idx] = 1;
                });
            }
            for (let idx = 0; idx < cells.length; idx++) {
                if (proved[idx] !== 1) continue;
                if (touchedClearable[idx] === 1) keptOpen++;
                else if (opened?.[idx] === 1) openedCount++;
                else (noTideClears ??= new Uint8Array(width * height))[idx] = 1;
            }
        }
        // The engine's retry: the crossed bands, closed wherever they are
        // proved — inside them and every cell their rings pass through.
        let barrierCount = 0;
        for (const b of tideBarriers) {
            if (b.open) continue;
            const close = (idx: number): void => {
                if (Number.isNaN(cells[idx]) || noTideClears?.[idx] === 1 || opened?.[idx] === 1) return;
                if (ntmRise !== undefined && !Number.isNaN(ntmRise[idx])) return;
                if (outSurveyed(b.rank, idx)) return;
                const tide = tideAtCell(idx);
                if (!tide || b.deepestM + tide.highestM >= needM - 1e-6) return;
                (noTideClears ??= new Uint8Array(width * height))[idx] = 1;
                barrierCount++;
            };
            rasterizePolygonCells(grid, b.geometry, (x, y) => close(y * width + x));
            ringCells(b.geometry, close);
        }
        if (noTideClears) {
            for (let idx = 0; idx < cells.length; idx++) {
                if (noTideClears[idx] !== 1) continue;
                cells[idx] = NaN;
                blockedCount++;
            }
            grid.noTideClears = noTideClears;
        }
        markPass('passNoTide', tPassTide, provedCount);
        engineLog.warn(
            `[noTide] ${blockedCount} cell(s) blocked — no tide known here clears them for ${needM.toFixed(1)} m (${provedCount} proved, ${keptOpen} kept open by water a tide clears${openedCount > 0 ? `, ${openedCount} left open as the only way through` : ''}${tideBarriers.length > 0 ? `, ${barrierCount} closed by ${tideBarriers.filter((b) => !b.open).length} crossed band(s)` : ''}; ${tideLookup.size} place(s) with a tide ceiling)`,
        );
    }

    // ── Charted caution water (see NavGrid.chartedShallow) ────────────
    // Owner decision 7 (2026-09-30): a pin in charted-shallow water gets a
    // route ALL the way to it, the stretch past the last deep-enough water
    // flagged 'needs tide'. Only honest chart water qualifies: a CAUTION
    // cell that an S-57 never-drying band owns (s57ShallowClaim) with no
    // land paint over it, or that a current Notice-to-Mariners survey charts
    // (ntmRiseM). Never land (or relax-softened land), never a drying band
    // (any DRVAL1 < 0 at the owning survey), never a hazard or berth buffer,
    // never a structure bar, never uncharted water — that is Phase 2b's local
    // connector.
    //
    // Decision-1 water (a finer never-drying band beating coarser land paint;
    // wetConflict, closing lines over a wet band included) qualifies ONLY when
    // its finest band is itself deep enough for the keel (d1DeepBand) — caution
    // solely because of the coarse land paint, as at Tangalooma (finest band
    // 10–15 m) and the Rivergate dredged area (9.1 m). Owner decision 2 binds
    // the rest: the offline Newport canal (a 0–2 m harbour band under every
    // cell's land paint, no OSM water) gets no route until the offline water
    // pack (Phase 2b) — round 2 routed out of it through a 5.6 km 'needs
    // tide' tail — and the Mooloolaba conflict creek (2 m) stays the
    // phantom-departure guard's honest-water snap (Phase 2a round-2 review,
    // 2026-09-30).
    {
        let chartedShallow: Uint8Array | null = null;
        const ntm = grid.ntmRiseM;
        for (let idx = 0; idx < cells.length; idx++) {
            if (!(cells[idx] < 0)) continue;
            if (hardBlocked[idx] === 1 || landBlocked[idx] === 1 || relaxedLand?.[idx] === 1) continue;
            if (clearanceBarred[idx] === 1 || obstnBlocked[idx] === 1 || berthBlocked?.[idx] === 1) continue;
            const s = shallowDepthM[idx];
            if (s < 0) continue; // a drying band (NaN compares false: no shallow claim)
            // OSM water under chart land paint is the OVERLAY's water, not the
            // chart's (round-3 review, 2026-09-30): since OSM water no longer
            // hides the S-57 band's shallow claim (Pass 1), the online Newport
            // canal reads CAUTION over its 0–2 m band — but its water is the
            // OSM canal against every cell's land paint, and a 'needs tide'
            // tail through it fails the chart's own land check (the canal line
            // is not a polygon). Such a pin keeps the endpoint carve it always
            // had, as while OSM painted it 5–10 m deep.
            if (osmWaterCells[idx] === 1 && landRankAt !== null && landRankAt[idx] !== LAND_NONE) continue;
            const chartWater = wetConflict[idx] === 1 ? d1DeepBand?.[idx] === 1 : s57ShallowClaim[idx] === 1;
            if (chartWater || (ntm !== undefined && !Number.isNaN(ntm[idx]))) {
                (chartedShallow ??= new Uint8Array(width * height))[idx] = 1;
            }
        }
        if (chartedShallow) grid.chartedShallow = chartedShallow;
    }
    grid.shallowDepthM = shallowDepthM;
    grid.clearanceBarred = clearanceBarred;
    grid.wetConflict = wetConflict;
    grid.markDiscBlocked = markDiscBlocked;
    grid.obstnBlocked = obstnBlocked;
    if (furnitureHazardBlocked) grid.furnitureHazardBlocked = furnitureHazardBlocked;
    if (deepHazardOnly) grid.deepHazardOnly = deepHazardOnly;
    // Exposed only when endpoint relax zones softened land — the relax-retry
    // acceptance uses it to catch a route circumventing a low-clearance
    // bridge overland (relax-carved cells near a clearanceBarred cell).
    if (relaxZones.length > 0) grid.relaxMask = relaxMask;
    if (routeProfile === 'tideAssist' || routeProfile === 'tideDirect') {
        // Tide-recoverable caution cells: wet at LAT (charted depth > 0) and
        // within a normal tide's reach of the keel margin. Computed AFTER all
        // passes so rescues/carves have settled; drying cells excluded by the
        // s > 0 gate; blocked cells excluded by cells < 0 (NaN compares false).
        // The SAME mask serves both tide profiles; only the cost multiplier
        // differs — 'tideAssist' = 10× (tide-window shortest), 'tideDirect' =
        // 1.5× (auto-route: commit to the near-direct crossing over a modest
        // deep detour). Baked onto the grid so cellCostMultiplier reads it.
        const TIDE_ASSIST_MAX_RISE_M = 1.8;
        const floorM = draftM + safetyM;
        const ta = new Uint8Array(width * height);
        let assistCells = 0;
        for (let i = 0; i < cells.length; i++) {
            // A land-vs-wet-chart conflict cell (Pass 2/2b) is land paint over
            // the band: it stays at the full caution price, never a tide
            // crossing (final review 2026-09-29).
            if (cells[i] < 0 && wetConflict[i] !== 1) {
                const s = shallowDepthM[i];
                if (!Number.isNaN(s) && s > 0 && floorM - s <= TIDE_ASSIST_MAX_RISE_M) {
                    ta[i] = 1;
                    assistCells++;
                }
            }
        }
        grid.tideAssist = ta;
        grid.assistCostMul = routeProfile === 'tideDirect' ? 1.5 : 10;
        if (assistCells > 0)
            engineLog.warn(
                `[${routeProfile}] profile active — ${assistCells} recoverable caution cells at ${grid.assistCostMul}×`,
            );
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
    // Unconditional DONE (pairs with the START breadcrumb) — its presence
    // proves the sync build finished rather than being killed mid-compute,
    // and the ms is the freeze duration to beat with the worker move.
    engineLog.warn(`buildNavGrid DONE ${buildTotal}ms ${width}×${height}`);
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
