/**
 * Charted-shallow caution runs along a finished route — the substrate for the
 * Phase 7 tide-window chips (RouteResult.shallowRuns) and the renderer's
 * charted-shallow mask (RouteResult.chartedShallowMask).
 *
 * Carved out of routeInshoreOnceEnds (fix-up, 2026-09-30) so a PROMOTED
 * Seaway Graph route (InshoreRouter) gets its runs from the same sampler as
 * an engine route: a promoted route used to ship none, so its 'needs tide'
 * chips vanished whenever a corridor with lateral marks promoted.
 *
 * The depth is the FINEST survey's (services/routing/leadLandClip
 * chartedDepthAt: the finest-ranked S-57 DEPARE / DRGARE bands covering the
 * point own it, with every band tied with them, and the shallowest of those
 * wins) — the grid's own finest-survey-wins rule. The sampler used to take the
 * minimum over EVERY band covering the point, whatever its rank, so a coarse
 * cell's generalised 0–30 m band set the depth of water a harbour cell charts
 * 10–15 m: the Tangalooma tail asked for +2.9 m of tide and the chart-only
 * Rivergate tail for +5.1 m over a river its dredged area charts 9.1 m
 * (fix-up, 2026-09-30).
 *
 * Since the round-3 review (2026-09-30) it reads EVERY segment, not only the
 * caution ones: charted-shallow water on a segment the grid did not flag
 * becomes an exact stretch the planner draws red (chartedShallowSpans) and
 * part of a run — so a tide chip — like any caution (the backstop below).
 */
import type {
    CautionNearShallow,
    ChartedShallowSpan,
    InshoreLayers,
    NavGrid,
    ShallowRunInfo,
    SurveyRunInfo,
    SurveyRunReason,
    SurveyUncheckedCell,
} from './types';
import { AMBER_SURVEY_REASONS, CAUTION_WHY } from './types';
import { forEachCellOnSegment, haversineM, latLonToGrid, segmentDistanceM } from './geometry';
import { UNKNOWN_OPEN } from './constants';
import {
    areaGeometry,
    chartAreaIndexFor,
    chartedDepthAt,
    chartedDepthOwnersAt,
    chartedDepthRangeAt,
    indexArea,
    isS57Feature,
    piecesAlong,
    pointInArea,
    readNum,
    segmentAreaDistanceM,
    type IndexedArea,
    type IndexedDepthArea,
} from '../routing/leadLandClip';
import { surveyGradeAt, surveyVerdict, type SurveyZone } from '../routing/leadReview';
import { surveyRanksTie } from '../enc/scaleShadow';

export interface ShallowRunInput {
    layers: InshoreLayers;
    grid: NavGrid;
    polyline: readonly [number, number][];
    /** Per-segment caution (polyline.length - 1). */
    caution: readonly boolean[];
    draftM: number;
    safetyM: number;
    /** First segment of the destination's charted tail (decision 7), or -1. */
    destinationTailStartSeg?: number;
    /** Last segment of the origin's charted head (decision 7), or -1. */
    originTailEndSeg?: number;
    /** Per segment: inside a charted hazard's buffer (safetyAudit
     * hazardBufferSegments). Owner decision 10: its red is not the tide's to
     * lift. Absent: no segment gets a tideDepthM (fail-safe — red). */
    hazardMask?: readonly boolean[];
}

export interface ShallowRunOutput {
    shallowRuns: ShallowRunInfo[];
    /** Per segment: caution over charted-shallow water (RouteResult.chartedShallowMask). */
    chartedShallowMask: boolean[];
    /** The backstop: charted-shallow stretches of segments NOT flagged caution
     * (RouteResult.chartedShallowSpans). */
    chartedShallowSpans: ChartedShallowSpan[];
    /** Per segment: caution over decision-1 water — a finer never-drying band
     * under a coarser chart's land paint (RouteResult.landPaintConflictMask). */
    landPaintConflictMask: boolean[];
    /** Per segment: the charted depth a tide must lift (RouteResult.tideDepthM,
     * owner decision 10) — see collectShallowRuns. */
    tideDepthM: (number | null)[];
    /** The longest caution run (m), for the engine's keel-margin log line. */
    shallowMaxM: number;
    /** Per segment: why a caution segment is caution (CAUTION_WHY bits, 0
     *  where it is not caution) — RouteResult.cautionWhy. */
    cautionWhy: number[];
    /** Per segment: the shallowest charted depth under a caution segment's
     *  line where it is below the floor, else null — RouteResult.cautionDepthM. */
    cautionDepthM: (number | null)[];
    /** Per segment: the shallow band a NEAR_SHALLOW segment passes too close
     *  to, else null — RouteResult.cautionNearShallow. */
    cautionNearShallow: (CautionNearShallow | null)[];
}

/** Below this a chip is noise, not pilotage info. */
const MIN_RUN_M = 200;

const EPS_T = 1e-9;

/**
 * A piece of the route a run is built from: a caution segment whole, or one
 * charted-shallow stretch of a segment the grid did not flag (the backstop).
 */
interface RunUnit {
    seg: number;
    t0: number;
    t1: number;
    /** Backstop stretch: its shallowest depth and where (null: a caution segment). */
    span: { d: number; at: [number, number]; ntm: boolean } | null;
    /** Backstop stretch: some of it is decision-1 water. */
    conflict?: boolean;
}

/**
 * One stretch of a straight line over which the chart reads the same (the
 * round-4 review, 2026-09-30): cut at the depth bands' own edges
 * (piecesAlong) and, inside a band, at every ≤5 m where a current NtM survey
 * or decision-1 water starts or stops.
 */
interface ChartPiece {
    t0: number;
    t1: number;
    /** Metres. */
    m: number;
    /** Its middle. */
    lon: number;
    lat: number;
    /** The finest band's depth there (null: no band). */
    finest: number | null;
    /** A current NtM survey's depth there (null: none). */
    ntm: number | null;
    /** Decision-1 water there (grid.wetConflict). */
    conflict: boolean;
}

/** What the chart says along one straight line a→b (collectShallowRuns). */
interface LineFacts {
    /** The shallowest depth read: a current NtM survey's (any value), a finest
     * band's below the caution floor, or — where no band exists at all — the
     * grid's. Infinity: none. */
    min: number;
    minAt: [number, number] | null;
    minNtm: boolean;
    /** The finest band's shallowest depth, any value (bands only; Infinity: none). */
    finestMin: number;
    /** Some of it has no chart depth at all. */
    uncharted: boolean;
    /** …read off the S-57 bands (the grid's cells are not a chart's word). */
    bandsUncharted: boolean;
    /** Some of it is decision-1 water. */
    conflict: boolean;
}

/** The NtM / decision-1 walk inside a band piece (m): finer than any cell. */
const CELL_WALK_M = 5;

