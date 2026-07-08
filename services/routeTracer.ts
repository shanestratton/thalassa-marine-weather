/**
 * Route Tracer — grade a hand-drawn route leg-by-leg against the SAME data
 * the live router uses (Shane 2026-07-08: "let people make their own routes
 * … with each pin we could check depth and markers between that pin and the
 * next pin, with warnings etc maybe yellow or red lines").
 *
 * The skipper taps pins on the chart; every consecutive pair becomes a LEG
 * that is validated for:
 *   • charted depth vs the vessel's keel (draft + 0.5 m owner margin at LAT)
 *     — thin water = caution, sub-keel = danger + a tide window ("clears
 *     HH:MM–HH:MM") for the shallowest spot;
 *   • land / charted-hazard / berth-row crossings (hard danger);
 *   • cardinal marks — the leg must pass on the SAFE quadrant side;
 *   • lateral gate pairs — the leg must THREAD between port and starboard,
 *     not pass outside either mark;
 *   • solo laterals — close approach gets a "verify the side" advisory;
 *   • leads/transits (RECTRC + navigation lines) — off-lead distance while
 *     riding one, plus a deeper-water nudge for thin legs.
 *
 * This is the HUMAN-IN-THE-LOOP router: the skipper owns the line, Thalassa
 * is the co-pilot watching the chart. A validated trace is also the curated-
 * fairway flywheel — see traceAsCuratedFairwaySnippet.
 *
 * Pure verdict logic lives in validateTraceLeg (sync, unit-testable); the
 * async edges are buildTracerContext (ENC + OSM + grid assembly, one per
 * trace session) and tideWindowLabelFor (WorldTides curve).
 */
import type { Feature, LineString } from 'geojson';
import { buildNavGrid } from './engine/navGrid';
import { CAUTION, UNKNOWN_OPEN, M_PER_DEG_LAT } from './engine/constants';
import type { NavGrid } from './engine/types';
import { assembleTracerLayers } from './InshoreRouter';
import { curatedFairwayCanalFeatures } from './curatedFairways';
import { parseLateralMarks, distM, type LatLon, type LateralMark } from './fairlead';
import { parseCardinalDiscs, type CardinalDisc } from './tier3/cardinalClamp';
import { parseLeadingLines, projectToLine, type LeadingLine } from './leadingLine';
import { computeTidalWindows, DEFAULT_TIDE_SAFETY_M } from './routing/tidalWindow';
import { tideFieldFromCurve } from './routing/env/EnvFields';
import { fetchTideCurve } from './TideHeightService';
import type { VoyagePlan } from '../types/navigation';
import { createLogger } from '../utils/createLogger';

const log = createLogger('routeTracer');

// ── Types ──────────────────────────────────────────────────────────────────

export interface TracePoint {
    lat: number;
    lon: number;
}

export type TraceGrade = 'clear' | 'caution' | 'danger';

export interface TraceIssue {
    severity: 'caution' | 'danger';
    /** Skipper-readable, ≤ ~60 chars — shown on the leg row in the panel. */
    message: string;
    at?: TracePoint;
}

export interface TraceLegVerdict {
    grade: TraceGrade;
    issues: TraceIssue[];
    /** Shallowest charted depth on the leg (m below LAT), null = none charted. */
    minDepthM: number | null;
    minAt: TracePoint | null;
    /** True when the leg needs tide over the keel — feed tideWindowLabelFor. */
    needsTide: boolean;
    /** P3 advisory: deeper-water nudge, e.g. "deeper water ~60 m to port". */
    nudge: string | null;
}

export interface GatePair {
    port: TracePoint;
    stbd: TracePoint;
}

export interface TracerContext {
    /** Depth grid — null on marks-only contexts (trace too long for the cell
     *  budget): depth/land checks are SKIPPED and every leg carries an honest
     *  "depth unchecked" caution instead of a guess. */
    grid: NavGrid | null;
    /** Real ENC lateral marks (CATLAM 1–4) NOT part of an accepted gate pair. */
    soloLaterals: LateralMark[];
    cardinals: CardinalDisc[];
    gatePairs: GatePair[];
    leads: LeadingLine[];
    /** CANAL centrelines (curated fairways + OSM canal/fairway lines). A
     *  land-reading sample within the LANE half-width of one is lane water,
     *  not land: the carve means "navigable lane", and it is one cell wide —
     *  50 m on the engine's grid but only ~10 m on the tracer's fine grid, so
     *  without this a route riding the lane dead-centre-adjacent reads as
     *  crossing the chart's LNDARE bleed (router-consistency golden). */
    canalLanes: LeadingLine[];
    draftM: number;
    /** True when the vessel profile has no usable draft and verdicts were
     *  graded against the 2.5 m fallback — clear legs downgrade to caution. */
    draftAssumed: boolean;
    /** Grid coverage bbox [W,S,E,N] — pins outside need a context rebuild. */
    bbox: [number, number, number, number];
    resM: number;
}

/** buildTracerContext outcome — statuses drive the panel strip. */
export type TracerBuildResult =
    | { status: 'ready'; ctx: TracerContext }
    | { status: 'marksonly'; ctx: TracerContext }
    | { status: 'toolarge' }
    | { status: 'nochart' };

// ── Tunables ───────────────────────────────────────────────────────────────

/** Extra water beyond draft+safety before a leg reads fully green. */
const THIN_MARGIN_M = 1.0;
/** Cardinal relevance band + minimum safe-side clearance (m). */
const CARDINAL_BAND_M = 400;
const CARDINAL_CLEAR_M = 90;
/** A gate is checked when the leg comes this close to its midpoint (m). */
const GATE_BAND_M = 300;
/** Solo-lateral "verify the side" advisory distance (m). */
const SOLO_LATERAL_BAND_M = 60;
/** Lead corridor: within this of a lead and roughly parallel → watch it. */
const LEAD_BAND_M = 150;
const LEAD_MAX_ANGLE_DEG = 30;
const LEAD_OFF_CAUTION_M = 40;
/** Context bbox padding (deg ≈ 2.2 km) and rebuild margin near the edge. */
export const TRACER_BBOX_PAD_DEG = 0.02;
/** Grid cell budget — resolution adapts so width×height stays under this. */
const MAX_GRID_CELLS = 2_000_000;
/** Above this bbox span the depth grid is skipped (marks-only verdicts) —
 *  an unbounded grid over a long trace was an ~800 MB jetsam kill. */
