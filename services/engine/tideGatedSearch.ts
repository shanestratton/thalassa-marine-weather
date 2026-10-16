/** Worker-safe CANDIDATE search. These numeric windows are not authority:
 * only the main-thread issued source permit and final exact-clock reread may
 * admit a result. No source/settings/saved-route DTO can issue that permit. */
import type { Polygon, MultiPolygon } from 'geojson';
import type { NavGrid } from './types';
import { MinHeap, cellCostMultiplier } from './aStar';
import { haversineM, mPerDegLon } from './geometry';
import { M_PER_DEG_LAT } from './constants';
import { trackPriorFactor, TRACK_PRIOR_MIN_FACTOR } from './trackPriors';
import { trafficLaneStepFactor } from './trafficLanes';
import { exclusionCostFactor } from './exclusionField';
import { holdingGeometryRelation, type HoldingBounds } from '../enc/holdingFootprint';
export interface TideGateAreaWindow {
    fromMs: number;
    untilMs: number;
    minLowM: number;
}
export interface TideGateArea {
    id: string;
    geometry: Polygon | MultiPolygon;
    coverage: HoldingBounds;
    station: { lat: number; lon: number };
    maxDistanceKm: number;
    chartedDepthM: number;
    windows: readonly TideGateAreaWindow[];
}
export interface TideGatedCandidateRequest {
    enabled: boolean;
    from: { lat: number; lon: number };
    to: { lat: number; lon: number };
    departureMs: number;
    speedKts: number;
    requiredM: number;
    expiresAtMs: number;
    uncertaintyMs: number;
    maxJourneyMs: number;
    areas: readonly TideGateArea[];
    /** Original point minima may only reduce an already charted area depth. */
    soundings?: readonly { lon: number; lat: number; depthM: number }[];
    /** Actual complete source read window; ceil-rounded edge cells cannot escape. */
    sourceBounds?: HoldingBounds;
}
export interface TideGridPath {
    grid: { width: number; height: number; minLon: number; minLat: number; dLon: number; dLat: number };
    points: readonly (readonly [number, number])[];
    timesMs: readonly number[];
    indices: readonly number[];
    distanceM: number;
    tideCells: readonly number[];
}
export type TideGatedCandidate =
    | { kind: 'off' }
    | { kind: 'held'; reason: string; strict: TideGridPath | null }
    | { kind: 'candidate'; strict: TideGridPath | null; path: TideGridPath };
const MAX_LABELS = 25000,
    BUCKET_MS = 300000,
    MAX_JOURNEY_MS = 86400000;
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
type GatedGrid = NavGrid & { exclusionBlocked?: Uint8Array };
export function tideGatedBounds(
    from: { lat: number; lon: number },
    to: { lat: number; lon: number },
): HoldingBounds | null {
    if (
        ![from.lat, from.lon, to.lat, to.lon].every(finite) ||
        Math.max(Math.abs(from.lat), Math.abs(to.lat)) > 80 ||
        Math.max(Math.abs(from.lon), Math.abs(to.lon)) > 180 ||
        Math.abs(from.lon - to.lon) > 180
    )
        return null;
    const pad = Math.max(Math.max(Math.abs(from.lat - to.lat), Math.abs(from.lon - to.lon)) * 0.5, 0.08);
    const b = [
        Math.min(from.lon, to.lon) - pad,
        Math.min(from.lat, to.lat) - pad,
        Math.max(from.lon, to.lon) + pad,
        Math.max(from.lat, to.lat) + pad,
    ] as const;
    return b[0] >= -180 && b[2] <= 180 && b[1] >= -85 && b[3] <= 85 ? b : null;
}
export function tideGatedGridLayout(bounds: HoldingBounds) {
    const mPerLon = mPerDegLon((bounds[1] + bounds[3]) / 2);
    const w = (bounds[2] - bounds[0]) * mPerLon,
        h = (bounds[3] - bounds[1]) * M_PER_DEG_LAT;
    let resolutionM = Math.max(50, Math.ceil(Math.sqrt((w * h) / 2500000)));
    const dimensions = () => ({
        width: Math.ceil((bounds[2] - bounds[0]) / (resolutionM / mPerLon)),
        height: Math.ceil((bounds[3] - bounds[1]) / (resolutionM / M_PER_DEG_LAT)),
    });
    let size = dimensions();
    while (size.width * size.height > 2500000) {
        resolutionM++;
        size = dimensions();
    }
    return {
        resolutionM,
        grid: {
            ...size,
            minLon: bounds[0],
            minLat: bounds[1],
            dLon: resolutionM / mPerLon,
            dLat: resolutionM / M_PER_DEG_LAT,
        },
    };
}
/** No grid writes, snaps, carves, interpolation of extrema or implicit waits.
 * Baseline is measured first on exactly the same original grid/masks. */
