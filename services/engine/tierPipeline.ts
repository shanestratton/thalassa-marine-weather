/**
 * Inshore Router Engine — tier splice/segment/dispatch + leading-line/fairlead glue.
 * Carved out of inshoreRouterEngine.ts (module split, 2026-06-24).
 */
import { M_PER_DEG_LAT, ENGINE_DEBUG, engineLog } from './constants';
import type { NavGrid, InshoreLayers, RelaxZone } from './types';
import { mPerDegLon, haversineM, latLonToGrid, pointInGeometry, geometryBbox, douglasPeucker } from './geometry';
import type { Polygon, MultiPolygon } from 'geojson';
import { buildNavGridCached, snapToNavigable } from './navGrid';
import { aStar } from './aStar';
import { smoothPath } from './pathShaping';
import { parseLateralMarks, refineWithFairlead, type LatLon, type LateralMark } from '../fairlead';
import {
    parseLeadingLines,
    snapToLeadingLines,
    buildLeadingApproach,
    distM as llDistM,
    anyAlong as llAnyAlong,
    type LeadingLine,
} from '../leadingLine';
import { segmentRoute, type TierSpan } from '../routing/segmentRoute';
import { routeTier3, type Tier3Context } from '../tier3/tier3Router';
import { routeTier4, type Tier4Context } from '../tier4/tier4Router';
import { followCanalLines, parseCanalLines, snapRouteToCanalLines } from '../tier3/canalLineFollower';
import { clampRouteToCardinalSafeSide, parseCardinalDiscs } from '../tier3/cardinalClamp';
import { stitchLegs } from '../glue/gluer';
import { isRefusal, freezeLeg, type Leg, type LegResult } from '../routing/legContract';
import { validateAgainstCrossLines } from '../seaway/crossLine';
import type { GateNode } from '../seaway/types';

/** Shane-confirmed rising-tide bar margin (docs/THREE_TIER_ROUTING.md §1.5).
 *  Feeds the marks-free inshore depth gate (→ 5 m all-tide for a 2.4 m draft). */
export const TIER_TIDE_SAFETY_M = 0.5;

/**
 * Build a passthrough Leg for a tier-3/4 span: KEEP the A* sub-polyline (the
 * engine already routed inshore/offshore water well — the standalone deep-water
 * router is for the future boundary-node-driven path, not for refining an
 * existing A* route).
 * Endpoints pinned to the span's shared-seam BoundaryNodes; caution + depth
 * recomputed per-vertex from the grid.
 */
export function passthroughLeg(
    span: TierSpan,
    polyline: readonly [number, number][],
    grid: NavGrid,
    recommendedTracks: readonly LeadingLine[] = [],
): Leg {
    let sub = polyline.slice(span.fromIdx, span.toIdx + 1).map(([lon, lat]) => [lon, lat] as [number, number]);
    sub[0] = span.entry.at as [number, number];
    sub[sub.length - 1] = span.exit.at as [number, number];

    // A tier-3 bay leg that MEETS a marked channel rides the RECTRC too, so it arrives at the tier-2
    // junction ALONG the channel centreline instead of hugging the bank right up to it (Shane's
    // Pinkenba: the yellow leg rode centre + the seam snapped, but the teal APPROACH still kinked to
    // the wall). No-op away from a RECTRC — the snap corridor gates it, so the open-bay crossing is
    // untouched. tier-4 (offshore) never rides (gated on tier===3).
    if (span.tier === 3 && recommendedTracks.length > 0 && sub.length >= 3) {
        // Per-vertex projection onto the RECTRC (NOT the run-based snap, whose minRun gate the short
        // junction legs fail): each interior vertex within the corridor rides the channel centreline;
        // endpoints stay pinned (the seam-snap above already put the boundary nodes on the RECTRC).
        // Three guards keep the projection honest: (1) the local route direction must run WITH the
        // track (mod 180, ≤45°), so a track the leg merely crosses — or a parallel channel's — can't
        // grab it; (2) a candidate landing on land or sub-keel-margin water is refused per-vertex
        // (the grid outranks the projection); (3) the emitted sub-segments are land-swept
        // endpoint-inclusive — any hit rolls the whole leg back to the A* geometry.
        let moved = 0;
        const projected = sub.map(([lon, lat], i): [number, number] => {
            if (i === 0 || i === sub.length - 1) return [lon, lat];
            const localBrg = tupleBearingDeg(sub[i - 1], sub[i + 1]);
            const p = nearestOnLeadingLines(lat, lon, recommendedTracks, SEAM_RECTRC_CORRIDOR_M, localBrg);
            if (!p) return [lon, lat];
            const c = gridCellAt(grid, p);
            if (c !== null && (Number.isNaN(c) || c < 0)) return [lon, lat];
            moved++;
            return p;
        });
        if (moved > 0) {
            let crossesLand = false;
            for (let k = 0; k + 1 < projected.length && !crossesLand; k++) {
                crossesLand = tupleLineCrossesHardLand(grid, projected[k], projected[k + 1], 20);
            }
            if (!crossesLand) {
                sub = projected;
                engineLog.warn(`[channelRide] tier3 approach projected onto RECTRC +${moved}`);
            }
        }
    }

    let controlling = Infinity;
    const cautionMask = sub.map(([lon, lat]) => {
        const { x, y } = latLonToGrid(grid, lat, lon);
        if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return false;
        const d = grid.cells[y * grid.width + x];
        if (!Number.isNaN(d) && d >= 0) controlling = Math.min(controlling, d);
        return Number.isNaN(d) || d < 0;
    });
    return freezeLeg({
        tierId: span.tier,
        entry: span.entry,
        exit: span.exit,
        polyline: sub,
        cautionMask,
        depthSource: span.tier === 4 ? 'gebco' : 'charted',
        controllingDepthM: Number.isFinite(controlling) ? controlling : null,
        provenance: `tier${span.tier}:passthrough`,
    });
}

export function pointToTupleSegM(p: { lat: number; lon: number }, a: readonly number[], b: readonly number[]): number {
    const refLat = (a[1] + b[1]) / 2;
    const mx = M_PER_DEG_LAT * Math.cos((refLat * Math.PI) / 180);
    const my = M_PER_DEG_LAT;
    const ax = a[0] * mx;
    const ay = a[1] * my;
    const bx = b[0] * mx;
    const by = b[1] * my;
    const px = p.lon * mx;
    const py = p.lat * my;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - ax, py - ay);
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function pointToTupleLinesM(
    p: { lat: number; lon: number },
    lines: readonly (readonly (readonly number[])[])[],
): number {
    let best = Infinity;
    for (const line of lines) {
        for (let i = 0; i + 1 < line.length; i++) {
            const d = pointToTupleSegM(p, line[i], line[i + 1]);
            if (d < best) best = d;
        }
    }
    return best;
}

export function pointToTuplePolylineM(
    p: { lat: number; lon: number },
    polyline: readonly (readonly [number, number])[],
): number {
    let best = Infinity;
    for (let i = 0; i + 1 < polyline.length; i++) {
        const d = pointToTupleSegM(p, polyline[i], polyline[i + 1]);
        if (d < best) best = d;
    }
    return best;
}

export function llPathLengthM(pts: readonly LatLon[]): number {
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += llDistM(pts[i - 1], pts[i]);
    return len;
}

export interface EgressTrack extends LeadingLine {
    /** First point index that belongs to tier 2. Points before this are tier 1 handoff. */
    tier2FromIndex?: number;
}

export function sameGatePair(a: LateralMark, b: LateralMark): boolean {
    if (a.key !== b.key) return false;
    if (a.seq === b.seq) return true;
    return Math.abs(a.seq - b.seq) === 1 && Math.ceil(a.seq / 2) === Math.ceil(b.seq / 2);
}