const MAX_DEPTH_GRID_SPAN_M = 40_000;
/** Above this we refuse the context outright — even feature loading (every
 *  intersecting ENC cell + the OSM overlay) is unbounded at that scale. */
const MAX_TRACE_SPAN_M = 80_000;
/** Half-width of a carved canal/fairway LANE. Matches the engine's effective
 *  corridor: one 50 m coarse cell around the centreline PLUS post-pass
 *  polyline simplification slop (the consistency golden measured the live
 *  engine 51 m off Shane's traced centreline at the Mooloolah entrance).
 *  Kept tight enough that a genuinely-over-the-spit line (the v1/v2 curated-
 *  fairway bugs ran 100+ m off) still reads as crossing land. */
const CANAL_LANE_HALF_WIDTH_M = 60;

// ── Context assembly ───────────────────────────────────────────────────────

/** Bbox [W,S,E,N] covering all points, padded for context reuse while tracing. */
export function traceBbox(
    points: readonly TracePoint[],
    padDeg = TRACER_BBOX_PAD_DEG,
): [number, number, number, number] {
    let w = Infinity,
        s = Infinity,
        e = -Infinity,
        n = -Infinity;
    for (const p of points) {
        w = Math.min(w, p.lon);
        s = Math.min(s, p.lat);
        e = Math.max(e, p.lon);
        n = Math.max(n, p.lat);
    }
    return [w - padDeg, s - padDeg, e + padDeg, n + padDeg];
}

export function pointInBbox(p: TracePoint, bbox: [number, number, number, number], marginDeg = 0.003): boolean {
    return (
        p.lon >= bbox[0] + marginDeg &&
        p.lat >= bbox[1] + marginDeg &&
        p.lon <= bbox[2] - marginDeg &&
        p.lat <= bbox[3] - marginDeg
    );
}

/** Bbox spans in metres (lon-span, lat-span) at the bbox mid-latitude. */
function bboxSpansM(bbox: [number, number, number, number]): { spanLonM: number; spanLatM: number } {
    const midLat = (bbox[1] + bbox[3]) / 2;
    return {
        spanLonM: (bbox[2] - bbox[0]) * 111_320 * Math.cos((midLat * Math.PI) / 180),
        spanLatM: (bbox[3] - bbox[1]) * M_PER_DEG_LAT,
    };
}

/**
 * Padded bbox for the pins with a SPAN-PROPORTIONAL pad (min 0.02°, up to
 * 25% of the larger span) — a fixed 2.2 km pad made coast-following traces
 * rebuild the whole context roughly every second pin (quadratic total cost).
 */
export function traceBboxPadded(points: readonly TracePoint[]): [number, number, number, number] {
    const tight = traceBbox(points, 0);
    const pad = Math.max(TRACER_BBOX_PAD_DEG, 0.25 * Math.max(tight[2] - tight[0], tight[3] - tight[1]));
    return [tight[0] - pad, tight[1] - pad, tight[2] + pad, tight[3] + pad];
}

/** Grid resolution for a bbox: as fine as the cell budget allows, floor 6 m.
 *  NO coarseness ceiling — the old Math.min(60,…) INVERTED the budget (a
 *  300 NM bbox pinned at 60 m allocated ~42M cells ≈ 800 MB → jetsam kill).
 *  Span caps above bound how coarse this can get instead. Exported for tests. */
export function tracerResolutionM(bbox: [number, number, number, number]): number {
    const { spanLonM, spanLatM } = bboxSpansM(bbox);
    return Math.max(6, Math.ceil(Math.sqrt((spanLonM * spanLatM) / MAX_GRID_CELLS)));
}

/**
 * Pure context assembly from an already-merged layer blob — the testable
 * core of buildTracerContext, also used by the router-consistency golden
 * (grade the LIVE engine's route through the tracer on the SAME layers).
 */
export function tracerContextFromLayers(
    merged: import('./inshoreRouterEngine').InshoreLayers,
    gatePairs: GatePair[],
    bbox: [number, number, number, number],
    draftM: number,
    opts: { draftAssumed?: boolean; skipGrid?: boolean } = {},
): TracerContext {
    const resM = tracerResolutionM(bbox);
    // Marina-scale traces (~3 km) land well under 20 m → navGrid's Pass 2c
    // berth carve is ACTIVE and legs over pontoon rows read blocked, exactly
    // like the fine routing grid. Bay-scale traces coarsen gracefully.
    const grid = opts.skipGrid ? null : buildNavGrid(merged, bbox, resM, draftM, DEFAULT_TIDE_SAFETY_M, 60);

    // Marks: real ENC laterals; those inside an accepted pair are gate-checked,
    // the rest get the solo "verify the side" advisory.
    const laterals = parseLateralMarks([
        ...(merged.BCNLAT?.features ?? []),
        ...(merged.BOYLAT?.features ?? []),
    ] as never[]);
    const inPair = (m: LatLon): boolean => gatePairs.some((g) => distM(m, g.port) < 30 || distM(m, g.stbd) < 30);
    const soloLaterals = laterals.filter((m) => !inPair(m));
    const cardinals = parseCardinalDiscs((merged.OBSTRN?.features ?? []) as never);
    const leads = parseLeadingLines([
        ...((merged.RECTRC?.features ?? []) as never[]),
        ...((merged.NAVLINE?.features ?? []) as never[]),
    ]);
    const canalLanes = parseLeadingLines((merged.CANAL?.features ?? []) as never[]);

    return {
        grid,
        soloLaterals,
        cardinals,
        gatePairs,
        leads,
        canalLanes,
        draftM,
        draftAssumed: opts.draftAssumed ?? false,
        bbox,
        resM,
    };
}

/**
 * Build the validation context for a trace session: assemble the router's
 * layer blob for the bbox, build the depth grid, parse marks/gates/leads.
 * Span-capped for honesty AND survival: beyond ~40 km the depth grid is
 * skipped (marks-only, every leg carries "depth unchecked"); beyond ~80 km
 * we refuse outright — split the trace.
 */