export function searchTideGatedCandidate(
    grid: GatedGrid,
    r: TideGatedCandidateRequest,
    options: { check: () => void; now?: () => number } = { check: () => {} },
): TideGatedCandidate {
    if (!r.enabled) return { kind: 'off' };
    const no = (reason: string, strict: TideGridPath | null = null): TideGatedCandidate => ({
        kind: 'held',
        reason,
        strict,
    });
    options.check();
    const now = options.now ?? Date.now,
        started = now();
    if (
        ![
            r.departureMs,
            r.speedKts,
            r.requiredM,
            r.uncertaintyMs,
            r.maxJourneyMs,
            r.expiresAtMs,
            r.from.lat,
            r.from.lon,
            r.to.lat,
            r.to.lon,
            grid.minLat,
            grid.minLon,
            grid.dLat,
            grid.dLon,
        ].every(finite) ||
        r.speedKts <= 0 ||
        r.speedKts > 100 ||
        r.requiredM <= 0 ||
        r.uncertaintyMs < 60000 ||
        r.uncertaintyMs > 3600000 ||
        r.maxJourneyMs <= 0 ||
        r.maxJourneyMs > MAX_JOURNEY_MS ||
        grid.dLat <= 0 ||
        grid.dLon <= 0 ||
        !Number.isInteger(grid.width) ||
        !Number.isInteger(grid.height) ||
        grid.width < 1 ||
        grid.height < 1 ||
        grid.width * grid.height > 2500000 ||
        grid.cells.length !== grid.width * grid.height ||
        grid.minLon < -180 ||
        grid.minLon + grid.width * grid.dLon > 180 ||
        grid.minLat < -85 ||
        grid.minLat + grid.height * grid.dLat > 85 ||
        Math.max(Math.abs(r.from.lat), Math.abs(r.to.lat)) > 80 ||
        Math.max(Math.abs(r.from.lon), Math.abs(r.to.lon)) > 180 ||
        Math.abs(r.from.lon - r.to.lon) > 180 ||
        !Array.isArray(r.areas) ||
        r.areas.length > 32 ||
        r.areas.some((a) => !a || !Array.isArray(a.windows)) ||
        (r.sourceBounds !== undefined && (r.sourceBounds.length !== 4 || !r.sourceBounds.every(finite))) ||
        r.areas.reduce((n, a) => n + (a.windows?.length ?? 10000), 0) > 512
    )
        return no('Tide search bounds, exact departure, speed or arrival uncertainty are unavailable.');
    const check = () => {
        options.check();
        const t = now();
        if (!finite(t) || t < started || t - started > 10000 || t >= r.expiresAtMs)
            throw new DOMException(
                'Tide candidate search exceeded 10 seconds, its source expired or its clock changed.',
                'AbortError',
            );
    };
    const index = (p: { lat: number; lon: number }) => {
        const x = Math.floor((p.lon - grid.minLon) / grid.dLon),
            y = Math.floor((p.lat - grid.minLat) / grid.dLat);
        return x >= 0 && y >= 0 && x < grid.width && y < grid.height ? y * grid.width + x : -1;
    };
    const start = index(r.from),
        end = index(r.to);
    if (start < 0 || end < 0) return no('An exact endpoint lies outside the original grid; no snap is substituted.');
    if (start === end) return no('Both exact endpoints occupy one grid cell; no bank shortcut is substituted.');
    const position = (idx: number): readonly [number, number] =>
        idx === start
            ? [r.from.lon, r.from.lat]
            : idx === end
              ? [r.to.lon, r.to.lat]
              : [
                    grid.minLon + ((idx % grid.width) + 0.5) * grid.dLon,
                    grid.minLat + (Math.floor(idx / grid.width) + 0.5) * grid.dLat,
                ];
    const bounds = (idx: number): HoldingBounds => {
        const w = grid.minLon + (idx % grid.width) * grid.dLon,
            s = grid.minLat + Math.floor(idx / grid.width) * grid.dLat;
        return [w, s, w + grid.dLon, s + grid.dLat];
    };
    const hard = (i: number) =>
        !finite(grid.cells[i]) ||
        !!(
            r.sourceBounds &&
            (grid.minLon + (i % grid.width) * grid.dLon < r.sourceBounds[0] ||
                grid.minLat + Math.floor(i / grid.width) * grid.dLat < r.sourceBounds[1] ||
                grid.minLon + ((i % grid.width) + 1) * grid.dLon > r.sourceBounds[2] ||
                grid.minLat + (Math.floor(i / grid.width) + 1) * grid.dLat > r.sourceBounds[3])
        ) ||
        !!(
            grid.landBlocked?.[i] ||
            grid.obstnBlocked?.[i] ||
            grid.berthBlocked?.[i] ||
            grid.clearanceBarred?.[i] ||
            grid.unvouched?.[i] ||
            grid.wetConflict?.[i] ||
            grid.relaxMask?.[i] ||
            grid.noTideClears?.[i] ||
            grid.wingCaution?.[i] ||
            grid.exclusionBlocked?.[i]
        );
    const depth = (i: number) =>
        finite(grid.shallowDepthM?.[i])
            ? Math.min(grid.cells[i] >= 0 ? grid.cells[i] : Infinity, grid.shallowDepthM![i])
            : grid.cells[i];
    const deep = (i: number) => !hard(i) && depth(i) >= r.requiredM;
    const bank = (i: number) =>
        !hard(i) &&
        grid.chartedShallow?.[i] === 1 &&
        finite(grid.shallowDepthM?.[i]) &&
        grid.shallowDepthM![i] > 0 &&
        grid.shallowDepthM![i] < r.requiredM;
    const cellAreas = new Map<number, readonly TideGateArea[]>();
    let vertices = 0,
        comparisons = 0;
    const vertex = () => {
        if (++vertices > 262144) throw Error('Tide footprint vertex budget reached.');
        if (vertices % 256 === 0) check();
    };
    const compare = () => {
        if (++comparisons > 500000) throw Error('Tide footprint comparison budget reached.');
        if (comparisons % 256 === 0) check();
    };
    const areasAt = (idx: number): readonly TideGateArea[] => {
        const cached = cellAreas.get(idx);
        if (cached) return cached;
        if (cellAreas.size >= 128) return [];
        const b = bounds(idx),
            at = { lat: (b[1] + b[3]) / 2, lon: (b[0] + b[2]) / 2 };
        const radius = haversineM(b[1], b[0], b[3], b[2]);
        const matches = r.areas.filter(
            (a) =>
                a &&
                typeof a.id === 'string' &&
                a.id.length > 0 &&
                a.id.length <= 160 &&
                finite(a.chartedDepthM) &&
                a.chartedDepthM > 0 &&
                a.coverage.length === 4 &&
                a.coverage.every(finite) &&
                b[0] >= a.coverage[0] &&
                b[1] >= a.coverage[1] &&
                b[2] <= a.coverage[2] &&
                b[3] <= a.coverage[3] &&
                finite(a.station?.lat) &&
                finite(a.station?.lon) &&
                finite(a.maxDistanceKm) &&
                a.maxDistanceKm > 0 &&
                a.maxDistanceKm <= 15 &&
                haversineM(at.lat, at.lon, a.station.lat, a.station.lon) + radius <= a.maxDistanceKm * 1000 &&
                holdingGeometryRelation(a.geometry, b, vertex, compare).covers,
        );
        cellAreas.set(idx, matches);
        return matches;
    };
    const admitted = (idx: number, from: number, until: number, allowTide: boolean) => {
        if (deep(idx)) return true;
        if (!allowTide || !bank(idx)) return false;
        const lo = r.departureMs + Math.floor((from - r.departureMs) / BUCKET_MS) * BUCKET_MS - r.uncertaintyMs;
        const hi = r.departureMs + Math.ceil((until - r.departureMs) / BUCKET_MS) * BUCKET_MS + r.uncertaintyMs;
        return areasAt(idx).some((a) =>
            a.windows.some(
                (w) =>
                    [w.fromMs, w.untilMs, w.minLowM].every(finite) &&
                    w.untilMs > w.fromMs &&
                    w.fromMs <= lo &&
                    w.untilMs >= hi &&
                    Math.min(a.chartedDepthM, grid.shallowDepthM![idx]) + w.minLowM >= r.requiredM,
            ),
        );
    };
    interface Label {
        index: number;
        parent: number;
        cost: number;
        at: number;
        key: number;
    }
    const search = (allowTide: boolean): TideGridPath | null => {
        if (!admitted(start, r.departureMs, r.departureMs, allowTide)) return null;
        const labels: Label[] = [],
            best = new Map<number, number>(),
            open = new MinHeap();
        const buckets = Math.ceil(r.maxJourneyMs / BUCKET_MS) + 1;
        const speedMs = (r.speedKts * 1852) / 3600;
        const heuristic = (i: number) => {
            const p = position(i);
            return haversineM(p[1], p[0], r.to.lat, r.to.lon) * TRACK_PRIOR_MIN_FACTOR;
        };
        const add = (index: number, parent: number, cost: number, at: number) => {
            const key = index * buckets + Math.floor((at - r.departureMs) / BUCKET_MS),
                old = best.get(key);
            if (old !== undefined && labels[old].cost <= cost) return;
            if (labels.length >= MAX_LABELS) throw Error('Tide candidate reached its 25,000-label bound.');
            const id = labels.length;
            labels.push({ index, parent, cost, at, key });
            best.set(key, id);
            open.push({ idx: id, f: cost + heuristic(index) });
        };
        add(start, -1, 0, r.departureMs);
        while (open.size) {
            check();
            const id = open.pop()!.idx,
                current = labels[id];
            if (best.get(current.key) !== id) continue;
            if (current.index === end) {
                const path: Label[] = [],
                    seen = new Set<number>();
                let next = id,
                    loop = false;
                while (next >= 0) {
                    const l = labels[next];
                    if (seen.has(l.index)) {
                        loop = true;
                        break;
                    }
                    seen.add(l.index);
                    path.push(l);
                    next = l.parent;
                }
                // Sailing a loop is not an authorized holding wait.
                if (loop) continue;
                path.reverse();
                const points = path.map((l) => position(l.index));
                let distanceM = 0;
                for (let i = 1; i < points.length; i++)
                    distanceM += haversineM(points[i - 1][1], points[i - 1][0], points[i][1], points[i][0]);
                const tideCells = new Set(path.filter((l) => !deep(l.index)).map((l) => l.index));
                for (let i = 1; i < path.length; i++) {
                    const a = path[i - 1].index,
                        b = path[i].index;
                    if (a % grid.width !== b % grid.width && Math.floor(a / grid.width) !== Math.floor(b / grid.width))
                        for (const side of [
                            Math.floor(a / grid.width) * grid.width + (b % grid.width),
                            Math.floor(b / grid.width) * grid.width + (a % grid.width),
                        ])
                            if (!deep(side)) tideCells.add(side);
                }
                return {
                    grid: {
                        width: grid.width,
                        height: grid.height,
                        minLon: grid.minLon,
                        minLat: grid.minLat,
                        dLon: grid.dLon,
                        dLat: grid.dLat,
                    },
                    points,
                    timesMs: path.map((l) => l.at),
                    indices: path.map((l) => l.index),
                    distanceM,
                    tideCells: [...tideCells],
                };
            }
            const x = current.index % grid.width,
                y = Math.floor(current.index / grid.width),
                a = position(current.index);
            for (let dy = -1; dy <= 1; dy++)
                for (let dx = -1; dx <= 1; dx++) {
                    if (!dx && !dy) continue;
                    const nx = x + dx,
                        ny = y + dy;
                    if (nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.height) continue;
                    const n = ny * grid.width + nx,
                        b = position(n),
                        length = haversineM(a[1], a[0], b[1], b[0]),
                        at = current.at + (length / speedMs) * 1000,
                        course =
                            ((Math.atan2((b[0] - a[0]) * mPerDegLon((a[1] + b[1]) / 2), (b[1] - a[1]) * M_PER_DEG_LAT) *
                                180) /
                                Math.PI +
                                360) %
                            360,
                        trafficFactor = trafficLaneStepFactor(grid, current.index, n, course);
                    if (
                        !Number.isFinite(trafficFactor) ||
                        at - r.departureMs > r.maxJourneyMs ||
                        !admitted(current.index, current.at, at, allowTide) ||
                        !admitted(n, current.at, at, allowTide) ||
                        (dx &&
                            dy &&
                            (!admitted(y * grid.width + nx, current.at, at, allowTide) ||
                                !admitted(ny * grid.width + x, current.at, at, allowTide)))
                    )
                        continue;
                    const centre = finite(grid.centreFactor?.[n]) ? Math.max(1, grid.centreFactor![n]) : 1;
                    const factor = deep(n)
                        ? cellCostMultiplier(grid.cells[n], grid.preferred[n] === 1) * trackPriorFactor(grid, n)
                        : 1.5;
                    add(
                        n,
                        id,
                        current.cost + length * factor * centre * trafficFactor * exclusionCostFactor(grid, n),
                        at,
                    );
                }
        }
        return null;
    };
    let strict: TideGridPath | null = null;
    try {
        strict = search(false);
        check();
        if (!r.areas.length)
            return no(
                'No navigation-qualified original tide windows and whole-cell datum/source proof are aboard.',
                strict,
            );
        const path = search(true);
        check();
        if (!path || !path.tideCells.length || (strict && path.distanceM >= strict.distanceM - 20))
            return no(
                'No shorter fully admitted crossing within the exact planned time bounds; a delay needs a separately verified holding wait.',
                strict,
            );
        return { kind: 'candidate', strict, path };
    } catch (error) {
        options.check();
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        return no(error instanceof Error ? error.message : 'Tide candidate unavailable.', strict);
    }
}