export function buildGateCentreTracks(
    marks: readonly LateralMark[],
    polyline: readonly [number, number][],
    referenceTracks: readonly LeadingLine[],
    onPairs?: (pairs: ReadonlyArray<{ port: LatLon; stbd: LatLon }>) => void,
): EgressTrack[] {
    if (marks.length < 4 || polyline.length < 2) return [];

    const routeStart: LatLon = { lat: polyline[0][1], lon: polyline[0][0] };
    const routeEnd: LatLon = { lat: polyline[polyline.length - 1][1], lon: polyline[polyline.length - 1][0] };
    const referenceLines = referenceTracks
        .filter((t) => t.pts.length >= 2)
        .map((t) => t.pts.map((p) => [p.lon, p.lat] as [number, number]));
    const ports = marks.map((m, idx) => ({ m, idx })).filter(({ m }) => m.side === 'port');
    const stbds = marks.map((m, idx) => ({ m, idx })).filter(({ m }) => m.side === 'stbd');

    const MIN_GATE_WIDTH_M = 12;
    const MAX_GATE_WIDTH_M = 180;
    const MAX_GATE_FROM_ORIGIN_M = 6000;
    const MAX_GATE_ROUTE_M = 900;
    const MAX_GATE_REFERENCE_M = 450;
    const MAX_GATE_STEP_M = 950;

    const candidates: Array<{
        portIdx: number;
        stbdIdx: number;
        lat: number;
        lon: number;
        widthM: number;
        endpointM: number;
        referenceM: number;
    }> = [];

    for (const p of ports) {
        for (const s of stbds) {
            if (!sameGatePair(p.m, s.m)) continue;
            const widthM = llDistM(p.m, s.m);
            if (widthM < MIN_GATE_WIDTH_M || widthM > MAX_GATE_WIDTH_M) continue;
            const centre: LatLon = { lat: (p.m.lat + s.m.lat) / 2, lon: (p.m.lon + s.m.lon) / 2 };
            const endpointM = Math.min(llDistM(routeStart, centre), llDistM(routeEnd, centre));
            if (endpointM > MAX_GATE_FROM_ORIGIN_M) continue;
            const routeM = pointToTuplePolylineM(centre, polyline);
            const referenceM = referenceLines.length > 0 ? pointToTupleLinesM(centre, referenceLines) : Infinity;
            if (routeM > MAX_GATE_ROUTE_M && referenceM > MAX_GATE_REFERENCE_M) continue;
            candidates.push({
                portIdx: p.idx,
                stbdIdx: s.idx,
                lat: centre.lat,
                lon: centre.lon,
                widthM,
                endpointM,
                referenceM,
            });
        }
    }

    const onReference = candidates.filter((c) => c.referenceM <= MAX_GATE_REFERENCE_M);
    const usable = onReference.length >= 2 ? onReference : candidates;
    usable.sort((a, b) => a.widthM - b.widthM);
    const usedPorts = new Set<number>();
    const usedStbds = new Set<number>();
    const centres: Array<{ lat: number; lon: number; originM: number }> = [];
    const acceptedPairs: Array<{ port: LatLon; stbd: LatLon }> = [];
    for (const c of usable) {
        if (usedPorts.has(c.portIdx) || usedStbds.has(c.stbdIdx)) continue;
        usedPorts.add(c.portIdx);
        usedStbds.add(c.stbdIdx);
        centres.push({ lat: c.lat, lon: c.lon, originM: c.endpointM });
        acceptedPairs.push({
            port: { lat: marks[c.portIdx].lat, lon: marks[c.portIdx].lon },
            stbd: { lat: marks[c.stbdIdx].lat, lon: marks[c.stbdIdx].lon },
        });
    }
    onPairs?.(acceptedPairs);
    if (centres.length < 2) return [];

    centres.sort((a, b) => a.originM - b.originM);
    const tracks: EgressTrack[] = [];
    let run: Array<{ lat: number; lon: number }> = [];
    const flush = (): void => {
        if (run.length >= 2) tracks.push({ pts: run.map((p) => ({ lat: p.lat, lon: p.lon })), tier2FromIndex: 1 });
        run = [];
    };
    for (const c of centres) {
        const last = run[run.length - 1];
        if (last && llDistM(last, c) > MAX_GATE_STEP_M) flush();
        run.push(c);
    }
    flush();
    return tracks;
}

export function turnDegLL(a: LatLon, b: LatLon, c: LatLon): number {
    const mPerLon = mPerDegLon(b.lat);
    const ux = (b.lon - a.lon) * mPerLon;
    const uy = (b.lat - a.lat) * M_PER_DEG_LAT;
    const vx = (c.lon - b.lon) * mPerLon;
    const vy = (c.lat - b.lat) * M_PER_DEG_LAT;
    const lu = Math.hypot(ux, uy);
    const lv = Math.hypot(vx, vy);
    if (lu < 1 || lv < 1) return 0;
    const cos = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv)));
    return (Math.acos(cos) * 180) / Math.PI;
}

export function trimInitialEgressSnap(path: LatLon[], grid: NavGrid): LatLon[] {
    const out = path.slice();
    while (
        out.length > 3 &&
        llDistM(out[0], out[1]) < 150 &&
        turnDegLL(out[0], out[1], out[2]) > 120 &&
        !lineCrossesHardLand(grid, out[0], out[2])
    ) {
        out.splice(1, 1);
    }
    return out;
}

export function tuplePathLengthM(pts: readonly (readonly [number, number])[]): number {
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += haversineM(pts[i - 1][1], pts[i - 1][0], pts[i][1], pts[i][0]);
    return len;
}

export function lineCrossesHardLand(grid: NavGrid, a: LatLon, b: LatLon, stepM = 25): boolean {
    const lenM = llDistM(a, b);
    const steps = Math.max(1, Math.ceil(lenM / stepM));
    for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const lat = a.lat + (b.lat - a.lat) * t;
        const lon = a.lon + (b.lon - a.lon) * t;
        const { x, y } = latLonToGrid(grid, lat, lon);
        if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) continue;
        const idx = y * grid.width + x;
        if (grid.landBlocked ? grid.landBlocked[idx] === 1 : Number.isNaN(grid.cells[idx])) return true;
    }
    return false;
}

export function tupleDistM(a: readonly [number, number], b: readonly [number, number]): number {
    return haversineM(a[1], a[0], b[1], b[0]);
}

export function tupleLineCrossesHardLand(
    grid: NavGrid,
    a: readonly [number, number],
    b: readonly [number, number],
    stepM = 25,
): boolean {
    return lineCrossesHardLand(grid, { lat: a[1], lon: a[0] }, { lat: b[1], lon: b[0] }, stepM);
}

export function pruneBridgeEndpointGridCenters(grid: NavGrid, bridge: readonly [number, number][]): [number, number][] {
    const out: [number, number][] = [];
    for (const p of bridge) {
        const last = out[out.length - 1];
        if (last && tupleDistM(last, p) < 1) continue;
        out.push([p[0], p[1]]);
    }
    if (out.length < 3) return out;

    const cellM = grid.dLat * M_PER_DEG_LAT;
    const endpointCellCenterM = Math.max(75, cellM * 1.8);
    const stepM = Math.max(10, cellM / 3);
    if (
        out.length >= 3 &&
        tupleDistM(out[0], out[1]) <= endpointCellCenterM &&
        !tupleLineCrossesHardLand(grid, out[0], out[2], stepM)
    ) {
        out.splice(1, 1);
    }
    if (out.length >= 3) {
        const i = out.length - 2;
        if (
            tupleDistM(out[i], out[i + 1]) <= endpointCellCenterM &&
            !tupleLineCrossesHardLand(grid, out[i - 1], out[i + 1], stepM)
        ) {
            out.splice(i, 1);
        }
    }
    return out;
}

export function gridBridgePolyline(grid: NavGrid, from: LatLon, to: LatLon): [number, number][] | null {
    const start = snapToNavigable(grid, from.lat, from.lon, 8);
    const end = snapToNavigable(grid, to.lat, to.lon, 8);
    if (!start || !end) return null;
    const path = aStar(grid, start, end);
    if (!path || path.length < 2) return null;
    const smoothed = smoothPath(grid, path);
    const out: [number, number][] = [[from.lon, from.lat]];
    for (const c of smoothed) {
        out.push([grid.minLon + (c.x + 0.5) * grid.dLon, grid.minLat + (c.y + 0.5) * grid.dLat]);
    }
    out.push([to.lon, to.lat]);
    return pruneBridgeEndpointGridCenters(grid, out);
}

export function spliceCanalEgressChannel(
    polyline: [number, number][],
    egressTracks: readonly EgressTrack[],
    canalLines: readonly (readonly (readonly [number, number])[])[],
    grid: NavGrid,
): { polyline: [number, number][]; spliced: boolean; gates: number; forceTier2?: boolean[] } {
    const forward = spliceCanalEgressChannelFromOrigin(polyline, egressTracks, canalLines, grid);
    if (forward.spliced) return forward;

    // The same tier contract applies when Newport is the arrival end: bay/inshore
    // tier-3 hands to tier-2 through the marked gates, then tier-1 runs dead-centre
    // through the canal/marina. Reuse the origin-side splice on reversed geometry
    // and flip the vertex masks back into caller order.
    const reversed = [...polyline].reverse().map((p) => [p[0], p[1]] as [number, number]);
    const backward = spliceCanalEgressChannelFromOrigin(reversed, egressTracks, canalLines, grid);
    if (!backward.spliced) return forward;
    return {
        polyline: [...backward.polyline].reverse().map((p) => [p[0], p[1]] as [number, number]),
        spliced: true,
        gates: backward.gates,
        forceTier2: backward.forceTier2 ? [...backward.forceTier2].reverse() : undefined,
    };
}

