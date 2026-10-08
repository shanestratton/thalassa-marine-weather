/**
 * Water no tide can clear (owner decision 11, Shane 2026-10-01: "ok avoid
 * water no tide can clear").
 *
 * The router must not route through water that no tide the app knows can
 * clear for this boat. It takes the deep way round — Newport → Rivergate
 * goes round Fisherman Islands in the shipping channel, not through the Boat
 * Passage that dries 2.2 m — and where there is no way round it draws no
 * route and says plainly why, naming the spot, its charted depth, the highest
 * tide and what the boat needs. SUPERSEDED in that last part by package
 * 125-05 (Shane, 2026-10-08: "better we just have red at the "dry" zones,
 * rather than just shit caning the whole route"): with no way round the
 * route goes through, red, and names each such stretch (collectDryRuns).
 *
 * PROOF, NOT SUSPICION. Water is unclearable only when even the DEEPEST value
 * the chart gives it — the owning depth band's DRVAL2 (the same owners as
 * leadLandClip chartedDepthAt: the finest survey, every band tied with it,
 * every unranked band), the deepest of them — plus the highest tide known for
 * that place is still below draft + safety (the planner's tideNeedM). So:
 *   • a 0–2 m band (the Newport canal estate) is NOT unclearable at a 2.5 m
 *     top: 2 + 2.5 ≥ 2.9, whatever its 0 m end;
 *   • a drying band −2.2..0 m is: 0 + 2.5 < 2.9;
 *   • a band with no DRVAL2 proves nothing (decision 10's red still applies),
 *     nor does a place with no tide ceiling, water no chart band covers, or a
 *     current Notice-to-Mariners survey zone (its surveyed depth is a least
 *     depth, not a bound).
 * Hazard, decision-1 and uncharted rules are unchanged.
 *
 * The HIGHEST TIDE per place (RouteRequest.tideCeilings): one per 0.25°
 * bucket of the tide cache, the top of the same 14-day curve the route's tide
 * chips read, from the departure on (services/routing/tideCeilings
 * routeAreaTideCeilings). The proof and the grid cache key read it quantised
 * UP to the next 0.1 m — never a lower ceiling than the curve reached
 * (tideCeilingLookup, whose `key` the grid cache key carries); the words say
 * the curve's own top (fix-up, 2026-10-01: "2.5 m" was printed for a 2.41 m
 * top).
 *
 * WHAT A ROUTE MAY CROSS (fix-up, 2026-10-01). The 50 m grid classes a cell
 * by its centre, so on the finished geometry, checked against the chart
 * itself (classifyNoTideRuns), a stretch of such water is one of:
 *   • a CLIP — a chord over the corner of a band, with a way round it in
 *     water a tide clears right there (noTideLocalWay, a 10 m local raster),
 *     no longer than NO_TIDE_CLIP_TOLERANCE_M: drawn red with its chip;
 *   • a CREEK — longer, but with such a local way (a channel narrower than a
 *     cell through drying flats): the engine draws that local way instead;
 *   • a CROSSING — no local way round (a bar across the passage, however
 *     thin): the route is refused, the engine routes again with the crossed
 *     band closed (TideBarrier), and only a route that reached both pins
 *     through it proves it is the only way through.
 *
 * PURE: no I/O.
 */
import type { Feature, MultiPolygon, Polygon } from 'geojson';
import type { DryPinTail, DryRun, InshoreLayers, TideBarrier, TideCeiling } from './types';
import { M_PER_DEG_LAT } from './constants';
import { douglasPeucker, geometryBbox, haversineM, mPerDegLon, pointInGeometry } from './geometry';
import { MinHeap } from './aStar';
import { hardLandAtPoint } from './safetyAudit';
import {
    chartAreaIndexFor,
    chartedDepthOwnersAt,
    chartedDepthRangeAt,
    type IndexedDepthArea,
} from '../routing/leadLandClip';

/**
 * The most water no tide clears a finished route may cross as a clip — a
 * chord over the corner of a drying bank beside the water it follows, with a
 * way round it right there (fix-up, 2026-10-01). One 50 m grid cell, fixed:
 * a long route's coarsened grid (80–130 m cells) used to widen it, and the
 * Seaway promotion check shares it (InshoreRouter seawayGraphSafetyFault).
 */
export const NO_TIDE_CLIP_TOLERANCE_M = 50;

/** The tide cache's 0.25° bucket of a spot, as integer steps (TideHeightService
 *  tideCurveBucket is `${row / 4},${col / 4}` of these). */
export function tideBucketStep(lat: number, lon: number): [number, number] {
    return [Math.round(lat * 4), Math.round(lon * 4)];
}

/** The tide cache's bucket key for a spot (TideHeightService tideCurveBucket). */
export function tideBucketKey(lat: number, lon: number): string {
    const [row, col] = tideBucketStep(lat, lon);
    return `${row / 4},${col / 4}`;
}

/** A ceiling rounded UP to the next 0.1 m: never lower than the curve reached,
 *  so a quantised key never proves more than the real top does. */
export function quantiseCeilingM(highestM: number): number {
    return Math.ceil(highestM * 10 - 1e-6) / 10;
}

/** The highest tide known at a spot. */
export interface CeilingAt {
    /** Quantised UP to 0.1 m: what the proof and the cache key read. */
    highestM: number;
    /** The curve's own top: what the words say. */
    topM: number;
    days: number;
}

