/** Geometry-only canal connector. Unknown space is blocked. No invented depths,
 * canal carving, satellite classification, relaxed erosion or straight fallback.
 * Runs the existing marina solver on a small, separate worker-owned grid. */
import type { FeatureCollection, Geometry, Position } from 'geojson';
import { euclideanDistanceTransform, routeMarina } from './marinaCenterline';
import { rasterizePolygonCells } from './engine/geometry';
import { visitGridSegment } from './gridSegmentTraversal';
import { preserveCanalCentreline } from './canalCentreline';
import { canalPathWithinWater } from './canalWaterContainment';

export type CanalPoint = { lat: number; lon: number };
export type CanalPair = [number, number];
export type CanalBbox = [number, number, number, number];
export interface CanalGrid {
    width: number;
    height: number;
    minLon: number;
    minLat: number;
    dLon: number;
    dLat: number;
    water: Uint8Array;
}
export interface CanalDepartureGeometry {
    coordinates: CanalPair[];
    grid: CanalGrid;
}
export const CANAL_RESOLUTION_M = 3;
export const CANAL_MAX_CELLS = 750_000;
export const CANAL_MAX_GATES = 24;
const M_LAT = 111_320;
const mLon = (lat: number) => M_LAT * Math.cos((lat * Math.PI) / 180);
export const canalDistanceM = (a: CanalPoint, b: CanalPoint) =>
    Math.hypot((a.lon - b.lon) * mLon((a.lat + b.lat) / 2), (a.lat - b.lat) * M_LAT);
const pair = (p: CanalPoint): CanalPair => [p.lon, p.lat];
const asPoint = (p: Position): CanalPoint => ({ lon: p[0], lat: p[1] });

/** Constraints come only from a separately verified channel profile. This is
 * structural validation, not an assertion that a marker pair is authoritative.
 * Retain the existing bounded crop: a winding profile outside it is unsupported,
 * never shortened or silently expanded at lower resolution. */
export function validateCanalGateCentres(exit: CanalPoint, bbox: CanalBbox, gateCentres?: readonly CanalPoint[]): void {
    if (gateCentres === undefined) return;
    if (!Array.isArray(gateCentres) || !gateCentres.length || gateCentres.length > CANAL_MAX_GATES)
        throw new Error('The channel exit profile must contain 1 to 24 verified marker gates.');
    const seen = new Set<string>();
    for (const gate of gateCentres) {
        if (
            !gate ||
            ![gate.lat, gate.lon].every(Number.isFinite) ||
            Math.abs(gate.lat) > 80 ||
            Math.abs(gate.lon) > 180
        )
            throw new Error('The channel exit profile contains an invalid marker gate.');
        if (gate.lon <= bbox[0] || gate.lon >= bbox[2] || gate.lat <= bbox[1] || gate.lat >= bbox[3])
            throw new Error('A channel marker gate is outside the supported canal map area. Plot this exit manually.');
        const key = `${gate.lon},${gate.lat}`;
        if (seen.has(key)) throw new Error('The channel exit profile contains a repeated marker gate.');
        seen.add(key);
    }
    const final = gateCentres.at(-1)!;
    if (final.lat !== exit.lat || final.lon !== exit.lon)
        throw new Error('Canal exit must be the exact centre of the final verified marker gate.');
}

export function canalDepartureBbox(start: CanalPoint, exit: CanalPoint): CanalBbox {
    for (const p of [start, exit])
        if (![p.lat, p.lon].every(Number.isFinite) || Math.abs(p.lat) > 80 || Math.abs(p.lon) > 180)
            throw new Error('Choose valid canal departure and exit positions.');
    const distance = canalDistanceM(start, exit);
    if (distance < 20)
        throw new Error('Canal exit is too close to departure. Place it at least 20 m away, beyond the canal walls.');
    if (Math.abs(start.lon - exit.lon) > 1)
        throw new Error('Canal section is too large. Place the exit closer, or plot this section manually.');
    // Budget by actual fixed-resolution grid area, not an arbitrary 4 km
    // endpoint separation: a narrow 4.8 km crop fits where a wide 3 km one may
    // not. makeGrid retains the 750,000-cell cap; the adapter also caps tiles
    // and worker time. Never coarsen the canals to fit a larger area.
    const padLat = 250 / M_LAT,
        padLon = 250 / mLon(start.lat);
    const bbox: CanalBbox = [
        Math.min(start.lon, exit.lon) - padLon,
        Math.min(start.lat, exit.lat) - padLat,
        Math.max(start.lon, exit.lon) + padLon,
        Math.max(start.lat, exit.lat) + padLat,
    ];
    makeGrid(bbox);
    return bbox;
}