export function spliceCanalEgressChannelFromOrigin(
    polyline: [number, number][],
    egressTracks: readonly EgressTrack[],
    canalLines: readonly (readonly (readonly [number, number])[])[],
    grid: NavGrid,
): { polyline: [number, number][]; spliced: boolean; gates: number; forceTier2?: boolean[] } {
    if (polyline.length < 3 || egressTracks.length === 0 || canalLines.length === 0) {
        return { polyline, spliced: false, gates: 0 };
    }

    const origin: LatLon = { lat: polyline[0][1], lon: polyline[0][0] };
    const dest: LatLon = { lat: polyline[polyline.length - 1][1], lon: polyline[polyline.length - 1][0] };
    const ORIGIN_ON_CANAL_M = 500;
    if (pointToTupleLinesM(origin, canalLines) > ORIGIN_ON_CANAL_M) {
        return { polyline, spliced: false, gates: 0 };
    }

    const CHAIN_NEAR_EXISTING_ROUTE_M = 900;
    const MAX_CANAL_APPROACH_M = 3500;
    const MAX_EGRESS_DETOUR_RATIO = 3.5;

    let best: {
        polyline: [number, number][];
        forceTier2: boolean[];
        gates: number;
        costM: number;
        preferred: boolean;
    } | null = null;
    const originalTotalM = tuplePathLengthM(polyline);

    for (const chain of egressTracks) {
        if (chain.pts.length < 2) continue;
        const reverseOptions = chain.tier2FromIndex === undefined ? [false, true] : [false];
        for (const reverse of reverseOptions) {
            const pts = reverse ? chain.pts.slice().reverse() : chain.pts.slice();
            const inner = pts[0];
            const outer = pts[pts.length - 1];
            if (pointToTuplePolylineM(inner, polyline) > CHAIN_NEAR_EXISTING_ROUTE_M) continue;

            const rawCanalPath = followCanalLines(origin, inner, canalLines, {
                entrySnapMaxM: ORIGIN_ON_CANAL_M,
                exitSnapMaxM: chain.tier2FromIndex === undefined ? undefined : 180,
            });
            if (!rawCanalPath) continue;
            const canalPath = trimInitialEgressSnap(rawCanalPath, grid);
            const canalM = llPathLengthM(canalPath);
            if (canalM > MAX_CANAL_APPROACH_M) continue;

            const chainM = llPathLengthM(pts);
            const bridge = gridBridgePolyline(grid, outer, dest);
            if (!bridge) continue;

            const bridgeM = tuplePathLengthM(bridge);
            const forcedTotalM = canalM + chainM + bridgeM;
            if (forcedTotalM > originalTotalM * MAX_EGRESS_DETOUR_RATIO) continue;

            const out: [number, number][] = [];
            const forceTier2: boolean[] = [];
            const push = (p: [number, number], force = false): void => {
                const last = out[out.length - 1];
                if (last && haversineM(last[1], last[0], p[1], p[0]) < 1) {
                    if (force) forceTier2[forceTier2.length - 1] = true;
                    return;
                }
                out.push(p);
                forceTier2.push(force);
            };
            for (const p of canalPath) push([p.lon, p.lat]);
            const tier2FromIndex = chain.tier2FromIndex ?? 0;
            for (let i = 0; i < pts.length; i++) push([pts[i].lon, pts[i].lat], i >= tier2FromIndex);
            for (let i = 1; i < bridge.length; i++) push([bridge[i][0], bridge[i][1]]);

            const candidate = {
                polyline: out,
                forceTier2,
                gates: pts.length,
                costM: forcedTotalM,
                preferred: chain.tier2FromIndex !== undefined,
            };
            if (
                !best ||
                (candidate.preferred && !best.preferred) ||
                (candidate.preferred === best.preferred && candidate.costM < best.costM)
            ) {
                best = candidate;
            }
        }
    }

    return best
        ? { polyline: best.polyline, spliced: true, gates: best.gates, forceTier2: best.forceTier2 }
        : { polyline, spliced: false, gates: 0 };
}

/**
 * Pull the canal RED off the OSM canal line onto the ENC channel medial axis.
 *
 * The canal red is snapped to the OSM canal centre-lines (frame 0 m), but the
 * chart the user sees renders the ENC channel, which sits ~8–10 m to one side
 * (the OSM↔ENC frames differ). So the red looks like it hugs a wall. The coarse
 * 50 m grid can't fix a sub-cell offset, so re-centre against the raw LNDARE
 * polygons directly: for each red vertex march perpendicular to travel until
 * land on BOTH sides, and move to the midpoint.
 *
 * SAFE BY CONSTRUCTION:
 *  - Acts ONLY on red (`redVtx`) and NEVER on yellow (`yellowVtx`) — gates untouched.
 *  - Requires HARD LAND on BOTH sides within MAX_HALF_M, so the open marina basin /
 *    bay (one-sided or unbounded) is left exactly as the OSM snap placed it.
 *  - A red-run endpoint that abuts a YELLOW gate is pinned to its original spot,
 *    so the canal→channel handoff has no dogleg (the yellow never moves).
 */
export function recentreCanalRedOnEnc(
    poly: readonly (readonly [number, number])[],
    redVtx: readonly boolean[],
    yellowVtx: readonly boolean[],
    lndare: ReadonlyArray<{ geom: Polygon | MultiPolygon; bbox: [number, number, number, number] }>,
    chains: ReadonlyArray<{ pts: ReadonlyArray<{ lat: number; lon: number }> }> = [],
): { polyline: [number, number][]; redMask: boolean[] } {
    const fallback = {
        polyline: poly.map((p) => [p[0], p[1]] as [number, number]),
        redMask: redVtx.map((r, i) => r && !yellowVtx[i]),
    };
    if (lndare.length === 0 && chains.length === 0) return fallback;
    const STEP_M = 3;
    const MAX_HALF_M = 90; // LNDARE walls: wider ⇒ open basin/bay, leave it alone
    const CHAIN_SNAP_M = 110; // buoy-chain snap reach (Shane: the marks run down the channel middle)
    const DENSIFY_M = 12; // dense enough to ride the channel's curve, not just the vertices
    const SIMPLIFY_DEG = 2.5 / 110_000; // ≈2.5 m — collapse the densify scaffold post-centre
    const inLand = (lon: number, lat: number): boolean => {
        for (const f of lndare) {
            if (lon < f.bbox[0] || lon > f.bbox[2] || lat < f.bbox[1] || lat > f.bbox[3]) continue;
            if (pointInGeometry(lon, lat, f.geom)) return true;
        }
        return false;
    };
    // Nearest point on any buoy-chain centre-line within CHAIN_SNAP_M. The lateral
    // marks are charted DOWN THE MIDDLE of the channel, so the chain IS the centre —
    // and the YELLOW already rides it, so snapping the RED here aligns the two.
    const nearestOnChains = (lon: number, lat: number): [number, number] | null => {
        const mLon = mPerDegLon(lat);
        let best: [number, number] | null = null;
        let bestD = CHAIN_SNAP_M;
        for (const ch of chains) {
            for (let k = 0; k + 1 < ch.pts.length; k++) {
                const ax = (ch.pts[k].lon - lon) * mLon;
                const ay = (ch.pts[k].lat - lat) * M_PER_DEG_LAT;
                const bx = (ch.pts[k + 1].lon - lon) * mLon;
                const by = (ch.pts[k + 1].lat - lat) * M_PER_DEG_LAT;
                const dx = bx - ax;
                const dy = by - ay;
                const l2 = dx * dx + dy * dy;
                const t = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2));
                const px = ax + t * dx;
                const py = ay + t * dy;
                const d = Math.hypot(px, py);
                if (d < bestD) {
                    bestD = d;
                    best = [lon + px / mLon, lat + py / M_PER_DEG_LAT];
                }
            }
        }
        return best;
    };
    // Centre one point: snap to the buoy chain (channel centre where marks exist), else
    // march to LNDARE land walls — "find the walls, divide by two" — for the marina canals.
    const centre = (lon: number, lat: number, dx: number, dy: number): [number, number] => {
        // 1. Buoy-chain snap — authoritative channel centre (marks down the middle).
        if (chains.length > 0) {
            const snapped = nearestOnChains(lon, lat);
            if (snapped) return snapped;
        }
        // 2. LNDARE land walls — the charted marina-canal banks.
        const dl = Math.hypot(dx, dy);
        if (dl < 1e-9 || lndare.length === 0) return [lon, lat];
        const mLon = mPerDegLon(lat);
        const pLonPerM = -(dy / dl) / mLon;
        const pLatPerM = dx / dl / M_PER_DEG_LAT;
        const dist = (sign: number): number => {
            for (let s = STEP_M; s <= MAX_HALF_M; s += STEP_M) {
                if (inLand(lon + pLonPerM * s * sign, lat + pLatPerM * s * sign)) return s;
            }
            return Infinity;
        };
        const a = dist(1);
        const b = dist(-1);
        if (!Number.isFinite(a) || !Number.isFinite(b)) return [lon, lat]; // not two-walled
        const shiftM = (a - b) / 2;
        return [lon + pLonPerM * shiftM, lat + pLatPerM * shiftM];
    };
    const outP: [number, number][] = [];
    const outRed: boolean[] = [];
    let i = 0;
    while (i < poly.length) {
        if (!redVtx[i] || yellowVtx[i]) {
            outP.push([poly[i][0], poly[i][1]]);
            outRed.push(false);
            i++;
            continue;
        }
        // Contiguous canal-red run [i..j].
        let j = i;
        while (j + 1 < poly.length && redVtx[j + 1] && !yellowVtx[j + 1]) j++;
        const run = poly.slice(i, j + 1).map((p) => [p[0], p[1]] as [number, number]);
        // Densify so re-centring follows the channel curve, not just the sparse vertices.
        const dense: [number, number][] = [run[0]];
        for (let k = 0; k + 1 < run.length; k++) {
            const segM = haversineM(run[k][1], run[k][0], run[k + 1][1], run[k + 1][0]);
            const n = Math.max(1, Math.round(segM / DENSIFY_M));
            for (let s = 1; s <= n; s++) {
                const t = s / n;
                dense.push([run[k][0] + (run[k + 1][0] - run[k][0]) * t, run[k][1] + (run[k + 1][1] - run[k][1]) * t]);
            }
        }
        const cen = dense.map((p, k) => {
            const prev = dense[Math.max(0, k - 1)];
            const next = dense[Math.min(dense.length - 1, k + 1)];
            const mLon = mPerDegLon(p[1]);
            return centre(p[0], p[1], (next[0] - prev[0]) * mLon, (next[1] - prev[1]) * M_PER_DEG_LAT);
        });
        // Smooth out per-point march/finegrid jitter (endpoints pinned so the seam to the
        // marina/gates stays put). A red run that feeds INTO a marker gate (Shane: "the
        // line from the canal bend to the first marker pair") is the channel APPROACH: it
        // has no marks until the gate, so the finegrid traces the NOISY satellite-water
        // medial axis ~±20 m off-centre. Smooth it HARDER (iterated low-pass) so it sheds
        // the wiggle while still FOLLOWING the channel's curve — the channel is NOT straight,
        // so we must NOT straight-chord it. Marina-canal runs (no gate) get the light pass.
        const abutsGate = (i > 0 && yellowVtx[i - 1]) || (j + 1 < poly.length && yellowVtx[j + 1]);
        const smoothIters = abutsGate ? 6 : 1;
        let sm = cen.map((c) => [c[0], c[1]] as [number, number]);
        for (let it = 0; it < smoothIters; it++) {
            sm = sm.map((c, k) =>
                k === 0 || k === sm.length - 1
                    ? c
                    : [(sm[k - 1][0] + c[0] + sm[k + 1][0]) / 3, (sm[k - 1][1] + c[1] + sm[k + 1][1]) / 3],
            );
        }
        // Drop the densify scaffolding: DP-collapse near-collinear points (tight tol, so the
        // smoothed CURVE survives) to keep the vertex count from inflating per-vertex metrics.
        const simplified = sm.length > 2 ? douglasPeucker(sm, SIMPLIFY_DEG) : sm;
        // KICK FIX: a run endpoint that abuts a YELLOW gate is pinned to its original
        // position, so the canal-red → channel-yellow handoff has no dogleg (the
        // yellow never moves, so the red must meet it exactly where it did before).
        if (simplified.length > 0) {
            if (i > 0 && yellowVtx[i - 1]) simplified[0] = [run[0][0], run[0][1]];
            if (j + 1 < poly.length && yellowVtx[j + 1])
                simplified[simplified.length - 1] = [run[run.length - 1][0], run[run.length - 1][1]];
        }
        for (const p of simplified) {
            outP.push(p);
            outRed.push(true);
        }
        i = j + 1;
    }
    return { polyline: outP, redMask: outRed };
}