/** The highest tide known at a spot, or null (no ceiling for its bucket). */
export interface CeilingLookup {
    at(lat: number, lon: number): CeilingAt | null;
    /** How many buckets carry a ceiling. */
    size: number;
    /** The quantised set, for the grid cache key ('' when none). */
    key: string;
}

const NO_CEILINGS: CeilingLookup = { at: () => null, size: 0, key: '' };

/**
 * The ceilings by bucket. Malformed entries are dropped; two for one bucket
 * keep the HIGHER top (fail safe: the higher tide proves less).
 */
export function tideCeilingLookup(ceilings: readonly TideCeiling[] | null | undefined): CeilingLookup {
    if (!ceilings || ceilings.length === 0) return NO_CEILINGS;
    const byStep = new Map<number, CeilingAt & { row: number; col: number }>();
    for (const c of ceilings) {
        if (!c || !Number.isFinite(c.lat) || !Number.isFinite(c.lon) || !Number.isFinite(c.highestM)) continue;
        if (c.highestM < -5 || c.highestM > 25) continue;
        const [row, col] = tideBucketStep(c.lat, c.lon);
        const k = row * 100_000 + col;
        const days = Number.isFinite(c.days) && c.days >= 1 ? Math.round(c.days) : 1;
        const held = byStep.get(k);
        if (!held || c.highestM > held.topM)
            byStep.set(k, { highestM: quantiseCeilingM(c.highestM), topM: c.highestM, days, row, col });
    }
    if (byStep.size === 0) return NO_CEILINGS;
    const key = [...byStep.values()]
        .map((v) => `${v.row},${v.col}@${v.highestM.toFixed(1)}`)
        .sort()
        .join('|');
    return {
        at(lat, lon) {
            const [row, col] = tideBucketStep(lat, lon);
            const v = byStep.get(row * 100_000 + col);
            return v ? { highestM: v.highestM, topM: v.topM, days: v.days } : null;
        },
        size: byStep.size,
        key,
    };
}

/** Why a spot is proved unclearable: its charted range and the tide there. */
export interface NoTideProof {
    /** The owning bands' shallowest DRVAL1 (null: one charts none). */
    shallowestM: number | null;
    /** The owning bands' deepest DRVAL2. */
    deepestM: number;
    /** The tide there, quantised (the proof) and the curve's own top (the words). */
    highestM: number;
    topM: number;
    days: number;
}

type BBox = [number, number, number, number];

const bboxesMeet = (a: BBox, b: BBox): boolean => !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);

/**
 * The exact test at a point, against the chart's own vectors: the proof, or
 * null when nothing is proved there. With `within`, only the bands and NtM
 * zones meeting that box are read (a local raster's thousands of points).
 */
export function noTideClearsAt(
    layers: InshoreLayers,
    ceilings: CeilingLookup,
    needM: number,
    within?: BBox,
): (lon: number, lat: number) => NoTideProof | null {
    if (ceilings.size === 0) return () => null;
    let bands: readonly IndexedDepthArea[] = chartAreaIndexFor(layers).depth;
    if (within) bands = bands.filter((a) => bboxesMeet(a.bbox, within));
    if (bands.length === 0) return () => null;
    const ntm = (layers.NTMZONE?.features ?? [])
        .map((f) => f.geometry)
        .filter((g): g is Polygon | MultiPolygon => !!g && (g.type === 'Polygon' || g.type === 'MultiPolygon'))
        .map((g) => ({ g, bbox: geometryBbox(g) }))
        .filter((z) => !within || bboxesMeet(z.bbox, within));
    return (lon, lat) => {
        const tide = ceilings.at(lat, lon);
        if (!tide) return null;
        const range = chartedDepthRangeAt(bands, lon, lat);
        if (!range || range.deepestM === null) return null;
        if (range.deepestM + tide.highestM >= needM - 1e-6) return null;
        for (const z of ntm) {
            const [x0, y0, x1, y1] = z.bbox;
            if (lon >= x0 && lon <= x1 && lat >= y0 && lat <= y1 && pointInGeometry(lon, lat, z.g)) return null;
        }
        return { shallowestM: range.shallowestM, deepestM: range.deepestM, ...tide };
    };
}

/** One stretch of a line through water no tide clears. */
export interface NoTideRun {
    /** From its first proved sample to its last (the band edges lie up to one
     *  sample step further out at each end). */
    lengthM: number;
    /** Where it starts and ends, and its midpoint by length, [lon, lat]. */
    start: [number, number];
    end: [number, number];
    mid: [number, number];
    /** Metres along the line of its first and last proved samples. */
    fromM: number;
    toM: number;
    /** The shallowest DRVAL1 along it (null when a band there charts none). */
    shallowestM: number | null;
    /** The deepest DRVAL2 along it. */
    deepestM: number;
    /** The highest tide there (quantised, the proof; the curve's top, the
     *  words) and the days behind it. */
    highestM: number;
    topM: number;
    days: number;
}

/** Metres along a polyline at each vertex. */
function cumulativeM(polyline: readonly (readonly [number, number])[]): number[] {
    const cum = [0];
    for (let i = 1; i < polyline.length; i++)
        cum.push(cum[i - 1] + haversineM(polyline[i - 1][1], polyline[i - 1][0], polyline[i][1], polyline[i][0]));
    return cum;
}

