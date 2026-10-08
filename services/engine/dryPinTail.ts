/**
 * A pin on dry ground gets its route (package 125-05b).
 *
 * Shane, 2026-10-08: "tried to do a route from the newport canals to
 * tangalooma, i got some message about it being dry at both ends???? again,
 * no one is going to use it, if it is too tight. better we just have red at
 * the "dry" zones, rather than just shit caning the whole route".
 *
 * The grid snaps a pin on charted drying ground (or in water no tide clears)
 * to the nearest water it can use — the deep water off a beach, or the edge
 * of the water a tide clears — and the route used to stop there: 153–220 m
 * short of the Tangalooma beach pins on the real cells, with "the route stops
 * at its edge" at both ends. The orchestrator (inshoreRouterEngine) now runs
 * the route on to the pin, red, and this builds that tail: from the route's
 * water to the pin, held to the chart itself — never charted land (the
 * audit's own point rule: decision-1 and OSM water are water, a drying band
 * under land paint is land), never water no chart covers, never under a
 * structure the mast cannot clear, never inside a charted hazard's keep-out,
 * nor across anything else the grid closes (a breakwater or coastline line,
 * a berth, an OSM reef or airfield, a mark's keep-out: review fix-up,
 * 2026-10-09). The straight line where it passes; else the grid's cheapest
 * way through water and dry ground (water preferred, the shallower drying
 * preferred), simplified where the chart allows; else none, and the route
 * stops at the water's edge as before. Pure.
 */
import type { Feature, MultiPolygon, Polygon, Position } from 'geojson';
import type { InshoreLayers, NavGrid } from './types';
import {
    bboxBuckets,
    douglasPeucker,
    geometryBbox,
    gridToLatLon,
    haversineM,
    latLonToGrid,
    mPerDegLon,
    pointInGeometry,
    segmentDistanceM,
    segmentGeometryDistanceM,
} from './geometry';
import { M_PER_DEG_LAT } from './constants';
import { MinHeap } from './aStar';
import { hardLandAtPoint, hazardBufferReader } from './safetyAudit';
import { chartAreaIndexFor, chartedDepthAt } from '../routing/leadLandClip';
import { polylineCrossesClearanceBar } from '../routing/overheadClearance';
import { isS57ChartProps } from '../enc/types';

type Pt = [number, number];

/** The chart's own checks for a pin's dry tail. */
export interface DryTailChart {
    /** Why the straight line a→b may not be part of a tail, or null. */
    lineFault(a: readonly [number, number], b: readonly [number, number]): string | null;
    /** Dry ground for this boat: charted drying (DRVAL1 < 0), or water no tide clears. */
    isDry(lon: number, lat: number): boolean;
}

/** Every ≤5 m along a tail is read against the chart. */
const STEP_M = 5;

export function dryTailChart(
    layers: InshoreLayers,
    opts: {
        needM: number;
        obstructionBufferM: number;
        /** Water no tide clears for this boat (engine/tideCeiling noTideClearsAt). */
        noTideAt: (lon: number, lat: number) => unknown;
    },
): DryTailChart {
    const onLand = hardLandAtPoint(layers);
    const bands = chartAreaIndexFor(layers).depth;
    const structures = layers.OBSTRN?.features ?? [];
    let hazards: ((polyline: readonly (readonly [number, number])[]) => boolean[]) | null = null;
    let furniture: ((a: readonly [number, number], b: readonly [number, number]) => string | null) | null = null;
    return {
        lineFault(a, b) {
            const steps = Math.max(1, Math.ceil(haversineM(a[1], a[0], b[1], b[0]) / STEP_M));
            for (let k = 0; k <= steps; k++) {
                const lon = a[0] + ((b[0] - a[0]) * k) / steps;
                const lat = a[1] + ((b[1] - a[1]) * k) / steps;
                if (onLand(lon, lat)) return 'charted land';
                if (bands.length > 0 && chartedDepthAt(bands, lon, lat) === null) return 'water no chart covers';
            }
            if (polylineCrossesClearanceBar([a, b], structures)) return 'a low structure';
            hazards ??= hazardBufferReader(layers, opts.obstructionBufferM, opts.needM);
            if (hazards([a, b])[0]) return "a charted hazard's keep-out";
            furniture ??= gridFurnitureFault(layers, { ...opts, bands });
            return furniture(a, b);
        },
        isDry(lon, lat) {
            const d = bands.length > 0 ? chartedDepthAt(bands, lon, lat) : null;
            return (d !== null && d < 0) || !!opts.noTideAt(lon, lat);
        },
    };
}