/**
 * The chart reader of collectShallowRuns — one rule for the shallow runs,
 * the tide depth and chartStateAlong (round 4, 2026-09-30).
 *
 * EXACT against the real S-57 bands (injected OSM/Mapbox water carries no
 * S-57 identity and is not charted depth): a line is cut at the bands' own
 * edges (piecesAlong), as the backstop always was, so no strip however
 * narrow falls between two samples. It used to sample every 25 m on a
 * caution segment (round-4 review, 2026-09-30): a 15 m ridge drying 2 m
 * across a 1.5 m bank went unseen and the segment was drawn amber, a tide
 * window worked from the bank; 24 m of the Brisbane River mouth with no band
 * at all (under four LNDARE polygons) read as charted 0 m and was drawn "a
 * tide clears it". The 50 m grid cell records the MIN DRVAL1 of every band
 * rasterized into it, so a cell merely GRAZED by a drying bank's corner
 * reads 0 m even where the route line itself stays inside the 2 m band — and
 * the chip then demands the full keel+margin rise (Shane's Newport "+2.9 m"
 * on water the chart carries at 2 m). Only depths BELOW the caution floor
 * count toward the min — a deep band can never launder an uncharted run into
 * "deep & safe", so uncharted-only runs still ship minDepthM null. The grid
 * cell (every 25 m) only where no chart band exists at all (fixtures /
 * injected-water-only areas): falling back per spot would re-import the very
 * graze the exact reader exists to reject.
 *
 * NTM survey zones override the chart: where the grid carries an NtM
 * requiredRise (acknowledged + current notice, navGrid NTM pass), the
 * surveyed depth in grid.shallowDepthM is FRESHER than any DEPARE band — the
 * exact reader must not "correct" a 1 Jul survey back to the chart edition.
 * Those zones and decision-1 water are grid cells, walked every ≤5 m.
 */
