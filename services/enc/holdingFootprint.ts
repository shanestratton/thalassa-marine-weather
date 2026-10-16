/** Conservative whole-area proof, never a sampled circle. A spherical disk
 * centred on the holding point encloses the entire incoming shortest arc and
 * its radius-wide corridor. Its enclosing rectangle deliberately over-reads.
 * Local/dateline/polar limits fail closed rather than approximating coverage. */
import type { Geometry, Position } from 'geojson';
import { haversineM, pointInGeometry } from '../engine/geometry';
export type HoldingBounds = readonly [number, number, number, number];
export function holdingFootprint(
    at: { lat: number; lon: number },
    incoming: { lat: number; lon: number } | null,
    radiusM: number,
): HoldingBounds | null {
    if (
        !incoming ||
        ![at.lat, at.lon, incoming.lat, incoming.lon, radiusM].every(Number.isFinite) ||
        Math.max(Math.abs(at.lat), Math.abs(incoming.lat)) > 80 ||
        Math.max(Math.abs(at.lon), Math.abs(incoming.lon)) > 180 ||
        radiusM < 10 ||
        radiusM > 500
    )
        return null;
    const leg = haversineM(at.lat, at.lon, incoming.lat, incoming.lon);
    if (leg > 10000) return null;
    // Use a smaller earth radius and a 2 m outward margin for conservative
    // floating-point/geodesic separation; do not shrink to sampled vertices.
    const angular = (leg + radiusM + 2) / 6350000;
    const dy = (angular * 180) / Math.PI;
    const dx = (Math.asin(Math.sin(angular) / Math.cos((at.lat * Math.PI) / 180)) * 180) / Math.PI;
    const box: HoldingBounds = [at.lon - dx, at.lat - dy, at.lon + dx, at.lat + dy];
    return box.every(Number.isFinite) && box[0] > -180 && box[2] < 180 ? box : null;
}
const inside = (p: Position, b: HoldingBounds) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
function segmentHits(a: Position, z: Position, b: HoldingBounds): boolean {
    let lo = 0,
        hi = 1;
    for (let axis = 0; axis < 2; axis++) {
        const d = z[axis] - a[axis],
            min = b[axis],
            max = b[axis + 2];
        if (Math.abs(d) < 1e-14) {
            if (a[axis] < min || a[axis] > max) return false;
        } else {
            const t0 = (min - a[axis]) / d,
                t1 = (max - a[axis]) / d;
            lo = Math.max(lo, Math.min(t0, t1));
            hi = Math.min(hi, Math.max(t0, t1));
            if (lo > hi) return false;
        }
    }
    return true;
}
const turn = (a: Position, b: Position, c: Position) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function segmentsMeet(a: Position, b: Position, c: Position, d: Position): boolean {
    const eps = 1e-12;
    if (
        Math.max(a[0], b[0]) + eps < Math.min(c[0], d[0]) ||
        Math.max(c[0], d[0]) + eps < Math.min(a[0], b[0]) ||
        Math.max(a[1], b[1]) + eps < Math.min(c[1], d[1]) ||
        Math.max(c[1], d[1]) + eps < Math.min(a[1], b[1])
    )
        return false;
    const a1 = turn(a, b, c),
        a2 = turn(a, b, d),
        b1 = turn(c, d, a),
        b2 = turn(c, d, b);
    return (
        (Math.abs(a1) <= eps || Math.abs(a2) <= eps || Math.sign(a1) !== Math.sign(a2)) &&
        (Math.abs(b1) <= eps || Math.abs(b2) <= eps || Math.sign(b1) !== Math.sign(b2))
    );
}
/** Validates and traverses every coordinate. Caller shares a global vertex
 * budget; malformed/ambiguous rings and unclosed polygons remain unknown. */