export async function buildTracerContext(
    bbox: [number, number, number, number],
    draftM: number,
    opts: { draftAssumed?: boolean } = {},
): Promise<TracerBuildResult> {
    const { spanLonM, spanLatM } = bboxSpansM(bbox);
    const spanM = Math.max(spanLonM, spanLatM);
    if (spanM > MAX_TRACE_SPAN_M) return { status: 'toolarge' };

    const t0 = Date.now();
    const bundle = await assembleTracerLayers(bbox);
    if (!bundle) return { status: 'nochart' };

    const skipGrid = spanM > MAX_DEPTH_GRID_SPAN_M;
    const ctx = tracerContextFromLayers(bundle.merged, bundle.gatePairs, bbox, draftM, {
        draftAssumed: opts.draftAssumed,
        skipGrid,
    });
    log.warn(
        `context ready in ${Date.now() - t0}ms — res=${ctx.resM}m grid=${ctx.grid ? `${ctx.grid.width}×${ctx.grid.height}` : 'SKIPPED (marks-only)'} gates=${ctx.gatePairs.length} solo=${ctx.soloLaterals.length} cardinals=${ctx.cardinals.length} leads=${ctx.leads.length}`,
    );
    return { status: skipGrid ? 'marksonly' : 'ready', ctx };
}

// ── Geometry helpers (local equirectangular, channel scale) ────────────────

const mPerLon = (lat: number): number => 111_320 * Math.cos((lat * Math.PI) / 180);

/** Closest point on segment ab to p, as {t, point, distM}. */
function closestOnLeg(p: TracePoint, a: TracePoint, b: TracePoint): { t: number; point: TracePoint; distM: number } {
    const kx = mPerLon(a.lat);
    const ax = a.lon * kx,
        ay = a.lat * M_PER_DEG_LAT;
    const bx = b.lon * kx,
        by = b.lat * M_PER_DEG_LAT;
    const px = p.lon * kx,
        py = p.lat * M_PER_DEG_LAT;
    const dx = bx - ax,
        dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    const cx = ax + t * dx,
        cy = ay + t * dy;
    return {
        t,
        point: { lat: cy / M_PER_DEG_LAT, lon: cx / kx },
        distM: Math.hypot(px - cx, py - cy),
    };
}

/** Signed 2D cross product of (b−a)×(p−a) in metres² — side of line test. */
function crossSide(a: TracePoint, b: TracePoint, p: TracePoint): number {
    const kx = mPerLon(a.lat);
    return (
        (b.lon - a.lon) * kx * (p.lat - a.lat) * M_PER_DEG_LAT - (b.lat - a.lat) * M_PER_DEG_LAT * (p.lon - a.lon) * kx
    );
}

/** True when segments a1→a2 and b1→b2 properly intersect (incl. touching). */
function segmentsIntersect(a1: TracePoint, a2: TracePoint, b1: TracePoint, b2: TracePoint): boolean {
    const d1 = crossSide(b1, b2, a1);
    const d2 = crossSide(b1, b2, a2);
    const d3 = crossSide(a1, a2, b1);
    const d4 = crossSide(a1, a2, b2);
    return ((d1 >= 0 && d2 <= 0) || (d1 <= 0 && d2 >= 0)) && ((d3 >= 0 && d4 <= 0) || (d3 <= 0 && d4 >= 0));
}

const SAFE_VEC: Record<CardinalDisc['dir'], readonly [number, number]> = {
    n: [0, 1],
    e: [1, 0],
    s: [0, -1],
    w: [-1, 0],
};
const DIR_WORD: Record<CardinalDisc['dir'], string> = { n: 'north', e: 'east', s: 'south', w: 'west' };

// ── Grid sampling ──────────────────────────────────────────────────────────

type CellRead =
    | { kind: 'blocked'; sub: 'land' | 'berth' | 'hazard' }
    | { kind: 'depth'; depthM: number }
    | { kind: 'caution-uncharted' }
    | { kind: 'uncharted' }
    | { kind: 'offgrid' };

function readCell(grid: NavGrid, p: TracePoint): CellRead {
    const x = Math.floor((p.lon - grid.minLon) / grid.dLon);
    const y = Math.floor((p.lat - grid.minLat) / grid.dLat);
    if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return { kind: 'offgrid' };
    const idx = y * grid.width + x;
    const v = grid.cells[idx];
    if (Number.isNaN(v)) {
        if (grid.berthBlocked?.[idx]) return { kind: 'blocked', sub: 'berth' };
        if (grid.landBlocked?.[idx]) return { kind: 'blocked', sub: 'land' };
        return { kind: 'blocked', sub: 'hazard' };
    }
    if (v === CAUTION) {
        const d = grid.shallowDepthM?.[idx];
        return d !== undefined && Number.isFinite(d) ? { kind: 'depth', depthM: d } : { kind: 'caution-uncharted' };
    }
    if (v === UNKNOWN_OPEN) return { kind: 'uncharted' };
    return { kind: 'depth', depthM: v };
}

/** Any non-blocked cell within `cells` of the point? Distinguishes a sample
 *  ON the land/water boundary (chart bleed, tap imprecision, coarse-vs-fine
 *  grid disagreement — "hugs the bank", caution) from one deep inside charted
 *  land (a real crossing — danger). */
function waterNearby(grid: NavGrid, p: TracePoint, cells: number): boolean {
    const x0 = Math.floor((p.lon - grid.minLon) / grid.dLon);
    const y0 = Math.floor((p.lat - grid.minLat) / grid.dLat);
    for (let dy = -cells; dy <= cells; dy++) {
        for (let dx = -cells; dx <= cells; dx++) {
            if (dx === 0 && dy === 0) continue;
            const x = x0 + dx;
            const y = y0 + dy;
            if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) continue;
            if (!Number.isNaN(grid.cells[y * grid.width + x])) return true;
        }
    }
    return false;
}

// ── The leg validator (pure, sync) ─────────────────────────────────────────