function chartSampler(
    layers: InshoreLayers,
    grid: NavGrid,
    cautionFloorM: number,
): {
    depthBands: IndexedDepthArea[];
    piecesOf: (a: readonly [number, number], b: readonly [number, number]) => ChartPiece[];
    factsOf: (a: readonly [number, number], b: readonly [number, number]) => LineFacts;
} {
    const sd = grid.shallowDepthM;
    const depthBands = chartAreaIndexFor(layers).depth;
    const cellAt = (lon: number, lat: number): number => {
        const { x, y } = latLonToGrid(grid, lat, lon);
        return x < 0 || y < 0 || x >= grid.width || y >= grid.height ? -1 : y * grid.width + x;
    };
    const ntmSurveyDepthAt = (lon: number, lat: number): number | null => {
        const rise = grid.ntmRiseM;
        if (!rise || !sd) return null;
        const idx = cellAt(lon, lat);
        if (idx < 0 || Number.isNaN(rise[idx])) return null;
        const d = sd[idx];
        return Number.isNaN(d) ? null : d;
    };
    const conflictCells = grid.wetConflict && grid.wetConflict.indexOf(1) >= 0 ? grid.wetConflict : null;
    const conflictAt = (lon: number, lat: number): boolean => {
        if (!conflictCells) return false;
        const idx = cellAt(lon, lat);
        return idx >= 0 && conflictCells[idx] === 1;
    };
    // Walk inside a band only when some cell can say something.
    const walkCells = !!(grid.ntmRiseM && sd) || conflictCells !== null;

    const piecesOf = (a: readonly [number, number], b: readonly [number, number]): ChartPiece[] => {
        const segM = haversineM(a[1], a[0], b[1], b[0]);
        const lerp = (t: number): [number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        const sb = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
        const near = depthBands.filter(
            (x) => !(x.bbox[2] < sb[0] || x.bbox[0] > sb[2] || x.bbox[3] < sb[1] || x.bbox[1] > sb[3]),
        );
        const out: ChartPiece[] = [];
        if (!(segM > 0)) {
            // A zero-length segment is the one spot.
            const [lon, lat] = [a[0], a[1]];
            out.push({
                t0: 0,
                t1: 1,
                m: 0,
                lon,
                lat,
                finest: chartedDepthAt(near, lon, lat),
                ntm: ntmSurveyDepthAt(lon, lat),
                conflict: conflictAt(lon, lat),
            });
            return out;
        }
        let acc = 0;
        for (const q of piecesAlong(near, [a as [number, number], b as [number, number]])) {
            const t0 = acc / segM;
            acc += q.m;
            const t1 = Math.min(1, acc / segM);
            const finest = chartedDepthAt(near, q.lon, q.lat);
            const n = walkCells ? Math.max(1, Math.ceil(q.m / CELL_WALK_M)) : 1;
            let prev: ChartPiece | null = null;
            for (let k = 0; k < n; k++) {
                const s0 = t0 + ((t1 - t0) * k) / n;
                const s1 = t0 + ((t1 - t0) * (k + 1)) / n;
                const [lon, lat] = lerp((s0 + s1) / 2);
                const ntm = walkCells ? ntmSurveyDepthAt(lon, lat) : null;
                const conflict = walkCells ? conflictAt(lon, lat) : false;
                if (prev && prev.ntm === ntm && prev.conflict === conflict) {
                    prev.t1 = s1;
                    prev.m += q.m / n;
                    continue;
                }
                prev = { t0: s0, t1: s1, m: q.m / n, lon, lat, finest, ntm, conflict };
                out.push(prev);
            }
        }
        // Each piece's middle.
        for (const p of out) [p.lon, p.lat] = lerp((p.t0 + p.t1) / 2);
        return out;
    };

    const factsOf = (a: readonly [number, number], b: readonly [number, number]): LineFacts => {
        const f: LineFacts = {
            min: Infinity,
            minAt: null,
            minNtm: false,
            finestMin: Infinity,
            uncharted: false,
            bandsUncharted: false,
            conflict: false,
        };
        const take = (d: number, at: [number, number], ntm: boolean): void => {
            if (d < f.min) {
                f.min = d;
                f.minAt = at;
                f.minNtm = ntm;
            }
        };
        if (depthBands.length > 0) {
            for (const p of piecesOf(a, b)) {
                if (p.conflict) f.conflict = true;
                if (p.ntm !== null) {
                    // Fresh NtM survey outranks the chart edition (both ways).
                    take(p.ntm, [p.lon, p.lat], true);
                    continue;
                }
                if (p.finest === null) {
                    f.uncharted = true;
                    f.bandsUncharted = true;
                    continue;
                }
                if (p.finest < f.finestMin) f.finestMin = p.finest;
                if (p.finest < cautionFloorM) take(p.finest, [p.lon, p.lat], false);
            }
            return f;
        }
        // No chart band anywhere: the grid's cells, every 25 m, both ends.
        const segM = haversineM(a[1], a[0], b[1], b[0]);
        const steps = Math.max(1, Math.ceil(segM / 25));
        for (let s = 0; s <= steps; s++) {
            const t = s / steps;
            const lon = a[0] + (b[0] - a[0]) * t;
            const lat = a[1] + (b[1] - a[1]) * t;
            const surveyed = ntmSurveyDepthAt(lon, lat);
            if (surveyed !== null) {
                take(surveyed, [lon, lat], true);
                continue;
            }
            const idx = sd ? cellAt(lon, lat) : -1;
            if (sd && idx >= 0 && !Number.isNaN(sd[idx])) take(sd[idx], [lon, lat], false);
            else f.uncharted = true;
        }
        return f;
    };
    return { depthBands, piecesOf, factsOf };
}

/**
 * The least a line keeps from a shallow band whose deep end clears the keel
 * (DRVAL2 ≥ draft + UKC: a contour-continuous band, e.g. 2–5 m beside the
 * 5–10 m the line is in — its edge is the 5 m contour). Round-2 review
 * fix-up 2, 2026-10-03: a 4.9 m beam puts 2.45 m of hull each side of the
 * line before any GPS error; 10 m covers that, and a catamaran's, with GPS to
 * spare. Measured on the real cells, Shane's North Molle corner keeps 12.3 m
 * from its 2–5 m band at its closest.
 */
export const SHALLOW_BAND_CLEARANCE_M = 10;

/**
 * The least a line keeps from a shallow band that dries, charts no depth, or
 * whose deepest value never clears the keel (DRVAL2 < draft + UKC: a cliff —
 * its edge steps straight from water deep enough to water that is not): the
 * engine's own rock keep-out (RouteRequest.obstructionBufferM's default).
 * Round-2 review fix-up 2, 2026-10-03. Not the app's 60 m point-hazard
 * buffer: that is an A* tuning (it joins a chain of rocks' buffers into one
 * no-go strip, InshoreRouter), and at 60 m the North Molle corner — 43.0 m
 * from its reef drying 3.6 m and 31.6 m from its 0–2 m band, measured on the
 * real cells — would be red again while its leg review says "no issue found".
 */
export const SHALLOW_CLIFF_CLEARANCE_M = 30;

/**
 * How close the straight line a→b comes to the shallow chart bands round it
 * — what GRID_ONLY must prove before a caution segment is drawn green
 * (round-2 review fix-up 2, 2026-10-03), and what a chord that replaces
 * segments must prove too (field round 2's any-angle string pulling).
 *
 * Why: GRID_ONLY said "the 50 m cell holds shallower water than the line
 * does" and asked only that the line not ENTER the shallow band. By
 * construction such a line runs 0–35 m from that band, so a line metres off
 * a steep-to drying reef, or along its very edge, was drawn green and saved
 * where it had been red (a passage 80 m wide between two reefs drying 3 m:
 * GRID_ONLY 5.4 m from the reef; AU421148 has ~170 km of such cliff edges).
 *
 * The bands: every S-57 band that OWNS the centre of a shallow-band CAUTION
 * cell (chartedDepthOwnersAt — the grid's own finest-survey rule) within
 * reach of the line, and is shallower there than draft + UKC. The cells the
 * line touches, and every such cell whose centre lies within the largest
 * clearance plus half a cell's diagonal of it: a 2–5 m cell under the line
 * must not hide a drying band 15 m off in the next one. Each band's distance
 * is exact (segmentAreaDistanceM against its rings; a part of it a finer
 * survey shadows counts too — when unsure, the red stays). It asks for:
 *   • `cliffClearanceM` (SHALLOW_CLIFF_CLEARANCE_M for the route) where it
 *     dries (DRVAL1 < 0), charts no depth, or its deepest value never clears
 *     the keel (DRVAL2 < floor, or none) — its edge is a step to too-shallow;
 *   • SHALLOW_BAND_CLEARANCE_M where its deep end clears the keel.
 *
 * `unmeasured`: a cell the line touches is caution for a depth no S-57 band
 * owning its centre explains (a Notice to Mariners survey's stamp, water the
 * chart index does not hold) — nothing to measure, so nothing is proved.
 * `near`: the band that falls shortest of its clearance (null: none does).
 */
export function nearShallowBand(input: {
    grid: NavGrid;
    depthBands: readonly IndexedDepthArea[];
    floorM: number;
    cliffClearanceM: number;
    a: readonly [number, number];
    b: readonly [number, number];
}): { unmeasured: boolean; near: CautionNearShallow | null } {
    const { grid, floorM, a, b } = input;
    const sd = grid.shallowDepthM;
    if (!sd) return { unmeasured: true, near: null };
    const cliffM = Math.max(0, input.cliffClearanceM);
    const reachM = Math.max(cliffM, SHALLOW_BAND_CLEARANCE_M);
    const midLat = (a[1] + b[1]) / 2;
    const kx = 111_320 * Math.cos((midLat * Math.PI) / 180);
    const ky = 111_320;
    const halfDiagM = 0.5 * Math.hypot(grid.dLon * kx, grid.dLat * ky);
    const padLon = (reachM + 2 * halfDiagM) / Math.max(kx, 1);
    const padLat = (reachM + 2 * halfDiagM) / ky;
    const box = [
        Math.min(a[0], b[0]) - padLon,
        Math.min(a[1], b[1]) - padLat,
        Math.max(a[0], b[0]) + padLon,
        Math.max(a[1], b[1]) + padLat,
    ];
    const near = input.depthBands.filter(
        (x) => !(x.bbox[2] < box[0] || x.bbox[0] > box[2] || x.bbox[3] < box[1] || x.bbox[1] > box[3]),
    );
    const touched = new Set<number>();
    forEachCellOnSegment(grid, a, b, (idx) => touched.add(idx));
    const isShallowCell = (idx: number): boolean => grid.cells[idx] < 0 && !Number.isNaN(sd[idx]);
    const ntm = (idx: number): boolean => (grid.ntmRiseM?.[idx] ?? 0) > 0;
    const bands = new Set<IndexedDepthArea>();
    let unmeasured = false;
    const take = (idx: number, mustExplain: boolean): void => {
        if (ntm(idx)) {
            if (mustExplain) unmeasured = true;
            return;
        }
        const x = idx % grid.width;
        const y = (idx - x) / grid.width;
        const lon = grid.minLon + (x + 0.5) * grid.dLon;
        const lat = grid.minLat + (y + 0.5) * grid.dLat;
        const owners = chartedDepthOwnersAt(near, lon, lat).filter((o) => o.drval1 === null || o.drval1 < floorM);
        if (owners.length === 0 && mustExplain) unmeasured = true;
        for (const o of owners) bands.add(o);
    };
    for (const idx of touched) if (isShallowCell(idx)) take(idx, true);
    // Every shallow-band cell whose centre is within reach (+ half a diagonal).
    const x0 = Math.max(0, Math.floor((box[0] - grid.minLon) / grid.dLon));
    const x1 = Math.min(grid.width - 1, Math.floor((box[2] - grid.minLon) / grid.dLon));
    const y0 = Math.max(0, Math.floor((box[1] - grid.minLat) / grid.dLat));
    const y1 = Math.min(grid.height - 1, Math.floor((box[3] - grid.minLat) / grid.dLat));
    for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
            const idx = y * grid.width + x;
            if (touched.has(idx) || !isShallowCell(idx)) continue;
            const c: [number, number] = [grid.minLon + (x + 0.5) * grid.dLon, grid.minLat + (y + 0.5) * grid.dLat];
            if (segmentDistanceM(a, b, c, c, kx, ky) > reachM + halfDiagM) continue;
            take(idx, false);
        }
    let worst: CautionNearShallow | null = null;
    for (const band of bands) {
        const d1 = band.drval1;
        const d2 = band.drval2 ?? null;
        const cliff = d1 === null || d1 < 0 || d2 === null || d2 < floorM;
        const requiredM = cliff ? cliffM : SHALLOW_BAND_CLEARANCE_M;
        const clearanceM = segmentAreaDistanceM(band, a, b, requiredM);
        if (!(clearanceM < requiredM)) continue;
        // The band that falls furthest short of what it asks for.
        if (!worst || requiredM - clearanceM > worst.requiredM - worst.clearanceM)
            worst = { clearanceM, depthM: d1, requiredM };
    }
    return { unmeasured, near: worst };
}

