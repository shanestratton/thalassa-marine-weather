/** Public reference locations and RAM-only chart summaries. No route, chart
 * geometry or derived bridge data is stored, sent to a worker or uploaded. */
import { calculateBearing, calculateDistance, destinationPoint } from '../../utils/navigationCalculations';
import { areaKey, type MarinePlace } from '../marineCatalogue/schema';
export type AlongPlaceKind = 'anchorage' | 'marina' | 'fuel' | 'bridge';
export interface AlongPlace {
    id: string;
    name: string;
    kind: AlongPlaceKind;
    lat: number;
    lon: number;
    source: string;
    sourceUrl: string | null;
    sourceAt: string | null;
    aboardOnly: boolean;
    note: string;
}
export interface AlongPlaceVisit extends AlongPlace {
    alongNm: number;
    offRouteNm: number;
    etaMs: number | null;
    /** A nearby place on a repeated/crossing leg has no unique visit ETA. */
    ambiguousVisit: boolean;
}
export interface AlongRouteGeometry {
    points: { lat: number; lon: number }[];
    segments: {
        a: { lat: number; lon: number };
        b: { lat: number; lon: number };
        startNm: number;
        distanceNm: number;
        bearing: number;
    }[];
    keys: string[];
    bounds: [number, number, number, number][];
    totalNm: number;
    identity: string;
}
const RAD = Math.PI / 180,
    R_NM = 3440.065;
export const ALONG_ROUTE_RADIUS_NM = 5;
export const ALONG_ROUTE_ROW_LIMIT = 128;
export const ALONG_ROUTE_COMPARISON_LIMIT = 500000;
const valid = (p: { lat: number; lon: number }) =>
    p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 85 && Math.abs(p.lon) <= 180;
const wrap = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;
export function nearestAlongArc(
    p: { lat: number; lon: number },
    a: { lat: number; lon: number },
    b: { lat: number; lon: number },
) {
    const length = calculateDistance(a.lat, a.lon, b.lat, b.lon);
    if (!(length > 0)) return { point: a, along: 0, offset: calculateDistance(a.lat, a.lon, p.lat, p.lon) };
    const bearing = calculateBearing(a.lat, a.lon, b.lat, b.lon);
    const d13 = calculateDistance(a.lat, a.lon, p.lat, p.lon) / R_NM;
    const theta = (calculateBearing(a.lat, a.lon, p.lat, p.lon) - bearing) * RAD;
    const along = Math.max(0, Math.min(length, Math.atan2(Math.sin(d13) * Math.cos(theta), Math.cos(d13)) * R_NM));
    const point = destinationPoint(a.lat, a.lon, bearing, along);
    return { point, along, offset: calculateDistance(point.lat, point.lon, p.lat, p.lon) };
}

/** At most16 public area cells, max4096 short spherical segments. A long
 * passage asks the user to select a leg; it never downloads a global strip. */
export function prepareAlongRoute(points: readonly { lat: number; lon: number }[]): AlongRouteGeometry {
    if (points.length < 2 || points.length > 8192 || !points.every(valid))
        throw Error('Choose a valid route or individual leg within 85° latitude.');
    const segments: AlongRouteGeometry['segments'] = [],
        bounds: AlongRouteGeometry['bounds'] = [];
    const keys = new Set<string>();
    let totalNm = 0;
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1],
            b = points[i];
        const length = calculateDistance(a.lat, a.lon, b.lat, b.lon);
        if (length < 1e-7) continue;
        if (!Number.isFinite(length) || length / R_NM >= Math.PI - 1e-7)
            throw Error('An antipodal route leg has no unique course. Choose an intermediate waypoint.');
        const bearing = calculateBearing(a.lat, a.lon, b.lat, b.lon),
            count = Math.ceil(length / 25);
        if (segments.length + count > 4096) throw Error('This route is too complex; choose an individual leg.');
        for (let n = 0; n < count; n++) {
            const p = n === 0 ? a : destinationPoint(a.lat, a.lon, bearing, (length * n) / count);
            const q = n === count - 1 ? b : destinationPoint(a.lat, a.lon, bearing, (length * (n + 1)) / count);
            const mid = destinationPoint(
                p.lat,
                p.lon,
                calculateBearing(p.lat, p.lon, q.lat, q.lon),
                length / count / 2,
            );
            if (![p, q, mid].every(valid))
                throw Error('This polar route window is unsupported. Choose a narrower leg.');
            segments.push({
                a: p,
                b: q,
                startNm: totalNm + (length * n) / count,
                distanceNm: length / count,
                bearing: calculateBearing(p.lat, p.lon, q.lat, q.lon),
            });
            const west = p.lon + wrap(q.lon - p.lon);
            const dy = ALONG_ROUTE_RADIUS_NM / 60 + 0.01;
            const lat = Math.max(Math.abs(p.lat), Math.abs(q.lat), Math.abs(mid.lat));
            const dx = dy / Math.max(0.001, Math.cos(lat * RAD));
            const lo = Math.min(p.lon, west, p.lon + wrap(mid.lon - p.lon)) - dx;
            const hi = Math.max(p.lon, west, p.lon + wrap(mid.lon - p.lon)) + dx;
            const south = Math.max(-85, Math.min(p.lat, q.lat, mid.lat) - dy),
                north = Math.min(85, Math.max(p.lat, q.lat, mid.lat) + dy);
            for (let y = Math.floor((south + 90) / 2) * 2 - 90; y <= north; y += 2)
                for (let x = Math.floor((lo + 180) / 2) * 2 - 180; x <= hi; x += 2) {
                    keys.add(areaKey(Math.max(-85, y), wrap(x)));
                    if (keys.size > 16)
                        throw Error('This route spans more than16 public catalogue cells. Choose an individual leg.');
                }
            // Dateline windows are always split before any local chart query.
            const left = wrap(lo),
                right = left + hi - lo;
            const parts: [number, number, number, number][] =
                right > 180
                    ? [
                          [left, south, 180, north],
                          [-180, south, right - 360, north],
                      ]
                    : [[left, south, right, north]];
            for (const part of parts) bounds.push(part);
        }
        totalNm += length;
    }
    if (!segments.length || !(totalNm > 0)) throw Error('This route has no measurable leg.');
    return {
        points: points.map(({ lat, lon }) => ({ lat, lon })),
        segments,
        keys: [...keys].sort(),
        bounds,
        totalNm,
        identity: JSON.stringify(points.map(({ lat, lon }) => [lat, lon])),
    };
}

