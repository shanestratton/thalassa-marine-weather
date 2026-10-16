/** Exact short spherical span references, for an informational list only.
 * Raw chart geometry stays in the caller's leased RAM window. */
import type { Geometry } from 'geojson';
import { calculateDistance } from '../../utils/navigationCalculations';
import { nearestAlongArc, type AlongRouteGeometry } from './alongRoutePlaces';
type Point = { lat: number; lon: number };
type Vec = [number, number, number];
const RAD = Math.PI / 180;
const vector = (p: Point): Vec => [
    Math.cos(p.lat * RAD) * Math.cos(p.lon * RAD),
    Math.cos(p.lat * RAD) * Math.sin(p.lon * RAD),
    Math.sin(p.lat * RAD),
];
const cross = (a: Vec, b: Vec): Vec => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
];
function intersection(a: Point, b: Point, c: Point, d: Point): Point | null {
    const n = cross(cross(vector(a), vector(b)), cross(vector(c), vector(d))),
        norm = Math.hypot(...n);
    if (norm < 1e-14) return null;
    for (const sign of [1, -1]) {
        const p = { lat: Math.asin((sign * n[2]) / norm) / RAD, lon: Math.atan2(sign * n[1], sign * n[0]) / RAD };
        const on = (x: Point, y: Point) =>
            Math.abs(
                calculateDistance(x.lat, x.lon, p.lat, p.lon) +
                    calculateDistance(p.lat, p.lon, y.lat, y.lon) -
                    calculateDistance(x.lat, x.lon, y.lat, y.lon),
            ) < 0.00005;
        if (on(a, b) && on(c, d)) return p;
    }
    return null;
}
export function bridgeReferencePoint(
    geometry: Geometry,
    route: AlongRouteGeometry,
    budget: { comparisons: number },
    assertCurrent: () => void,
): Point {
    const parts: Point[][] = [];
    let vertices = 0;
    const line = (raw: unknown) => {
        if (!Array.isArray(raw) || raw.length === 0) throw Error('Unsupported empty bridge geometry.');
        const points: Point[] = [];
        for (const value of raw) {
            if (
                ++vertices > 8192 ||
                !Array.isArray(value) ||
                value.length < 2 ||
                !Number.isFinite(value[0]) ||
                !Number.isFinite(value[1]) ||
                Math.abs(value[0]) > 180 ||
                Math.abs(value[1]) > 85
            )
                throw Error('Unsupported bridge geometry bounds.');
            const p = { lat: value[1] as number, lon: value[0] as number },
                before = points.at(-1);
            if (before && calculateDistance(before.lat, before.lon, p.lat, p.lon) > 100)
                throw Error('A bridge span exceeds the regional geometry bound.');
            points.push(p);
        }
        parts.push(points);
    };
    if (geometry.type === 'Point') line([geometry.coordinates]);
    else if (geometry.type === 'LineString') line(geometry.coordinates);
    else if (geometry.type === 'MultiPoint') geometry.coordinates.forEach((p) => line([p]));
    else if (geometry.type === 'MultiLineString' || geometry.type === 'Polygon') geometry.coordinates.forEach(line);
    else if (geometry.type === 'MultiPolygon') geometry.coordinates.forEach((p) => p.forEach(line));
    else throw Error('Unsupported bridge geometry type.');
    const best: { point: Point | null; offset: number } = { point: null, offset: Infinity };
    const consider = (point: Point, offset: number) => {
        if (Number.isFinite(offset) && offset < best.offset) {
            best.point = point;
            best.offset = offset;
        }
    };
    for (const points of parts)
        for (let i = 0; i < points.length; i++)
            for (const leg of route.segments) {
                if (++budget.comparisons > 200000)
                    throw Error('The complete bridge scan exceeds its comparison cap. Choose an individual leg.');
                if (budget.comparisons % 256 === 0) assertCurrent();
                const a = points[i],
                    b = points[i + 1];
                consider(a, nearestAlongArc(a, leg.a, leg.b).offset);
                if (b) {
                    const crossing = intersection(a, b, leg.a, leg.b);
                    if (crossing) return crossing;
                    for (const end of [leg.a, leg.b]) {
                        const near = nearestAlongArc(end, a, b);
                        consider(near.point, near.offset);
                    }
                }
            }
    assertCurrent();
    if (!best.point) throw Error('The bridge reference could not be located.');
    return best.point;
}