/**
 * The chart's own facts along the straight line a→b, as a key (round 4,
 * 2026-09-30) — what collectShallowRuns reads on a caution segment, read the
 * same way (chartSampler factsOf, exact since the round-4 review): the
 * shallowest depth read, whether some of it has no chart depth, whether some
 * of it is decision-1 water. The engine's scaffold collapse merges a run of
 * segments into one only where the merged line reads the same as every
 * segment it replaces, so the shallow runs, the tide depth and the colours
 * never change.
 */
export function chartStateAlong(input: {
    layers: InshoreLayers;
    grid: NavGrid;
    draftM: number;
    safetyM: number;
}): (a: readonly [number, number], b: readonly [number, number]) => string {
    const { factsOf } = chartSampler(input.layers, input.grid, input.draftM + input.safetyM);
    return (a, b) => {
        const f = factsOf(a, b);
        return `${Number.isFinite(f.min) ? f.min.toFixed(2) : '-'}|${f.uncharted ? 'u' : ''}|${f.conflict ? 'x' : ''}`;
    };
}

export function collectShallowRuns(input: ShallowRunInput): ShallowRunOutput {
    const { layers, grid, polyline, caution, draftM, safetyM } = input;
    const destinationTailStartSeg = input.destinationTailStartSeg ?? -1;
    const originTailEndSeg = input.originTailEndSeg ?? -1;
    const shallowRuns: ShallowRunInfo[] = [];
    const segCount = Math.max(0, polyline.length - 1);
    const chartedShallowMask: boolean[] = new Array(segCount).fill(false);
    const chartedShallowSpans: ChartedShallowSpan[] = [];
    const landPaintConflictMask: boolean[] = new Array(segCount).fill(false);
    // Owner decision 10 (Shane, 2026-09-30: "Amber if a tide clears it"): per
    // caution segment, its shallowest charted depth, and whether some sample
    // of it has no chart depth at all — a tide proves nothing there.
    const segMinDepth: number[] = new Array(segCount).fill(Infinity);
    const segUncharted: boolean[] = new Array(segCount).fill(false);
    const cautionFloorM = draftM + safetyM;
    // The exact chart reader (chartSampler: NtM survey, finest S-57 band
    // pieces, the grid's only where no band exists). Read on EVERY segment
    // since the round-3 review (the backstop below), so no longer only when
    // some segment is caution.
    const { depthBands, piecesOf, factsOf } = chartSampler(layers, grid, cautionFloorM);
    const segLenM = (i: number): number => {
        const [lonA, latA] = polyline[i];
        const [lonB, latB] = polyline[i + 1];
        return haversineM(latA, lonA, latB, lonB);
    };
    const pointAt = (i: number, t: number): [number, number] => {
        const [lonA, latA] = polyline[i];
        const [lonB, latB] = polyline[i + 1];
        return [lonA + (lonB - lonA) * t, latA + (latB - latA) * t];
    };
    // Owner decision 10: a charted hazard's buffer is not the tide's to lift.
    // No mask (or one that does not fit): nothing is (fail-safe — red).
    const hazardMask = input.hazardMask && input.hazardMask.length === segCount ? input.hazardMask : null;

    // ── The renderer's BACKSTOP (round-3 review, 2026-09-30) ────────────
    // A segment the grid did NOT flag caution can still cross water the
    // finest S-57 survey charts shallower than draft + safety: OSM water used
    // to outrank the chart's own band in the grid (fixed in navGrid Pass 1,
    // but the rule was a single line of defence), a 50 m cell can miss a
    // narrow band, and several splices ride off the grid (lead and RECTRC
    // snaps, canal egress, the tap-to-water bridge). Every such segment is cut
    // at the depth bands' own edges (chartSampler piecesOf), and each piece
    // the finest survey (or a current NtM survey) charts below the floor is a
    // stretch the planner draws red, with a run — and so a tide chip — like
    // any caution. A stretch a tide may draw amber (owner decision 10) only
    // when that depth alone is its red (round-4 review, 2026-09-30:
    // tideLiftable): not in a charted hazard's buffer, not over decision-1
    // water, and never without the caller's hazard mask. A promoted route's
    // stretch beside a drying rock went from red to amber on its band's 1.5 m.
    const spansBySeg = new Map<number, RunUnit[]>();
    if (depthBands.length > 0) {
        for (let i = 0; i < segCount; i++) {
            if (caution[i]) continue;
            if (!(segLenM(i) > 0)) continue;
            const out: RunUnit[] = [];
            for (const q of piecesOf(polyline[i], polyline[i + 1])) {
                const d = q.ntm !== null ? q.ntm : q.finest;
                if (d === null || d >= cautionFloorM) continue;
                const last = out[out.length - 1];
                if (last && last.span && Math.abs(last.t1 - q.t0) < EPS_T) {
                    last.t1 = q.t1;
                    if (q.conflict) last.conflict = true;
                    if (d < last.span.d) last.span = { d, at: [q.lon, q.lat], ntm: q.ntm !== null };
                } else {
                    out.push({
                        seg: i,
                        t0: q.t0,
                        t1: q.t1,
                        span: { d, at: [q.lon, q.lat], ntm: q.ntm !== null },
                        conflict: q.conflict,
                    });
                }
            }
            if (out.length === 0) continue;
            // A stretch that reaches a segment end is exactly that end.
            if (out[0].t0 < EPS_T) out[0].t0 = 0;
            if (out[out.length - 1].t1 > 1 - 1e-6) out[out.length - 1].t1 = 1;
            spansBySeg.set(i, out);
            for (const u of out) {
                chartedShallowSpans.push({
                    startSeg: i,
                    startT: u.t0,
                    endSeg: i,
                    endT: u.t1,
                    minDepthM: (u.span as NonNullable<RunUnit['span']>).d,
                    ...(hazardMask && !hazardMask[i] && !u.conflict ? { tideLiftable: true } : {}),
                });
            }
        }
    }
    // Why each caution segment is caution, read EXACTLY along its line (round
    // 2, 2026-10-02: the field route's North Molle corner drew red where only
    // the 50 m cells touched a 2 m shore band; the line itself charted 5 m+,
    // the leg review said "no issue found" and nothing said why). A segment
    // is caution for its CELLS alone (GRID_ONLY) only when both hold:
    //   • its line reads clean — a chart depth everywhere, none below the
    //     floor, no decision-1 water, no hazard's buffer;
    //   • some cell the line touches is a shallow chart band's CAUTION, and
    //     every cell that could have made it caution is a shallow chart
    //     band's alone: never a blocked cell (land, a mark's disc, a hazard's
    //     buffer, a berth, a bridge bar, water no tide clears — navGrid writes
    //     every one as NaN, and gridCautionSegMask and the tier/bridge
    //     samplers flag a segment for any of them), decision-1 or
    //     coast-closing water, relaxed or carved land, a wing (passing outside
    //     a lateral mark), nor water no evidence vouches for. The one blocked
    //     cell that may count is a charted hazard's keep-out cell on a line
    //     the exact audit finds clear of every hazard's buffer
    //     (auditClearedHazardCell, fix-up review 2026-10-03).
    // EVERY cell the line touches is read (forEachCellOnSegment), corners
    // included: whichever sampler flagged the segment, the cell it found is
    // among them (fix-up review, 2026-10-03 — this reader skipped blocked
    // cells, sampled ~25 m, and called a segment with no caution cell at all
    // GRID_ONLY, so a mark's disc over 10–15 m water was drawn green and
    // saved). It is then not drawn red, and no run (so no chip) claims it. A
    // charted tail (decision 7) is never GRID_ONLY: it is the pin's own water.
    // Nor is a line that does not keep its CLEARANCE from the shallow bands
    // round it (round-2 review fix-up 2, 2026-10-03; nearShallowBand): not
    // entering the band was all GRID_ONLY asked, and by construction its line
    // runs 0–35 m from that band, so a line metres off a steep-to drying reef,
    // or along its very edge, went from red to green and Save. It keeps its
    // red, named (NEAR_SHALLOW: "passes 5 m from water charted to dry 3.0 m"),
    // and a cell a Notice to Mariners survey stamped below the floor is never
    // a shallow band's here: its depth is read on a 5 m walk, so a line
    // clipping a 1.2 m survey cell's corner could read the chart's 10 m.
    const cautionNearShallow: (CautionNearShallow | null)[] = new Array(segCount).fill(null);
    /** A cell closed by charted hazards' keep-outs alone — no land, berth,
     *  structure, mark disc, water no tide clears, nor router furniture the
     *  audit does not read — on a segment the exact audit finds clear of
     *  every charted hazard's buffer (hazardMask false). The grid closes a
     *  whole cell when its square comes within the buffer, so a line can clip
     *  such a cell's corner up to a diagonal beyond it (fix-up review,
     *  2026-10-03): on the Pi's cells a 981 m smoothing chord to Shute Harbour
     *  clipped one 113.7 m from the nearest charted hazard, in 15 m water, and
     *  was drawn red "a charted hazard" — Auto refused to save it. The line
     *  keeps every hazard's buffer; the cell is the grid's alone. */
    const auditClearedHazardCell = (idx: number, seg: number): boolean =>
        hazardMask !== null &&
        hazardMask[seg] === false &&
        grid.obstnBlocked?.[idx] === 1 &&
        grid.markDiscBlocked?.[idx] !== 1 &&
        grid.furnitureHazardBlocked?.[idx] !== 1 &&
        grid.clearanceBarred?.[idx] !== 1 &&
        grid.berthBlocked?.[idx] !== 1 &&
        grid.landBlocked?.[idx] !== 1 &&
        grid.noTideClears?.[idx] !== 1;
    /** Why a blocked (NaN) cell is blocked, as a CAUTION_WHY bit. Land the
     *  line only touches is BLOCKED, not LAND: LAND is land the router OPENED
     *  (a relax zone, a carve), and the land audit owns land it crosses. */
    const blockedWhy = (idx: number): number => {
        if (grid.markDiscBlocked?.[idx] === 1) return CAUTION_WHY.MARK;
        if (grid.berthBlocked?.[idx] === 1 || grid.clearanceBarred?.[idx] === 1) return CAUTION_WHY.STRUCTURE;
        if (grid.obstnBlocked?.[idx] === 1) return CAUTION_WHY.HAZARD;
        return CAUTION_WHY.BLOCKED;
    };
    /** What, besides a shallow band, made a CAUTION cell caution (0: nothing). */
    const cautionFlags = (idx: number, seg: number): number => {
        let bits = 0;
        if (grid.wingCaution?.[idx] === 1) bits |= CAUTION_WHY.WING;
        if (grid.landBlocked?.[idx] === 1 || grid.relaxMask?.[idx] === 1) bits |= CAUTION_WHY.LAND;
        if (grid.markDiscBlocked?.[idx] === 1) bits |= CAUTION_WHY.MARK;
        else if (grid.obstnBlocked?.[idx] === 1 && !auditClearedHazardCell(idx, seg)) bits |= CAUTION_WHY.HAZARD;
        if (grid.berthBlocked?.[idx] === 1 || grid.clearanceBarred?.[idx] === 1) bits |= CAUTION_WHY.STRUCTURE;
        return bits;
    };
    /** The cells segment `seg` touches that could have made it caution: why
     *  (CAUTION_WHY bits), and whether they are the grid's alone — at least
     *  one such cell (a shallow chart band's, or a charted hazard keep-out
     *  cell the audit clears the line of), and nothing else. */
    const cautionCells = (seg: number): { bits: number; onlyShallowBand: boolean } => {
        const sd = grid.shallowDepthM;
        let bits = 0;
        let other = !sd;
        let shallowBand = false;
        forEachCellOnSegment(grid, polyline[seg], polyline[seg + 1], (idx) => {
            const v = grid.cells[idx];
            if (Number.isNaN(v)) {
                if (auditClearedHazardCell(idx, seg)) {
                    shallowBand = true;
                    return;
                }
                bits |= blockedWhy(idx);
                other = true;
                return;
            }
            if (v === UNKNOWN_OPEN && grid.unvouched?.[idx] === 1) {
                other = true;
                return;
            }
            if (!(v < 0)) return; // charted depth or vouched open water: not what made it caution
            const flags = cautionFlags(idx, seg);
            bits |= flags;
            if (
                flags !== 0 ||
                !sd ||
                Number.isNaN(sd[idx]) ||
                grid.wetConflict?.[idx] === 1 ||
                (grid.ntmRiseM?.[idx] ?? 0) > 0 // an NtM survey's sub-floor stamp
            )
                other = true;
            else shallowBand = true;
        });
        return { bits, onlyShallowBand: shallowBand && !other };
    };
    const facts: (LineFacts | null)[] = new Array(segCount).fill(null);
    const cautionWhy: number[] = new Array(segCount).fill(0);
    for (let i = 0; i < segCount; i++) {
        if (!caution[i]) continue;
        const f = factsOf(polyline[i], polyline[i + 1]);
        facts[i] = f;
        let why = 0;
        if (Number.isFinite(f.min)) why |= CAUTION_WHY.SHALLOW;
        if (f.uncharted) why |= CAUTION_WHY.UNCHARTED;
        if (f.conflict) why |= CAUTION_WHY.DISAGREE;
        if (hazardMask?.[i]) why |= CAUTION_WHY.HAZARD;
        const cells = cautionCells(i);
        why |= cells.bits;
        const tail = (destinationTailStartSeg >= 0 && i >= destinationTailStartSeg) || i <= originTailEndSeg;
        if (why === 0) {
            why = CAUTION_WHY.UNEXPLAINED;
            if (depthBands.length > 0 && hazardMask && !tail && cells.onlyShallowBand) {
                const clear = nearShallowBand({
                    grid,
                    depthBands,
                    floorM: cautionFloorM,
                    cliffClearanceM: SHALLOW_CLIFF_CLEARANCE_M,
                    a: polyline[i],
                    b: polyline[i + 1],
                });
                if (clear.near) {
                    why = CAUTION_WHY.NEAR_SHALLOW;
                    cautionNearShallow[i] = clear.near;
                } else if (!clear.unmeasured) why = CAUTION_WHY.GRID_ONLY;
            }
        }
        cautionWhy[i] = why;
    }
    const units: RunUnit[] = [];
    for (let i = 0; i < segCount; i++) {
        if (caution[i]) {
            if (cautionWhy[i] !== CAUTION_WHY.GRID_ONLY) units.push({ seg: i, t0: 0, t1: 1, span: null });
        } else for (const u of spansBySeg.get(i) ?? []) units.push(u);
    }

    let shallowMaxM = 0;
    let run: RunUnit[] = [];
    let runM = 0;
    let runMin = Infinity;
    let runMinAt: [number, number] | null = null;
    let runNtm = false;
    // Decision-1 water along a tail: whether any sample sits in it, and the
    // finest survey's shallowest depth along the run (any value).
    let runConflict = false;
    let runFinestMin = Infinity;
    // Some of the run has no chart band under it at all (uncharted).
    let runUncharted = false;
    // …or no chart depth of any kind (the grid's included), and some of it
    // lies in a charted hazard's buffer: why its red is not the tide's to
    // lift, for its chip (round-4 review, 2026-09-30).
    let runNoDepth = false;
    let runNearHazard = false;
    const flush = (): void => {
        if (run.length === 0) return;
        const first = run[0];
        const last = run[run.length - 1];
        const startSeg = first.seg;
        const endSeg = last.seg;
        if (runM > shallowMaxM) shallowMaxM = runM;
        // A charted pin's tail (decision 7) is marked whatever its length:
        // it is the stretch past the last deep-enough water, 'needs tide'
        // with its charted depth — the tide chip is how the route says so.
        const endpointTail: 'origin' | 'destination' | undefined =
            destinationTailStartSeg >= 0 && startSeg === destinationTailStartSeg && first.t0 === 0
                ? 'destination'
                : originTailEndSeg >= 0 && startSeg === 0 && first.t0 === 0 && endSeg === originTailEndSeg
                  ? 'origin'
                  : undefined;
        if (runM >= MIN_RUN_M || endpointTail) {
            // Midpoint by along-track length — where the window chip anchors.
            let acc = 0;
            let mid = pointAt(first.seg, first.t0);
            for (const u of run) {
                const m = (u.t1 - u.t0) * segLenM(u.seg);
                if (acc + m >= runM / 2) {
                    const f = m > 0 ? (runM / 2 - acc) / m : 0;
                    mid = pointAt(u.seg, u.t0 + (u.t1 - u.t0) * f);
                    break;
                }
                acc += m;
            }
            const minDepthM = Number.isFinite(runMin) ? runMin : null;
            shallowRuns.push({
                startSeg,
                endSeg,
                ...(first.t0 > 0 ? { startT: first.t0 } : {}),
                ...(last.t1 < 1 ? { endT: last.t1 } : {}),
                lengthM: Math.round(runM),
                minDepthM,
                midLat: mid[1],
                midLon: mid[0],
                ...(runMinAt ? { minAtLat: runMinAt[1], minAtLon: runMinAt[0] } : {}),
                // The deepest the chart admits at that spot (decision 11
                // fix-up, 2026-10-01): a 0–2 m band's 0 m end may need more
                // than any tide while the band itself is not proved
                // unclearable — the chip says which (tideWindowChips).
                ...(() => {
                    if (!runMinAt || runNtm || depthBands.length === 0) return {};
                    const deepestM = chartedDepthRangeAt(depthBands, runMinAt[0], runMinAt[1])?.deepestM ?? null;
                    return deepestM !== null ? { deepestM } : {};
                })(),
                ...(runNtm ? { ntmSurveyed: true } : {}),
                ...(endpointTail ? { endpointTail } : {}),
                // A tail through decision-1 water with no finest-survey depth
                // below the floor: caution only because a coarser chart paints
                // land there — named, never given a fabricated tide window.
                // Mid-route too (round-3 review, 2026-09-30: decision-1 water
                // in a marked channel drew yellow like a deep buoyed channel),
                // when every sample of the run is charted: an uncharted stretch
                // in it is not the charts disagreeing.
                ...(minDepthM === null &&
                runConflict &&
                Number.isFinite(runFinestMin) &&
                (endpointTail || !runUncharted)
                    ? { coarserLandPaint: true, finestDepthM: runFinestMin }
                    : {}),
                ...(runConflict ? { chartsDisagree: true } : {}),
                ...(runNearHazard ? { nearHazard: true } : {}),
                ...(runNoDepth ? { partUncharted: true } : {}),
            });
        }
        run = [];
        runM = 0;
        runMin = Infinity;
        runMinAt = null;
        runNtm = false;
        runConflict = false;
        runFinestMin = Infinity;
        runUncharted = false;
        runNoDepth = false;
        runNearHazard = false;
    };
    let prev: RunUnit | null = null;
    for (const u of units) {
        const contiguous =
            prev !== null &&
            ((u.seg === prev.seg && Math.abs(u.t0 - prev.t1) < EPS_T) ||
                (u.seg === prev.seg + 1 && prev.t1 === 1 && u.t0 === 0));
        // A charted tail is its own run (decision 7): break at its edge.
        const tailEdge = u.t0 === 0 && (u.seg === destinationTailStartSeg || u.seg === originTailEndSeg + 1);
        if (!contiguous || tailEdge) flush();
        prev = u;
        run.push(u);
        const segM = segLenM(u.seg);
        runM += (u.t1 - u.t0) * segM;
        if (hazardMask?.[u.seg]) runNearHazard = true;
        if (u.span) {
            // A backstop stretch: its depth is below the floor by construction.
            if (u.span.d < runMin) {
                runMin = u.span.d;
                runMinAt = u.span.at;
                runNtm = u.span.ntm;
            }
            if (u.conflict) runConflict = true;
            continue;
        }
        // A caution segment, read EXACTLY (chartSampler factsOf; round-4
        // review, 2026-09-30 — it was sampled every 25 m): the shallowest
        // depth, whether any of it has no chart depth, whether any of it is
        // decision-1 water. run.minDepthM comes from the same pieces.
        const i = u.seg;
        const f = facts[i] ?? factsOf(polyline[i], polyline[i + 1]);
        if (f.finestMin < runFinestMin) runFinestMin = f.finestMin;
        if (f.uncharted) {
            // Only the bands' reading names a run uncharted (decision-1
            // labels); any stretch without a depth keeps a segment's red.
            if (f.bandsUncharted) runUncharted = true;
            runNoDepth = true;
            segUncharted[i] = true;
        }
        if (f.conflict) {
            runConflict = true;
            landPaintConflictMask[i] = true;
        }
        if (Number.isFinite(f.min)) {
            segMinDepth[i] = f.min;
            chartedShallowMask[i] = true;
            if (f.min < runMin) {
                runMin = f.min;
                runMinAt = f.minAt;
                runNtm = f.minNtm;
            }
        }
    }
    flush();
    // The depth a tide must lift, per segment (owner decision 10, 2026-09-30):
    // the planner draws a caution segment amber when some tide gives draft +
    // UKC over this depth, red when none does. Only where the charted depth
    // ALONE makes it red: never inside a charted hazard's buffer, never where
    // a sample has no chart depth (uncharted, unvouched), never over
    // decision-1 water (the charts disagree — no tide settles that), never
    // where the shallowest depth read is not below the floor (a caution the
    // depth does not explain: an NtM survey charting it deep). Null
    // keeps the red, and so does a caller that sends no hazard mask. The
    // backstop's stretches carry their own depth (chartedShallowSpans) and
    // the same guard (tideLiftable).
    const tideDepthM: (number | null)[] = Array.from({ length: segCount }, (_, i) =>
        hazardMask &&
        !hazardMask[i] &&
        caution[i] &&
        chartedShallowMask[i] &&
        !segUncharted[i] &&
        !landPaintConflictMask[i] &&
        segMinDepth[i] < cautionFloorM
            ? segMinDepth[i]
            : null,
    );
    const cautionDepthM: (number | null)[] = segMinDepth.map((d, i) =>
        caution[i] && Number.isFinite(d) && d < cautionFloorM ? d : null,
    );
    return {
        shallowRuns,
        chartedShallowMask,
        chartedShallowSpans,
        landPaintConflictMask,
        tideDepthM,
        shallowMaxM,
        cautionWhy,
        cautionDepthM,
        cautionNearShallow,
    };
}

