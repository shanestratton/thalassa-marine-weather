/**
 * shelterGeometry — decide whether a point is in ENCLOSED water and, if so, the
 * longest over-water fetch, by ray-casting against the OSM coastline.
 *
 * The coastline is the land/water boundary. From a water point we shoot rays on
 * many bearings; the distance to the first coastline crossing is the over-water
 * fetch on that bearing (capped at maxKm if the ray reaches the limit without
 * hitting land — i.e. open water that far out).
 *
 * Enclosed ⇔ almost no bearing reaches the limit: the point is boxed in by land
 * within maxKm in (nearly) every direction. An open coast has a whole seaward
 * arc of bearings reaching the limit, so it is never classed enclosed — that is
 * the safety guarantee against damping waves where they're real.
 *
 * Maths is planar (local equirectangular metres about the point); fine for the
 * ≤ ~60 km ranges involved and dependency-free for testability.
 */

export type LngLat = [number, number]; // [lon, lat] — GeoJSON order
export type Segment = [LngLat, LngLat];

export interface FetchAssessment {
    enclosed: boolean;
    /** Longest over-water fetch across all bearings (km), capped at maxKm. */
    maxFetchKm: number;
    /** Shortest fetch across all bearings (km). */
    minFetchKm: number;
    /** Number of bearings whose ray reached maxKm without hitting land ("open"). */
    openBearings: number;
    /** Per-bearing fetch (km), in bearing order from 0°. */
    fetchByBearingKm: number[];
}

export interface FetchOptions {
    bearings?: number; // ray count (evenly spaced)
    maxKm?: number; // ray length / open-water sentinel
    /** Enclosed if at most this many bearings reach open water. Tolerates a
     *  narrow bay mouth threading one or two rays through to the ocean. */
    maxOpenBearings?: number;
}

const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON_EQ = 111_320;

/** Project [lon,lat] into local metres about (lon0,lat0). */
function toLocal(p: LngLat, lon0: number, lat0: number, cosLat0: number): [number, number] {
    return [(p[0] - lon0) * M_PER_DEG_LON_EQ * cosLat0, (p[1] - lat0) * M_PER_DEG_LAT];
}

/**
 * Nearest positive distance (m) from the origin along unit direction (dx,dy) to
 * segment (a→b), or Infinity if the ray misses. Ray: O + t·d, t ≥ 0.
 */
function raySegmentDist(dx: number, dy: number, a: [number, number], b: [number, number], maxM: number): number {
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    // Solve t·d − s·e = a, with s ∈ [0,1], t ≥ 0.  (O = origin = 0)
    const denom = dx * ey - dy * ex;
    if (Math.abs(denom) < 1e-9) return Infinity; // parallel
    const t = (a[0] * ey - a[1] * ex) / denom; // distance along ray (d is unit)
    const s = (a[0] * dy - a[1] * dx) / denom; // position along segment
    if (t < 0 || t > maxM || s < 0 || s > 1) return Infinity;
    return t;
}

/**
 * Directional fetch + enclosure for a point against coastline segments.
 * With no/sparse coastline every ray reaches maxKm → open → never enclosed
 * (the safe default: missing data never triggers damping).
 */
export function assessFetch(lat: number, lon: number, coastline: Segment[], opts: FetchOptions = {}): FetchAssessment {
    const bearings = opts.bearings ?? 36;
    const maxKm = opts.maxKm ?? 55;
    const maxOpenBearings = opts.maxOpenBearings ?? 2;
    const maxM = maxKm * 1000;
    const cosLat0 = Math.cos((lat * Math.PI) / 180) || 1e-6;

    // Localise the coastline once.
    const local: Array<[[number, number], [number, number]]> = [];
    for (const seg of coastline) {
        if (!seg || seg.length !== 2) continue;
        local.push([toLocal(seg[0], lon, lat, cosLat0), toLocal(seg[1], lon, lat, cosLat0)]);
    }

    const fetchByBearingKm: number[] = [];
    let openBearings = 0;
    let maxFetchKm = 0;
    let minFetchKm = maxKm;

    for (let i = 0; i < bearings; i++) {
        const brgRad = (i * (360 / bearings) * Math.PI) / 180;
        // bearing 0 = North = +y, 90 = East = +x
        const dx = Math.sin(brgRad);
        const dy = Math.cos(brgRad);
        let nearest = Infinity;
        for (const [a, b] of local) {
            const d = raySegmentDist(dx, dy, a, b, maxM);
            if (d < nearest) nearest = d;
        }
        const km = nearest === Infinity ? maxKm : nearest / 1000;
        if (km >= maxKm - 1e-6) openBearings++;
        fetchByBearingKm.push(km);
        if (km > maxFetchKm) maxFetchKm = km;
        if (km < minFetchKm) minFetchKm = km;
    }

    const enclosed = openBearings <= maxOpenBearings;
    return { enclosed, maxFetchKm, minFetchKm, openBearings, fetchByBearingKm };
}

// ── Many points against one coastline (131-PYD-10) ─────────────

/**
 * The coastline bucketed once into cells about 2 NM a side, for ray-casting
 * many points. Plan Your Day's places worldwide put up to eighty bays and
 * anchorages against a fjord coastline of a hundred thousand segments, and
 * assessFetch tests every segment on every bearing: 3.6 million tests a
 * place, about 40 s for Tromsø on a desktop before this.
 */
export interface CoastlineIndex {
    /** lon0, lat0, lon1, lat1 for each segment. */
    seg: Float64Array;
    cellLatDeg: number;
    cellLonDeg: number;
    cells: Map<number, number[]>;
    /** Segments spanning too many cells to bucket: tested from every point. */
    wide: number[];
}