export function validateTraceLeg(a: TracePoint, b: TracePoint, ctx: TracerContext): TraceLegVerdict {
    const issues: TraceIssue[] = [];
    const legM = distM(a, b);
    const { grid, draftM } = ctx;
    const keelM = draftM + DEFAULT_TIDE_SAFETY_M;

    // 1 — sample charted depth along the leg (skipped on marks-only contexts:
    // the trace outgrew the depth-grid budget, so say "unchecked", never guess).
    const stepM = Math.max(5, ctx.resM * 0.6);
    const steps = Math.max(1, Math.ceil(legM / stepM));
    let minDepthM: number | null = null;
    let minAt: TracePoint | null = null;
    let blockedAt: TracePoint | null = null;
    let blockedSub: 'land' | 'berth' | 'hazard' | null = null;
    let bankShaveAt: TracePoint | null = null;
    let uncharted = 0;
    let conflict = 0;
    const inCanalLane = (p: TracePoint): boolean =>
        ctx.canalLanes.some((l) => l.pts.length >= 2 && projectToLine(p, l.pts).dist <= CANAL_LANE_HALF_WIDTH_M);
    // Boundary tolerance ≈ 25 m (at least 2 cells) — the live engine's 50 m
    // grid legitimately puts a route within one coarse cell of the charted
    // bank; deep-inside-land stays a hard crossing.
    const edgeCells = Math.max(2, Math.ceil(25 / ctx.resM));
    if (grid) {
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const p = { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
            const r = readCell(grid, p);
            if (r.kind === 'blocked' && r.sub === 'land' && inCanalLane(p)) {
                // Chart-LNDARE bleed inside a carved canal/fairway lane — the
                // lane is navigable (that's what the carve asserts), but it
                // carries no depth claim, so count it as uncharted.
                uncharted++;
            } else if (r.kind === 'blocked' && r.sub === 'land' && waterNearby(grid, p, edgeCells)) {
                // On the land/water boundary — bank hug, not a crossing.
                if (!bankShaveAt) bankShaveAt = p;
            } else if (r.kind === 'blocked' && !blockedAt) {
                blockedAt = p;
                blockedSub = r.sub;
            } else if (r.kind === 'depth') {
                if (minDepthM === null || r.depthM < minDepthM) {
                    minDepthM = r.depthM;
                    minAt = p;
                }
            } else if (r.kind === 'uncharted' || r.kind === 'offgrid') {
                uncharted++;
            } else if (r.kind === 'caution-uncharted') {
                conflict++;
            }
        }
    } else {
        issues.push({ severity: 'caution', message: 'depth unchecked — trace too long, split it' });
    }

    let needsTide = false;
    if (blockedAt && blockedSub) {
        const msg =
            blockedSub === 'land'
                ? 'crosses charted land'
                : blockedSub === 'berth'
                  ? 'cuts through marina berths'
                  : 'crosses a charted hazard';
        issues.push({ severity: 'danger', message: msg, at: blockedAt });
    } else if (bankShaveAt) {
        issues.push({ severity: 'caution', message: 'hugs the charted bank — verify the line', at: bankShaveAt });
    }
    if (minDepthM !== null && minAt) {
        if (minDepthM < keelM) {
            needsTide = true;
            const rise = keelM - minDepthM;
            issues.push({
                severity: 'danger',
                message: `${minDepthM.toFixed(1)} m charted — needs +${rise.toFixed(1)} m tide`,
                at: minAt,
            });
        } else if (minDepthM < keelM + THIN_MARGIN_M) {
            issues.push({
                severity: 'caution',
                message: `thin water — ${minDepthM.toFixed(1)} m charted at low tide (LAT)`,
                at: minAt,
            });
        }
    }
    if (conflict > 0) {
        issues.push({ severity: 'caution', message: 'depth data conflicts here — treat as unproven' });
    }
    if (uncharted / (steps + 1) > 0.3) {
        issues.push({ severity: 'caution', message: 'no charted depth for part of this leg' });
    }

    // 2 — cardinals: the leg must stay on the safe quadrant side.
    for (const c of ctx.cardinals) {
        const near = closestOnLeg(c, a, b);
        if (near.distM > CARDINAL_BAND_M) continue;
        const safe = SAFE_VEC[c.dir];
        const kx = mPerLon(c.lat);
        const sideM = (near.point.lon - c.lon) * kx * safe[0] + (near.point.lat - c.lat) * M_PER_DEG_LAT * safe[1];
        if (sideM < 0) {
            issues.push({
                severity: 'danger',
                message: `wrong side of the ${DIR_WORD[c.dir]} cardinal — pass ${DIR_WORD[c.dir]} of it`,
                at: near.point,
            });
        } else if (sideM < CARDINAL_CLEAR_M) {
            issues.push({
                severity: 'caution',
                message: `shaves the ${DIR_WORD[c.dir]} cardinal — give it ${CARDINAL_CLEAR_M} m`,
                at: near.point,
            });
        }
    }

    // 3 — gate pairs: thread BETWEEN port and starboard, not outside.
    for (const g of ctx.gatePairs) {
        const mid = { lat: (g.port.lat + g.stbd.lat) / 2, lon: (g.port.lon + g.stbd.lon) / 2 };
        const near = closestOnLeg(mid, a, b);
        if (near.distM > GATE_BAND_M) continue;
        if (segmentsIntersect(a, b, g.port, g.stbd)) continue; // threaded — perfect
        // Does the leg cross the gate LINE beyond one of the marks? That's the
        // classic "went the wrong side of the red" — flag it. A leg that stops
        // short of the line (pin dropped mid-approach) is left alone; the next
        // leg gets the same check.
        const sA = crossSide(g.port, g.stbd, a);
        const sB = crossSide(g.port, g.stbd, b);
        if ((sA >= 0 && sB <= 0) || (sA <= 0 && sB >= 0)) {
            const halfM = distM(g.port, g.stbd) / 2;
            // Crossing point distance from gate midpoint along the gate line —
            // beyond ~2 gate half-widths is an unrelated channel arm, skip.
            // (Was Math.max(halfM*2, GATE_BAND_M), which defeated the cutoff
            // for every real pair narrower than 300 m half-width — false reds
            // 250 m outside a 60 m club channel in honest deep water.)
            const cross = closestOnLeg(mid, a, b).point;
            const offM = distM(mid, cross);
            if (offM <= Math.max(halfM * 2, 60)) {
                const outsidePort = distM(cross, g.port) < distM(cross, g.stbd);
                issues.push({
                    severity: 'danger',
                    message: `wrong side of the ${outsidePort ? 'red (port)' : 'green (starboard)'} mark — pass between the pair`,
                    at: cross,
                });
            }
        }
    }

    // 4 — solo laterals: close approach → verify-the-side advisory. Without a
    // derived direction of buoyage we don't guess the safe side (honesty rule)
    // — the engine's full clamp does that on computed routes; here the skipper
    // drew the line, so we just make sure the mark is CONSIDERED.
    for (const m of ctx.soloLaterals) {
        const near = closestOnLeg(m, a, b);
        if (near.distM < SOLO_LATERAL_BAND_M) {
            issues.push({
                severity: 'caution',
                message: `close to ${m.name || 'a'} ${m.side === 'port' ? 'port' : 'starboard'} mark — verify your side`,
                at: near.point,
            });
        }
    }

    // 5 — leads: riding a transit? report drift off the line.
    const legBrgRad = Math.atan2((b.lon - a.lon) * mPerLon(a.lat), (b.lat - a.lat) * M_PER_DEG_LAT);
    const mid = { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };
    for (const lead of ctx.leads) {
        if (lead.pts.length < 2) continue;
        const proj = projectToLine(mid, lead.pts);
        if (proj.dist > LEAD_BAND_M) continue;
        // Local lead bearing at the nearest segment end-pair.
        let bestSeg = 0;
        let bestD = Infinity;
        for (let i = 1; i < lead.pts.length; i++) {
            const d = closestOnLeg(mid, lead.pts[i - 1], lead.pts[i]).distM;
            if (d < bestD) {
                bestD = d;
                bestSeg = i;
            }
        }
        const p0 = lead.pts[bestSeg - 1];
        const p1 = lead.pts[bestSeg];
        const leadBrgRad = Math.atan2((p1.lon - p0.lon) * mPerLon(p0.lat), (p1.lat - p0.lat) * M_PER_DEG_LAT);
        let dDeg = Math.abs(((legBrgRad - leadBrgRad) * 180) / Math.PI) % 180;
        if (dDeg > 90) dDeg = 180 - dDeg;
        if (dDeg > LEAD_MAX_ANGLE_DEG) continue;
        if (proj.dist > LEAD_OFF_CAUTION_M) {
            issues.push({
                severity: 'caution',
                message: `${Math.round(proj.dist)} m off the lead — steer to the transit`,
                at: proj.point,
            });
        }
        break; // one lead verdict per leg is enough
    }

    // 6 — deeper-water nudge for thin/sub-keel legs (advisory only).
    let nudge: string | null = null;
    if (grid && minAt && minDepthM !== null && minDepthM < keelM + THIN_MARGIN_M) {
        // Perpendicular unit vector (east, north): leg dir is (sin brg, cos brg),
        // rotated 90° clockwise = starboard side of travel.
        const perpE = Math.cos(legBrgRad);
        const perpN = -Math.sin(legBrgRad);
        outer: for (const offM of [30, 60, 90, 120]) {
            for (const sign of [1, -1] as const) {
                const q = {
                    lat: minAt.lat + (sign * offM * perpN) / M_PER_DEG_LAT,
                    lon: minAt.lon + (sign * offM * perpE) / mPerLon(minAt.lat),
                };
                const r = readCell(grid, q);
                if (r.kind === 'depth' && r.depthM >= keelM + THIN_MARGIN_M) {
                    // sign +1 = right of travel = starboard.
                    nudge = `deeper water ~${offM} m to ${sign === 1 ? 'starboard' : 'port'}`;
                    break outer;
                }
            }
        }
    }

    // Draft honesty: a "clear" graded against the 2.5 m FALLBACK draft is not
    // a clear — downgrade with an explicit reason until a real draft exists.
    if (ctx.draftAssumed && issues.length === 0) {
        issues.push({ severity: 'caution', message: 'checked against a default 2.5 m draft — set your vessel' });
    }

    const grade: TraceGrade = issues.some((i) => i.severity === 'danger')
        ? 'danger'
        : issues.length > 0
          ? 'caution'
          : 'clear';
    return { grade, issues, minDepthM, minAt, needsTide, nudge };
}