// ── Survey quality along the route (owner decision 9, 2026-09-30) ──────────
//
// Shane, 2026-09-30: "Yes, amber on the route" — decisions 3 and 4 (read on
// the leads since round 1) read on the route too. The route still goes: a
// stretch whose charted depth less its survey's vertical error is below
// draft + UKC ("survey may be out by 2.2 m"), or whose survey is CATZOC D / U
// or not graded ("old or ungraded survey"), is drawn amber (dashes, since owner
// decision 10 — solid amber is needs-tide) and named. Never a
// refusal, never a path cost: this runs on the FINISHED geometry, like the
// shallow runs above, for an engine route and a promoted Seaway route alike.
//
// The grade at a spot is the FINEST survey's there: the M_QUAL zones whose
// rank is the finest (or tied with it) among everything charted on the spot —
// zones, depth bands, land paint — the worst CATZOC among them, and none at
// all when any of them carries no CATZOC. A finer cell with no zone on the
// spot never borrows a coarser cell's grade: when that finer cell's data
// carries no M_QUAL layer at all it is 'survey-unchecked' (not extracted,
// said as a caveat like decision 8's bridges), otherwise 'survey-ungraded'
// (decision 4). The margin table is the lead review's (leadReview
// surveyVerdict) — one rule, one table — and since the round-3 review
// (2026-09-30) so is who owns the grade (leadReview surveyGradeAt: the leads
// ranked the zones alone and could borrow a coarser grade). The route reads
// decision 9's words on water already charted shallower than the keel needs
// too (surveyVerdict belowNeed): that stretch is red already, and the survey
// error rides its tide chip and the caveat.