/** The point `m` metres along a polyline (clamped), and the segment it lies on. */
export function pointAlongM(
    polyline: readonly (readonly [number, number])[],
    cum: readonly number[],
    m: number,
): { p: [number, number]; seg: number } {
    const n = polyline.length;
    if (n === 1 || m <= 0) return { p: [polyline[0][0], polyline[0][1]], seg: 0 };
    if (m >= cum[n - 1]) return { p: [polyline[n - 1][0], polyline[n - 1][1]], seg: n - 2 };
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] <= m) lo = mid;
        else hi = mid;
    }
    const segM = cum[hi] - cum[lo];
    const t = segM > 0 ? (m - cum[lo]) / segM : 0;
    const a = polyline[lo];
    const b = polyline[hi];
    return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], seg: lo };
}

/**
 * The stretches of a polyline through water no tide clears, sampled every
 * `stepM` against the chart itself (noTideClearsAt), longest first.
 */
export function noTideClearsRuns(
    layers: InshoreLayers,
    polyline: readonly (readonly [number, number])[],
    ceilings: CeilingLookup,
    needM: number,
    stepM = 10,
): NoTideRun[] {
    if (ceilings.size === 0 || polyline.length < 2) return [];
    const proofAt = noTideClearsAt(layers, ceilings, needM);
    const runs: NoTideRun[] = [];
    let cur: (NoTideRun & { pts: { p: [number, number]; m: number }[] }) | null = null;
    const close = (): void => {
        if (!cur) return;
        // The midpoint by length along the run's own samples.
        const half = cur.lengthM / 2;
        const at = cur.pts.find((s) => s.m >= half) ?? cur.pts[cur.pts.length - 1];
        const { pts: _pts, ...run } = cur;
        runs.push({ ...run, mid: at.p });
        cur = null;
    };
    let alongM = 0;
    for (let i = 0; i + 1 < polyline.length; i++) {
        const [lonA, latA] = polyline[i];
        const [lonB, latB] = polyline[i + 1];
        const segM = haversineM(latA, lonA, latB, lonB);
        const steps = Math.max(1, Math.ceil(segM / stepM));
        for (let k = i === 0 ? 0 : 1; k <= steps; k++) {
            const t = k / steps;
            const p: [number, number] = [lonA + (lonB - lonA) * t, latA + (latB - latA) * t];
            const atM = alongM + segM * t;
            const proof = proofAt(p[0], p[1]);
            if (!proof) {
                close();
                continue;
            }
            if (!cur) {
                cur = {
                    lengthM: 0,
                    start: p,
                    end: p,
                    mid: p,
                    fromM: atM,
                    toM: atM,
                    shallowestM: proof.shallowestM,
                    deepestM: proof.deepestM,
                    highestM: proof.highestM,
                    topM: proof.topM,
                    days: proof.days,
                    pts: [{ p, m: 0 }],
                };
                continue;
            }
            cur.lengthM += haversineM(cur.end[1], cur.end[0], p[1], p[0]);
            cur.end = p;
            cur.toM = atM;
            cur.pts.push({ p, m: cur.lengthM });
            if (proof.shallowestM === null || cur.shallowestM === null) cur.shallowestM = null;
            else if (proof.shallowestM < cur.shallowestM) cur.shallowestM = proof.shallowestM;
            if (proof.deepestM > cur.deepestM) cur.deepestM = proof.deepestM;
            if (proof.highestM > cur.highestM) {
                cur.highestM = proof.highestM;
                cur.topM = proof.topM;
            }
        }
        alongM += segM;
    }
    close();
    return runs.sort((a, b) => b.lengthM - a.lengthM);
}

/** The bands' sum along a set of runs. */
export const noTideTotalM = (runs: readonly NoTideRun[]): number => runs.reduce((m, r) => m + r.lengthM, 0);

/**
 * The charted bands that make spots water no tide clears (fix-up,
 * 2026-10-01): at each spot, the owning bands — every one of them proved,
 * where the spot is — as TideBarriers for the engine's retry to close.
 */
export function noTideBarriersAt(
    layers: InshoreLayers,
    ceilings: CeilingLookup,
    needM: number,
    spots: readonly (readonly [number, number])[],
): TideBarrier[] {
    const proofAt = noTideClearsAt(layers, ceilings, needM);
    const bands = chartAreaIndexFor(layers).depth;
    const out: TideBarrier[] = [];
    for (const [lon, lat] of spots) {
        const proof = proofAt(lon, lat);
        if (!proof) continue;
        for (const a of chartedDepthOwnersAt(bands, lon, lat)) {
            const d2 = a.drval2 ?? null;
            if (d2 === null || d2 + proof.highestM >= needM - 1e-6) continue;
            if (out.some((b) => b.geometry === a.geometry)) continue;
            out.push({ geometry: a.geometry, deepestM: d2, rank: a.rank });
        }
    }
    return out;
}

/** Longest side of a local raster, in cells. */
const LOCAL_MAX_CELLS = 200;
/** A local raster's finest cell. */
const LOCAL_MIN_RES_M = 10;