/** Grade every leg of a trace. verdicts[i] covers points[i]→points[i+1]. */
export function validateTrace(points: readonly TracePoint[], ctx: TracerContext): TraceLegVerdict[] {
    const out: TraceLegVerdict[] = [];
    for (let i = 1; i < points.length; i++) out.push(validateTraceLeg(points[i - 1], points[i], ctx));
    return out;
}

// ── Tide window label (async, per sub-keel leg) ────────────────────────────

const fmtHm = (ms: number): string =>
    new Date(ms).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false });

/** "today" / "tonight" / "tomorrow" for a window opening — a bare "08:45"
 *  read tonight was tomorrow's window to the punter (windows shift ~50 min/
 *  day, so acting on the wrong day is a real grounding vector). */
function dayWord(ms: number): string {
    const now = new Date();
    const then = new Date(ms);
    if (then.getDate() !== now.getDate() || then.getMonth() !== now.getMonth()) return 'tomorrow';
    return then.getHours() >= 18 ? 'tonight' : 'today';
}

/**
 * "clears 08:45–14:30 today" ("(approx)" from interpolated extremes) for a
 * shallow spot over the next 24 h, or "needs +X.X m — no tide window in
 * 24 h". Null when tide data is unavailable (offline) — the leg stays red
 * with its depth message; never guess a window.
 */
