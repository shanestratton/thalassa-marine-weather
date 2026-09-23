/** Continuous, geometry-only containment in the UNION of mapped water.
 * Raster cell centres cannot establish that a chord misses a thin bank/hole.
 * Every ring intersection partitions each leg; no fixed sampling interval is
 * used. This says nothing about depth, surveyed accuracy or vessel clearance. */
import type { FeatureCollection } from 'geojson';
import RBush from 'rbush';

type Point = readonly [number, number];
type Box = { minX: number; minY: number; maxX: number; maxY: number };
type Edge = Box & { a: Point; b: Point; polygon: number; ring: number; index: number; ringSize: number };
type Ring = { points: Point[]; edges: Edge[] };
type WaterPolygon = Box & { rings: Ring[]; id: number };
type Location = 'inside' | 'outside' | 'boundary';

export const CANAL_WATER_LIMITS = {
    features: 2_048,
    polygons: 4_096,
    vertices: 100_000,
    pathPoints: 10_000,
    work: 4_000_000,
} as const;
// About 0.01 mm in latitude. Unresolvable near-boundary cases fail closed;
// this is a numerical guard, not a clearance allowance or erosion distance.
const EPS = 1e-10;
const EXACT_EPS = 1e-12;
const MAX_LOCAL_RADIUS = 1e-5;
const TAU = Math.PI * 2;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const validPoint = (v: unknown): v is [number, number] =>
    Array.isArray(v) &&
    v.length === 2 &&
    typeof v[0] === 'number' &&
    typeof v[1] === 'number' &&
    Number.isFinite(v[0]) &&
    Number.isFinite(v[1]) &&
    Math.abs(v[0]) <= 180 &&
    Math.abs(v[1]) <= 80;
const same = (a: Point, b: Point) => a[0] === b[0] && a[1] === b[1];
const box = (a: Point, b: Point, pad = EPS): Box => ({
    minX: Math.min(a[0], b[0]) - pad,
    minY: Math.min(a[1], b[1]) - pad,
    maxX: Math.max(a[0], b[0]) + pad,
    maxY: Math.max(a[1], b[1]) + pad,
});
const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;