const SEAM_RECTRC_CORRIDOR_M = 200; // pull a tier-2/3 channel seam onto the RECTRC if within this
const RECTRC_ALIGN_MAX_DEG = 45; // route-vs-track alignment gate — a crossing/parallel-channel track can't grab the route
const SEAM_SNAP_MAX_TURN_DEG = 100; // reject a seam move that folds the route back on itself

/** Bearing (deg, metre-scaled equirectangular) from tuple a to tuple b ([lon,lat]). */
function tupleBearingDeg(a: readonly [number, number], b: readonly [number, number]): number {
    const mLon = mPerDegLon((a[1] + b[1]) / 2);
    return (Math.atan2((b[0] - a[0]) * mLon, (b[1] - a[1]) * M_PER_DEG_LAT) * 180) / Math.PI;
}

/** Angular difference of two LINE directions (mod 180 — a track is valid sailed either way). */
function lineAngleDiffDeg(aDeg: number, bDeg: number): number {
    const d = Math.abs((((aDeg - bDeg) % 180) + 180) % 180);
    return Math.min(d, 180 - d);
}

/** Full-circle angular difference (for the seam turn/kink check). */
function headingDiffDeg(aDeg: number, bDeg: number): number {
    const d = Math.abs((((aDeg - bDeg) % 360) + 360) % 360);
    return Math.min(d, 360 - d);
}

/** Grid cell value at [lon,lat] — NaN = land, <0 = below keel margin, null = off-grid. */
function gridCellAt(grid: NavGrid, p: readonly [number, number]): number | null {
    const { x, y } = latLonToGrid(grid, p[1], p[0]);
    if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return null;
    return grid.cells[y * grid.width + x];
}

/**
 * Nearest point on any recommended-track line to (lat,lon) within maxM — else null. Returns [lon,lat].
 * When routeBearingDeg is given, only track segments running WITH the route (mod 180, ≤ RECTRC_ALIGN_MAX_DEG)
 * are candidates — the guard snapToLeadingLines gets from maxAngleDeg, kept here so a charted track the
 * route merely CROSSES (or a parallel channel's track) can never grab a vertex sideways.
 */
function nearestOnLeadingLines(
    lat: number,
    lon: number,
    lines: ReadonlyArray<{ pts: ReadonlyArray<{ lat: number; lon: number }> }>,
    maxM: number,
    routeBearingDeg: number | null = null,
): [number, number] | null {
    const mLon = mPerDegLon(lat);
    let best: [number, number] | null = null;
    let bestD = maxM;
    for (const line of lines) {
        const pts = line.pts;
        for (let k = 0; k + 1 < pts.length; k++) {
            const ax = (pts[k].lon - lon) * mLon;
            const ay = (pts[k].lat - lat) * M_PER_DEG_LAT;
            const bx = (pts[k + 1].lon - lon) * mLon;
            const by = (pts[k + 1].lat - lat) * M_PER_DEG_LAT;
            const dx = bx - ax;
            const dy = by - ay;
            if (routeBearingDeg !== null) {
                const segBrg = (Math.atan2(dx, dy) * 180) / Math.PI;
                if (lineAngleDiffDeg(segBrg, routeBearingDeg) > RECTRC_ALIGN_MAX_DEG) continue;
            }
            const l2 = dx * dx + dy * dy;
            const t = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2));
            const px = ax + t * dx;
            const py = ay + t * dy;
            const d = Math.hypot(px, py);
            if (d < bestD) {
                bestD = d;
                best = [lon + px / mLon, lat + py / M_PER_DEG_LAT];
            }
        }
    }
    return best;
}

/**
 * Four-tier contract path — segment the REAL A*
 * route into ordered tier spans, route each by tier, glue with the concat-only
 * Gluer. Tier-1/2 spans re-home onto the canal/channel followers WITHOUT the
 * silent-passthrough skip that left Newport stepped; tier-3/4 spans keep the
 * proven A* geometry. Returns the final geometry, or null on ANY refusal
 * (segmentation / a tier / a seam double-back) so the caller falls back to the
 * monolith splice — the live route can never get WORSE than today.
 *
 * Caution is NOT returned here: the caller recomputes it in-scope with the
 * strict-uncharted rule (isUnvouchedIdx), so red rendering matches the monolith.
 */