/**
 * A way between two points through water a tide clears, on a local raster
 * over `window` (fix-up, 2026-10-01): cells of 10 m (coarser for a big
 * window, at most 200 a side) classed by their centres against the chart
 * itself — open unless charted land by the land audit's own point rule
 * (safetyAudit hardLandAtPoint) or water no tide clears (noTideClearsAt).
 * 8-connected, never squeezing diagonally between two closed cells. The way
 * runs from `from` to `to` through cell centres, simplified only along
 * chords that stay in open cells; null when the two are not joined inside
 * the window (a bar, not a corner).
 */
export function noTideLocalWay(
    layers: InshoreLayers,
    ceilings: CeilingLookup,
    needM: number,
    from: readonly [number, number],
    to: readonly [number, number],
    window: BBox,
): [number, number][] | null {
    const [minLon, minLat, maxLon, maxLat] = window;
    const mLon = mPerDegLon((minLat + maxLat) / 2);
    const wM = (maxLon - minLon) * mLon;
    const hM = (maxLat - minLat) * M_PER_DEG_LAT;
    if (!(wM > 0 && hM > 0)) return null;
    const res = Math.max(LOCAL_MIN_RES_M, Math.max(wM, hM) / LOCAL_MAX_CELLS);
    const dLon = res / mLon;
    const dLat = res / M_PER_DEG_LAT;
    const w = Math.max(1, Math.ceil((maxLon - minLon) / dLon));
    const h = Math.max(1, Math.ceil((maxLat - minLat) / dLat));
    const proofAt = noTideClearsAt(layers, ceilings, needM, window);
    const onLand = hardLandAtPoint(layers);
    const open = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        const lat = minLat + (y + 0.5) * dLat;
        for (let x = 0; x < w; x++) {
            const lon = minLon + (x + 0.5) * dLon;
            open[y * w + x] = onLand(lon, lat) || proofAt(lon, lat) ? 0 : 1;
        }
    }
    const centre = (idx: number): [number, number] => [
        minLon + ((idx % w) + 0.5) * dLon,
        minLat + (Math.floor(idx / w) + 0.5) * dLat,
    ];
    /** The open cell nearest a point, within two cells of its own, or -1. */
    const openCellNear = (p: readonly [number, number]): number => {
        const cx = Math.min(w - 1, Math.max(0, Math.floor((p[0] - minLon) / dLon)));
        const cy = Math.min(h - 1, Math.max(0, Math.floor((p[1] - minLat) / dLat)));
        let best = -1;
        let bestM = Infinity;
        for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
                const x = cx + dx;
                const y = cy + dy;
                if (x < 0 || y < 0 || x >= w || y >= h || open[y * w + x] !== 1) continue;
                const c = centre(y * w + x);
                const m = haversineM(p[1], p[0], c[1], c[0]);
                if (m < bestM) {
                    bestM = m;
                    best = y * w + x;
                }
            }
        }
        return best;
    };
    const start = openCellNear(from);
    const goal = openCellNear(to);
    if (start < 0 || goal < 0) return null;
    const gx = goal % w;
    const gy = Math.floor(goal / w);
    const octile = (idx: number): number => {
        const dx = Math.abs((idx % w) - gx);
        const dy = Math.abs(Math.floor(idx / w) - gy);
        return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
    };
    const g = new Float64Array(w * h).fill(Infinity);
    const parent = new Int32Array(w * h).fill(-1);
    const heap = new MinHeap();
    g[start] = 0;
    heap.push({ f: octile(start), idx: start });
    let found = false;
    for (let e = heap.pop(); e; e = heap.pop()) {
        if (e.idx === goal) {
            found = true;
            break;
        }
        if (e.f > g[e.idx] + octile(e.idx) + 1e-9) continue;
        const x = e.idx % w;
        const y = Math.floor(e.idx / w);
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                const nx = x + dx;
                const ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                const n = ny * w + nx;
                if (open[n] !== 1) continue;
                if (dx !== 0 && dy !== 0 && (open[y * w + nx] !== 1 || open[ny * w + x] !== 1)) continue;
                const gn = g[e.idx] + (dx !== 0 && dy !== 0 ? Math.SQRT2 : 1);
                if (gn >= g[n]) continue;
                g[n] = gn;
                parent[n] = e.idx;
                heap.push({ f: gn + octile(n), idx: n });
            }
        }
    }
    if (!found) return null;
    const cellsOnWay: number[] = [];
    for (let c = goal; c !== -1; c = parent[c]) cellsOnWay.push(c);
    cellsOnWay.reverse();
    const pts: [number, number][] = [[from[0], from[1]], ...cellsOnWay.map(centre), [to[0], to[1]]];
    /** A chord leaves the open cells (sampled every half cell). */
    const chordLeaves = (a: [number, number], b: [number, number]): boolean => {
        const steps = Math.max(1, Math.ceil(haversineM(a[1], a[0], b[1], b[0]) / (res / 2)));
        for (let s = 1; s < steps; s++) {
            const lon = a[0] + ((b[0] - a[0]) * s) / steps;
            const lat = a[1] + ((b[1] - a[1]) * s) / steps;
            const x = Math.floor((lon - minLon) / dLon);
            const y = Math.floor((lat - minLat) / dLat);
            if (x < 0 || y < 0 || x >= w || y >= h || open[y * w + x] !== 1) return true;
        }
        return false;
    };
    return douglasPeucker(pts, Math.min(dLat, dLon) * 0.25, chordLeaves);
}