export interface SurveyRunInput {
    layers: InshoreLayers;
    polyline: readonly [number, number][];
    draftM: number;
    /** The under-keel clearance on top of the draft (the route's safetyM). */
    safetyM: number;
    /** Cells merged for the route whose data carries no M_QUAL layer. */
    uncheckedCells?: readonly SurveyUncheckedCell[];
    /** Where a current NtM survey is stamped (grid.ntmRiseM), that fresh
     * survey is the authority, not the chart edition's M_QUAL: no stretch. */
    grid?: NavGrid;
}

export interface SurveyRunOutput {
    surveyRuns: SurveyRunInfo[];
    /** Per segment: some of it is amber for survey quality. */
    surveyMask: boolean[];
    /** The unchecked cells that own some of the route. */
    uncheckedCells: string[];
}

/** Sample spacing along the route (m) — the shallow sampler's. */
const SURVEY_STEP_M = 25;

const zoneMemo = new WeakMap<object, SurveyZone[]>();

/** The M_QUAL zones of a layer set, indexed once per collection. */
function surveyZonesOf(layers: InshoreLayers): SurveyZone[] {
    const fc = layers.M_QUAL;
    if (!fc) return [];
    const hit = zoneMemo.get(fc);
    if (hit) return hit;
    const zones: SurveyZone[] = [];
    for (const f of fc.features) {
        if (!isS57Feature(f)) continue;
        const g = areaGeometry(f);
        if (!g) continue;
        zones.push({
            area: indexArea(g, readNum(f.properties, '_scaleRank')),
            catzoc: readNum(f.properties, 'CATZOC'),
        });
    }
    zoneMemo.set(fc, zones);
    return zones;
}