export function applyThreeTier(
    polyline: [number, number][],
    grid: NavGrid,
    layers: InshoreLayers,
    draftM: number,
    safetyM: number,
    obstructionBufferM: number,
    relaxedLndare: boolean,
    relaxZones: RelaxZone[],
): {
    polyline: [number, number][];
    provenance: string;
    spanCount: number;
    canalMask: boolean[];
    channelMask: boolean[];
    tier4Mask: boolean[];
    offshoreMask: boolean[];
} | null {
    if (polyline.length < 2) return null;

    const markFeatures = [...(layers.BOYLAT?.features ?? []), ...(layers.BCNLAT?.features ?? [])];
    const marks = parseLateralMarks(markFeatures as Parameters<typeof parseLateralMarks>[0]);
    // The marina mouth (Newport) has NO tessellated SENC laterals — its only channel
    // "marks" are OSM pair-inferred channel midpoints pushed into BOYLAT, which carry no
    // CATLAM/OBJNAM so parseLateralMarks drops them. They DO set grid.preferred, leaving the
    // exit channel channelWater=true with ZERO parsed marks → permanently tier-1 RED. Feed
    // them (channel-centre points; side irrelevant for a distance test) into a proximity-only
    // list that segmentRoute's nearMark sees, WITHOUT polluting `marks` — the tier-1/2
    // gate-followers need real SIDED marks, so they keep `marks` clean.
    const midpointMarks = (layers.BOYLAT?.features ?? [])
        .filter((f) => f.properties?._class === 'channel_midpoint' && f.geometry?.type === 'Point')
        .map((f) => {
            const [lon, lat] = (f.geometry as { coordinates: number[] }).coordinates;
            return { lat, lon, side: 'port' as const, key: '_mp', seq: 0, name: 'midpoint' };
        });
    const segMarks = midpointMarks.length ? [...marks, ...midpointMarks] : marks;
    // CHANNEL-MIDPOINT CHAINS → ordered centrelines for tier-2. The same OSM
    // pair-inferred midpoints carry _chainId + _chainOrder; group by chain, sort by
    // order ⇒ one LeadingLine per buoyed channel = Shane's "7-5-3-1" spine. Tier-2
    // snaps onto these FIRST (a buoyed chain IS the channel), bypassing the fragile
    // gate-pairing AND the land veto — no cross-pair, no body-land. Tier-3 untouched.
    const chainGroups = new Map<number, { order: number; lon: number; lat: number }[]>();
    for (const f of layers.BOYLAT?.features ?? []) {
        const cp = f.properties as { _class?: string; _chainId?: number; _chainOrder?: number } | null;
        if (cp?._class !== 'channel_midpoint' || f.geometry?.type !== 'Point') continue;
        if (typeof cp._chainId !== 'number' || typeof cp._chainOrder !== 'number') continue;
        const [lon, lat] = (f.geometry as { coordinates: number[] }).coordinates;
        const g = chainGroups.get(cp._chainId);
        if (g) g.push({ order: cp._chainOrder, lon, lat });
        else chainGroups.set(cp._chainId, [{ order: cp._chainOrder, lon, lat }]);
    }
    const channelChains: LeadingLine[] = [];
    const singletonChainPts: { lat: number; lon: number }[] = [];
    for (const g of chainGroups.values()) {
        if (g.length < 2) {
            // 1-gate cluster (isolated gate pair). Collect; handle below.
            singletonChainPts.push({ lat: g[0].lat, lon: g[0].lon });
            continue;
        }
        g.sort((a, b) => a.order - b.order);
        channelChains.push({ pts: g.map((p) => ({ lat: p.lat, lon: p.lon })) });
    }
    // ── SINGLETON STEP 1: attach to nearest multi-point chain endpoint ──
    // The outermost Newport exit gate is in its own 1-gate cluster (spatially
    // separate from the inner gates). If a multi-point chain ends within 800 m,
    // it is an extension — append or prepend so the snap threads the outer gate.
    const SINGLETON_ATTACH_M = 800;
    const unattachedSingles: { lat: number; lon: number }[] = [];
    for (const sp of singletonChainPts) {
        let bestChain: LeadingLine | null = null;
        let bestDist = SINGLETON_ATTACH_M;
        let appendToEnd = true;
        for (const chain of channelChains) {
            const pts = chain.pts;
            const dEnd = llDistM(pts[pts.length - 1], sp);
            const dStart = llDistM(pts[0], sp);
            const d = Math.min(dEnd, dStart);
            if (d < bestDist) {
                bestDist = d;
                bestChain = chain;
                appendToEnd = dEnd <= dStart;
            }
        }
        if (bestChain) {
            if (appendToEnd) bestChain.pts.push(sp);
            else bestChain.pts.unshift(sp);
        } else {
            unattachedSingles.push(sp);
        }
    }
    // ── SINGLETON STEP 2: synthesise chain when all gates are isolated ──
    // Newport: every gate pair can end up in its own 1-gate cluster (no multi-
    // point chain to attach to). Sort all unattached singletons by proximity
    // along the A* polyline → the natural inner→outer order → a synthesised
    // LeadingLine that snapToLeadingLines can snap onto, centering the route
    // through EVERY gate in sequence.
    if (unattachedSingles.length >= 2) {
        const SYNTH_NEAR_ROUTE_M = 500;
        const sorted = unattachedSingles
            .map((sp) => {
                let minD = Infinity;
                let bestIdx = 0;
                for (let i = 0; i < polyline.length; i++) {
                    const d = haversineM(sp.lat, sp.lon, polyline[i][1], polyline[i][0]);
                    if (d < minD) {
                        minD = d;
                        bestIdx = i;
                    }
                }
                return { sp, bestIdx, minD };
            })
            .filter((s) => s.minD < SYNTH_NEAR_ROUTE_M)
            .sort((a, b) => a.bestIdx - b.bestIdx);
        if (sorted.length >= 2) {
            channelChains.push({ pts: sorted.map((s) => s.sp) });
        }
    }
    engineLog.warn(
        `[chain] chains=${channelChains.length}(pts=${channelChains.map((c) => c.pts.length).join(',')}) sing=${singletonChainPts.length} unatt=${unattachedSingles.length}`,
    );
    const leadingLines = parseLeadingLines((layers.NAVLINE?.features ?? []) as Parameters<typeof parseLeadingLines>[0]);
    // OSM canal centre-lines (layers.CANAL) — the dead-centre route through a canal
    // estate, drawn down the middle of every canal. tier-1 follows these FIRST.
    const canalLines = parseCanalLines((layers.CANAL?.features ?? []) as Parameters<typeof parseCanalLines>[0]);

    // ── RECTRC: snap onto the OFFICIAL recommended track FIRST ──
    // Where the chart carries a hydrographer-drawn recommended track, that IS
    // the route — snap onto it before deriving anything from buoys (authoritative
    // > derived). landBlocked-only veto: a RECTRC is a charted safe route, so a
    // narrow-channel cell the coarse grid calls NaN must not block it.
    let route = polyline;
    let rectrcSnapped = 0;
    const rectrcLines = parseLeadingLines((layers.RECTRC?.features ?? []) as Parameters<typeof parseLeadingLines>[0]);
    if (rectrcLines.length > 0) {
        const landOnly = (p: { lat: number; lon: number }): boolean => {
            const { x, y } = latLonToGrid(grid, p.lat, p.lon);
            if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return false;
            return grid.landBlocked ? grid.landBlocked[y * grid.width + x] === 1 : false;
        };
        const snapped = snapToLeadingLines(
            route.map(([lon, lat]) => ({ lat, lon })),
            route.map(() => false),
            rectrcLines,
            // followInteriorVertices: a RECTRC bends with the river — follow its curve instead of
            // chording across it (which cut the inside of every bend and hugged the bank).
            { corridorM: 300, minRunM: 80, maxAngleDeg: 45, isBlocked: landOnly, followInteriorVertices: true },
        );
        if (snapped.snapped > 0) {
            route = snapped.polyline.map((p) => [p.lon, p.lat] as [number, number]);
            rectrcSnapped = snapped.snapped;
        }
    }

    let gatePairs: ReadonlyArray<{ port: LatLon; stbd: LatLon }> = [];
    const gateCentreTracks = buildGateCentreTracks(marks, route, [...leadingLines, ...rectrcLines], (p) => {
        gatePairs = p;
    });
    const egressTracks: EgressTrack[] = [...gateCentreTracks, ...channelChains, ...leadingLines, ...rectrcLines];
    const canalEgress = spliceCanalEgressChannel(route, egressTracks, canalLines, grid);
    if (canalEgress.spliced) {
        route = canalEgress.polyline;
    }

    // refuseUnchartedRunM: null — the engine's strict-uncharted sweep below owns
    // the refuse-on-no-evidence decision; segmentRoute must NOT unilaterally
    // refuse (a relaxed berth-start crosses unvouched water) or the whole path
    // silently falls back to the monolith. Unknown runs ride as caution spans.
    const spans = segmentRoute(route, grid, segMarks, draftM, safetyM, TIER_TIDE_SAFETY_M, {
        refuseUnchartedRunM: null,
        forceTier2: canalEgress.forceTier2,
    });
    if (isRefusal(spans)) {
        if (ENGINE_DEBUG) engineLog.warn(`[3tier] FALLBACK — segmentRoute refused (${spans.reason})`);
        return null;
    }
    // A degenerate span would starve a tier router — bail to the proven path.
    if (spans.some((s) => s.toIdx - s.fromIdx < 1)) {
        if (ENGINE_DEBUG) engineLog.warn(`[3tier] FALLBACK — degenerate span`);
        return null;
    }

    // Inject a fine-grid builder so a narrow canal span no buoyed-channel
    // refiner resolves is re-routed on a SEPARATE ~12 m grid (the corner-clip
    // cure) instead of emitting the coarse A* slice that clips the bend. The
    // closure captures buildNavGridCached (same builder, tiny crop, same
    // draft/safety/buffer as the coarse grid) so tier3 never imports the engine.
    // Any build failure returns null → the span keeps its coarse A* slice, so
    // the fine pass can only IMPROVE a canal leg, never disconnect a route.
    const buildFineGrid = (
        fineBbox: readonly [number, number, number, number],
        fineResolutionM: number,
    ): NavGrid | null => {
        try {
            return buildNavGridCached(
                layers,
                [fineBbox[0], fineBbox[1], fineBbox[2], fineBbox[3]],
                fineResolutionM,
                draftM,
                safetyM,
                obstructionBufferM,
                // Match the COARSE route's relax state. Newport's berth is
                // islanded, so the rendered route is the localized-relaxed retry;
                // building the fine grid strict made it see the relaxed-LNDARE
                // stretch as land (the persistent barrier/1189m). Same relax ⇒ the
                // fine grid agrees with the route it's refining.
                relaxedLndare,
                relaxZones,
            ).grid;
        } catch {
            return null;
        }
    };
    const ctx3: Tier3Context = { grid, marks, leadingLines, recommendedTracks: rectrcLines, buildFineGrid };
    const ctx4: Tier4Context = {
        grid,
        recommendedTracks: rectrcLines,
        marks,
        channelChains,
        egressTracks,
        egressMask: canalEgress.forceTier2,
        preferChannelChains: canalEgress.spliced,
    };
    // Pull each tier-2↔tier-3 SEAM — the shared boundary vertex where the bay (tier-3) leg hands off
    // to the marked-channel (tier-2) leg — onto the RECTRC. The seam sits on the raw A* route, which
    // hugs the bank at a river entrance, so the route kinks to the wall right where teal meets yellow
    // even though the channel leg itself rides centre (Shane's Pinkenba seam). Snapping the shared
    // node onto the recommended track lands BOTH adjacent legs' seam segments on the channel centre.
    let routedSpans = spans;
    if (rectrcLines.length > 0 && spans.length > 1) {
        const seamAt = new Map<number, [number, number]>(); // shared seam idx → RECTRC point [lon,lat]
        for (let i = 0; i + 1 < spans.length; i++) {
            const a = spans[i];
            const b = spans[i + 1];
            // Any boundary in the channel/inshore region (both sides tier-2 or tier-3) — this covers
            // the string of SHORT tier-3 legs the channel breaks into at a river bend, whose
            // tier-3↔tier-3 seams also sit on the wall between the yellow legs.
            const channelSeam = (a.tier === 2 || a.tier === 3) && (b.tier === 2 || b.tier === 3);
            if (!channelSeam) continue;
            const prev = route[Math.max(a.toIdx - 1, 0)];
            const next = route[Math.min(a.toIdx + 1, route.length - 1)];
            // The seam may only move ALONG its own channel (route-aligned track segment), onto
            // navigable water, and the two seam-adjacent segments it creates must be land-clean
            // and not fold the route back on itself. Any failure keeps the raw A* seam.
            const snapped = nearestOnLeadingLines(
                a.exit.at[1],
                a.exit.at[0],
                rectrcLines,
                SEAM_RECTRC_CORRIDOR_M,
                tupleBearingDeg(prev, next),
            );
            if (!snapped) continue;
            const c = gridCellAt(grid, snapped);
            if (c !== null && (Number.isNaN(c) || c < 0)) continue; // land / below keel margin
            if (tupleLineCrossesHardLand(grid, prev, snapped, 20) || tupleLineCrossesHardLand(grid, snapped, next, 20))
                continue;
            if (headingDiffDeg(tupleBearingDeg(prev, snapped), tupleBearingDeg(snapped, next)) > SEAM_SNAP_MAX_TURN_DEG)
                continue;
            seamAt.set(a.toIdx, snapped);
        }
        if (seamAt.size > 0) {
            const depthOrNull = (c: number | null): number | null => (c === null || Number.isNaN(c) ? null : c);
            routedSpans = spans.map((span) => {
                const e = seamAt.get(span.fromIdx);
                const x = seamAt.get(span.toIdx);
                if (!e && !x) return span;
                // A moved node gets its through-heading + depth recomputed from the MOVED geometry,
                // so the Gluer's double-back clause judges the real seam, not the pre-snap one.
                const entry = e
                    ? {
                          ...span.entry,
                          at: e,
                          headingDeg: tupleBearingDeg(e, route[Math.min(span.fromIdx + 1, route.length - 1)]),
                          depthM: depthOrNull(gridCellAt(grid, e)),
                      }
                    : span.entry;
                const exit = x
                    ? {
                          ...span.exit,
                          at: x,
                          headingDeg: tupleBearingDeg(route[Math.max(span.toIdx - 1, 0)], x),
                          depthM: depthOrNull(gridCellAt(grid, x)),
                      }
                    : span.exit;
                return { ...span, entry, exit };
            });
            engineLog.warn(`[seamSnap] tier2/3 channel seams onto RECTRC: ${seamAt.size}`);
        }
    }
    const results: LegResult[] = routedSpans.map((span) =>
        span.tier === 2
            ? routeTier4(span, route, ctx4)
            : span.tier === 1
              ? routeTier3(span, route, ctx3)
              : passthroughLeg(span, route, grid, rectrcLines),
    );
    const glued = stitchLegs(
        results,
        canalEgress.spliced
            ? {
                  allowDoubleBack: (legA, legB) => legB.tierId === 3 && legA.provenance.includes('tier2:chain'),
              }
            : undefined,
    );
    if (glued.refusal || glued.polyline.length < 2) {
        const why = glued.refusal ? `${glued.refusal.reason}@${glued.refusal.atIndex}` : `empty`;
        if (ENGINE_DEBUG) engineLog.warn(`[3tier] FALLBACK — glue refused (${why})`);
        return null;
    }
    const egressTag = canalEgress.spliced ? `egress-channel×${canalEgress.gates} → ` : '';
    const rectrcTag = `${egressTag}${rectrcSnapped > 0 ? `rectrc×${rectrcSnapped} → ` : ''}`;
    // TEMP on-device diag — confirms RECTRC snap + gate-follow engage on Shane's
    // live Newport grid. Re-gate behind ENGINE_DEBUG once confirmed.
    engineLog.warn(
        `[tiers] ENGAGED ${rectrcTag}spans=${spans.map((s) => `t${s.tier}[${s.fromIdx}-${s.toIdx}]`).join(' ')} prov="${glued.legs.map((l) => l.provenance).join(' | ')}"`,
    );

    // Per-vertex masks from the glued legs:
    //   tier 1 → canal/marina RED
    //   tier 2 → lead-out/marked channel YELLOW
    //   tier 4 → offshore DARK BLUE
    // Carry them across the canal snap by exact coordinate. Where a vertex lands
    // on both canal and channel, canal RED wins in the renderer.
    const canalPre: boolean[] = new Array(glued.polyline.length).fill(false);
    const channelPre: boolean[] = new Array(glued.polyline.length).fill(false);
    const offshorePre: boolean[] = new Array(glued.polyline.length).fill(false);
    // Vertices from a tier-1 FINE-grid leg (routeMarina medial axis) already ride the
    // dead-centre of the injected water — the middle of the open channel. The OSM
    // canal-line snap below must NOT pull them onto the OSM canal line, which in wide
    // uncharted water sits ~40-75 m off the open-water centre (OSM↔chart frame skew):
    // that was Shane's Newport "main channel" hugging the west side. Protect finegrid
    // vertices so they keep their medial axis = the middle of the open water. (Narrow
    // marina canals: medial axis ≈ the OSM line, so no visible change there.)
    const finegridPre: boolean[] = new Array(glued.polyline.length).fill(false);
    const channelSegKeys = new Set<string>();
    // TRUE lateral-pair gates only (chain / fairlead / gate-follower) — segments where the route
    // threads dead centre between a port/starboard pair. The cardinal clamp pins THESE (a buoyed
    // gate outranks a single cardinal's quadrant) but NOT a tier2 rectrc/gate-astar recommended
    // track, which a cardinal should be able to pull onto its safe side.
    const gateSegKeys = new Set<string>();
    const segKey = (a: readonly [number, number], b: readonly [number, number]): string =>
        `${a[0]}|${a[1]}→${b[0]}|${b[1]}`;
    let gi = 0;
    for (const leg of glued.legs) {
        const len = leg.polyline.length;
        if (leg.tierId === 1) for (let v = 0; v < len; v++) canalPre[gi + v] = true;
        if (leg.provenance.includes('finegrid')) for (let v = 0; v < len; v++) finegridPre[gi + v] = true;
        if (leg.tierId === 2) {
            for (let v = 0; v < len; v++) channelPre[gi + v] = true;
            for (let v = 0; v < len - 1; v++) channelSegKeys.add(segKey(leg.polyline[v], leg.polyline[v + 1]));
            if (
                leg.provenance.includes('chain') ||
                leg.provenance.includes('fairlead') ||
                leg.provenance.includes('gates')
            ) {
                for (let v = 0; v < len - 1; v++) gateSegKeys.add(segKey(leg.polyline[v], leg.polyline[v + 1]));
            }
        }
        if (leg.tierId === 4) for (let v = 0; v < len; v++) offshorePre[gi + v] = true;
        gi += len - 1;
    }
    const canalKeys = new Set<string>();
    const offshoreKeys = new Set<string>();
    for (let i = 0; i < glued.polyline.length; i++) {
        const key = `${glued.polyline[i][0]}|${glued.polyline[i][1]}`;
        if (canalPre[i]) canalKeys.add(key);
        if (offshorePre[i]) offshoreKeys.add(key);
    }

    // Canal centre-line snap — wherever the assembled route rides the OSM canal
    // lines (a wall-hug / corner-cut through a carved canal estate), replace that
    // run with the dead-centre line. Tier-agnostic: the canal lines carve the
    // estate to navigable water, so its spans can come out as inshore passthrough,
    // not a canal leg — a per-span follow would miss them. Tier-2 channel vertices
    // are protected so the canal snap cannot swallow a canal→marked-channel egress.
    // No-op off-canal (the river / open water passes through byte-identical).
    const { polyline: snappedPoly, onCanal: canalVtx } = snapRouteToCanalLines(glued.polyline, canalLines, {
        protectedVertices: channelPre.map((c, i) => c || finegridPre[i]),
    });
    const canalSnapTag = snappedPoly.length !== glued.polyline.length ? ' +canalsnap' : '';
    const outPoly = snappedPoly.map((p) => [p[0], p[1]] as [number, number]);

    const CANAL_RENDER_M = 45;
    const tier1Vtx = outPoly.map(([lon, lat], i) => {
        const onCanalLine = canalLines.length > 0 && pointToTupleLinesM({ lat, lon }, canalLines) <= CANAL_RENDER_M;
        return canalVtx[i] || canalKeys.has(`${lon}|${lat}`) || onCanalLine;
    });
    // Per-vertex YELLOW flag (an endpoint of a tier-2 marked-channel segment) — the
    // gates. Re-centring must NEVER move these, so the yellow stays exactly between
    // the marker pairs.
    const yellowVtx = outPoly.map((p, i) => {
        const a = i > 0 && channelSegKeys.has(segKey(outPoly[i - 1], p));
        const b = i + 1 < outPoly.length && channelSegKeys.has(segKey(p, outPoly[i + 1]));
        return a || b;
    });
    // Channel re-centre: pull the canal/main-channel RED onto the channel CENTRE.
    // Two references, in priority order:
    //   (1) the buoy chains (channelChains) — the lateral marks are charted down the
    //       MIDDLE of the channel, and the YELLOW already rides them, so snapping the
    //       RED onto the same chain centres it AND aligns red↔yellow (Shane's coupling);
    //   (2) LNDARE land walls — "find the banks, divide by two" — for the marina canals.
    // Yellow excluded; densify changes the polyline length, so a rebuilt red mask is returned.
    const lndare = (layers.LNDARE?.features ?? [])
        .filter((f) => f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon')
        .map((f) => {
            const geom = f.geometry as Polygon | MultiPolygon;
            return { geom, bbox: geometryBbox(geom) };
        });
    const { polyline: finalPoly, redMask: finalRed } = recentreCanalRedOnEnc(
        outPoly,
        tier1Vtx,
        yellowVtx,
        lndare,
        channelChains,
    );
    // Cardinal safe-side clamp on the fully-assembled polyline — the only layer that can enforce a
    // cardinal's safe side uniformly, because the gate/track followers (chain/rectrc/gate-astar)
    // discard the obstacle grid, so an avoidance disc can't steer them. No-op when no cardinals are
    // present (golden/repro) or the route already clears them; canal-RED + gate vertices are pinned.
    const cardinalDiscs = parseCardinalDiscs(layers.OBSTRN?.features ?? []);
    // Solo-lateral side-enforcement rides the SAME final-polyline post-process: `marks` are the
    // real chart laterals (parseLateralMarks, above). The clamp keeps only un-paired marks (a
    // port/stbd pair is a gate the chain/fairlead/egress routing already threads dead-centre) and
    // refuses a detour on a chain/fairlead gate or canal-RED vertex (gateSegKeys + the red mask) —
    // so it only ever rounds a SOLO mark the route passes on the wrong side (e.g. VQR), never a gate.
    // Each mark carries an ABSOLUTE safe vector where the direction of buoyage is derivable from
    // the IALA numbering convention (seq ascends FROM seaward, so low-seq → high-seq through the
    // mark's channel-key neighbours points harbourward). Without it the clamp falls back to the
    // travel tangent — correct inbound only, the outbound-mirror bug.
    const lateralClampMarks = marks.map((m) => {
        let safeVec: readonly [number, number] | undefined;
        const bySeq = marks.filter((o) => o.key === m.key).sort((a, b) => a.seq - b.seq);
        if (bySeq.length >= 2) {
            const i = bySeq.indexOf(m);
            const lo = bySeq[Math.max(0, i - 1)];
            const hi = bySeq[Math.min(bySeq.length - 1, i + 1)];
            const mLon = mPerDegLon(m.lat);
            let te = (hi.lon - lo.lon) * mLon;
            let tn = (hi.lat - lo.lat) * M_PER_DEG_LAT;
            const tl = Math.hypot(te, tn);
            if (tl > 1) {
                te /= tl;
                tn /= tl;
                // Running WITH buoyage: a port-hand mark's safe water is RIGHT of the
                // buoyage direction, a stbd-hand mark's is LEFT.
                safeVec = m.side === 'port' ? [tn, -te] : [-tn, te];
            }
        }
        return { lat: m.lat, lon: m.lon, side: m.side, ...(safeVec ? { safeVec } : {}) };
    });
    const {
        polyline: clampedPoly,
        redMask: clampedRed,
        movedCardinals: clampMoved,
        movedLaterals: clampMovedLat,
    } = clampRouteToCardinalSafeSide(finalPoly, finalRed, cardinalDiscs, grid, {
        gateSegKeys,
        laterals: lateralClampMarks,
    });
    const cardinalClampTag =
        (clampMoved > 0 ? ` +cardinalclamp×${clampMoved}` : '') +
        (clampMovedLat > 0 ? ` +lateralclamp×${clampMovedLat}` : '');
    const channelSeg = clampedPoly
        .slice(0, -1)
        .map((p, i) => channelSegKeys.has(segKey(p, clampedPoly[i + 1])) && !clampedRed[i] && !clampedRed[i + 1]);
    const offshoreVtx = clampedPoly.map(([lon, lat]) => offshoreKeys.has(`${lon}|${lat}`));

    // FINAL gate-discipline audit — the engine path's only whole-route cross-line check
    // (the seaway shadow measures its own candidate, never the shipped engine route).
    // The post-assembly passes (canal snap, red re-centre, cardinal clamp) mutate
    // geometry AFTER the legs threaded their gates, so the finished polyline is
    // re-checked against every accepted pair and any wrong-side pass is named in the
    // device log. Log-only: enforcement stays with the pass-level pins/rollbacks above.
    if (gatePairs.length > 0) {
        const gates = gatePairs.map(
            (g, i) => ({ id: `gate${i}`, portMark: g.port, stbdMark: g.stbd }) as unknown as GateNode,
        );
        const audit = validateAgainstCrossLines(
            clampedPoly.map(([lon, lat]) => ({ lat, lon })),
            gates,
        );
        // Always one line per route — silence on-device is ambiguous (clean vs never-ran).
        const detail = audit.ok
            ? 'CLEAN'
            : audit.violations.map((v) => `${v.gateId}:${v.side}@seg${v.segIndex}`).join(' ');
        engineLog.warn(
            `[gateAudit] gates=${audit.gatesChecked} crossed=${audit.crossings.length} wrongSidePasses=${audit.violations.length} — ${detail}`,
        );
    }

    return {
        polyline: clampedPoly,
        provenance: `${rectrcTag}${glued.legs.map((l) => l.provenance).join(' | ')}${canalSnapTag}${cardinalClampTag}`,
        spanCount: spans.length,
        // Per-vertex tier-1 flag (parallel to polyline) for canal/marina RED.
        canalMask: clampedRed,
        // Per-segment tier-2 flag for the YELLOW marked-channel.
        channelMask: channelSeg,
        // Deprecated alias for callers that still use the old marked-channel name.
        tier4Mask: channelSeg,
        // Per-vertex offshore (tier-4) flag for the DARK BLUE offshore leg.
        offshoreMask: offshoreVtx,
    };
}

/**
 * Fairlead at the grid stage — follows the lateral marks through a buoyed
 * channel, scoped to OPEN water and validated against the real navigable grid.
 *
 *  - isLand uses the GRID (blocked OR caution cell), so it catches estate land
 *    the raw LNDARE polygons miss — the gap that drew lines across the canal.
 *  - The marina exit is the first route vertex in open water (no blocked cell
 *    within ~150 m); Fairlead only acts from there on, never in the canal.
 *  - refineWithFairlead requires a genuine along-channel transit and validates
 *    the whole spliced run against isLand; any failure → route unchanged.
 */
export function applyFairleadAtGrid(
    polyline: [number, number][],
    cautionMask: boolean[],
    grid: NavGrid,
    layers: InshoreLayers,
): { polyline: [number, number][]; cautionMask: boolean[]; fairlead?: string } {
    const passthrough = { polyline, cautionMask };
    const markFeatures = [...(layers.BOYLAT?.features ?? []), ...(layers.BCNLAT?.features ?? [])];
    if (markFeatures.length < 3 || polyline.length < 2) return passthrough;
    const marks = parseLateralMarks(markFeatures as Parameters<typeof parseLateralMarks>[0]);
    if (marks.length < 3) return passthrough;

    const poly: LatLon[] = polyline.map(([lon, lat]) => ({ lat, lon }));
    const w = grid.width;
    const h = grid.height;

    const isLand = (p: LatLon): boolean => {
        const { x, y } = latLonToGrid(grid, p.lat, p.lon);
        if (x < 0 || y < 0 || x >= w || y >= h) return true;
        const d = grid.cells[y * w + x];
        return Number.isNaN(d) || d < 0;
    };

    const resM = grid.dLat * M_PER_DEG_LAT;
    const openCells = Math.max(2, Math.round(150 / Math.max(1, resM)));
    const isOpen = (p: LatLon): boolean => {
        const { x, y } = latLonToGrid(grid, p.lat, p.lon);
        for (let dy = -openCells; dy <= openCells; dy++) {
            for (let dx = -openCells; dx <= openCells; dx++) {
                if (dx * dx + dy * dy > openCells * openCells) continue;
                const nx = x + dx;
                const ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= w || ny >= h || Number.isNaN(grid.cells[ny * w + nx])) return false;
            }
        }
        return true;
    };
    let fromIdx = poly.length; // never, unless open water is found
    for (let i = 0; i < poly.length; i++) {
        if (isOpen(poly[i])) {
            fromIdx = i;
            break;
        }
    }

    const refined = refineWithFairlead(poly, marks, isLand, { fromIdx, cautionMask });
    if (!refined.replacedRange) return passthrough;

    const newPolyline: [number, number][] = refined.polyline.map((p) => [p.lon, p.lat]);
    // refineWithFairlead re-aligns the caution mask across every splice (kept
    // segments keep their flag, spliced bridges/centrelines are clean). Use it
    // when its length matches; fall back to the input mask defensively.
    const newCaution: boolean[] =
        refined.cautionMask && refined.cautionMask.length === newPolyline.length - 1
            ? refined.cautionMask
            : cautionMask;

    if (ENGINE_DEBUG)
        engineLog.warn(`fairlead: spliced "${refined.channelKey}" channel from open-water vertex ${fromIdx}`);
    return { polyline: newPolyline, cautionMask: newCaution, fairlead: refined.channelKey ?? undefined };
}