const CELL_M = 3_700;
const WIDE_CELLS = 64;
const cellKey = (row: number, col: number) => row * 1_000_000 + col;

export function indexCoastline(coastline: readonly Segment[], aroundLat: number): CoastlineIndex {
    const cellLatDeg = CELL_M / M_PER_DEG_LAT;
    const cellLonDeg = CELL_M / (M_PER_DEG_LON_EQ * Math.max(0.05, Math.cos((aroundLat * Math.PI) / 180)));
    const valid = coastline.filter((s) => s && s.length === 2);
    const seg = new Float64Array(valid.length * 4);
    const cells = new Map<number, number[]>();
    const wide: number[] = [];
    valid.forEach(([a, b], i) => {
        seg[i * 4] = a[0];
        seg[i * 4 + 1] = a[1];
        seg[i * 4 + 2] = b[0];
        seg[i * 4 + 3] = b[1];
        const c0 = Math.floor(Math.min(a[0], b[0]) / cellLonDeg);
        const c1 = Math.floor(Math.max(a[0], b[0]) / cellLonDeg);
        const r0 = Math.floor(Math.min(a[1], b[1]) / cellLatDeg);
        const r1 = Math.floor(Math.max(a[1], b[1]) / cellLatDeg);
        if ((r1 - r0 + 1) * (c1 - c0 + 1) > WIDE_CELLS) {
            wide.push(i);
            return;
        }
        for (let r = r0; r <= r1; r++)
            for (let c = c0; c <= c1; c++) {
                const list = cells.get(cellKey(r, c));
                if (list) list.push(i);
                else cells.set(cellKey(r, c), [i]);
            }
    });
    return { seg, cellLatDeg, cellLonDeg, cells, wide };
}

/**
 * What assessFetch's fetchByBearingKm gives (the same rays, projection and
 * cap), from an index: each segment is tested only on the bearings it spans
 * as seen from the point, cells are visited nearest first, and the walk stops
 * once every ray has met land nearer than any cell not yet visited.
 */
export function fetchByBearingIndexed(lat: number, lon: number, index: CoastlineIndex, maxKm: number, bearings = 36) {
    const maxM = maxKm * 1000;
    const cosLat0 = Math.cos((lat * Math.PI) / 180) || 1e-6;
    const step = 360 / bearings;
    const dxs = Array.from({ length: bearings }, (_, i) => Math.sin((i * step * Math.PI) / 180));
    const dys = Array.from({ length: bearings }, (_, i) => Math.cos((i * step * Math.PI) / 180));
    const nearest = new Array<number>(bearings).fill(Infinity);
    const { seg } = index;
    const ray = (k: number, ax: number, ay: number, ex: number, ey: number) => {
        const dx = dxs[k];
        const dy = dys[k];
        const denom = dx * ey - dy * ex;
        if (Math.abs(denom) < 1e-9) return;
        const t = (ax * ey - ay * ex) / denom;
        const s = (ax * dy - ay * dx) / denom;
        if (t < 0 || t > maxM || s < 0 || s > 1) return;
        if (t < nearest[k]) nearest[k] = t;
    };
    const test = (i: number) => {
        const ax = (seg[i * 4] - lon) * M_PER_DEG_LON_EQ * cosLat0;
        const ay = (seg[i * 4 + 1] - lat) * M_PER_DEG_LAT;
        const bx = (seg[i * 4 + 2] - lon) * M_PER_DEG_LON_EQ * cosLat0;
        const by = (seg[i * 4 + 3] - lat) * M_PER_DEG_LAT;
        const ex = bx - ax;
        const ey = by - ay;
        const from = (Math.atan2(ax, ay) * 180) / Math.PI;
        const to = (Math.atan2(bx, by) * 180) / Math.PI;
        const sweep = ((((to - from) % 360) + 540) % 360) - 180;
        // Through (or nearly through) the point itself: every bearing.
        if ((!ax && !ay) || (!bx && !by) || Math.abs(sweep) > 179) {
            for (let k = 0; k < bearings; k++) ray(k, ax, ay, ex, ey);
            return;
        }
        const lo = sweep >= 0 ? from : from + sweep;
        for (let k = Math.ceil((lo - 0.01) / step); k <= Math.floor((lo + Math.abs(sweep) + 0.01) / step); k++)
            ray(((k % bearings) + bearings) % bearings, ax, ay, ex, ey);
    };
    for (const i of index.wide) test(i);
    const row0 = Math.floor(lat / index.cellLatDeg);
    const col0 = Math.floor(lon / index.cellLonDeg);
    const cellM = Math.min(index.cellLatDeg * M_PER_DEG_LAT, index.cellLonDeg * M_PER_DEG_LON_EQ * cosLat0);
    for (let ring = 0; ; ring++) {
        // Nothing in this ring or beyond lies nearer than `clear`.
        const clear = (ring - 1) * cellM;
        if (clear > maxM) break;
        if (ring > 0 && nearest.every((m) => Math.min(m, maxM) <= clear)) break;
        for (let dr = -ring; dr <= ring; dr++) {
            const edge = Math.abs(dr) === ring;
            for (let dc = -ring; dc <= ring; dc += edge ? 1 : 2 * ring) {
                const list = index.cells.get(cellKey(row0 + dr, col0 + dc));
                if (list) for (const i of list) test(i);
            }
        }
    }
    return nearest.map((m) => (m === Infinity ? maxKm : m / 1000));
}