export function publicAlongPlace(
    p: MarinePlace,
    source: { label: string; url: string; at: string },
): AlongPlace | null {
    if (!['anchorage', 'marina', 'fuel'].includes(p.kind)) return null;
    return {
        id: p.id,
        name: p.name,
        kind: p.kind as AlongPlaceKind,
        lat: p.lat,
        lon: p.lon,
        source: source.label,
        sourceUrl: source.url,
        sourceAt: source.at,
        aboardOnly: false,
        note: [
            p.approximate
                ? 'Approximate reference point; no checked access route.'
                : 'Mapped reference; no checked access route.',
            p.facilityKinds?.length === 2 ? 'Marina and marine fuel mapped.' : '',
            p.access ?? '',
            ...(p.restrictions ?? []),
            'Confirm permission, opening and fuel availability.',
        ]
            .filter(Boolean)
            .join(' '),
    };
}

/** Bounded projection on short great-circle legs. Repeated nonadjacent visits
 * remain visibly ambiguous instead of borrowing the earliest pass's ETA. */
export async function projectAlongPlaces(
    geometry: AlongRouteGeometry,
    places: readonly AlongPlace[],
    timing: { departureMs: number | null; speedKts: number | null },
    signal: AbortSignal,
    assertCurrent: () => void,
): Promise<{ rows: AlongPlaceVisit[]; limited: boolean }> {
    if (places.length > 10000) throw Error('The reference inventory exceeds the route-list cap.');
    const rows: AlongPlaceVisit[] = [];
    let comparisons = 0;
    for (let index = 0; index < places.length; index++) {
        if (index % 32 === 0) {
            await new Promise<void>((done) => setTimeout(done, 0));
            signal.throwIfAborted();
            assertCurrent();
        }
        const p = places[index];
        if (!valid(p)) throw Error('A reference position is invalid.');
        let best: { along: number; offset: number } | null = null;
        const visits: { along: number; offset: number; segment: number; bearing: number }[][] = [];
        for (let segment = 0; segment < geometry.segments.length; segment++) {
            const leg = geometry.segments[segment];
            if (++comparisons > ALONG_ROUTE_COMPARISON_LIMIT)
                throw Error('This route and inventory exceed the projection budget. Choose an individual leg.');
            if (comparisons % 256 === 0) {
                signal.throwIfAborted();
                assertCurrent();
            }
            const { along, offset } = nearestAlongArc(p, leg.a, leg.b);
            if (!Number.isFinite(offset)) throw Error('Reference projection is unavailable.');
            if (offset > ALONG_ROUTE_RADIUS_NM) continue;
            const candidate = { along: leg.startNm + along, offset, segment, bearing: leg.bearing };
            const group = visits.at(-1),
                previous = group?.at(-1);
            if (previous && previous.segment + 1 === segment && Math.abs(wrap(previous.bearing - leg.bearing)) <= 120)
                group!.push(candidate);
            else visits.push([candidate]);
            if (!best || offset < best.offset) best = candidate;
        }
        if (!best) continue;
        const ambiguousVisit = visits
            .map((group) => group.reduce((a, b) => (a.offset < b.offset ? a : b)))
            .some((v) => Math.abs(v.along - best!.along) > 0.25 && Math.abs(v.offset - best!.offset) < 0.02);
        const eta =
            !ambiguousVisit &&
            timing.departureMs !== null &&
            Number.isFinite(timing.departureMs) &&
            timing.speedKts !== null &&
            Number.isFinite(timing.speedKts) &&
            timing.speedKts > 0
                ? timing.departureMs + (best.along / timing.speedKts) * 3600000
                : null;
        rows.push({
            ...p,
            alongNm: best.along,
            offRouteNm: best.offset,
            ambiguousVisit,
            etaMs: eta !== null && Math.abs(eta) <= 8.64e15 ? eta : null,
        });
    }
    signal.throwIfAborted();
    assertCurrent();
    rows.sort((a, b) => a.alongNm - b.alongNm || a.offRouteNm - b.offRouteNm || a.id.localeCompare(b.id));
    return { rows: rows.slice(0, ALONG_ROUTE_ROW_LIMIT), limited: rows.length > ALONG_ROUTE_ROW_LIMIT };
}