/**
 * Leading-line snap at the grid stage — snaps the route onto the charted
 * navigation_line transit it follows, so the track sits dead on the leading
 * line ("line up the marks") instead of merely near the Pass-5b corridor band.
 *
 *  - isBlocked uses the GRID (NaN / out-of-bounds) so a transit never snaps
 *    across solid land. Caution water is allowed (leading-line approaches are
 *    often shallow), and the on-line segment keeps its red HONESTLY.
 *  - Origin/destination are never moved; only the in-passage transit snaps.
 */
export function applyLeadingLineSnap(
    polyline: [number, number][],
    cautionMask: boolean[],
    grid: NavGrid,
    layers: InshoreLayers,
): { polyline: [number, number][]; cautionMask: boolean[]; leadingLines: number } {
    const passthrough = { polyline, cautionMask, leadingLines: 0 };
    const navFeatures = layers.NAVLINE?.features ?? [];
    if (navFeatures.length === 0 || polyline.length < 4) return passthrough;
    const lines = parseLeadingLines(navFeatures as Parameters<typeof parseLeadingLines>[0]);
    if (lines.length === 0) return passthrough;

    const w = grid.width;
    const h = grid.height;
    const cellAt = (p: LatLon): number => {
        const { x, y } = latLonToGrid(grid, p.lat, p.lon);
        if (x < 0 || y < 0 || x >= w || y >= h) return NaN;
        return grid.cells[y * w + x];
    };
    // LAND-only veto: a charted lead is never vetoed by a point-hazard buffer
    // (WRECKS/OBSTRN) — the lead exists to guide PAST those. Land still
    // aborts. Hazard-buffer crossings stay honest via the caution flag.
    const isBlocked = (p: LatLon): boolean => {
        const { x, y } = latLonToGrid(grid, p.lat, p.lon);
        if (x < 0 || y < 0 || x >= w || y >= h) return true;
        return grid.landBlocked ? grid.landBlocked[y * w + x] === 1 : Number.isNaN(grid.cells[y * w + x]);
    };
    const isCaution = (p: LatLon): boolean => {
        const d = cellAt(p);
        return Number.isNaN(d) || d < 0; // hazard-buffer (NaN) or shallow → red
    };

    // RECTRC wins over NAVLNE here too: a run already on the hydrographer's
    // recommended track is protected from being dragged onto a leading line.
    const recommendedTracks = parseLeadingLines(
        (layers.RECTRC?.features ?? []) as Parameters<typeof parseLeadingLines>[0],
    );

    const poly: LatLon[] = polyline.map(([lon, lat]) => ({ lat, lon }));
    const r = snapToLeadingLines(poly, cautionMask, lines, {
        isBlocked,
        isCaution,
        protect: recommendedTracks.length > 0 ? recommendedTracks : undefined,
    });
    if (r.snapped === 0) return passthrough;

    const newPolyline: [number, number][] = r.polyline.map((p) => [p.lon, p.lat]);
    if (ENGINE_DEBUG)
        engineLog.warn(`leading-line: snapped route onto ${r.snapped} charted transit(s) (line up the marks)`);
    return { polyline: newPolyline, cautionMask: r.cautionMask, leadingLines: r.snapped };
}

