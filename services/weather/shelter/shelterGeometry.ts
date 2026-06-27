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