/** The survey verdict at one spot, or null where nothing charted covers it. */
function surveyReasonAt(
    lon: number,
    lat: number,
    zones: readonly SurveyZone[],
    bands: readonly IndexedDepthArea[],
    land: readonly IndexedArea[],
    unchecked: readonly SurveyUncheckedCell[],
    needM: number,
): {
    reason: SurveyRunReason | null;
    catzoc: number | null;
    errorM?: number;
    depthM: number | null;
    cellId?: string;
} | null {
    // Who grades the spot: the lead review's own rule (round-3 review,
    // 2026-09-30) — zones, bands and land paint ranked together, unranked
    // surveys never out-surveyed, no coarser grade borrowed.
    const grade = surveyGradeAt(lon, lat, zones, bands, land);
    if (!grade) return null;
    const ds = bands.filter((a) => pointInArea(a, lon, lat));
    const depthM = ds.length > 0 ? chartedDepthAt(ds, lon, lat) : null;
    if (!grade.zoned) {
        // The finest survey here has no zone on this spot.
        const finest = grade.finestRank;
        const cell = unchecked.find(
            (c) =>
                lon >= c.bbox[0] &&
                lon <= c.bbox[2] &&
                lat >= c.bbox[1] &&
                lat <= c.bbox[3] &&
                (c.rank === null ? finest === null : finest !== null && surveyRanksTie(c.rank, finest)),
        );
        return cell
            ? { reason: 'survey-unchecked', catzoc: null, depthM, cellId: cell.id }
            : { reason: 'survey-ungraded', catzoc: null, depthM };
    }
    const catzoc = grade.catzoc;
    // The route's reading of decision 9 (belowNeed): charted water already
    // shallower than draft + UKC whose grade's error is known gets the words
    // too — under its red, on its tide chip (leadReview surveyVerdict).
    const v = surveyVerdict(catzoc, depthM, needM, { belowNeed: true });
    switch (v.kind) {
        case 'ungraded':
            return { reason: 'survey-ungraded', catzoc: null, depthM };
        case 'poor':
            return { reason: 'survey-poor', catzoc, depthM };
        case 'margin':
            return { reason: 'survey-margin', catzoc, errorM: v.errorM, depthM };
        default:
            return { reason: null, catzoc, depthM };
    }
}