/**
 * What the grid closes that the chart reads above do not (review fix-up,
 * 2026-10-09): a tail drawn straight past the grid crossed an OSM breakwater
 * line and 114 m of an OSM reef on the way to a pin on the sand behind them,
 * and its words told the skipper which tide floats him over it. Held to the
 * same blocks as the grid (navGrid passes 2b, 2c and 3), exactly: never
 * across a COASTLINE line (an OSM breakwater always, natural=coastline too —
 * a pin behind one is the shore's, not the sand's), never into a berth, never
 * into an obstruction with no S-57 identity (an OSM reef, an airfield, a
 * mark's inferred keep-out — the audit's hazard reader skips them) nor within
 * the keep-out of such a point. A mark's keep-out that yields to deep charted
 * water (navGrid's _yieldsToChartedDeep) is read where the chart has it
 * shallower than the keel needs. Why, or null.
 */
function gridFurnitureFault(
    layers: InshoreLayers,
    opts: { needM: number; obstructionBufferM: number; bands: ReturnType<typeof chartAreaIndexFor>['depth'] },
): (a: readonly [number, number], b: readonly [number, number]) => string | null {
    interface Line {
        c: Position;
        d: Position;
        why: string;
    }
    interface Area {
        geom: Polygon | MultiPolygon;
        bbox: [number, number, number, number];
        why: string;
        yields: boolean;
    }
    interface Spot {
        p: Position;
        why: string;
    }
    const lines: Line[] = [];
    const areas: Area[] = [];
    const spots: Spot[] = [];
    const addLines = (f: Feature, why: string): void => {
        const g = f.geometry;
        if (!g || (g.type !== 'LineString' && g.type !== 'MultiLineString')) return;
        const parts = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
        for (const coords of parts)
            for (let i = 0; i + 1 < coords.length; i++) lines.push({ c: coords[i], d: coords[i + 1], why });
    };
    const addArea = (f: Feature, why: string, yields = false): void => {
        const g = f.geometry;
        if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) return;
        areas.push({ geom: g, bbox: geometryBbox(g), why, yields });
    };
    for (const f of layers.COASTLINE?.features ?? [])
        addLines(
            f,
            (f.properties as { natural?: unknown } | null)?.natural === 'coastline' ? 'the coastline' : 'a breakwater',
        );
    for (const f of layers.BERTH?.features ?? []) {
        addLines(f, 'a berth');
        addArea(f, 'a berth');
    }
    for (const fcol of [layers.OBSTRN, layers.WRECKS, layers.UWTROC]) {
        for (const f of fcol?.features ?? []) {
            const props = f.properties as Record<string, unknown> | null;
            const cls = props?._class;
            // Not obstructions (pair-wings), read above (clearance bars), or
            // charted (the audit's hazard reader, above).
            if (cls === 'pair-wing' || cls === 'low-clearance' || isS57ChartProps(props) || !f.geometry) continue;
            const isMarkDisc =
                cls === 'iala-oriented-hazard' || cls === 'direct-hazard' || cls === 'lateral-marker-as-hazard';
            const why =
                cls === 'osm-reef'
                    ? 'a reef'
                    : cls === 'osm-aeroway'
                      ? 'an airfield'
                      : isMarkDisc
                        ? "a mark's keep-out"
                        : 'an obstruction';
            const g = f.geometry;
            if (g.type === 'Point') spots.push({ p: g.coordinates, why });
            else if (g.type === 'MultiPoint') for (const p of g.coordinates) spots.push({ p, why });
            else addArea(f, why, isMarkDisc && props?._yieldsToChartedDeep === true);
        }
    }
    if (lines.length === 0 && areas.length === 0 && spots.length === 0) return () => null;
    const lineNear = bboxBuckets(lines, (l) => [
        Math.min(l.c[0], l.d[0]),
        Math.min(l.c[1], l.d[1]),
        Math.max(l.c[0], l.d[0]),
        Math.max(l.c[1], l.d[1]),
    ]);
    const areaNear = bboxBuckets(areas, (x) => x.bbox);
    const spotNear = bboxBuckets(spots, (x) => [x.p[0], x.p[1], x.p[0], x.p[1]]);
    return (a, b) => {
        const kx = mPerDegLon((a[1] + b[1]) / 2);
        const ky = M_PER_DEG_LAT;
        const box = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
        for (const l of lineNear(box)) if (segmentDistanceM(a, b, l.c, l.d, kx, ky) < 0.5) return l.why;
        for (const x of areaNear(box)) {
            if (!x.yields) {
                if (segmentGeometryDistanceM(a, b, x.geom, kx, ky) === 0) return x.why;
                continue;
            }
            const steps = Math.max(1, Math.ceil(haversineM(a[1], a[0], b[1], b[0]) / STEP_M));
            for (let k = 0; k <= steps; k++) {
                const lon = a[0] + ((b[0] - a[0]) * k) / steps;
                const lat = a[1] + ((b[1] - a[1]) * k) / steps;
                if (!pointInGeometry(lon, lat, x.geom)) continue;
                const d = opts.bands.length > 0 ? chartedDepthAt(opts.bands, lon, lat) : null;
                if (d === null || d < opts.needM) return x.why;
            }
        }
        const padLon = opts.obstructionBufferM / kx;
        const padLat = opts.obstructionBufferM / ky;
        for (const x of spotNear([box[0] - padLon, box[1] - padLat, box[2] + padLon, box[3] + padLat]))
            if (segmentDistanceM(a, b, x.p, x.p, kx, ky) < opts.obstructionBufferM) return x.why;
        return null;
    };
}

