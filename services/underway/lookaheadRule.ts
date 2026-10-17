/**
 * Bounded chart look-ahead (133-04). Pure, shared verbatim with the Pi vault.
 * Chart facts stay aboard. Depth is charted metres + a datum-matched tide at
 * ETA, compared with draft + the shared UKC; never the legacy router multiplier.
 */
export interface AheadFix {
    lat: number;
    lon: number;
    at: number;
    sogKn: number;
    cogDeg: number;
}
export interface AheadPoint {
    lat: number;
    lon: number;
}
export interface AheadHazard {
    geometry: { type: string; coordinates?: unknown };
    minDepthM: number | null;
    layer: string;
}
export interface AheadHit {
    kind: 'depth' | 'danger';
    etaMs: number;
    distanceNm: number;
    chartDepthM: number | null;
    tideM: number | null;
}
export interface AheadCone {
    fix: AheadFix;
    distanceNm: number;
    windowMin: number;
    polygon: [number, number][];
}
/** Split a dateline-crossing cone into two ordinary catalogue bboxes. */
export function aheadBounds(cone: AheadCone): [number, number, number, number][] {
    const xs = cone.polygon.map((p) => p[0]),
        ys = cone.polygon.map((p) => p[1]);
    const w = Math.min(...xs),
        e = Math.max(...xs),
        s = Math.min(...ys),
        n = Math.max(...ys);
    return e - w > 180
        ? [
              [Math.min(...xs.filter((x) => x >= 0)), s, 180, n],
              [-180, s, Math.max(...xs.filter((x) => x < 0)), n],
          ]
        : [[w, s, e, n]];
}
/** Reject excessive exact-geometry work before its edge/contact loops. */
export function aheadGeometryWithinLimit(hazards: readonly AheadHazard[]): boolean {
    if (hazards.length > 5000) return false;
    let count = 0;
    const visit = (raw: unknown): boolean => {
        if (!Array.isArray(raw)) return true;
        if (typeof raw[0] === 'number') return ++count <= 50_000;
        return raw.every(visit);
    };
    return hazards.every((h) => visit(h.geometry.coordinates));
}
const R = 3440.065;
const RAD = Math.PI / 180;
const wrap = (x: number) => ((((x + 180) % 360) + 360) % 360) - 180;
const xy = (p: readonly number[], fix: AheadPoint): [number, number] => [
    wrap(p[0] - fix.lon) * 60 * Math.cos(fix.lat * RAD),
    (p[1] - fix.lat) * 60,
];
const destination = (fix: AheadPoint, bearing: number, nm: number): [number, number] => {
    const a = fix.lat * RAD,
        b = fix.lon * RAD,
        c = bearing * RAD,
        d = nm / R;
    const lat = Math.asin(Math.sin(a) * Math.cos(d) + Math.cos(a) * Math.sin(d) * Math.cos(c));
    return [
        wrap(
            (b + Math.atan2(Math.sin(c) * Math.sin(d) * Math.cos(a), Math.cos(d) - Math.sin(a) * Math.sin(lat))) / RAD,
        ),
        lat / RAD,
    ];
};
/** 10 minutes by default, bounded to 5–15; at least 0.3 NM ahead. */
export function aheadCone(fix: AheadFix, windowMin = 10, onLine = false): AheadCone | null {
    if (
        ![fix.lat, fix.lon, fix.at, fix.sogKn, fix.cogDeg].every(Number.isFinite) ||
        Math.abs(fix.lat) > 85 ||
        Math.abs(fix.lon) > 180 ||
        fix.sogKn <= 0.5 ||
        fix.sogKn > 100
    )
        return null;
    const minutes = Number.isFinite(windowMin) ? Math.max(5, Math.min(15, windowMin)) : 10;
    const distanceNm = Math.max(0.3, (fix.sogKn * minutes) / 60);
    // Close to the followed line: a narrow steering corridor avoids alarming
    // on a mark beside a channel. It never excludes the actual COG centreline.
    const angle = onLine ? 1 : 3;
    const near = 8 / 1852;
    const polygon = [
        destination(fix, fix.cogDeg - 90, near),
        destination(fix, fix.cogDeg - angle, distanceNm),
        destination(fix, fix.cogDeg + angle, distanceNm),
        destination(fix, fix.cogDeg + 90, near),
        destination(fix, fix.cogDeg - 90, near),
    ];
    return { fix, distanceNm, windowMin: minutes, polygon };
}
type XY = readonly number[];
const cross = (a: XY, b: XY, c: XY) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function touches(a: XY, b: XY, c: XY, d: XY): boolean {
    const eps = 1e-10;
    if (
        Math.max(a[0], b[0]) + eps < Math.min(c[0], d[0]) ||
        Math.max(c[0], d[0]) + eps < Math.min(a[0], b[0]) ||
        Math.max(a[1], b[1]) + eps < Math.min(c[1], d[1]) ||
        Math.max(c[1], d[1]) + eps < Math.min(a[1], b[1])
    )
        return false;
    return cross(a, b, c) * cross(a, b, d) <= eps && cross(c, d, a) * cross(c, d, b) <= eps;
}
function inRing(p: XY, ring: XY[]): boolean {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[j],
            b = ring[i];
        if (
            Math.abs(cross(a, b, p)) < 1e-10 &&
            p[0] >= Math.min(a[0], b[0]) &&
            p[0] <= Math.max(a[0], b[0]) &&
            p[1] >= Math.min(a[1], b[1]) &&
            p[1] <= Math.max(a[1], b[1])
        )
            return true;
        if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0])
            inside = !inside;
    }
    return inside;
}
function inPolygon(p: XY, rings: XY[][]): boolean {
    return !!rings[0]?.length && inRing(p, rings[0]) && !rings.slice(1).some((r) => inRing(p, r));
}
const pair = (x: unknown): x is number[] =>
    Array.isArray(x) && x.length >= 2 && Number.isFinite(x[0]) && Number.isFinite(x[1]);