/** A stretch of the route across water no tide clears with no way round it there. */
export interface NoTideCrossing {
    /** Its runs as one: first start to last end, their total length, the
     *  shallowest and deepest along it, and the longest run's middle. */
    run: NoTideRun;
    /** Every run's start, middle and end — where the crossed bands are read. */
    spots: [number, number][];
}

/** A stretch of the route over water no tide clears with a local way round. */
export interface NoTideSplice extends NoTideCrossing {
    /** Metres along the route where the way leaves it and rejoins it. */
    fromM: number;
    toM: number;
    /** The way, from the point at `fromM` to the point at `toM`. */
    points: [number, number][];
}

/** How classifyNoTideRuns sorted a route's water no tide clears. */
export interface NoTideClassification {
    clips: NoTideRun[];
    splices: NoTideSplice[];
    crossings: NoTideCrossing[];
}

/** Runs closer than this along the route are one stretch. */
const STRETCH_JOIN_M = 100;
/** The local window around a stretch reaches this far beyond it. */
const LOCAL_WINDOW_PAD_M = 150;

/**
 * The water no tide clears on a finished route, sorted (fix-up,
 * 2026-10-01; see the module header): runs closer than 100 m are one
 * stretch; a stretch with a local way round it (noTideLocalWay, its window
 * 150 m beyond it) is a clip when it measures no more than `toleranceM` out
 * to the band edges (its runs plus a sample step at each end of each), else
 * a splice carrying that way; one with no local way, or one that runs to an
 * end of the route, is a crossing — unless it is a clip at the end. Runs
 * before `fromM` are not read (the far-snap bridge from a cut-off pin).
 */
export function classifyNoTideRuns(
    layers: InshoreLayers,
    polyline: readonly (readonly [number, number])[],
    ceilings: CeilingLookup,
    needM: number,
    opts: { fromM?: number; toleranceM?: number; stepM?: number } = {},
): NoTideClassification {
    const out: NoTideClassification = { clips: [], splices: [], crossings: [] };
    if (ceilings.size === 0 || polyline.length < 2) return out;
    const stepM = opts.stepM ?? 10;
    const toleranceM = opts.toleranceM ?? NO_TIDE_CLIP_TOLERANCE_M;
    const cum = cumulativeM(polyline);
    const totalM = cum[cum.length - 1];
    const skipM = Math.max(0, Math.min(totalM, opts.fromM ?? 0));
    // The line from skipM on, and its runs placed back on the whole line.
    const head = pointAlongM(polyline, cum, skipM);
    const tail: [number, number][] = [head.p];
    for (let i = head.seg + 1; i < polyline.length; i++) tail.push([polyline[i][0], polyline[i][1]]);
    const runs = noTideClearsRuns(layers, tail, ceilings, needM, stepM)
        .map((r) => ({ ...r, fromM: r.fromM + skipM, toM: r.toM + skipM }))
        .sort((a, b) => a.fromM - b.fromM);
    const stretches: NoTideRun[][] = [];
    for (const r of runs) {
        const s = stretches[stretches.length - 1];
        if (s && r.fromM - s[s.length - 1].toM <= STRETCH_JOIN_M) s.push(r);
        else stretches.push([r]);
    }
    for (const s of stretches) {
        const first = s[0];
        const last = s[s.length - 1];
        const longest = s.reduce((a, b) => (b.lengthM > a.lengthM ? b : a));
        const lengthM = noTideTotalM(s);
        const edgedM = lengthM + 2 * stepM * s.length;
        const asOne: NoTideRun = {
            ...longest,
            lengthM,
            start: first.start,
            end: last.end,
            fromM: first.fromM,
            toM: last.toM,
            shallowestM: s.some((r) => r.shallowestM === null)
                ? null
                : Math.min(...s.map((r) => r.shallowestM as number)),
            deepestM: Math.max(...s.map((r) => r.deepestM)),
        };
        const spots = s.flatMap((r) => [r.start, r.mid, r.end]);
        const crossing = (): void => {
            out.crossings.push({ run: asOne, spots });
        };
        const entryM = first.fromM - stepM;
        const exitM = last.toM + stepM;
        if (entryM < skipM - 1e-6 || exitM > totalM + 1e-6) {
            // It runs to an end of the route: no water a tide clears beyond it.
            if (edgedM <= toleranceM) out.clips.push(asOne);
            else crossing();
            continue;
        }
        const entry = pointAlongM(polyline, cum, entryM);
        const exit = pointAlongM(polyline, cum, exitM);
        let x0 = Math.min(entry.p[0], exit.p[0]);
        let x1 = Math.max(entry.p[0], exit.p[0]);
        let y0 = Math.min(entry.p[1], exit.p[1]);
        let y1 = Math.max(entry.p[1], exit.p[1]);
        for (let i = entry.seg + 1; i <= exit.seg; i++) {
            x0 = Math.min(x0, polyline[i][0]);
            x1 = Math.max(x1, polyline[i][0]);
            y0 = Math.min(y0, polyline[i][1]);
            y1 = Math.max(y1, polyline[i][1]);
        }
        const padLat = LOCAL_WINDOW_PAD_M / M_PER_DEG_LAT;
        const padLon = LOCAL_WINDOW_PAD_M / mPerDegLon((y0 + y1) / 2);
        const way = noTideLocalWay(layers, ceilings, needM, entry.p, exit.p, [
            x0 - padLon,
            y0 - padLat,
            x1 + padLon,
            y1 + padLat,
        ]);
        if (!way) crossing();
        else if (edgedM <= toleranceM) out.clips.push(asOne);
        else out.splices.push({ run: asOne, spots, fromM: entryM, toM: exitM, points: way });
    }
    return out;
}