/** Metres of a line over dry ground (its ≤5 m samples). */
function dryMetres(chart: DryTailChart, a: Pt, b: Pt): number {
    const segM = haversineM(a[1], a[0], b[1], b[0]);
    const steps = Math.max(1, Math.ceil(segM / STEP_M));
    let n = 0;
    for (let k = 0; k < steps; k++) {
        const t = (k + 0.5) / steps;
        if (chart.isDry(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)) n++;
    }
    return (n * segM) / steps;
}

/** A chord may stand in for the way it replaces with this many more metres of dry ground. */
const DRIER_SLACK_M = 10;

/**
 * The tail's way to `pin` from the route, as points from its join to the pin,
 * and which of `joins` it leaves the route at — or why there is none.
 * `joins` are the route's own points nearest the pin end (the route's end,
 * or its start, first). The grid's way first: searched from the pin's cell
 * through `passable` cells, out as far as the gap plus 500 m, at `weight` per
 * cell-step, to the first join's cell it reaches — so it keeps to water and
 * crosses the dry ground where it is narrowest and least dry (where the
 * grid's snap ended the route, a straight line can cross a beach on the
 * slant: 1.1 km of flats for 800 m). Then simplified, a chord standing in for
 * the way only where the chart allows it (lineFault) and it crosses no more
 * dry ground. Its first and last hops, and every segment kept, are held to
 * the chart. Where the grid has no way, or its way fails the chart, the
 * straight line from the route's end, if the chart allows it.
 */