function pointSegmentDistance(p: Point, a: Point, b: Point): number {
    const dx = b[0] - a[0],
        dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** All parameters at which closed segments meet, including collinear overlap.
 * Near-collinear ambiguity produces extra events, never skips a crossing. */
function intersections(a: Point, b: Point, c: Point, d: Point): number[] {
    const rx = b[0] - a[0],
        ry = b[1] - a[1],
        sx = d[0] - c[0],
        sy = d[1] - c[1];
    const length = Math.hypot(rx, ry);
    if (!length) return pointSegmentDistance(a, c, d) <= EPS ? [0] : [];
    const denominator = cross(rx, ry, sx, sy);
    const qx = c[0] - a[0],
        qy = c[1] - a[1];
    if (denominator === 0) {
        if (Math.abs(cross(qx, qy, rx, ry)) > EPS * length) return [];
        const squared = rx * rx + ry * ry;
        const t0 = (qx * rx + qy * ry) / squared;
        const t1 = ((d[0] - a[0]) * rx + (d[1] - a[1]) * ry) / squared;
        const lo = Math.max(0, Math.min(t0, t1)),
            hi = Math.min(1, Math.max(t0, t1));
        return lo <= hi ? [lo, hi] : [];
    }
    // Cancellation so severe that the intersection cannot be located reliably
    // is unsupported, not permission to accept a near-parallel shoreline.
    if (Math.abs(denominator) <= (Math.abs(rx * sy) + Math.abs(ry * sx)) * Number.EPSILON * 16)
        throw new Error('Ambiguous segment intersection');
    const t = cross(qx, qy, sx, sy) / denominator;
    const u = cross(qx, qy, rx, ry) / denominator;
    const toleranceT = EPS / length,
        toleranceU = EPS / Math.hypot(sx, sy);
    return t >= -toleranceT && t <= 1 + toleranceT && u >= -toleranceU && u <= 1 + toleranceU
        ? [Math.max(0, Math.min(1, t))]
        : [];
}

export function canalPathWithinWater(
    coordinates: readonly [number, number][],
    waterFeatures: FeatureCollection,
): boolean {
    let work = 0,
        vertices = 0;
    const spend = (n = 1) => {
        if ((work += n) > CANAL_WATER_LIMITS.work) throw new Error('Containment work budget');
    };
    const locateRing = (p: Point, ring: Ring): Location => {
        let inside = false;
        for (const edge of ring.edges) {
            spend();
            const { a, b } = edge;
            if (pointSegmentDistance(p, a, b) <= EPS) return 'boundary';
            if (a[1] > p[1] !== b[1] > p[1] && p[0] < a[0] + ((p[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1]))
                inside = !inside;
        }
        return inside ? 'inside' : 'outside';
    };
    const locatePolygon = (p: Point, polygon: WaterPolygon): Location => {
        const outer = locateRing(p, polygon.rings[0]);
        if (outer === 'outside') return outer;
        let boundary = outer === 'boundary';
        for (let i = 1; i < polygon.rings.length; i++) {
            const hole = locateRing(p, polygon.rings[i]);
            if (hole === 'inside') return 'outside';
            boundary ||= hole === 'boundary';
        }
        return boundary ? 'boundary' : 'inside';
    };
    try {
        if (
            !Array.isArray(coordinates) ||
            coordinates.length < 2 ||
            coordinates.length > CANAL_WATER_LIMITS.pathPoints ||
            !coordinates.every(validPoint) ||
            !record(waterFeatures) ||
            waterFeatures.type !== 'FeatureCollection' ||
            !Array.isArray(waterFeatures.features) ||
            !waterFeatures.features.length ||
            waterFeatures.features.length > CANAL_WATER_LIMITS.features
        )
            return false;
        const polygons: WaterPolygon[] = [],
            allEdges: Edge[] = [];
        for (const feature of waterFeatures.features) {
            if (!record(feature) || feature.type !== 'Feature' || !record(feature.geometry)) return false;
            const geometry = feature.geometry;
            if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') return false;
            const pieces = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
            if (!Array.isArray(pieces) || !pieces.length) return false;
            for (const piece of pieces) {
                if (!Array.isArray(piece) || !piece.length || polygons.length >= CANAL_WATER_LIMITS.polygons)
                    return false;
                const polygon: WaterPolygon = {
                    rings: [],
                    id: polygons.length,
                    minX: Infinity,
                    minY: Infinity,
                    maxX: -Infinity,
                    maxY: -Infinity,
                };
                for (const raw of piece) {
                    if (
                        !Array.isArray(raw) ||
                        raw.length < 4 ||
                        (vertices += raw.length) > CANAL_WATER_LIMITS.vertices ||
                        !raw.every(validPoint) ||
                        !same(raw[0], raw.at(-1)!)
                    )
                        return false;
                    const points: Point[] = [];
                    for (const p of raw.slice(0, -1)) {
                        spend();
                        if (!points.length || !same(p, points.at(-1)!)) points.push([p[0], p[1]]);
                    }
                    if (points.length > 1 && same(points[0], points.at(-1)!)) points.pop();
                    if (points.length < 3) return false;
                    const edges: Edge[] = [];
                    let area = 0;
                    for (let i = 0; i < points.length; i++) {
                        const a = points[i],
                            b = points[(i + 1) % points.length];
                        if (Math.abs(a[0] - b[0]) > 180 || Math.hypot(a[0] - b[0], a[1] - b[1]) <= EPS) return false;
                        area += cross(
                            a[0] - points[0][0],
                            a[1] - points[0][1],
                            b[0] - points[0][0],
                            b[1] - points[0][1],
                        );
                        edges.push({
                            ...box(a, b),
                            a,
                            b,
                            polygon: polygon.id,
                            ring: polygon.rings.length,
                            index: i,
                            ringSize: points.length,
                        });
                        if (!polygon.rings.length) {
                            polygon.minX = Math.min(polygon.minX, a[0]);
                            polygon.maxX = Math.max(polygon.maxX, a[0]);
                            polygon.minY = Math.min(polygon.minY, a[1]);
                            polygon.maxY = Math.max(polygon.maxY, a[1]);
                        }
                    }
                    if (Math.abs(area) <= EPS * EPS) return false;
                    polygon.rings.push({ points, edges });
                    allEdges.push(...edges);
                }
                polygons.push(polygon);
            }
        }
        const edges = new RBush<Edge>().load(allEdges);
        const water = new RBush<WaterPolygon>().load(polygons);
        // Reject malformed/self-crossing rings and holes, independently of the
        // route. Different polygons may overlap: their union is intentional.
        for (const edge of allEdges) {
            for (const other of edges.search(edge)) {
                spend();
                if (other.polygon !== edge.polygon || (other.ring === edge.ring && other.index <= edge.index)) continue;
                const adjacent =
                    other.ring === edge.ring &&
                    (other.index === edge.index + 1 || (edge.index === 0 && other.index === edge.ringSize - 1));
                const hits = intersections(edge.a, edge.b, other.a, other.b);
                // Valid clipped polygons can have a hole touching the outer
                // ring (or another hole) at one shared vertex. A shared edge
                // or proper crossing remains invalid. The route still cannot
                // graze that point unless it is interior to OTHER union water.
                const sharedVertex =
                    other.ring !== edge.ring &&
                    hits.length > 0 &&
                    hits.every((t) => t === hits[0]) &&
                    [edge.a, edge.b].some((p) => same(p, other.a) || same(p, other.b));
                if (hits.length && !adjacent && !sharedVertex) return false;
                if (
                    adjacent &&
                    hits.length === 2 &&
                    Math.abs(hits[1] - hits[0]) * Math.hypot(edge.b[0] - edge.a[0], edge.b[1] - edge.a[1]) > EPS
                )
                    return false;
            }
        }
        for (const polygon of polygons) {
            for (let i = 1; i < polygon.rings.length; i++) {
                let interior = false;
                for (const edge of polygon.rings[i].edges) {
                    const middle: Point = [(edge.a[0] + edge.b[0]) / 2, (edge.a[1] + edge.b[1]) / 2];
                    for (const p of [edge.a, middle]) {
                        const outer = locateRing(p, polygon.rings[0]);
                        if (outer === 'outside') return false;
                        interior ||= outer === 'inside';
                        for (let j = 1; j < polygon.rings.length; j++) {
                            if (i !== j && locateRing(p, polygon.rings[j]) === 'inside') return false;
                        }
                    }
                }
                if (!interior) return false;
            }
        }
        const unionLocation = (p: Point): Location => {
            let boundary = false;
            for (const polygon of water.search(box(p, p))) {
                spend();
                const location = locatePolygon(p, polygon);
                if (location === 'inside') return location;
                boundary ||= location === 'boundary';
            }
            return boundary ? 'boundary' : 'outside';
        };
        const unionInterior = (p: Point): boolean => {
            const location = unionLocation(p);
            if (location !== 'boundary') return location === 'inside';
            // A tile seam can be boundary of EACH polygon but interior of the
            // union. Certify all local angular sectors, not just left/right of
            // the route (which would miss a bank touched at a concave vertex).
            const angles = new Set<number>();
            let radius = MAX_LOCAL_RADIUS;
            for (const edge of edges.search(box(p, p, MAX_LOCAL_RADIUS))) {
                spend();
                const distance = pointSegmentDistance(p, edge.a, edge.b);
                if (distance > EXACT_EPS) {
                    radius = Math.min(radius, distance / 4);
                    continue;
                }
                for (const end of [edge.a, edge.b]) {
                    const dx = end[0] - p[0],
                        dy = end[1] - p[1],
                        length = Math.hypot(dx, dy);
                    if (length > EXACT_EPS) {
                        radius = Math.min(radius, length / 4);
                        const angle = Math.atan2(dy, dx);
                        angles.add(angle < 0 ? angle + TAU : angle);
                    }
                }
            }
            if (angles.size < 2 || radius <= EPS * 16) return false;
            const ordered = [...angles].sort((a, b) => a - b);
            for (let i = 0; i < ordered.length; i++) {
                const end = i + 1 < ordered.length ? ordered[i + 1] : ordered[0] + TAU;
                const middle = (ordered[i] + end) / 2;
                if (unionLocation([p[0] + radius * Math.cos(middle), p[1] + radius * Math.sin(middle)]) !== 'inside')
                    return false;
            }
            return true;
        };
        for (let i = 1; i < coordinates.length; i++) {
            const a = coordinates[i - 1],
                b = coordinates[i];
            if (Math.abs(a[0] - b[0]) > 1 || Math.abs(a[1] - b[1]) > 1) return false;
            const parameters = [0, 1];
            for (const edge of edges.search(box(a, b))) {
                spend();
                parameters.push(...intersections(a, b, edge.a, edge.b));
            }
            parameters.sort((x, y) => x - y);
            let previous = -1;
            for (const t of parameters) {
                if (t === previous) continue;
                const at = (v: number): Point => [a[0] + (b[0] - a[0]) * v, a[1] + (b[1] - a[1]) * v];
                if (!unionInterior(at(t)) || (previous >= 0 && !unionInterior(at((previous + t) / 2)))) return false;
                previous = t;
            }
        }
        return true;
    } catch {
        // Invalid topology, numerical ambiguity and budget exhaustion are not
        // permission to substitute an unchecked raster-only connector.
        return false;
    }
}