/**
 * The DRY stretches of a finished route (package 125-05; RouteResult.dryRuns,
 * see DryRun): sampled every `stepM` against the chart itself — the finest
 * survey's owning bands (chartedDepthRangeAt) — never on hard land, never
 * inside a current Notice-to-Mariners survey zone (its depth is a fresh least
 * depth, not a band's). A sample is dry when the chart has it DRYING
 * (DRVAL1 < 0) and no tide known there lifts even that to `needM` — with no
 * tide known, any drying ground: red 'no tide data' — or when decision 11's
 * own proof holds there (its DEEPEST charted value plus the highest tide is
 * short of the need: noTideClearsAt). Never-drying water a tide may clear (a
 * 0–2 m canal band at a 2.5 m top) is not dry: decision 10 already draws it
 * by its shallowest end, and naming every such stretch would cry wolf on
 * every canal exit. Samples closer than STRETCH_JOIN_M are one stretch. In
 * route order. Segments `skipSeg` accepts are not read: a pin's own dry tail
 * (package 125-05b), named by pinTailDryRun.
 */
export function collectDryRuns(
    layers: InshoreLayers,
    polyline: readonly (readonly [number, number])[],
    ceilings: CeilingLookup,
    draftM: number,
    needM: number,
    stepM = 10,
    skipSeg?: (seg: number) => boolean,
): DryRun[] {
    if (polyline.length < 2 || !Number.isFinite(needM)) return [];
    const bands = chartAreaIndexFor(layers).depth;
    if (bands.length === 0) return [];
    const ntm = (layers.NTMZONE?.features ?? [])
        .map((f) => f.geometry)
        .filter((g): g is Polygon | MultiPolygon => !!g && (g.type === 'Polygon' || g.type === 'MultiPolygon'))
        .map((g) => ({ g, bbox: geometryBbox(g) }));
    const inNtm = (lon: number, lat: number): boolean =>
        ntm.some(
            (z) =>
                lon >= z.bbox[0] &&
                lon <= z.bbox[2] &&
                lat >= z.bbox[1] &&
                lat <= z.bbox[3] &&
                pointInGeometry(lon, lat, z.g),
        );
    let onLand: ((lon: number, lat: number) => boolean) | null = null;
    interface Sample {
        seg: number;
        t: number;
        p: [number, number];
        m: number;
        shallowestM: number | null;
        deepestM: number;
        tide: CeilingAt | null;
    }
    const dryAt = (seg: number, t: number, p: [number, number], m: number): Sample | null => {
        const range = chartedDepthRangeAt(bands, p[0], p[1]);
        if (!range) return null;
        const tide = ceilings.at(p[1], p[0]);
        const s = range.shallowestM;
        const drying = s !== null && s < 0 && (!tide || s + tide.highestM < needM - 1e-6);
        const proved = !!tide && range.deepestM !== null && range.deepestM + tide.highestM < needM - 1e-6;
        if ((!drying && !proved) || inNtm(p[0], p[1])) return null;
        onLand ??= hardLandAtPoint(layers);
        if (onLand(p[0], p[1])) return null;
        return { seg, t, p, m, shallowestM: s, deepestM: range.deepestM ?? s ?? 0, tide };
    };
    // Every dry sample, in order, then cut into stretches.
    const samples: Sample[] = [];
    let alongM = 0;
    for (let i = 0; i + 1 < polyline.length; i++) {
        const [lonA, latA] = polyline[i];
        const [lonB, latB] = polyline[i + 1];
        const segM = haversineM(latA, lonA, latB, lonB);
        const steps = Math.max(1, Math.ceil(segM / stepM));
        for (let k = i === 0 ? 0 : 1; k <= steps; k++) {
            // A skipped segment's samples, and the vertex it starts with.
            if (skipSeg?.(i) || (k === steps && skipSeg?.(i + 1))) continue;
            const t = k / steps;
            const hit = dryAt(i, t, [lonA + (lonB - lonA) * t, latA + (latB - latA) * t], alongM + segM * t);
            if (hit) samples.push(hit);
        }
        alongM += segM;
    }
    const runs: DryRun[] = [];
    let first = 0;
    for (let j = 1; j <= samples.length; j++) {
        if (j < samples.length && samples[j].m - samples[j - 1].m <= STRETCH_JOIN_M) continue;
        const s = samples.slice(first, j);
        first = j;
        const a = s[0];
        const b = s[s.length - 1];
        const half = (a.m + b.m) / 2;
        const mid = (s.find((x) => x.m >= half) ?? b).p;
        let shallowestM: number | null = a.shallowestM;
        let deepestM = a.deepestM;
        let tide: CeilingAt | null = null;
        for (const x of s) {
            shallowestM = shallowestM === null || x.shallowestM === null ? null : Math.min(shallowestM, x.shallowestM);
            deepestM = Math.max(deepestM, x.deepestM);
            if (x.tide && (!tide || x.tide.topM > tide.topM)) tide = x.tide;
        }
        // A sample at the very end of a segment is the next one's start.
        const at = (x: Sample): [number, number] =>
            x.t >= 1 && x.seg + 1 < polyline.length - 1 ? [x.seg + 1, 0] : [x.seg, x.t];
        const [startSeg, startT] = at(a);
        const [endSeg, endT] = [b.seg, b.t];
        runs.push({
            startSeg,
            startT,
            endSeg,
            endT,
            lengthM: b.m - a.m,
            mid,
            place: noTideRunPlace(layers, { start: a.p, mid, end: b.p }),
            shallowestM,
            deepestM,
            draftM,
            needM,
            tide: tide ? { topM: tide.topM, days: tide.days } : null,
        });
    }
    return runs;
}