export function holdingGeometryRelation(
    g: Geometry,
    b: HoldingBounds,
    vertex: () => void,
    compare: () => void = () => {},
): { intersects: boolean; covers: boolean } {
    if (g.type === 'GeometryCollection') throw Error('Geometry collections have no holding coverage proof.');
    let rings: Position[][] = [],
        points: Position[] = [],
        polygons: Position[][][] = [];
    switch (g.type) {
        case 'Point':
            points = [g.coordinates];
            break;
        case 'MultiPoint':
            points = g.coordinates;
            break;
        case 'LineString':
            rings = [g.coordinates];
            break;
        case 'MultiLineString':
            rings = g.coordinates;
            break;
        case 'Polygon':
            polygons = [g.coordinates];
            break;
        case 'MultiPolygon':
            polygons = g.coordinates;
            break;
    }
    if (polygons.length) rings = polygons.flat();
    if (points.length + rings.length === 0) throw Error('Empty holding geometry.');
    const validate = (p: Position) => {
        vertex();
        if (p.length < 2 || !p.every(Number.isFinite) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90)
            throw Error('Malformed holding chart coordinate.');
    };
    points.forEach(validate);
    let boundary = points.some((p) => inside(p, b));
    for (const ring of rings) {
        if (ring.length < (polygons.length ? 4 : 2)) throw Error('Malformed holding chart boundary.');
        ring.forEach(validate);
        if (polygons.length && (ring[0][0] !== ring.at(-1)![0] || ring[0][1] !== ring.at(-1)![1]))
            throw Error('Unclosed holding chart polygon.');
        for (let i = 1; i < ring.length; i++) {
            if (ring[i][0] === ring[i - 1][0] && ring[i][1] === ring[i - 1][1])
                throw Error('Degenerate holding chart boundary.');
            if (Math.abs(ring[i][0] - ring[i - 1][0]) > 180)
                throw Error('Dateline chart geometry needs a split review.');
            boundary ||= segmentHits(ring[i - 1], ring[i], b);
        }
        if (polygons.length) {
            let area = 0;
            for (let i = 1; i < ring.length; i++) area += turn(ring[0], ring[i - 1], ring[i]);
            if (Math.abs(area) < 1e-14) throw Error('Degenerate holding chart polygon.');
        }
    }
    let comparisons = 0;
    for (const polygon of polygons) {
        for (let r = 0; r < polygon.length; r++) {
            const ring = polygon[r];
            for (let s = r; s < polygon.length; s++)
                for (let i = 1; i < ring.length; i++)
                    for (let j = s === r ? i + 1 : 1; j < polygon[s].length; j++) {
                        if (s === r && (j === i + 1 || (i === 1 && j === ring.length - 1))) continue;
                        compare();
                        if (++comparisons > 500000)
                            throw Error('Holding topology exceeds 500,000 boundary comparisons.');
                        if (segmentsMeet(ring[i - 1], ring[i], polygon[s][j - 1], polygon[s][j]))
                            throw Error('Intersecting or ambiguous holding polygon rings.');
                    }
            if (r > 0) {
                if (!pointInGeometry(ring[0][0], ring[0][1], { type: 'Polygon', coordinates: [polygon[0]] }))
                    throw Error('Holding polygon hole is outside its outer ring.');
                for (let s = 1; s < r; s++)
                    if (
                        pointInGeometry(ring[0][0], ring[0][1], { type: 'Polygon', coordinates: [polygon[s]] }) ||
                        pointInGeometry(polygon[s][0][0], polygon[s][0][1], { type: 'Polygon', coordinates: [ring] })
                    )
                        throw Error('Overlapping holding polygon holes.');
            }
        }
    }
    const corners = [
        [b[0], b[1]],
        [b[0], b[3]],
        [b[2], b[1]],
        [b[2], b[3]],
    ];
    // With no ring touching the rectangle, four inside corners prove that
    // its entire connected interior is inside one polygon, excluding holes.
    const covers =
        !boundary &&
        polygons.some((coordinates) =>
            corners.every((p) => pointInGeometry(p[0], p[1], { type: 'Polygon', coordinates })),
        );
    const containsCorner =
        (g.type === 'Polygon' || g.type === 'MultiPolygon') && corners.some((p) => pointInGeometry(p[0], p[1], g));
    return { intersects: boundary || containsCorner, covers };
}