export async function tideWindowLabelFor(minDepthM: number, draftM: number, at: TracePoint): Promise<string | null> {
    try {
        const fromMs = Date.now();
        const untilMs = fromMs + 24 * 3600_000;
        const curve = await fetchTideCurve(at.lat, at.lon, fromMs, untilMs);
        if (!curve) return null;
        const res = computeTidalWindows({ minDepthM, draftM, tide: tideFieldFromCurve(curve), fromMs, untilMs });
        if (res.alwaysOpen) return null;
        if (res.windows.length === 0) return `needs +${res.requiredRiseM.toFixed(1)} m — no tide window in 24 h`;
        const w = res.windows[0];
        return `clears ${fmtHm(w.openMs)}–${fmtHm(w.closeMs)} ${dayWord(w.openMs)}${w.approx ? ' (approx)' : ''}`;
    } catch (err) {
        log.warn(`tide window failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
}

// ── Pin helpers (P2 punter-proofing) ───────────────────────────────────────

/** Is this exact spot blocked in the tracer grid (and why)? Drives the
 *  pin-level diagnosis: "pin 4 is on charted land — drag it seaward". */
export function tracePinBlocked(ctx: TracerContext, p: TracePoint): 'land' | 'berth' | 'hazard' | null {
    if (!ctx.grid) return null;
    const r = readCell(ctx.grid, p);
    return r.kind === 'blocked' ? r.sub : null;
}

/**
 * Snap a fat-fingered tap on the breakwater/bank to the nearest navigable
 * cell (spiral search, ≤ maxM). Returns null when the spot is fine as-is or
 * nothing navigable is close — the tap then lands verbatim and the pin-level
 * diagnosis explains it. Never snaps ACROSS more than maxM: a deliberate
 * inland tap stays where the skipper put it.
 */
export function snapTraceTapToWater(ctx: TracerContext, p: TracePoint, maxM = 60): TracePoint | null {
    const grid = ctx.grid;
    if (!grid) return null;
    if (tracePinBlocked(ctx, p) === null) return null; // already navigable
    const maxCells = Math.max(1, Math.ceil(maxM / ctx.resM));
    const x0 = Math.floor((p.lon - grid.minLon) / grid.dLon);
    const y0 = Math.floor((p.lat - grid.minLat) / grid.dLat);
    let best: { x: number; y: number; d2: number } | null = null;
    for (let dy = -maxCells; dy <= maxCells; dy++) {
        for (let dx = -maxCells; dx <= maxCells; dx++) {
            const x = x0 + dx;
            const y = y0 + dy;
            if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) continue;
            if (Number.isNaN(grid.cells[y * grid.width + x])) continue;
            const d2 = dx * dx + dy * dy;
            if (!best || d2 < best.d2) best = { x, y, d2 };
        }
    }
    if (!best) return null;
    return {
        lat: grid.minLat + (best.y + 0.5) * grid.dLat,
        lon: grid.minLon + (best.x + 0.5) * grid.dLon,
    };
}

// ── Route health summary ───────────────────────────────────────────────────

export interface TraceHealth {
    clear: number;
    caution: number;
    danger: number;
    label: string;
    tone: TraceGrade;
}

export function traceHealth(verdicts: readonly TraceLegVerdict[]): TraceHealth {
    let clear = 0,
        caution = 0,
        danger = 0;
    for (const v of verdicts) {
        if (v.grade === 'danger') danger++;
        else if (v.grade === 'caution') caution++;
        else clear++;
    }
    const label =
        verdicts.length === 0
            ? 'drop pins to trace'
            : danger > 0
              ? `${danger} no-go leg${danger > 1 ? 's' : ''}`
              : caution > 0
                ? `${caution} caution${caution > 1 ? 's' : ''}`
                : 'all clear';
    return { clear, caution, danger, label, tone: danger > 0 ? 'danger' : caution > 0 ? 'caution' : 'clear' };
}

// ── P4: save / load / flywheel / sail ──────────────────────────────────────

export interface SavedTrace {
    id: string;
    name: string;
    createdAt: string; // ISO
    points: TracePoint[];
}

const TRACES_KEY = 'thalassa_traced_routes_v1';

export function loadSavedTraces(): SavedTrace[] {
    try {
        const raw = localStorage.getItem(TRACES_KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw) as SavedTrace[];
        return Array.isArray(arr) ? arr.filter((t) => t && Array.isArray(t.points) && t.points.length >= 2) : [];
    } catch {
        return [];
    }
}

/** persisted=false means storage refused (quota) — tell the skipper, don't
 *  flash "Saved ✓" over a trace that won't exist next session. `cloud`
 *  resolves with the account-push outcome so the UI can be equally honest
 *  about the desktop→phone hop ('signedout' = never left this browser). */
export function saveTrace(
    name: string,
    points: readonly TracePoint[],
): { trace: SavedTrace; persisted: boolean; cloud: Promise<import('./savedRoutesSync').PushResult> } {
    const trace: SavedTrace = {
        id: `trace-${Date.now().toString(36)}`,
        name: name.trim() || `Trace ${new Date().toLocaleDateString('en-AU')}`,
        createdAt: new Date().toISOString(),
        points: points.map((p) => ({ lat: p.lat, lon: p.lon })),
    };
    const all = [trace, ...loadSavedTraces()].slice(0, 50);
    let persisted = false;
    try {
        localStorage.setItem(TRACES_KEY, JSON.stringify(all));
        persisted = loadSavedTraces().some((t) => t.id === trace.id);
    } catch {
        /* quota — persisted stays false */
    }
    // Account sync (Phase 5.3): best-effort push so the route follows the
    // punter across devices — build on the desktop, sail on the phone.
    const cloud = import('./savedRoutesSync')
        .then(({ pushSavedRoute }) => pushSavedRoute(trace))
        .catch(() => 'error' as const);
    return { trace, persisted, cloud };
}

export function deleteTrace(id: string): void {
    try {
        localStorage.setItem(TRACES_KEY, JSON.stringify(loadSavedTraces().filter((t) => t.id !== id)));
    } catch {
        /* ignore */
    }
    // Tombstone on the account so the delete syncs across devices too.
    void import('./savedRoutesSync').then(({ pushSavedRouteDelete }) => pushSavedRouteDelete(id)).catch(() => {});
}

/**
 * The curated-fairway flywheel: a skipper's validated trace, exported as a
 * paste-ready CuratedFairway snippet (services/curatedFairways.ts shape) —
 * exactly how Shane's 29 tapped Mooloolaba coords became the shipped lane.
 */
export function traceAsCuratedFairwaySnippet(name: string, points: readonly TracePoint[]): string {
    const [w, s, e, n] = traceBbox(points, 0.005);
    const id = (name.trim() || 'traced-fairway')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return JSON.stringify(
        {
            id,
            bbox: [Number(w.toFixed(4)), Number(s.toFixed(4)), Number(e.toFixed(4)), Number(n.toFixed(4))],
            line: points.map((p) => [Number(p.lon.toFixed(5)), Number(p.lat.toFixed(5))]),
        },
        null,
        4,
    );
}

/** Minimal VoyagePlan so a trace can be followed like any planned passage. */
export function traceAsVoyagePlan(
    name: string,
    points: readonly TracePoint[],
    /** Per-leg grades (length = points-1) — carried on routeGeoJSON.properties
     *  so follow mode renders the validated colours, not a plain blue line. */
    legGrades?: readonly TraceGrade[],
): VoyagePlan {
    let nm = 0;
    for (let i = 1; i < points.length; i++) nm += distM(points[i - 1], points[i]) / 1852;
    const hours = Math.max(0.25, nm / 5.5); // conservative 5.5 kn passage speed
    const geo: Feature<LineString> = {
        type: 'Feature',
        properties: {
            _source: 'route-tracer',
            ...(legGrades && legGrades.length === points.length - 1 ? { legGrades: [...legGrades] } : {}),
        },
        geometry: { type: 'LineString', coordinates: points.map((p) => [p.lon, p.lat]) },
    };
    // Unnamed traces get a time-stamped label — the logbook duplicate check
    // keys on label + calendar day, so two unnamed traces on the same day
    // used to collide (the second silently lost its logbook entry).
    const stamp = new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false });
    const label = name.trim() || `Traced route ${stamp} (${points.length} pins)`;
    return {
        origin: `${label} — start`,
        destination: `${label} — end`,
        departureDate: new Date().toISOString(),
        originCoordinates: { lat: points[0].lat, lon: points[0].lon },
        destinationCoordinates: { lat: points[points.length - 1].lat, lon: points[points.length - 1].lon },
        distanceApprox: `${nm.toFixed(1)} NM`,
        // Fractional hours — every existing parser handles "0.5 hours";
        // "NN minutes" parsed to NULL and defaulted to a 12-hour spread.
        durationApprox: `${hours.toFixed(1)} hours`,
        overview: `Hand-traced route (${points.length} pins), graded leg-by-leg by the Route Tracer.`,
        // Interior pins only — origin/destinationCoordinates already carry the
        // endpoints; duplicating them made 32 log rows for 30 pins with two
        // zero-length legs.
        waypoints: points
            .slice(1, -1)
            .map((p, i) => ({ name: `Pin ${i + 2}`, coordinates: { lat: p.lat, lon: p.lon } })),
        routeGeoJSON: geo,
    };
}

// ── Guided Builder core (masterplan Phase 2) ───────────────────────────────

/**
 * Ramer–Douglas–Peucker on trace points (perpendicular tolerance in metres).
 * The "⚡ Auto to destination" chip runs the four-tier router and drops its
 * polyline back as PINS — a 60-vertex engine line would be marker soup, so
 * it decimates to the bends first. Also the track→trace path (Phase 4).
 */
export function rdpTracePoints(points: readonly TracePoint[], epsilonM: number): TracePoint[] {
    if (points.length <= 2) return [...points];
    const keep = new Uint8Array(points.length);
    keep[0] = 1;
    keep[points.length - 1] = 1;
    const stack: Array<[number, number]> = [[0, points.length - 1]];
    while (stack.length > 0) {
        const [s, e] = stack.pop()!;
        let maxD = 0;
        let maxI = -1;
        for (let i = s + 1; i < e; i++) {
            const d = closestOnLeg(points[i], points[s], points[e]).distM;
            if (d > maxD) {
                maxD = d;
                maxI = i;
            }
        }
        if (maxD > epsilonM && maxI > 0) {
            keep[maxI] = 1;
            stack.push([s, maxI], [maxI, e]);
        }
    }
    return points.filter((_, i) => keep[i] === 1);
}

/** True bearing a→b in degrees [0, 360). */
export function bearingDegBetween(a: TracePoint, b: TracePoint): number {
    const brg = (Math.atan2((b.lon - a.lon) * mPerLon(a.lat), (b.lat - a.lat) * M_PER_DEG_LAT) * 180) / Math.PI;
    return (brg + 360) % 360;
}

/** Octant arrow for a course chip — "↘ head 168°". */
export function courseArrow(deg: number): string {
    const arrows = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'] as const;
    return arrows[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

/** A proven (curated) lane near the punter, offered as a tap-to-accept ghost. */
export interface GhostLane {
    id: string;
    points: TracePoint[];
}

/** Curated fairway lanes whose bbox overlaps the given area — rendered as a
 *  dotted ghost while tracing; accepting one splices its points as pins. */
export function curatedLanesNear(bbox: [number, number, number, number]): GhostLane[] {
    return curatedFairwayCanalFeatures(bbox)
        .filter((f) => f.geometry.type === 'LineString')
        .map((f) => ({
            id: String((f.properties as Record<string, unknown> | null)?._id ?? 'lane'),
            points: (f.geometry as LineString).coordinates.map(([lon, lat]) => ({ lat, lon })),
        }));
}

// ── Fix-this-leg (masterplan Phase 3.2) ────────────────────────────────────

/** A*-cell traversal cost. Mirrors the engine's pricing philosophy: clear
 *  water 1×, thin water 4×, sub-keel caution 40× (passable — the skipper may
 *  accept a tide gate — but strongly avoided), uncharted 6×. */
function cellCost(grid: NavGrid, idx: number, keelM: number): number | null {
    const v = grid.cells[idx];
    if (Number.isNaN(v)) return null; // blocked
    if (v === CAUTION) return 40;
    if (v === UNKNOWN_OPEN) return 6;
    if (v >= keelM + THIN_MARGIN_M) return 1;
    if (v >= keelM) return 4;
    return 40;
}

/**
 * One-tap "Fix this leg": A* between the leg's two pins on the ALREADY-BUILT
 * tracer grid, searched inside a corridor around the leg (bounded work — the
 * grid can be 2M cells but a fix is local). Returns the detour as sparse
 * pins (RDP 20 m) INCLUDING both endpoints, or null when no clean path
 * exists — the modal then offers Acknowledge instead. Never fabricates.
 */
export function fixLegOnGrid(ctx: TracerContext, a: TracePoint, b: TracePoint): TracePoint[] | null {
    const grid = ctx.grid;
    if (!grid) return null;
    const keelM = ctx.draftM + DEFAULT_TIDE_SAFETY_M;
    const legM = distM(a, b);
    // Corridor: the leg's bbox padded by max(400 m, half the leg) each side.
    const padM = Math.max(400, legM * 0.5);
    const padLat = padM / M_PER_DEG_LAT;
    const padLon = padM / mPerLon(a.lat);
    const minX = Math.max(0, Math.floor((Math.min(a.lon, b.lon) - padLon - grid.minLon) / grid.dLon));
    const maxX = Math.min(grid.width - 1, Math.floor((Math.max(a.lon, b.lon) + padLon - grid.minLon) / grid.dLon));
    const minY = Math.max(0, Math.floor((Math.min(a.lat, b.lat) - padLat - grid.minLat) / grid.dLat));
    const maxY = Math.min(grid.height - 1, Math.floor((Math.max(a.lat, b.lat) + padLat - grid.minLat) / grid.dLat));
    const W = maxX - minX + 1;
    const H = maxY - minY + 1;
    if (W <= 0 || H <= 0 || W * H > 600_000) return null; // corridor too big — don't freeze the UI

    const toLocal = (p: TracePoint): { x: number; y: number } | null => {
        const x = Math.floor((p.lon - grid.minLon) / grid.dLon) - minX;
        const y = Math.floor((p.lat - grid.minLat) / grid.dLat) - minY;
        return x >= 0 && y >= 0 && x < W && y < H ? { x, y } : null;
    };
    // Snap a blocked endpoint to its nearest navigable neighbour (a pin ON
    // the flagged shallow is common — the fix must still be findable).
    const snapLocal = (p: TracePoint): { x: number; y: number } | null => {
        const l = toLocal(p);
        if (!l) return null;
        if (cellCost(grid, (l.y + minY) * grid.width + (l.x + minX), keelM) !== null) return l;
        for (let r = 1; r <= 4; r++) {
            for (let dy = -r; dy <= r; dy++) {
                for (let dx = -r; dx <= r; dx++) {
                    const x = l.x + dx;
                    const y = l.y + dy;
                    if (x < 0 || y < 0 || x >= W || y >= H) continue;
                    if (cellCost(grid, (y + minY) * grid.width + (x + minX), keelM) !== null) return { x, y };
                }
            }
        }
        return null;
    };
    const start = snapLocal(a);
    const goal = snapLocal(b);
    if (!start || !goal) return null;

    const gScore = new Float64Array(W * H).fill(Infinity);
    const cameFrom = new Int32Array(W * H).fill(-1);
    const startIdx = start.y * W + start.x;
    const goalIdx = goal.y * W + goal.x;
    gScore[startIdx] = 0;
    // Binary heap of [f, idx].
    const heap: Array<[number, number]> = [[0, startIdx]];
    const pop = (): [number, number] | undefined => {
        if (heap.length === 0) return undefined;
        const top = heap[0];
        const last = heap.pop()!;
        if (heap.length > 0) {
            heap[0] = last;
            let i = 0;
            for (;;) {
                const l = 2 * i + 1;
                const r = l + 1;
                let m = i;
                if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
                if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
                if (m === i) break;
                [heap[i], heap[m]] = [heap[m], heap[i]];
                i = m;
            }
        }
        return top;
    };
    const push = (f: number, idx: number): void => {
        heap.push([f, idx]);
        let i = heap.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (heap[p][0] <= heap[i][0]) break;
            [heap[i], heap[p]] = [heap[p], heap[i]];
            i = p;
        }
    };
    const h = (idx: number): number => {
        const x = idx % W;
        const y = (idx / W) | 0;
        return Math.hypot(x - goal.x, y - goal.y);
    };
    const DIRS = [
        [1, 0, 1],
        [-1, 0, 1],
        [0, 1, 1],
        [0, -1, 1],
        [1, 1, Math.SQRT2],
        [1, -1, Math.SQRT2],
        [-1, 1, Math.SQRT2],
        [-1, -1, Math.SQRT2],
    ] as const;
    let found = false;
    let expansions = 0;
    while (heap.length > 0 && expansions < 400_000) {
        const cur = pop()!;
        const idx = cur[1];
        if (idx === goalIdx) {
            found = true;
            break;
        }
        if (cur[0] > gScore[idx] + h(idx) + 1e-9) continue; // stale heap entry
        expansions++;
        const x = idx % W;
        const y = (idx / W) | 0;
        for (const [dx, dy, mul] of DIRS) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const nIdx = ny * W + nx;
            const cost = cellCost(grid, (ny + minY) * grid.width + (nx + minX), keelM);
            if (cost === null) continue;
            const g = gScore[idx] + cost * mul;
            if (g < gScore[nIdx]) {
                gScore[nIdx] = g;
                cameFrom[nIdx] = idx;
                push(g + h(nIdx), nIdx);
            }
        }
    }
    if (!found) return null;

    // Reconstruct → lat/lon → decimate to editable pins.
    const cells: TracePoint[] = [];
    for (let idx = goalIdx; idx !== -1; idx = cameFrom[idx]) {
        const x = (idx % W) + minX;
        const y = ((idx / W) | 0) + minY;
        cells.push({ lat: grid.minLat + (y + 0.5) * grid.dLat, lon: grid.minLon + (x + 0.5) * grid.dLon });
        if (idx === startIdx) break;
    }
    cells.reverse();
    const path = [a, ...cells.slice(1, -1), b];
    return rdpTracePoints(path, Math.max(15, ctx.resM * 1.5));
}

// ── THE departure window (masterplan Phase 3.4) ────────────────────────────

function intersectWindows(
    xs: Array<{ o: number; c: number }>,
    ys: Array<{ o: number; c: number }>,
): Array<{ o: number; c: number }> {
    const out: Array<{ o: number; c: number }> = [];
    for (const x of xs) {
        for (const y of ys) {
            const o = Math.max(x.o, y.o);
            const c = Math.min(x.c, y.c);
            if (c > o) out.push({ o, c });
        }
    }
    return out.sort((p, q) => p.o - q.o);
}

/**
 * The report-modal headline: intersect every tide-gated leg's windows into
 * ONE departure call — "leave 09:10–13:30 today and every tide gate clears".
 * Returns null when no leg needs tide (nothing to say) or tide data is
 * unavailable (never guess). NOTE v1 checks the gates against the same clock
 * (no transit-time offset) — honest for day-hop traces where gates sit within
 * a few hours of departure; the label says "gates checked for today's tide".
 */
export async function commonDepartureWindowLabel(
    verdicts: readonly TraceLegVerdict[],
    draftM: number,
): Promise<string | null> {
    const gated = verdicts.filter((v) => v.needsTide && v.minDepthM !== null && v.minAt);
    if (gated.length === 0) return null;
    const fromMs = Date.now();
    const untilMs = fromMs + 24 * 3600_000;
    let common: Array<{ o: number; c: number }> | null = null;
    for (const v of gated) {
        const curve = await fetchTideCurve(v.minAt!.lat, v.minAt!.lon, fromMs, untilMs);
        if (!curve) return null; // offline — the per-leg red rows still stand
        const res = computeTidalWindows({
            minDepthM: v.minDepthM!,
            draftM,
            tide: tideFieldFromCurve(curve),
            fromMs,
            untilMs,
        });
        if (res.alwaysOpen) continue;
        const wins = res.windows.map((w) => ({ o: w.openMs, c: w.closeMs }));
        if (wins.length === 0) return 'no tide window clears every gate in 24 h — wait or re-route';
        common = common === null ? wins : intersectWindows(common, wins);
        if (common.length === 0) return 'no COMMON window clears every gate in 24 h — split the passage';
    }
    if (!common || common.length === 0) return null;
    const w = common[0];
    return `leave ${fmtHm(w.o)}–${fmtHm(w.c)} ${dayWord(w.o)} and every tide gate clears (checked at today's tide)`;
}