/**
 * Leading-line APPROACH at the grid stage — when the destination is served by
 * charted leading line(s), re-route the final approach to come in VIA the
 * transit: make the seaward mark, then steer each lead into the anchorage.
 * Proper pilotage instead of A*'s shortest-path straight-in.
 *
 *  - Diverts at the route vertex nearest the seaward anchor (the boat heads for
 *    the mark from there); leaves the route untouched if the route never comes
 *    within MAX_BRIDGE_M of the anchor — those leads don't serve this passage.
 *  - The spliced approach is validated against hard land; any crossing aborts.
 *  - Caution carried honestly per the grid (clean where Pass 5b rescued the
 *    leads, red where genuinely shallow).
 */
export function applyLeadingLineApproach(
    polyline: [number, number][],
    cautionMask: boolean[],
    grid: NavGrid,
    layers: InshoreLayers,
): { polyline: [number, number][]; cautionMask: boolean[]; leadingApproach: number } {
    const passthrough = { polyline, cautionMask, leadingApproach: 0 };
    const navFeatures = layers.NAVLINE?.features ?? [];
    if (navFeatures.length === 0 || polyline.length < 2) {
        if (ENGINE_DEBUG) engineLog.warn(`leading-line approach: SKIP — navFeatures=${navFeatures.length}`);
        return passthrough;
    }
    const lines = parseLeadingLines(navFeatures as Parameters<typeof parseLeadingLines>[0]);
    if (lines.length === 0) {
        if (ENGINE_DEBUG) engineLog.warn('leading-line approach: SKIP — no parseable lines');
        return passthrough;
    }

    const last = polyline[polyline.length - 1];
    const dest: LatLon = { lat: last[1], lon: last[0] };
    const approach = buildLeadingApproach(dest, lines);
    if (!approach) {
        if (ENGINE_DEBUG)
            engineLog.warn(
                `leading-line approach: SKIP — no serving lead within maxDestM of dest ${dest.lat.toFixed(4)},${dest.lon.toFixed(4)} (${lines.length} lines)`,
            );
        return passthrough;
    }

    const w = grid.width;
    const h = grid.height;
    const cellAt = (p: LatLon): number => {
        const { x, y } = latLonToGrid(grid, p.lat, p.lon);
        if (x < 0 || y < 0 || x >= w || y >= h) return NaN;
        return grid.cells[y * w + x];
    };
    // LAND-only veto — same rationale as the snap above: the Tangalooma
    // WRECKS' buffer cells sit ON the charted approach line, and a lead must
    // not be vetoed by the very hazard it exists to guide past. Land aborts;
    // hazard-buffer crossings render caution (isCautionOrBlocked below).
    const isBlocked = (p: LatLon): boolean => {
        const { x, y } = latLonToGrid(grid, p.lat, p.lon);
        if (x < 0 || y < 0 || x >= w || y >= h) return true;
        return grid.landBlocked ? grid.landBlocked[y * w + x] === 1 : Number.isNaN(grid.cells[y * w + x]);
    };
    const isCautionOrBlocked = (p: LatLon): boolean => {
        const d = cellAt(p);
        return Number.isNaN(d) || d < 0;
    };

    const poly: LatLon[] = polyline.map(([lon, lat]) => ({ lat, lon }));

    // Divert at the route vertex nearest the seaward anchor (never the dest
    // itself). If the route never comes within MAX_BRIDGE_M of the anchor, the
    // leads run the wrong way for this passage → leave the route alone.
    //
    // SPLICE-JUNCTION GUARD (field artefact 2026-06-13, Newport approach,
    // ROUTING_COLLAB A-23/26: a ±171° spike-and-return at idx 148-150).
    // Nearest-vertex divert had NO direction discipline: when the route's
    // tail already sits ON the lead axis between anchor and dest, the
    // splice yanked it BACKWARD to the anchor and ran forward again —
    // out, ~180° turn, back. Both splice junctions (route→anchor at the
    // divert, divert→anchor→turn at the anchor) now obey the same
    // |turn| ≤ 120° family as buildLeadingApproach's internal dog-leg
    // guard (cos > −0.5). Candidates are tried nearest-first; a route
    // already lined up past the anchor finds NO compliant divert and the
    // approach is skipped — it was already doing what the leads ask.
    const MAX_BRIDGE_M = 1500;
    const APPROACH_TURN_MIN_COS = -0.5; // |turn| ≤ 120° at every splice junction
    const turnCos = (a: LatLon, b: LatLon, c: LatLon): number => {
        const mPerLon = mPerDegLon(b.lat);
        const ux = (b.lon - a.lon) * mPerLon;
        const uy = (b.lat - a.lat) * M_PER_DEG_LAT;
        const vx = (c.lon - b.lon) * mPerLon;
        const vy = (c.lat - b.lat) * M_PER_DEG_LAT;
        const lu = Math.hypot(ux, uy);
        const lv = Math.hypot(vx, vy);
        if (lu < 1 || lv < 1) return 1; // degenerate legs can't reverse
        return (ux * vx + uy * vy) / (lu * lv);
    };
    const candidates: Array<{ i: number; d: number }> = [];
    for (let i = 0; i < poly.length - 1; i++) {
        const d = llDistM(poly[i], approach.anchor);
        if (d < MAX_BRIDGE_M) candidates.push({ i, d });
    }
    candidates.sort((a, b) => a.d - b.d);
    let divertIdx = -1;
    for (const { i } of candidates) {
        const atDivert = i === 0 ? 1 : turnCos(poly[i - 1], poly[i], approach.anchor);
        const atAnchor = turnCos(poly[i], approach.anchor, approach.chain[1]);
        if (atDivert >= APPROACH_TURN_MIN_COS && atAnchor >= APPROACH_TURN_MIN_COS) {
            divertIdx = i;
            break;
        }
    }
    if (divertIdx < 0) {
        if (ENGINE_DEBUG)
            engineLog.warn(
                candidates.length === 0
                    ? `leading-line approach: SKIP — route never within ${MAX_BRIDGE_M}m of anchor ${approach.anchor.lat.toFixed(4)},${approach.anchor.lon.toFixed(4)}`
                    : `leading-line approach: SKIP — every divert candidate (${candidates.length}) would splice a >120° reversal (route already lined up past the anchor)`,
            );
        return passthrough;
    }

    // Never route the approach across solid land (the leads themselves are
    // navigable; the divert bridge must not cut a headland).
    const spliced = [poly[divertIdx], ...approach.chain];
    if (llAnyAlong(spliced, 25, isBlocked)) {
        if (ENGINE_DEBUG) {
            // Pinpoint the first land crossing for diagnosis.
            let hit = '';
            outer: for (let i = 0; i < spliced.length - 1; i++) {
                const a = spliced[i];
                const b = spliced[i + 1];
                const n = Math.max(1, Math.ceil(llDistM(a, b) / 25));
                for (let k = 0; k <= n; k++) {
                    const t = k / n;
                    const p = { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
                    if (isBlocked(p)) {
                        hit = `seg ${i}→${i + 1} @ ${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;
                        break outer;
                    }
                }
            }
            engineLog.warn(
                `leading-line approach: SKIP — spliced chain crosses LAND (divert ${divertIdx}, first land ${hit}; chain ${spliced.map((p) => `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`).join(' → ')})`,
            );
        }
        return passthrough;
    }

    // Keep the route up to the divert vertex, then the transit chain
    // (anchor → leads → dest).
    const newPoly = [...poly.slice(0, divertIdx + 1), ...approach.chain];
    const newPolyline: [number, number][] = newPoly.map((p) => [p.lon, p.lat]);

    // Rebuild caution: prefix preserved; each new approach segment flagged
    // per the grid (clean on rescued leads, red where genuinely shallow).
    const newCaution: boolean[] = cautionMask.slice(0, divertIdx);
    for (let i = divertIdx; i < newPoly.length - 1; i++) {
        newCaution.push(llAnyAlong([newPoly[i], newPoly[i + 1]], 25, isCautionOrBlocked));
    }

    if (ENGINE_DEBUG)
        engineLog.warn(
            `leading-line approach: routed via ${approach.lineCount} charted transit(s) — seaward anchor ${approach.anchor.lat.toFixed(4)},${approach.anchor.lon.toFixed(4)}, divert vertex ${divertIdx}`,
        );
    return { polyline: newPolyline, cautionMask: newCaution, leadingApproach: approach.lineCount };
}