function makeGrid(bbox: CanalBbox): Omit<CanalGrid, 'water'> {
    const [minLon, minLat, maxLon, maxLat] = bbox;
    const dLat = CANAL_RESOLUTION_M / M_LAT,
        dLon = CANAL_RESOLUTION_M / mLon((minLat + maxLat) / 2);
    const width = Math.ceil((maxLon - minLon) / dLon),
        height = Math.ceil((maxLat - minLat) / dLat);
    if (![width, height].every(Number.isFinite) || width < 3 || height < 3 || width * height > CANAL_MAX_CELLS)
        throw new Error('Canal section is too large. Place the exit closer, or plot this section manually.');
    return { minLon, minLat, width, height, dLon, dLat };
}

/** Check every grid cell touched by the actual straight segments, including pins.
 * Optional clipping is only for checking SevenCs against this local crop. */
export function canalSegmentsInWater(coordinates: readonly CanalPair[], grid: CanalGrid, clip = false): boolean {
    const { width, height, minLon, minLat, dLon, dLat, water } = grid;
    if (
        ![width, height].every((v) => Number.isInteger(v) && v > 0) ||
        ![minLon, minLat, dLon, dLat].every(Number.isFinite) ||
        dLon <= 0 ||
        dLat <= 0 ||
        water.length !== width * height
    )
        return false;
    let visits = 0;
    for (let i = 1; i < coordinates.length; i++) {
        const a = coordinates[i - 1],
            b = coordinates[i];
        if (![...a, ...b].every(Number.isFinite)) return false;
        const ax = (a[0] - minLon) / dLon,
            ay = (a[1] - minLat) / dLat;
        const dx = (b[0] - a[0]) / dLon,
            dy = (b[1] - a[1]) / dLat;
        let lo = 0,
            hi = 1;
        if (clip) {
            // Liang–Barsky: skip outside portions, never skip an in-crop crossing.
            for (const [p, q] of [
                [-dx, ax],
                [dx, width - 0.00001 - ax],
                [-dy, ay],
                [dy, height - 0.00001 - ay],
            ]) {
                if (p === 0) {
                    if (q < 0) hi = -1;
                } else if (p < 0) lo = Math.max(lo, q / p);
                else hi = Math.min(hi, q / p);
            }
            if (lo > hi) continue;
        }
        if (
            !visitGridSegment(ax + dx * lo, ay + dy * lo, ax + dx * hi, ay + dy * hi, (x, y) => {
                if (++visits > 200_000) return false;
                // Clipping validates only the known crop, including every in-crop
                // cell at an entry/exit. An outside neighbour at that boundary is
                // not evidence about the provider's route beyond our local map.
                if (x < 0 || y < 0 || x >= width || y >= height) return clip;
                return !!water[y * width + x];
            })
        )
            return false;
    }
    return coordinates.length >= 2;
}