/** Exact polygon/line intersections, including holes and the antimeridian. No 150 m mark buffer. */
function contacts(cone: AheadCone, hazard: AheadHazard): [number, number][] {
    const cp = cone.polygon.map((p) => xy(p, cone.fix));
    const found: [number, number][] = [];
    const mapLine = (raw: unknown): [number, number][] =>
        Array.isArray(raw) ? raw.filter(pair).map((p) => xy(p, cone.fix)) : [];
    const lineHit = (line: [number, number][]) => {
        for (const p of line) if (inRing(p, cp)) found.push(p);
        for (let i = 1; i < line.length; i++)
            for (let j = 1; j < cp.length; j++) {
                const a = line[i - 1],
                    b = line[i],
                    c = cp[j - 1],
                    d = cp[j];
                if (!touches(a, b, c, d)) continue;
                const den = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0]);
                if (Math.abs(den) < 1e-12) {
                    found.push(c, d);
                    continue;
                }
                const t = ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / den;
                found.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
            }
    };
    const polygonHit = (raw: unknown) => {
        if (!Array.isArray(raw)) return;
        const rings = raw.map(mapLine);
        for (const p of cp) if (inPolygon(p, rings)) found.push(p);
        for (const ring of rings) lineHit(ring);
    };
    const g = hazard.geometry,
        c = g.coordinates;
    if (g.type === 'Point' && pair(c) && inRing(xy(c, cone.fix), cp)) found.push(xy(c, cone.fix));
    if (g.type === 'LineString') lineHit(mapLine(c));
    if (g.type === 'MultiLineString' && Array.isArray(c)) for (const l of c) lineHit(mapLine(l));
    if (g.type === 'Polygon') polygonHit(c);
    if (g.type === 'MultiPolygon' && Array.isArray(c)) for (const p of c) polygonHit(p);
    return found;
}
/**
 * Tide lookup must already be matched to THIS cell's vertical datum; null
 * means no credit, never a guessed datum. Earliest danger wins.
 */
export function scanAhead(
    cone: AheadCone,
    hazards: readonly AheadHazard[],
    draftM: number,
    ukcM: number,
    tideAt: (etaMs: number) => number | null = () => null,
): AheadHit | null {
    if (!Number.isFinite(draftM) || draftM <= 0 || !Number.isFinite(ukcM) || ukcM < 0) return null;
    let first: AheadHit | null = null;
    const angle = cone.fix.cogDeg * RAD;
    for (const h of hazards) {
        const points = contacts(cone, h);
        if (!points.length) continue;
        const distances = points.map((p) =>
            Math.max(0, Math.min(cone.distanceNm, p[0] * Math.sin(angle) + p[1] * Math.cos(angle))),
        );
        const along = Math.min(...distances),
            end = Math.max(...distances);
        const etaMs = cone.fix.at + (along / cone.fix.sogKn) * 3600_000;
        const endMs = cone.fix.at + (end / cone.fix.sogKn) * 3600_000;
        // A polygon can span several arrival times. Use its least predicted
        // water across that interval, including falling tide before the exit.
        // Missing coverage never grants positive tide credit.
        const tides: number[] = [];
        let missing = false;
        for (let t = etaMs; t < endMs; t += 30_000) {
            const v = tideAt(t);
            if (v === null || !Number.isFinite(v)) missing = true;
            else tides.push(v);
        }
        const last = tideAt(endMs);
        if (last === null || !Number.isFinite(last)) missing = true;
        else tides.push(last);
        if (missing) tides.push(0);
        const tideM = tides.length ? Math.min(...tides) : null;
        const depth = h.minDepthM;
        // Solid charted hazards remain hazards whatever the tide. Depth
        // areas and soundings use the one draft+UKC threshold.
        const solid = !['DEPARE', 'DRGARE', 'SOUNDG'].includes(h.layer);
        if (!solid && depth !== null && Number.isFinite(depth) && depth + (tideM ?? 0) >= draftM + ukcM) continue;
        const hit: AheadHit = { kind: solid ? 'danger' : 'depth', etaMs, distanceNm: along, chartDepthM: depth, tideM };
        if (!first || hit.etaMs < first.etaMs) first = hit;
    }
    return first;
}
