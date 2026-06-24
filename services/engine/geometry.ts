/**
 * Inshore Router Engine — geometry primitives & grid-coordinate helpers.
 * Carved out of inshoreRouterEngine.ts (module split, 2026-06-24).
 * Layer 3: depends only on constants + types. bresenhamCells lives HERE
 * (not in aStar) because buildNavGrid in navGrid.ts calls it — keeping the
 * dependency arrow pointing downward.
 */
import type { Polygon, MultiPolygon, Position } from 'geojson';
import type { NavGrid } from './types';

export function mPerDegLon(lat: number): number {
    return 111_320 * Math.cos((lat * Math.PI) / 180);
}

/** Great-circle distance in meters using the haversine formula. */
export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6_371_000;
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const dφ = ((lat2 - lat1) * Math.PI) / 180;
    const dλ = ((lon2 - lon1) * Math.PI) / 180;
    const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Ray-casting point-in-polygon for a single ring.
 * Coordinates are [lon, lat]. Returns true if (lon, lat) is inside.
 */
export function pointInRing(lon: number, lat: number, ring: Position[]): boolean {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0];
        const yi = ring[i][1];
        const xj = ring[j][0];
        const yj = ring[j][1];
        const intersects = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
        if (intersects) inside = !inside;
    }
    return inside;
}

/**
 * Point-in-(Polygon|MultiPolygon). Outer ring contains; inner rings
 * (holes) subtract. Polygon[0] is outer, Polygon[1+] are holes.
 */
export function pointInGeometry(lon: number, lat: number, geom: Polygon | MultiPolygon): boolean {
    if (geom.type === 'Polygon') {
        if (!pointInRing(lon, lat, geom.coordinates[0])) return false;
        for (let h = 1; h < geom.coordinates.length; h++) {
            if (pointInRing(lon, lat, geom.coordinates[h])) return false; // in hole
        }
        return true;
    }
    // MultiPolygon
    for (const poly of geom.coordinates) {
        if (!pointInRing(lon, lat, poly[0])) continue;
        let inHole = false;
        for (let h = 1; h < poly.length; h++) {
            if (pointInRing(lon, lat, poly[h])) {
                inHole = true;
                break;
            }
        }
        if (!inHole) return true;
    }
    return false;
}

/**
 * Compute the bbox of a polygon/multipolygon geometry as
 * [minLon, minLat, maxLon, maxLat]. Used to skip cells that can't
 * possibly be inside the polygon.
 */
export function geometryBbox(geom: Polygon | MultiPolygon): [number, number, number, number] {
    let minLon = Infinity,
        minLat = Infinity,
        maxLon = -Infinity,
        maxLat = -Infinity;
    const rings = geom.type === 'Polygon' ? [geom.coordinates[0]] : geom.coordinates.map((p) => p[0]);
    for (const ring of rings) {
        for (const [lon, lat] of ring) {
            if (lon < minLon) minLon = lon;
            if (lon > maxLon) maxLon = lon;
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
        }
    }
    return [minLon, minLat, maxLon, maxLat];
}

/**
 * Scanline polygon rasterizer — visit every grid cell strictly inside
 * a Polygon or MultiPolygon, calling `callback(x, y)` per cell.
 *
 * Why this exists
 * ───────────────
 * Pass 1 (DEPARE) was 97% of buildNavGrid in the wild (36.88 s of
 * 38.27 s on a Newport → Brisbane route, May 2026). The previous
 * implementation did one `pointInGeometry()` per cell × per polygon
 * — for a 50-vertex DEPARE polygon covering a 50×50 cell range that's
 * 125,000 ray-cast vertex ops. A scanline fill instead does ~edges
 * per row + cells per row = ~5,000 ops on the same input. The bigger
 * the polygon (more cells, more vertices), the bigger the win.
 *
 * Algorithm
 * ─────────
 * Classic even-odd scanline fill with hole support:
 *   1. For each scanline row y, sweep ALL ring edges (outer + holes)
 *      and collect x-coordinates where the edge crosses lat(y).
 *   2. Sort the crossings ascending. Even-odd parity — between
 *      [0,1], [2,3], [4,5]… is inside; in between is outside.
 *   3. For each "inside" range, snap to cell columns and call the
 *      visitor for each cell whose centre falls inside.
 *
 * Holes work naturally with parity: a hole edge contributes a
 * crossing that flips the inside flag back to outside for that span.
 *
 * Vertex-exactly-on-scanline handling is the strict-greater test
 * `(yi > lat) !== (yj > lat)` — same convention as the existing
 * pointInRing, so the two paths agree on edge cases (cells whose
 * centre lies on a polygon boundary).
 *
 * Cost vs old per-cell pointInGeometry:
 *   • E vertices, R rows, W cells/row, polygon covers ~R×W cells
 *   • Old: R × W × E ray-cast vertex ops
 *   • New: R × E (edge scan) + R × W (fill) ≈ R × (E + W)
 *   • Speedup ≈ W × E / (E + W). For W=E=50: 25×.
 */