/**
 * A pin's own red tail as a dry stretch (package 125-05b; RouteDebug
 * .dryPinTail): its segments' dry ground — charted drying, or water decision
 * 11 proves no tide clears, read every `stepM` against the chart as
 * collectDryRuns reads it — named WHATEVER the tide: the highest tide known
 * there is said, not used to leave it out. Its length is the tail's own
 * (its segments, cut at the dry ground's edges). Null when none of it reads
 * dry.
 */
export function pinTailDryRun(
    layers: InshoreLayers,
    polyline: readonly (readonly [number, number])[],
    span: Pick<DryPinTail, 'startSeg' | 'endSeg' | 'at'>,
    end: 'origin' | 'destination',
    ceilings: CeilingLookup,
    draftM: number,
    needM: number,
    stepM = 10,
): DryRun | null {
    const bands = chartAreaIndexFor(layers).depth;
    if (bands.length === 0 || span.startSeg < 0 || span.endSeg < span.startSeg || span.endSeg + 1 >= polyline.length)
        return null;
    let dry = false;
    let shallowestM: number | null = Infinity;
    let deepestM = -Infinity;
    let tide: CeilingAt | null = null;
    let lengthM = 0;
    for (let i = span.startSeg; i <= span.endSeg; i++) {
        const [lonA, latA] = polyline[i];
        const [lonB, latB] = polyline[i + 1];
        const segM = haversineM(latA, lonA, latB, lonB);
        lengthM += segM;
        const steps = Math.max(1, Math.ceil(segM / stepM));
        for (let k = 0; k <= steps; k++) {
            const lon = lonA + ((lonB - lonA) * k) / steps;
            const lat = latA + ((latB - latA) * k) / steps;
            const range = chartedDepthRangeAt(bands, lon, lat);
            if (!range) continue;
            const t = ceilings.at(lat, lon);
            const s = range.shallowestM;
            const proved = !!t && range.deepestM !== null && range.deepestM + t.highestM < needM - 1e-6;
            if (!((s !== null && s < 0) || proved)) continue;
            dry = true;
            shallowestM = shallowestM === null || s === null ? null : Math.min(shallowestM, s);
            deepestM = Math.max(deepestM, range.deepestM ?? s ?? 0);
            if (t && (!tide || t.topM > tide.topM)) tide = t;
        }
    }
    if (!dry) return null;
    // Its middle by length.
    let mid: [number, number] = [polyline[span.startSeg][0], polyline[span.startSeg][1]];
    let acc = 0;
    for (let i = span.startSeg; i <= span.endSeg; i++) {
        const a = polyline[i];
        const b = polyline[i + 1];
        const m = haversineM(a[1], a[0], b[1], b[0]);
        if (acc + m >= lengthM / 2) {
            const f = m > 0 ? (lengthM / 2 - acc) / m : 0;
            mid = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
            break;
        }
        acc += m;
    }
    const first = polyline[span.startSeg];
    const last = polyline[span.endSeg + 1];
    return {
        startSeg: span.startSeg,
        startT: 0,
        endSeg: span.endSeg,
        endT: 1,
        lengthM,
        mid,
        place: noTideRunPlace(layers, { start: [first[0], first[1]], mid, end: [last[0], last[1]] }),
        shallowestM: shallowestM === Infinity ? null : shallowestM,
        deepestM,
        draftM,
        needM,
        tide: tide ? { topM: tide.topM, days: tide.days } : null,
        pin: { end, at: span.at },
    };
}

/**
 * Whether a route crosses water a tide must clear where no tide is known
 * (fix-up, 2026-10-01): a band whose deepest charted value (DRVAL2) is short
 * of `needM` — only such water can be proved unclearable — in a 0.25° place
 * with no ceiling. Then the route could not be held to decision 11 there,
 * and says so (InshoreRouteResult.tideCheck). Sampled every 25 m.
 */
