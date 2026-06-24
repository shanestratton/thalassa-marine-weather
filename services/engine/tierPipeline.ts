/**
 * Inshore Router Engine — tier splice/segment/dispatch + leading-line/fairlead glue.
 * Carved out of inshoreRouterEngine.ts (module split, 2026-06-24).
 */
import { M_PER_DEG_LAT, ENGINE_DEBUG, engineLog } from './constants';
import type { NavGrid, InshoreLayers, RelaxZone } from './types';
import { mPerDegLon, haversineM, latLonToGrid } from './geometry';
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
import { buildFineCanalLeg, FINE_CANAL_APRON_DEG, FINE_CANAL_RES_M, spanCropBbox } from '../tier3/fineCanalGrid';
import { stitchLegs } from '../glue/gluer';
import {
    isRefusal,
    freezeLeg,
    type BoundaryNode,
    type LatLon as RouteLatLon,
    type Leg,
    type LegResult,
} from '../routing/legContract';

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
export function passthroughLeg(span: TierSpan, polyline: readonly [number, number][], grid: NavGrid): Leg {
    const sub = polyline.slice(span.fromIdx, span.toIdx + 1).map(([lon, lat]) => [lon, lat] as [number, number]);
    sub[0] = span.entry.at as [number, number];
    sub[sub.length - 1] = span.exit.at as [number, number];
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
    /** Higher wins when multiple egress tracks can serve the same canal exit. */
    egressPriority?: number;
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
    for (const c of usable) {
        if (usedPorts.has(c.portIdx) || usedStbds.has(c.stbdIdx)) continue;
        usedPorts.add(c.portIdx);
        usedStbds.add(c.stbdIdx);
        centres.push({ lat: c.lat, lon: c.lon, originM: c.endpointM });
    }
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

function projectBeyondGate(prev: LatLon, gate: LatLon, distanceM: number): LatLon | null {
    const mx = mPerDegLon(gate.lat);
    const dxM = (gate.lon - prev.lon) * mx;
    const dyM = (gate.lat - prev.lat) * M_PER_DEG_LAT;
    const lenM = Math.hypot(dxM, dyM);
    if (lenM < 1) return null;
    return {
        lat: gate.lat + (dyM / lenM) * (distanceM / M_PER_DEG_LAT),
        lon: gate.lon + (dxM / lenM) * (distanceM / mx),
    };
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
        priority: number;
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
                priority: chain.egressPriority ?? (chain.tier2FromIndex !== undefined ? 1 : 0),
            };
            if (
                !best ||
                candidate.priority > best.priority ||
                (candidate.priority === best.priority &&
                    (candidate.gates > best.gates ||
                        (candidate.gates === best.gates &&
                            ((candidate.preferred && !best.preferred) ||
                                (candidate.preferred === best.preferred && candidate.costM < best.costM)))))
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
            { corridorM: 300, minRunM: 80, maxAngleDeg: 45, isBlocked: landOnly },
        );
        if (snapped.snapped > 0) {
            route = snapped.polyline.map((p) => [p.lon, p.lat] as [number, number]);
            rectrcSnapped = snapped.snapped;
        }
    }

    const gateCentreTracks = buildGateCentreTracks(marks, route, [...leadingLines, ...rectrcLines]);
    const channelEgressTracks: EgressTrack[] = channelChains.map((chain) => ({
        ...chain,
        tier2FromIndex: 1,
        egressPriority: 2,
    }));
    const egressTracks: EgressTrack[] = [...channelEgressTracks, ...gateCentreTracks, ...leadingLines, ...rectrcLines];
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
    const routeCanalRunViaFineGrid = (run: readonly RouteLatLon[]): RouteLatLon[] | null => {
        if (run.length < 2) return null;
        const runM = tuplePathLengthM(run);
        if (runM < 80 || runM > 5000) return null;
        const entry: BoundaryNode = {
            at: run[0],
            headingDeg: 0,
            kind: 'origin',
            depthM: null,
            snapped: true,
        };
        const exit: BoundaryNode = {
            at: run[run.length - 1],
            headingDeg: 0,
            kind: 'dest',
            depthM: null,
            snapped: true,
        };
        const span: TierSpan = {
            tier: 1,
            entry,
            exit,
            fromIdx: 0,
            toIdx: run.length - 1,
            caution: false,
        };
        const fineGrid = buildFineGrid(spanCropBbox(run, span, FINE_CANAL_APRON_DEG), FINE_CANAL_RES_M);
        if (!fineGrid) return null;
        return buildFineCanalLeg(fineGrid, span, undefined, run)?.polyline ?? null;
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
    const results: LegResult[] = spans.map((span) =>
        span.tier === 2
            ? routeTier4(span, route, ctx4)
            : span.tier === 1
              ? routeTier3(span, route, ctx3)
              : passthroughLeg(span, route, grid),
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
    // Carry them across the canal snap by exact coordinate. Channel segments are
    // rendered/exported as tier 2 at the engine boundary, so they must not also
    // carry canal red on the same segment.
    // tier-1 (canal) RED is decided below by geometry (canal-line snap / proximity),
    // NOT by which leg emitted the vertex — so we no longer track a per-leg canal
    // flag here (that's what bled RED onto non-canal Mapbox-water tier-1 legs).
    const channelPre: boolean[] = new Array(glued.polyline.length).fill(false);
    const offshorePre: boolean[] = new Array(glued.polyline.length).fill(false);
    const channelSegKeys = new Set<string>();
    const channelVertexKeys = new Set<string>();
    const segKey = (a: readonly [number, number], b: readonly [number, number]): string =>
        `${a[0]}|${a[1]}→${b[0]}|${b[1]}`;
    const vtxKey = (a: readonly [number, number]): string => `${a[0]}|${a[1]}`;
    const chainYellowLines = [...gateCentreTracks, ...channelChains]
        .filter((t) => t.pts.length >= 2)
        .map((t) => t.pts.map((p) => [p.lon, p.lat] as [number, number]));
    const CHAIN_RENDER_TRACK_M = 25;
    const onChainYellowLine = (p: readonly [number, number]): boolean =>
        chainYellowLines.length === 0 ||
        pointToTupleLinesM({ lat: p[1], lon: p[0] }, chainYellowLines) <= CHAIN_RENDER_TRACK_M;
    let gi = 0;
    for (const leg of glued.legs) {
        const len = leg.polyline.length;
        if (leg.tierId === 2) {
            for (let v = 0; v < len; v++) {
                channelPre[gi + v] = true;
                channelVertexKeys.add(vtxKey(leg.polyline[v]));
            }
            for (let v = 0; v < len - 1; v++) {
                const a = leg.polyline[v];
                const b = leg.polyline[v + 1];
                const limitToGateChain = canalEgress.gates >= 4 && leg.provenance.includes('chain×');
                if (limitToGateChain && !(onChainYellowLine(a) && onChainYellowLine(b))) {
                    continue;
                }
                channelSegKeys.add(segKey(a, b));
            }
        }
        if (leg.tierId === 4) for (let v = 0; v < len; v++) offshorePre[gi + v] = true;
        gi += len - 1;
    }
    const offshoreKeys = new Set<string>();
    for (let i = 0; i < glued.polyline.length; i++) {
        if (offshorePre[i]) offshoreKeys.add(`${glued.polyline[i][0]}|${glued.polyline[i][1]}`);
    }

    // Canal centre-line snap — wherever the assembled route rides the OSM canal
    // lines (a wall-hug / corner-cut through a carved canal estate), replace that
    // run with the dead-centre line. Tier-agnostic: the canal lines carve the
    // estate to navigable water, so its spans can come out as inshore passthrough,
    // not a canal leg — a per-span follow would miss them. Tier-2 channel vertices
    // are protected so the canal snap cannot swallow a canal→marked-channel egress.
    // No-op off-canal (the river / open water passes through byte-identical).
    const { polyline: snappedPoly } = snapRouteToCanalLines(glued.polyline, canalLines, {
        protectedVertices: channelPre,
        routeRun: (run) => routeCanalRunViaFineGrid(run),
    });
    const canalSnapTag = snappedPoly.length !== glued.polyline.length ? ' +canalsnap' : '';
    const outPoly = snappedPoly.map((p) => [p[0], p[1]] as [number, number]);

    const insertStraightOuterGateExit = (): void => {
        if (canalEgress.gates < 4) return;
        const rawChannelSeg = outPoly.slice(0, -1).map((p, i) => channelSegKeys.has(segKey(p, outPoly[i + 1])));
        const runs: Array<{ from: number; to: number; minCanalM: number }> = [];
        for (let i = 0; i < rawChannelSeg.length; i++) {
            if (!rawChannelSeg[i]) continue;
            const from = i;
            while (i + 1 < rawChannelSeg.length && rawChannelSeg[i + 1]) i++;
            const to = i;
            let minCanalM = Infinity;
            for (let v = from; v <= to + 1; v++) {
                minCanalM = Math.min(
                    minCanalM,
                    canalLines.length > 0
                        ? pointToTupleLinesM({ lat: outPoly[v][1], lon: outPoly[v][0] }, canalLines)
                        : 0,
                );
            }
            runs.push({ from, to, minCanalM });
        }
        const MIN_GATE_RUN_SEGS = Math.max(1, canalEgress.gates - 1);
        const CANAL_GATE_ATTACH_M = 300;
        const gateRun = runs
            .filter((r) => r.to - r.from + 1 >= MIN_GATE_RUN_SEGS && r.minCanalM <= CANAL_GATE_ATTACH_M)
            .sort((a, b) => a.minCanalM - b.minCanalM || a.from - b.from)[0];
        if (!gateRun) return;
        const lastGateSeg = gateRun.to;
        if (lastGateSeg < 1 || lastGateSeg + 2 >= outPoly.length) return;

        const prev = outPoly[lastGateSeg];
        const gate = outPoly[lastGateSeg + 1];
        const next = outPoly[lastGateSeg + 2];
        const OUTER_GATE_CLEARANCE_M = 1000;
        const projected = projectBeyondGate(
            { lat: prev[1], lon: prev[0] },
            { lat: gate[1], lon: gate[0] },
            OUTER_GATE_CLEARANCE_M,
        );
        if (!projected) return;
        const exitPoint: [number, number] = [projected.lon, projected.lat];
        if (tupleDistM(gate, exitPoint) < 80 || tupleDistM(next, exitPoint) < 80) return;
        if (tupleLineCrossesHardLand(grid, gate, exitPoint)) return;

        const mx = mPerDegLon(gate[1]);
        const axisX = (gate[0] - prev[0]) * mx;
        const axisY = (gate[1] - prev[1]) * M_PER_DEG_LAT;
        const axisM = Math.hypot(axisX, axisY);
        if (axisM < 1) return;
        const alongGateAxisM = (p: readonly [number, number]): number =>
            ((p[0] - gate[0]) * mx * axisX + (p[1] - gate[1]) * M_PER_DEG_LAT * axisY) / axisM;

        const replaceFrom = lastGateSeg + 2;
        let keepFrom = replaceFrom;
        const BACKTRACK_PRUNE_M = 1500;
        while (keepFrom < outPoly.length) {
            const p = outPoly[keepFrom];
            const isImmediateBacktrack = alongGateAxisM(p) < -40 && tupleDistM(gate, p) < BACKTRACK_PRUNE_M;
            const tooCloseToExit = tupleDistM(exitPoint, p) < 120;
            if (!isImmediateBacktrack && !tooCloseToExit && !tupleLineCrossesHardLand(grid, exitPoint, p)) break;
            keepFrom++;
        }
        if (keepFrom >= outPoly.length) {
            outPoly.splice(replaceFrom, 0, exitPoint);
            return;
        }
        outPoly.splice(replaceFrom, keepFrom - replaceFrom, exitPoint);
    };
    insertStraightOuterGateExit();

    const CANAL_RENDER_M = 45;
    const channelSegRaw = outPoly.slice(0, -1).map((p, i) => channelSegKeys.has(segKey(p, outPoly[i + 1])));
    const channelVtxRaw = outPoly.map(
        (p, i) => channelVertexKeys.has(vtxKey(p)) || !!channelSegRaw[i] || !!channelSegRaw[i - 1],
    );
    const firstChannelSegIdx = channelSegRaw.findIndex(Boolean);
    const lastChannelSegIdx = channelSegRaw.reduce((last, flagged, i) => (flagged ? i : last), -1);
    const firstChannelIdx = firstChannelSegIdx >= 0 ? firstChannelSegIdx : channelVtxRaw.findIndex(Boolean);
    const lastChannelIdx =
        lastChannelSegIdx >= 0
            ? lastChannelSegIdx + 1
            : channelVtxRaw.reduce((last, flagged, i) => (flagged ? i : last), -1);
    const endpointCanalM = Math.max(CANAL_RENDER_M, 120);
    const originOnCanal =
        canalLines.length > 0 &&
        outPoly.length > 0 &&
        pointToTupleLinesM({ lat: outPoly[0][1], lon: outPoly[0][0] }, canalLines) <= endpointCanalM;
    const destOnCanal =
        canalLines.length > 0 &&
        outPoly.length > 0 &&
        pointToTupleLinesM({ lat: outPoly[outPoly.length - 1][1], lon: outPoly[outPoly.length - 1][0] }, canalLines) <=
            endpointCanalM;
    const canalAllowedAt = (i: number): boolean => {
        if (firstChannelIdx < 0) return true;
        return (originOnCanal && i <= firstChannelIdx) || (destOnCanal && i >= lastChannelIdx);
    };
    const tier1Vtx = outPoly.map(([lon, lat], i) => {
        // RED requires GEOMETRY-CONFIRMED canal, not merely "was internally tier-1":
        //   onCanalLine — within CANAL_RENDER_M of a charted OSM canal/dock line
        // The old mask also reddened raw `canalKeys` (ANY glued tier-1 leg vertex).
        // That bled RED onto broad Mapbox/satellite-water tier-1 legs with no canal
        // nearby — e.g. the Brisbane River approach to Pinkenba routed `tier1:finegrid`
        // but ~3 km from any canal line (docs/AI_COLLAB.md 2026-06-24). Per Shane's
        // colour contract that water is YELLOW/TEAL, not RED. Drop the unguarded
        // canalKeys term; a tier-1 leg only reddens where the chart proves canal.
        // Channel vertices stay yellow, and the canal side of a marked-channel
        // egress is decided by route position: origin-side canal before the first
        // channel, destination-side canal after the last channel. That stops the
        // bay-side route after Newport's outer gate from turning red merely because
        // it passes near the same canal linework.
        const onCanalLine = canalLines.length > 0 && pointToTupleLinesM({ lat, lon }, canalLines) <= CANAL_RENDER_M;
        return !channelVtxRaw[i] && canalAllowedAt(i) && onCanalLine;
    });
    const channelSeg = channelSegRaw.map((isChannel, i) => isChannel && !tier1Vtx[i] && !tier1Vtx[i + 1]);
    const offshoreVtx = outPoly.map(([lon, lat]) => offshoreKeys.has(`${lon}|${lat}`));

    return {
        polyline: outPoly,
        provenance: `${rectrcTag}${glued.legs.map((l) => l.provenance).join(' | ')}${canalSnapTag}`,
        spanCount: spans.length,
        // Per-vertex tier-1 flag (parallel to polyline) for canal/marina RED.
        canalMask: tier1Vtx,
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