export function rasterizePolygonCells(
    grid: { width: number; height: number; minLon: number; minLat: number; dLon: number; dLat: number },
    geom: Polygon | MultiPolygon,
    callback: (x: number, y: number) => void,
): void {
    const polygons: Position[][][] = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
    const { width, height, minLon, minLat, dLon, dLat } = grid;

    for (const poly of polygons) {
        // Per-polygon row range from the outer ring's lat extent.
        // Inner rings (holes) live entirely inside the outer, so they
        // can't extend the row range.
        const outer = poly[0];
        let minLatPoly = Infinity;
        let maxLatPoly = -Infinity;
        for (let i = 0; i < outer.length; i++) {
            const lat = outer[i][1];
            if (lat < minLatPoly) minLatPoly = lat;
            if (lat > maxLatPoly) maxLatPoly = lat;
        }
        const y0 = Math.max(0, Math.floor((minLatPoly - minLat) / dLat));
        const y1 = Math.min(height - 1, Math.ceil((maxLatPoly - minLat) / dLat));
        if (y1 < y0) continue;

        // Reuse one scratch array per polygon to avoid per-row GC churn.
        const crossings: number[] = [];

        for (let y = y0; y <= y1; y++) {
            const lat = minLat + (y + 0.5) * dLat;
            crossings.length = 0;

            // Collect crossings from outer + holes alike. Even-odd
            // parity below handles hole subtraction without needing
            // an explicit "skip" pass.
            for (const ring of poly) {
                for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                    const yi = ring[i][1];
                    const yj = ring[j][1];
                    if (yi > lat !== yj > lat) {
                        const xi = ring[i][0];
                        const xj = ring[j][0];
                        const x = ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
                        crossings.push(x);
                    }
                }
            }
            if (crossings.length < 2) continue;
            crossings.sort((a, b) => a - b);

            // Pair-fill: [0..1], [2..3], … are inside spans (even-odd).
            for (let k = 0; k + 1 < crossings.length; k += 2) {
                const lonStart = crossings[k];
                const lonEnd = crossings[k + 1];
                // First column whose cell-centre is ≥ lonStart, last
                // whose centre is ≤ lonEnd. The centre-test is what
                // matches the old per-cell pointInGeometry semantics
                // exactly — we still classify by cell centre, just
                // without paying the ray-cast on each one.
                const xStart = Math.max(0, Math.ceil((lonStart - minLon) / dLon - 0.5));
                const xEnd = Math.min(width - 1, Math.floor((lonEnd - minLon) / dLon - 0.5));
                for (let x = xStart; x <= xEnd; x++) {
                    callback(x, y);
                }
            }
        }
    }
}

export function isNavigable(grid: NavGrid, x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return false;
    return !Number.isNaN(grid.cells[y * grid.width + x]);
}

export function gridToLatLon(grid: NavGrid, x: number, y: number): [number, number] {
    // Cell center
    const lon = grid.minLon + (x + 0.5) * grid.dLon;
    const lat = grid.minLat + (y + 0.5) * grid.dLat;
    return [lon, lat];
}

export function latLonToGrid(grid: NavGrid, lat: number, lon: number): { x: number; y: number } {
    const x = Math.floor((lon - grid.minLon) / grid.dLon);
    const y = Math.floor((lat - grid.minLat) / grid.dLat);
    return { x, y };
}

/**
 * Bresenham's line algorithm. Iterates the cells touched by the line
 * from (x0,y0) to (x1,y1). Used to test whether two cells have an
 * unobstructed straight-line path between them.
 */
export function* bresenhamCells(x0: number, y0: number, x1: number, y1: number): Generator<{ x: number; y: number }> {
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let x = x0;
    let y = y0;
    while (true) {
        yield { x, y };
        if (x === x1 && y === y1) break;
        const e2 = 2 * err;
        if (e2 > -dy) {
            err -= dy;
            x += sx;
        }
        if (e2 < dx) {
            err += dx;
            y += sy;
        }
    }
}

// ── Polyline simplification (Douglas-Peucker) ───────────────────────

/**
 * Perpendicular distance from point P to segment AB, in degrees.
 * Used purely for relative comparison; no need for meters.
 */
export function perpendicularDistanceDeg(p: [number, number], a: [number, number], b: [number, number]): number {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    if (dx === 0 && dy === 0) {
        return Math.hypot(p[0] - a[0], p[1] - a[1]);
    }
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
    const projX = a[0] + t * dx;
    const projY = a[1] + t * dy;
    return Math.hypot(p[0] - projX, p[1] - projY);
}

/** @internal exported for the douglas-peucker termination regression test. */
export function douglasPeucker(
    points: [number, number][],
    toleranceDeg: number,
    /** Optional land guard: returns true if the straight chord a→b crosses
     *  land. When it does, the span is NOT collapsed — the bend vertices are
     *  kept — so the simplifier can never cut a chord across a canal bank (the
     *  Newport canal-bend corner-clip, 2026-06-18). */
    chordCrossesLand?: (a: [number, number], b: [number, number]) => boolean,
): [number, number][] {
    if (points.length < 3) return points.slice();
    let maxD = 0;
    let idx = 0;
    for (let i = 1; i < points.length - 1; i++) {
        const d = perpendicularDistanceDeg(points[i], points[0], points[points.length - 1]);
        if (d > maxD) {
            maxD = d;
            idx = i;
        }
    }
    // Recurse ONLY on a geometric split. maxD > tol guarantees idx ≥ 1, so both
    // sub-slices strictly shrink and the recursion always terminates. (The land
    // guard must NEVER gate this branch: on a near-straight chord that merely
    // nicks a land cell, maxD is ~0 and idx stays 0, so points.slice(idx) ===
    // points.slice(0) — the same array — and the right branch recurses on itself
    // forever → stack overflow → the engine throws → the passage falls through to
    // the "route too short" bail. That was the 2026-06-18 canal regression.)
    if (maxD > toleranceDeg) {
        const left = douglasPeucker(points.slice(0, idx + 1), toleranceDeg, chordCrossesLand);
        const right = douglasPeucker(points.slice(idx), toleranceDeg, chordCrossesLand);
        return left.slice(0, -1).concat(right);
    }
    // Geometry says collapse to the chord — but never collapse a chord that
    // cuts across a canal bank. Keep every vertex (no recursion, terminates).
    if (chordCrossesLand?.(points[0], points[points.length - 1])) {
        return points.slice();
    }
    return [points[0], points[points.length - 1]];
}