export function dryTailWay(
    grid: NavGrid,
    chart: DryTailChart,
    joins: readonly Pt[],
    pin: Pt,
    opts: {
        resolutionM: number;
        tolDeg: number;
        passable: (idx: number) => boolean;
        weight: (idx: number) => number;
    },
): { points: Pt[]; join: number } | string {
    const from = joins[0];
    const straight = (): { points: Pt[]; join: number } | string => {
        const fault = chart.lineFault(from, pin);
        return fault ?? { points: [from, pin], join: 0 };
    };
    const w = grid.width;
    const cellOf = (p: Pt): number => {
        const { x, y } = latLonToGrid(grid, p[1], p[0]);
        return x < 0 || y < 0 || x >= w || y >= grid.height ? -1 : y * w + x;
    };
    const start = cellOf(pin);
    /** Each join's cell, the one nearest the route's end winning. */
    const goals = new Map<number, number>();
    joins.forEach((p, j) => {
        const c = cellOf(p);
        if (c >= 0 && c !== start && !goals.has(c)) goals.set(c, j);
    });
    if (start < 0 || goals.size === 0) return straight();
    const sx = start % w;
    const sy = Math.floor(start / w);
    let farM = 0;
    for (const p of joins) farM = Math.max(farM, haversineM(p[1], p[0], pin[1], pin[0]));
    const radius = Math.ceil((farM + 500) / opts.resolutionM);
    const open = (idx: number): boolean => goals.has(idx) || opts.passable(idx);
    const cost = new Map<number, number>([[start, 0]]);
    const parent = new Map<number, number>([[start, -1]]);
    const heap = new MinHeap();
    heap.push({ f: 0, idx: start });
    let goal = -1;
    for (let e = heap.pop(); e; e = heap.pop()) {
        if (e.f > (cost.get(e.idx) ?? Infinity)) continue;
        if (goals.has(e.idx)) {
            goal = e.idx;
            break;
        }
        const x = e.idx % w;
        const y = Math.floor(e.idx / w);
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                const nx = x + dx;
                const ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= w || ny >= grid.height) continue;
                if (Math.max(Math.abs(nx - sx), Math.abs(ny - sy)) > radius) continue;
                const n = ny * w + nx;
                if (!open(n)) continue;
                // No corner squeeze: a diagonal step needs both cells it cuts between.
                if (dx !== 0 && dy !== 0 && (!open(y * w + nx) || !open(ny * w + x))) continue;
                const c = e.f + (dx !== 0 && dy !== 0 ? Math.SQRT2 : 1) * opts.weight(n);
                if (c >= (cost.get(n) ?? Infinity)) continue;
                cost.set(n, c);
                parent.set(n, e.idx);
                heap.push({ f: c, idx: n });
            }
        }
    }
    if (goal < 0) return straight();
    const join = goals.get(goal) as number;
    // join → … → pin: the parents lead from the join's cell back to the
    // pin's, by cell centres between the two real ends.
    const way: Pt[] = [joins[join]];
    for (let c = parent.get(goal) as number; c !== start && c !== -1; c = parent.get(c) as number)
        way.push(gridToLatLon(grid, c % w, Math.floor(c / w)));
    way.push(pin);
    const faultOf = (pts: readonly Pt[]): string | null => {
        for (let i = 0; i + 1 < pts.length; i++) {
            const f = chart.lineFault(pts[i], pts[i + 1]);
            if (f) return f;
        }
        return null;
    };
    // The dry metres along the way to each point, for the chord rule.
    const at = new Map<Pt, number>(way.map((p, i) => [p, i]));
    const dryTo = [0];
    for (let i = 1; i < way.length; i++) dryTo.push(dryTo[i - 1] + dryMetres(chart, way[i - 1], way[i]));
    const simplified = douglasPeucker(way, opts.tolDeg, (a, b) => {
        const i = at.get(a);
        const j = at.get(b);
        if (i === undefined || j === undefined) return true;
        return chart.lineFault(a, b) !== null || dryMetres(chart, a, b) > dryTo[j] - dryTo[i] + DRIER_SLACK_M;
    });
    if (faultOf(simplified) === null) return { points: simplified, join };
    if (faultOf(way) === null) return { points: way, join };
    return straight();
}

/**
 * A line cut at the edges of its dry ground (to within ~0.1 m): its points
 * and, per segment, whether the segment is over dry ground. Segments under
 * half a metre are not made.
 */
export function splitAtDryEdges(
    points: readonly Pt[],
    isDry: (lon: number, lat: number) => boolean,
): { points: Pt[]; dry: boolean[] } {
    const out: Pt[] = [[points[0][0], points[0][1]]];
    const dry: boolean[] = [];
    const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const push = (p: Pt, wasDry: boolean): void => {
        const last = out[out.length - 1];
        if (haversineM(last[1], last[0], p[1], p[0]) < 0.5) {
            if (dry.length > 0) dry[dry.length - 1] ||= wasDry;
            return;
        }
        out.push(p);
        dry.push(wasDry);
    };
    for (let i = 0; i + 1 < points.length; i++) {
        const a = points[i];
        const b = points[i + 1];
        const steps = Math.max(1, Math.ceil(haversineM(a[1], a[0], b[1], b[0]) / STEP_M));
        let state = isDry(a[0], a[1]);
        for (let k = 1; k <= steps; k++) {
            const p = lerp(a, b, k / steps);
            const next = isDry(p[0], p[1]);
            if (next === state) continue;
            // The edge, between the samples either side of it.
            let lo = (k - 1) / steps;
            let hi = k / steps;
            for (let it = 0; it < 8; it++) {
                const mid = (lo + hi) / 2;
                const m = lerp(a, b, mid);
                if (isDry(m[0], m[1]) === state) lo = mid;
                else hi = mid;
            }
            push(lerp(a, b, hi), state);
            state = next;
        }
        push([b[0], b[1]], state);
    }
    return { points: out, dry };
}
