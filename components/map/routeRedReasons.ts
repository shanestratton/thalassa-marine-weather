/**
 * Why each red stretch of a Thalassa route is red, in the skipper's words
 * (round 2, 2026-10-02). Pure.
 *
 * Shane's field route: legs 3→4→5→6 were drawn red with a glow while each
 * leg's chart check said "no issue found" with 5.0 m least. Two checkers, two
 * stories, and nothing on the screen said why the line was red. The router
 * knows why — charted depth below the keel's need, decision-1 water, a
 * hazard's keep-out, water no chart covers, the canal — so every red stretch
 * the map draws (inshoreRoutePieces' 'danger') carries its reason here, and
 * the route review lists it under the leg it is on. Red the chart under the
 * line does not support (caution for its 50 m cells alone, CAUTION_WHY
 * GRID_ONLY) is no longer drawn at all (inshoreSegmentStates); a line that
 * would be but passes too close to a shallow band (NEAR_SHALLOW, round-2
 * review fix-up 2, 2026-10-03) keeps its red and says how close, to what.
 */
import { CAUTION_WHY, type CautionNearShallow, type ChartedShallowSpan } from '../../services/engine/types';
import { tideTopAlong, type InshoreRoutePiece, type RouteTide } from './inshoreRouteState';

export interface RedReasonMasks {
    cautionMask?: readonly boolean[];
    canalMask?: readonly boolean[];
    landPaintConflictMask?: readonly boolean[];
    cautionWhy?: readonly number[];
    cautionDepthM?: readonly (number | null)[];
    /** Per segment: the shallow band a NEAR_SHALLOW segment passes too close to. */
    cautionNearShallow?: readonly (CautionNearShallow | null)[];
    tideDepthM?: readonly (number | null)[];
    chartedShallowSpans?: readonly ChartedShallowSpan[];
    /** Draft + UKC the router judged depth against. */
    tideNeedM?: number;
}

export interface RouteRedStretch {
    /** Where it runs along the route, as segment + fraction. */
    startSeg: number;
    startT: number;
    endSeg: number;
    endT: number;
    lengthM: number;
    /** Its middle, by length — where the review's locator points. */
    at: { lat: number; lon: number };
    /** Why it is red: one clause, lower case, no full stop. */
    why: string;
}

const HAZARD = 'within the keep-out of a charted rock, wreck or obstruction';
const DISAGREE = "the charts disagree: a coarser chart paints land over a finer chart's water here";
const UNCHARTED = 'no chart gives a depth for part of it (uncharted or unvouched water)';
const CANAL = 'canal or marina basin: narrow water — keep to the charted channel';
const WING = 'passes outside a lateral mark — the wrong side of a channel mark';
const LAND = 'the router opened land or a blocked cell here to reach the water — check it on the chart';
const MARK = 'touches the keep-out the router keeps round a navigation mark — check which side to pass it on the chart';
const STRUCTURE = 'touches a berth, pontoon or bridge the router keeps closed — check it on the chart';
const BLOCKED =
    "touches a cell the router's chart grid keeps closed (land, the shore's keep-out or water no tide clears) — check it on the chart";
const GRID = "the router's chart grid reads shallow, uncharted or disputed water here";
const NEAR = 'passes too close to water charted shallower than this boat needs';

const metres = (m: number): string => `${m.toFixed(1)} m`;