export function collectSurveyRuns(input: SurveyRunInput): SurveyRunOutput {
    const { layers, polyline, grid } = input;
    const segCount = Math.max(0, polyline.length - 1);
    const surveyMask: boolean[] = new Array(segCount).fill(false);
    const surveyRuns: SurveyRunInfo[] = [];
    const uncheckedSeen = new Set<string>();
    const unchecked = input.uncheckedCells ?? [];
    const zones = surveyZonesOf(layers);
    // Nothing to read: no zone anywhere and no cell known to lack them.
    if (segCount === 0 || (zones.length === 0 && unchecked.length === 0)) {
        return { surveyRuns, surveyMask, uncheckedCells: [] };
    }
    const index = chartAreaIndexFor(layers);
    const needM = input.draftM + input.safetyM;
    const ntmAt = (lon: number, lat: number): boolean => {
        const rise = grid?.ntmRiseM;
        if (!grid || !rise) return false;
        const { x, y } = latLonToGrid(grid, lat, lon);
        if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return false;
        return !Number.isNaN(rise[y * grid.width + x]);
    };

    interface Piece {
        seg: number;
        t0: number;
        t1: number;
        m: number;
    }
    let run: {
        reason: SurveyRunReason;
        pieces: Piece[];
        lengthM: number;
        catzoc: number | null;
        errorM?: number;
        minDepthM?: number;
        cells: Set<string>;
    } | null = null;
    const flush = (): void => {
        if (!run) return;
        const r = run;
        run = null;
        // Midpoint by along-track length.
        let acc = 0;
        let mid: [number, number] = polyline[r.pieces[0].seg];
        for (const p of r.pieces) {
            if (acc + p.m >= r.lengthM / 2) {
                const f = p.m > 0 ? (r.lengthM / 2 - acc) / p.m : 0;
                const t = p.t0 + (p.t1 - p.t0) * f;
                const [lonA, latA] = polyline[p.seg];
                const [lonB, latB] = polyline[p.seg + 1];
                mid = [lonA + (lonB - lonA) * t, latA + (latB - latA) * t];
                break;
            }
            acc += p.m;
        }
        const first = r.pieces[0];
        const last = r.pieces[r.pieces.length - 1];
        surveyRuns.push({
            reason: r.reason,
            startSeg: first.seg,
            startT: first.t0,
            endSeg: last.seg,
            endT: last.t1,
            lengthM: Math.round(r.lengthM),
            catzoc: r.catzoc,
            ...(r.errorM !== undefined ? { errorM: Math.round(r.errorM * 10) / 10 } : {}),
            ...(r.minDepthM !== undefined ? { minDepthM: r.minDepthM } : {}),
            midLat: mid[1],
            midLon: mid[0],
            ...(r.cells.size > 0 ? { cellIds: [...r.cells] } : {}),
        });
    };

    for (let i = 0; i < segCount; i++) {
        const [lonA, latA] = polyline[i];
        const [lonB, latB] = polyline[i + 1];
        const segM = haversineM(latA, lonA, latB, lonB);
        const steps = Math.max(1, Math.ceil(segM / SURVEY_STEP_M));
        // Only what can cover this segment.
        const sb = [Math.min(lonA, lonB), Math.min(latA, latB), Math.max(lonA, lonB), Math.max(latA, latB)];
        const near = (b: readonly number[]): boolean => !(b[2] < sb[0] || b[0] > sb[2] || b[3] < sb[1] || b[1] > sb[3]);
        const segZones = zones.filter((z) => near(z.area.bbox));
        const segBands = index.depth.filter((a) => near(a.bbox));
        const segLand = index.land.filter((a) => near(a.bbox));
        const segUnchecked = unchecked.filter((c) => near(c.bbox));
        for (let s = 0; s < steps; s++) {
            const t = (s + 0.5) / steps;
            const lon = lonA + (lonB - lonA) * t;
            const lat = latA + (latB - latA) * t;
            const at = ntmAt(lon, lat)
                ? null
                : surveyReasonAt(lon, lat, segZones, segBands, segLand, segUnchecked, needM);
            const reason = at?.reason ?? null;
            if (reason === null || (run && run.reason !== reason)) flush();
            if (reason === null || !at) continue;
            const piece: Piece = { seg: i, t0: s / steps, t1: (s + 1) / steps, m: segM / steps };
            if (!run) run = { reason, pieces: [], lengthM: 0, catzoc: at.catzoc, cells: new Set() };
            run.pieces.push(piece);
            run.lengthM += piece.m;
            if (at.catzoc !== null && (run.catzoc === null || at.catzoc > run.catzoc)) run.catzoc = at.catzoc;
            if (at.errorM !== undefined && (run.errorM === undefined || at.errorM > run.errorM)) run.errorM = at.errorM;
            if (at.depthM !== null && (run.minDepthM === undefined || at.depthM < run.minDepthM))
                run.minDepthM = at.depthM;
            if (at.cellId) {
                run.cells.add(at.cellId);
                uncheckedSeen.add(at.cellId);
            }
            if (AMBER_SURVEY_REASONS.has(reason)) surveyMask[i] = true;
        }
    }
    flush();
    return { surveyRuns, surveyMask, uncheckedCells: [...uncheckedSeen] };
}