export function routeCrossesUncheckedShallow(
    layers: InshoreLayers,
    polyline: readonly (readonly [number, number])[],
    ceilings: CeilingLookup,
    needM: number,
    stepM = 25,
): boolean {
    const bands = chartAreaIndexFor(layers).depth;
    if (bands.length === 0 || polyline.length < 2) return false;
    for (let i = 0; i + 1 < polyline.length; i++) {
        const [lonA, latA] = polyline[i];
        const [lonB, latB] = polyline[i + 1];
        const steps = Math.max(1, Math.ceil(haversineM(latA, lonA, latB, lonB) / stepM));
        for (let k = i === 0 ? 0 : 1; k <= steps; k++) {
            const lon = lonA + ((lonB - lonA) * k) / steps;
            const lat = latA + ((latB - latA) * k) / steps;
            if (ceilings.at(lat, lon)) continue;
            const range = chartedDepthRangeAt(bands, lon, lat);
            if (range && range.deepestM !== null && range.deepestM < needM - 1e-6) return true;
        }
    }
    return false;
}

/** Last words of a name that take "the" ("the Boat Passage", "the Brisbane
 *  River") — a bay, a creek or a reef does not ("Deception Bay"). */
const ARTICLE_WORDS =
    /\b(passage|channel|river|reach|basin|banks?|flats|cutting|narrows|bar|spit|sound|roads|entrance|gutter|straits?|inlet|arm|cut|leads?)$/i;

/** A sea area's name as it reads in a sentence. */
export function placeWords(name: string): string {
    const n = name.trim();
    if (/^the\s/i.test(n)) return n;
    return ARTICLE_WORDS.test(n) ? `the ${n}` : n;
}

/**
 * The smallest charted sea area (S-57 SEAARE OBJNAM) containing a point —
 * its name and its extent's area in square degrees — or null.
 */
export function seaAreaAt(layers: InshoreLayers, lon: number, lat: number): { name: string; areaDeg2: number } | null {
    let best: { name: string; areaDeg2: number } | null = null;
    for (const f of (layers.SEAARE?.features ?? []) as Feature[]) {
        const g = f.geometry;
        if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) continue;
        const props = f.properties as Record<string, unknown> | null;
        const raw = props?.OBJNAM ?? props?.objnam;
        if (typeof raw !== 'string' || raw.trim() === '') continue;
        const [x0, y0, x1, y1] = geometryBbox(g);
        if (lon < x0 || lon > x1 || lat < y0 || lat > y1) continue;
        if (!pointInGeometry(lon, lat, g)) continue;
        const areaDeg2 = (x1 - x0) * (y1 - y0);
        if (!best || areaDeg2 < best.areaDeg2) best = { name: raw.trim(), areaDeg2 };
    }
    return best;
}

/**
 * A named area this big (square degrees, ≈ 240 km² here) does not say where
 * the spot is — "Moreton Bay" is the whole bay (the real-chart Wynnum → Lytton
 * Reach check, 2026-10-01) — so its position goes with the name. The Boat
 * Passage's extent is 0.0012.
 */
const LARGE_SEA_AREA_DEG2 = 0.02;

const m1 = (m: number): string => `${m.toFixed(1)} m`;

/** "27.393° S, 153.172° E" */
function positionWords(lon: number, lat: number): string {
    return `${Math.abs(lat).toFixed(3)}° ${lat < 0 ? 'S' : 'N'}, ${Math.abs(lon).toFixed(3)}° ${lon < 0 ? 'W' : 'E'}`;
}

/** Where a run is, in words: its sea area's name (and, for a large one, its
 *  position), else its position. */
export function noTideRunPlace(layers: InshoreLayers, run: Pick<NoTideRun, 'start' | 'mid' | 'end'>): string {
    const area =
        seaAreaAt(layers, run.mid[0], run.mid[1]) ??
        seaAreaAt(layers, run.start[0], run.start[1]) ??
        seaAreaAt(layers, run.end[0], run.end[1]);
    const at = positionWords(run.mid[0], run.mid[1]);
    if (!area) return `water near ${at}`;
    return area.areaDeg2 > LARGE_SEA_AREA_DEG2 ? `${placeWords(area.name)} near ${at}` : placeWords(area.name);
}

/** Its charted depth, in words: "charted to dry 2.2 m" or "charted 0–0.3 m". */
export function noTideDepthWords(run: Pick<NoTideRun, 'shallowestM' | 'deepestM'>): string {
    const s = run.shallowestM;
    if (s !== null && s < 0) return `charted to dry ${m1(-s)}`;
    const d = (m: number): string => (Number.isInteger(m) ? m.toFixed(0) : m.toFixed(1));
    return s === null ? `charted no deeper than ${m1(run.deepestM)}` : `charted ${d(s)}–${d(run.deepestM)} m`;
}

/**
 * The refusal (decision 11): "No route for 2.4 m draft: the only way through
 * crosses the Boat Passage, charted to dry 2.2 m; the highest tide in the
 * next 14 days is 2.5 m and you need 2.9 m." The tide is the curve's own top
 * (fix-up, 2026-10-01), never the quantised ceiling the proof reads.
 */
export function noTideClearsRefusal(
    layers: InshoreLayers,
    run: Pick<NoTideRun, 'start' | 'mid' | 'end' | 'shallowestM' | 'deepestM' | 'topM' | 'days'>,
    draftM: number,
    needM: number,
): string {
    return (
        `No route for ${m1(draftM)} draft: the only way through crosses ${noTideRunPlace(layers, run)}, ` +
        `${noTideDepthWords(run)}; the highest tide in the next ${run.days} day${run.days === 1 ? '' : 's'} is ` +
        `${m1(run.topM)} and you need ${m1(needM)}.`
    );
}