export function buildCanalDepartureGeometry(
    start: CanalPoint,
    exit: CanalPoint,
    bbox: CanalBbox,
    waterFeatures: FeatureCollection,
    obstacles: FeatureCollection,
    gateCentres?: CanalPoint[],
): CanalDepartureGeometry {
    validateCanalGateCentres(exit, bbox, gateCentres);
    const shape = makeGrid(bbox);
    const { width, height, minLon, minLat, dLon, dLat } = shape;
    const water = new Uint8Array(width * height);
    // Only observed polygon water supplies connectivity. Holes remain land.
    for (const f of waterFeatures.features)
        if (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon')
            rasterizePolygonCells(shape, f.geometry, (x, y) => {
                water[y * width + x] = 1;
            });
    const stamp = (x: number, y: number) => {
        // Pad obstacle boundaries one cell. Thin walls/piers cannot fall between raster centres.
        for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++)
                if (x + dx >= 0 && x + dx < width && y + dy >= 0 && y + dy < height)
                    water[(y + dy) * width + x + dx] = 0;
    };
    const line = (coords: Position[]) => {
        for (let i = 1; i < coords.length; i++) {
            const a = coords[i - 1],
                b = coords[i];
            const steps = Math.ceil((canalDistanceM(asPoint(a), asPoint(b)) / CANAL_RESOLUTION_M) * 2);
            if (!Number.isFinite(steps) || steps > 100_000) throw new Error('Canal obstacle geometry is too large.');
            for (let j = 0; j <= steps; j++) {
                const t = steps ? j / steps : 0;
                stamp(
                    Math.floor((a[0] + (b[0] - a[0]) * t - minLon) / dLon),
                    Math.floor((a[1] + (b[1] - a[1]) * t - minLat) / dLat),
                );
            }
        }
    };
    const block = (geom: Geometry) => {
        if (geom.type === 'Polygon' || geom.type === 'MultiPolygon') {
            rasterizePolygonCells(shape, geom, stamp);
            (geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates).forEach((p) => p.forEach(line));
        } else if (geom.type === 'LineString') line(geom.coordinates);
        else if (geom.type === 'MultiLineString') geom.coordinates.forEach(line);
        else if (geom.type === 'Point')
            stamp(Math.floor((geom.coordinates[0] - minLon) / dLon), Math.floor((geom.coordinates[1] - minLat) / dLat));
        else throw new Error('Unsupported canal obstacle geometry. Plot this section manually.');
    };
    obstacles.features.forEach((f) => block(f.geometry));
    const providerWater = water.slice();
    // Block crop edges too: no route can use the rim as an invented exit.
    for (let x = 0; x < width; x++) {
        water[x] = 0;
        water[(height - 1) * width + x] = 0;
    }
    for (let y = 0; y < height; y++) {
        water[y * width] = 0;
        water[y * width + width - 1] = 0;
    }
    const grid: CanalGrid = { ...shape, water };
    // The same eroded provider mask is also used to veto constrained-anchor
    // cleanup. Never trade away an existing clearance margin for a smoother line.
    const clearance = euclideanDistanceTransform(providerWater, shape);
    const checkWater = Uint8Array.from(providerWater, (v, i) => (v && clearance[i] >= 2 ? 1 : 0));
    const checkGrid: CanalGrid = { ...grid, water: checkWater };
    // Match the solver's erosion exactly, including the artificial crop rim.
    // Retain this margin along every interior chord, not just at marker gates.
    const routeClearance = euclideanDistanceTransform(water, shape);
    const passable = Uint8Array.from(water, (v, i) => (v && routeClearance[i] >= 2 ? 1 : 0));
    const anchorCheckGrid: CanalGrid = { ...grid, water: passable };
    const anchors = [start, ...(gateCentres ?? [exit])];
    if (anchors.some((anchor) => !canalSegmentsInWater([pair(anchor), pair(anchor)], grid)))
        if (gateCentres)
            throw new Error(
                'Departure or a verified marker gate is outside mapped unobstructed water. Plot this exit manually.',
            );
        else
            throw new Error(
                'Departure or Canal exit is outside mapped unobstructed water. Move the pin into the channel.',
            );
    // Uniform cost only, NOT depth. No synthetic 5/10 m soundings enter review.
    const depth = Float32Array.from(water, (v) => (v ? 1 : NaN));
    const cell = (p: CanalPoint) => ({
        x: Math.floor((p.lon - minLon) / dLon),
        y: Math.floor((p.lat - minLat) / dLat),
    });
    // Rasterize once. Solve independently between pinned gate centres so the
    // solver's string-pulling can never simplify a bend past a mandatory gate.
    // The disposable worker's existing total time budget still covers all legs.
    const pinned: CanalPair[] = [pair(start)];
    for (let i = 1; i < anchors.length; i++) {
        const from = anchors[i - 1],
            to = anchors[i];
        if (from.lat === to.lat && from.lon === to.lon) continue;
        const solved = routeMarina(depth, shape, cell(from), cell(to), {
            keelCells: 2,
            depthWeight: 0,
            canalHalfWidthCells: 12,
            bias: 5,
            simplifyWaypoints: false,
        });
        if (!solved)
            throw new Error(
                'No connected canal exit found. No shortcut has been substituted. Try another exit or plot manually.',
            );
        // routeMarina's legacy waypoints are shortest line-of-sight chords.
        // Preserve its actual centred search path instead: remove grid stairs
        // only within a tight deviation bound, checking all touched cells.
        const centred = preserveCanalCentreline(solved.cells, passable, routeClearance, shape);
        if (!centred) throw new Error('Canal centreline could not be verified. Plot this section manually.');
        const interior: CanalPair[] = centred.map((c) => [minLon + (c.x + 0.5) * dLon, minLat + (c.y + 0.5) * dLat]);
        if (canalDistanceM(from, asPoint(interior[0])) > 12 || canalDistanceM(to, asPoint(interior.at(-1)!)) > 12)
            throw new Error('A canal endpoint would need to jump too far. Move it into the channel.');
        if (interior.length > 1 && !canalSegmentsInWater(interior, anchorCheckGrid))
            throw new Error('Canal path loses the mapped bank margin. Plot this section manually.');
        if (gateCentres) {
            // A pinned exact midpoint and its raster-centre surrogate can be
            // ~1 m apart. Keeping both on both adjoining legs creates a tiny
            // out-and-back. Remove only these one-cell endpoint surrogates,
            // and only when the new actual segment passes BOTH original raw
            // water and the stricter eroded mask. Exact gates are never removed.
            const withinOneCell = CANAL_RESOLUTION_M * Math.SQRT2;
            const clearReplacement = (a: CanalPair, b: CanalPair) =>
                canalSegmentsInWater([a, b], grid) && canalSegmentsInWater([a, b], anchorCheckGrid);
            if (
                interior.length &&
                canalDistanceM(from, asPoint(interior[0])) <= withinOneCell &&
                clearReplacement(pair(from), interior[1] ?? pair(to))
            )
                interior.shift();
            if (
                interior.length &&
                canalDistanceM(to, asPoint(interior.at(-1)!)) <= withinOneCell &&
                clearReplacement(interior.at(-2) ?? pair(from), pair(to))
            )
                interior.pop();
        }
        const segment = [pair(from), ...interior, pair(to)];
        if (!canalSegmentsInWater(segment, grid))
            throw new Error('Canal path crosses a mapped bank or obstruction. Plot this section manually.');
        pinned.push(...segment.slice(1));
    }
    const coordinates = pinned.filter((p, i, all) => i === 0 || p[0] !== all[i - 1][0] || p[1] !== all[i - 1][1]);
    if (!canalSegmentsInWater(coordinates, grid))
        throw new Error('Canal path crosses a mapped bank or obstruction. Plot this section manually.');
    // Independently verify continuous polygon containment as well. A water
    // cell's centre does not prove its whole area is water; thin banks/holes
    // and exact endpoint joins must not pass just because the raster missed
    // them. Tile seams are interior to the polygon union, not invented walls.
    if (!canalPathWithinWater(coordinates, waterFeatures))
        throw new Error('Canal path could not be verified inside mapped water boundaries. Plot this section manually.');
    // Eroded mask for the PROVIDER seam/backtracking check. Endpoint pins were
    // checked separately against raw water; SevenCs may not cut near the walls.
    return { coordinates, grid: checkGrid };
}