/** Haversine metres between two [lon, lat] points. */
function distM(a: readonly [number, number], b: readonly [number, number]): number {
    const r = Math.PI / 180;
    const h =
        Math.sin(((b[1] - a[1]) * r) / 2) ** 2 +
        Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(((b[0] - a[0]) * r) / 2) ** 2;
    return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/**
 * The charted-depth clause, with what the tide says where the router lets a
 * tide lift this red (decision 10): no tide data, or the highest tide known
 * there does not clear it.
 */
function shallowWords(
    depthM: number,
    needM: number | undefined,
    liftable: boolean,
    tide: RouteTide | undefined,
    coords: readonly (readonly [number, number])[],
): string {
    const charted = depthM < 0 ? `charted to dry ${metres(-depthM)}` : `charted ${metres(depthM)}`;
    const need =
        typeof needM === 'number' && Number.isFinite(needM)
            ? ` — shallower than the ${metres(needM)} this boat needs`
            : ' — shallower than this boat needs';
    if (!liftable) return `${charted}${need}`;
    const top = tide ? tideTopAlong(tide, coords) : null;
    return top === null
        ? `${charted}${need}; no tide data here shows a tide that clears it`
        : `${charted}${need}; the highest tide here (${metres(top)}) does not clear it`;
}

/**
 * A line kept red for its clearance (CAUTION_WHY NEAR_SHALLOW; round-2 review
 * fix-up 2, 2026-10-03): how close it passes to which water, and the
 * clearance the router keeps — "passes 5 m from water charted to dry 3.0 m —
 * the router keeps 30 m off it".
 */
function nearWords(near: CautionNearShallow | null | undefined): string {
    if (!near || !Number.isFinite(near.clearanceM) || !Number.isFinite(near.requiredM)) return NEAR;
    const d = near.depthM;
    const water =
        typeof d === 'number' && Number.isFinite(d)
            ? d < 0
                ? `water charted to dry ${metres(-d)}`
                : `water charted ${metres(d)}`
            : 'charted water with no depth given';
    const where =
        near.clearanceM < 1 ? `runs on the edge of ${water}` : `passes ${Math.round(near.clearanceM)} m from ${water}`;
    return `${where} — the router keeps ${Math.round(near.requiredM)} m off it`;
}

/**
 * Every red stretch the map draws, with why. `pieces` are the drawn pieces
 * (inshoreRoutePieces, with the same tide the map used); `cutAt` route
 * positions (segment + fraction, e.g. display waypoints) never fall inside a
 * stretch, so each belongs to one leg.
 */
export function routeRedStretches(
    polyline: readonly (readonly [number, number])[],
    pieces: readonly InshoreRoutePiece[],
    masks: RedReasonMasks,
    tide?: RouteTide,
    cutAt: readonly number[] = [],
): RouteRedStretch[] {
    const segCount = polyline.length - 1;
    if (segCount < 1) return [];
    const fits = <T>(m: readonly T[] | undefined): m is readonly T[] => Array.isArray(m) && m.length === segCount;
    const spans = (Array.isArray(masks.chartedShallowSpans) ? masks.chartedShallowSpans : []).filter(
        (s) => Number.isFinite(s.startSeg + s.startT) && Number.isFinite(s.endSeg + s.endT),
    );
    const point = (u: number): [number, number] => {
        const i = Math.min(segCount - 1, Math.max(0, Math.floor(u)));
        const t = Math.min(1, Math.max(0, u - i));
        const [lonA, latA] = polyline[i];
        const [lonB, latB] = polyline[i + 1];
        return [lonA + (lonB - lonA) * t, latA + (latB - latA) * t];
    };
    /** Why the stretch u0..u1 (inside one segment) is red. */
    const whyAt = (u0: number, u1: number): string => {
        const um = (u0 + u1) / 2;
        const i = Math.min(segCount - 1, Math.floor(um));
        const coords = [point(u0), point(u1)];
        const span = spans.find((s) => um > s.startSeg + s.startT && um < s.endSeg + s.endT);
        if (span) return shallowWords(span.minDepthM, masks.tideNeedM, span.tideLiftable === true, tide, coords);
        if (fits(masks.canalMask) && masks.canalMask[i]) return CANAL;
        const why = fits(masks.cautionWhy) ? masks.cautionWhy[i] : 0;
        const parts: string[] = [];
        if (why & CAUTION_WHY.SHALLOW) {
            const depth = fits(masks.cautionDepthM) ? masks.cautionDepthM[i] : null;
            const lift = fits(masks.tideDepthM) ? masks.tideDepthM[i] : null;
            if (typeof depth === 'number' && Number.isFinite(depth))
                parts.push(shallowWords(depth, masks.tideNeedM, typeof lift === 'number', tide, coords));
            else parts.push('charted shallower than this boat needs');
        }
        if (why & CAUTION_WHY.DISAGREE || (!why && fits(masks.landPaintConflictMask) && masks.landPaintConflictMask[i]))
            parts.push(DISAGREE);
        if (why & CAUTION_WHY.UNCHARTED) parts.push(UNCHARTED);
        if (why & CAUTION_WHY.NEAR_SHALLOW)
            parts.push(nearWords(fits(masks.cautionNearShallow) ? masks.cautionNearShallow[i] : null));
        if (why & CAUTION_WHY.HAZARD) parts.push(HAZARD);
        if (why & CAUTION_WHY.WING) parts.push(WING);
        if (why & CAUTION_WHY.LAND) parts.push(LAND);
        if (why & CAUTION_WHY.MARK) parts.push(MARK);
        if (why & CAUTION_WHY.STRUCTURE) parts.push(STRUCTURE);
        if (why & CAUTION_WHY.BLOCKED) parts.push(BLOCKED);
        return parts.length > 0 ? parts.join('; ') : GRID;
    };

    const cuts = [...cutAt].filter((u) => Number.isFinite(u) && u > 0 && u < segCount);
    const out: RouteRedStretch[] = [];
    let open: { u0: number; u1: number; why: string; lengthM: number } | null = null;
    const close = () => {
        if (!open) return;
        // Its middle by length, along the route.
        let acc = 0;
        let at = point((open.u0 + open.u1) / 2);
        for (let i = Math.floor(open.u0); i < Math.ceil(open.u1); i++) {
            const a = Math.max(open.u0, i);
            const b = Math.min(open.u1, i + 1);
            const m = distM(point(a), point(b));
            if (acc + m >= open.lengthM / 2) {
                at = point(a + ((b - a) * (open.lengthM / 2 - acc)) / Math.max(m, 1e-9));
                break;
            }
            acc += m;
        }
        const startSeg = Math.min(segCount - 1, Math.floor(open.u0));
        const endSeg = Math.min(segCount - 1, Math.max(startSeg, Math.ceil(open.u1) - 1));
        out.push({
            startSeg,
            startT: open.u0 - startSeg,
            endSeg,
            endT: open.u1 - endSeg,
            lengthM: Math.round(open.lengthM),
            at: { lon: at[0], lat: at[1] },
            why: open.why,
        });
        open = null;
    };
    for (const piece of pieces) {
        if (piece.state !== 'danger') {
            close();
            continue;
        }
        // Cut the piece at every segment end, span edge and leg boundary.
        const edges = new Set<number>([piece.u0, piece.u1]);
        for (let i = Math.ceil(piece.u0); i < piece.u1; i++) edges.add(i);
        for (const s of spans)
            for (const u of [s.startSeg + s.startT, s.endSeg + s.endT]) if (u > piece.u0 && u < piece.u1) edges.add(u);
        for (const u of cuts) if (u > piece.u0 && u < piece.u1) edges.add(u);
        const sorted = [...edges].sort((a, b) => a - b);
        for (let k = 0; k + 1 < sorted.length; k++) {
            const [u0, u1] = [sorted[k], sorted[k + 1]];
            if (!(u1 > u0)) continue;
            const why = whyAt(u0, u1);
            const lengthM = distM(point(u0), point(u1));
            const legBreak = cuts.some((c) => Math.abs(c - u0) < 1e-9);
            if (open && open.why === why && Math.abs(open.u1 - u0) < 1e-9 && !legBreak) {
                open.u1 = u1;
                open.lengthM += lengthM;
            } else {
                close();
                open = { u0, u1, why, lengthM };
            }
        }
    }
    close();
    return out;
}
