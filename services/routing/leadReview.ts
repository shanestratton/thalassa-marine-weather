/**
 * leadReview — what the chart says ON and BESIDE a lead besides its depth
 * (inshore router, Phase 1 review). PURE: no React, no I/O, no storage.
 *
 * Why: the lead graph's 'clear' class used to mean only "charted DRVAL1 ≥
 * draft + 0.5 m all along". It never read obstructions, structures or survey
 * quality, so on the Newport cells NAVLNE 2373 and 2920 were inked clear 36 m
 * and 45 m from obstructions of unknown depth (OBSTRN 145 and 2627, no
 * VALSOU) — inside the router's 60 m obstruction buffer, where the router
 * flags the same water red — and a bridge the owner decided must BLOCK when
 * its clearance is unknown would have been inked clear too.
 *
 * The draft-independent facts, per compiled span:
 *   • hazards — every S-57 OBSTRN / WRECKS / UWTROC (point, line or area)
 *     within LEAD_HAZARD_BUFFER_M of the span, with its VALSOU (null when the
 *     chart gives none: depth over it unknown). The classifier demotes a span
 *     when any of them is unknown or shallower than draft + UKC.
 *   • structures — every S-57 BRIDGE, SLCONS (shoreline construction),
 *     PONTON, or overhead cable / pipe / conveyor (CBLOHD / PIPOHD / CONVYR)
 *     on the span (within
 *     LEAD_STRUCTURE_TOUCH_M, or crossed). BRIDGE and the overhead lines keep
 *     their clearance facts (overheadClearance.chartStructureClearance: the
 *     lowest charted of VERCLR / VERCCL / VERCSA, and whether the bridge
 *     opens); the classifier reads them against the vessel's air draft
 *     (Part B, owner decisions 2026-09-29/30).
 *   • structuresUnknown — the data under the span does not CARRY the
 *     structure layers at all (LEAD_REQUIRED_STRUCTURE_LAYERS). Both cell
 *     pipelines extract BRIDGE, PONTON, CBLOHD, PIPOHD and CONVYR since Part B
 *     (schema 2), but every cell installed today was converted before it
 *     (schema 1), so "nothing on the line" cannot be known there and the lead
 *     is never clear (Phase 1 review, 2026-09-29). An EMPTY collection is the
 *     "extracted, none charted" contract a re-extracted cell meets; a missing
 *     key is unknown.
 *   • survey — the span cut into stretches by survey grade and charted
 *     depth: the finest survey on each piece owns it — M_QUAL zones, depth
 *     bands and land paint ranked together (surveyGradeAt, the route's own
 *     rule since the round-3 review, 2026-09-30; the worst CATZOC among the
 *     owning zones). A stretch no M_QUAL covers, whose finest survey has no
 *     zone on it, or whose owning zone carries no CATZOC, is NOT GRADED
 *     (catzoc null) — a coarser cell's grade is never borrowed. The
 *     classifier reads each stretch against the draft (owner decisions 3 and
 *     4, 2026-09-30):
 *       – A1, A2, B and C: clear only if depth − the grade's vertical error
 *         (catzocVerticalErrorM) is still at least draft + UKC;
 *       – D and U: never clear (no error bound to trust);
 *       – not graded: never clear ('survey not graded').
 *     worstCatzoc keeps the single worst grade for display.
 *
 * Exact where it matters: areas are cut at their edges (leadLandClip's
 * piecesAlong) and distances are segment-to-segment, not sampled.
 */
import type { Position } from 'geojson';
import { S57_CLEARANCE_STRUCTURE_CLASSES } from '../enc/types';
import { depthSurveyOwners } from '../enc/scaleShadow';
import {
    chartStructureClearance,
    CLEARANCE_STRUCTURE_LAYERS,
    type ClearanceStructureLayer,
    type StructureClearance,
} from './overheadClearance';
import {
    areaGeometry,
    chartedDepthAt,
    indexArea,
    isS57Feature,
    piecesAlong,
    pointInArea,
    readNum,
    type ClipCollectionLike,
    type ClipFeatureLike,
    type IndexedArea,
    type IndexedDepthArea,
} from './leadLandClip';

/** The router's obstruction buffer (InshoreRouter.ts routeOpts
 *  obstructionBufferM): inside it the router flags a lead caution. */
export const LEAD_HAZARD_BUFFER_M = 60;
/** A structure this close to the line is on it (rounding at a crossing). */
export const LEAD_STRUCTURE_TOUCH_M = 10;
/** CATZOC D (5) and U (6): poor or unassessed survey, with no vertical
 * error bound to allow for — never clear (owner decision 3, 2026-09-30).
 * C (4) is no longer blanket review: it is read against its error bound. */
export const LEAD_POOR_SURVEY_CATZOC = 5;

/**
 * The S-57 CATZOC vertical error at a charted depth, metres (IHO S-57
 * Appendix B.1 M_QUAL; services/enc/types.ts CATZOC): A1 (1) 0.5 m + 1% of
 * depth; A2 (2) and B (3) 1.0 m + 2%; C (4) 2.0 m + 5%. Null for D (5), U (6)
 * or anything else: no bound, so no margin can be trusted.
 */
export function catzocVerticalErrorM(catzoc: number, depthM: number): number | null {
    const d = Math.max(0, depthM);
    switch (catzoc) {
        case 1:
            return 0.5 + 0.01 * d;
        case 2:
        case 3:
            return 1.0 + 0.02 * d;
        case 4:
            return 2.0 + 0.05 * d;
        default:
            return null;
    }
}

/**
 * What a survey grade says about a charted depth against the water a keel
 * needs (owner decisions 3 and 4, 2026-09-30) — the ONE rule the lead review
 * (leadCompiler surveyReasons) and the route (services/engine/shallowRuns
 * collectSurveyRuns, owner decision 9, 2026-09-30) both read:
 *   • 'ungraded' — no CATZOC owns it (decision 4);
 *   • 'poor' — CATZOC D or U, or a grade with no vertical error bound;
 *   • 'margin' — the charted depth clears `needM` (draft + UKC) but the depth
 *     less the grade's vertical error (catzocVerticalErrorM) does not;
 *     `errorM` is that error (decision 3 exactly as the leads read it);
 *   • 'ok' — the grade's error still leaves `needM`; or the charted depth is
 *     already below `needM`, which is a DEPTH matter (needs tide: decisions
 *     6 and 7), not a survey one; or no depth is charted to read it against
 *     (uncharted water is another rule's business).
 */
export type SurveyVerdict =
    | { kind: 'ok' }
    | { kind: 'margin'; errorM: number }
    | { kind: 'poor' }
    | { kind: 'ungraded' };

export function surveyVerdict(
    catzoc: number | null,
    depthM: number | null,
    needM: number,
    opts: { belowNeed?: boolean } = {},
): SurveyVerdict {
    if (catzoc === null) return { kind: 'ungraded' };
    if (catzoc >= LEAD_POOR_SURVEY_CATZOC) return { kind: 'poor' };
    if (depthM === null) return { kind: 'ok' };
    const errorM = catzocVerticalErrorM(catzoc, depthM);
    if (errorM === null) return { kind: 'poor' };
    const clears = depthM >= needM - 1e-9;
    // `belowNeed` (the ROUTE's reading, round-3 review, 2026-09-30): decision
    // 9's own words — "where charted depth minus the zone error is below
    // draft + UKC" — cover water already charted shallower than the keel
    // needs too. There the route is red with a tide chip whose window is
    // worked from the charted depth alone; the survey error rides that chip
    // ("survey may be out by 2.1 m") and the caveat. The drawing does not
    // change (red beats amber). The lead review keeps reading it as a depth
    // matter: a charted-shallow lead is 'needs tide' already (decision 6).
    if (!clears) return opts.belowNeed ? { kind: 'margin', errorM } : { kind: 'ok' };
    return depthM - errorM < needM - 1e-9 ? { kind: 'margin', errorM } : { kind: 'ok' };
}

/** An M_QUAL zone: its area (with `_scaleRank`) and its CATZOC (null: none). */
export interface SurveyZone {
    area: IndexedArea;
    catzoc: number | null;
}

/**
 * Who grades the survey at one spot — ONE rule for the lead review
 * (reviewAlongLine) and the route (services/engine/shallowRuns
 * collectSurveyRuns), round-3 review, 2026-09-30. Everything charted on the
 * spot is ranked together — M_QUAL zones, depth bands AND land paint — and
 * the finest survey owns it (scaleShadow depthSurveyOwners: the finest rank,
 * every rank tied with it, and every unranked survey, whose fineness is
 * unknown). The grade is the worst CATZOC among the owning ZONES; a zone
 * without a CATZOC grades nothing (null). When no owning survey has a zone on
 * the spot (`zoned: false`) — a finer cell charts the water but carries no
 * zone there — a coarser cell's grade is NEVER borrowed: the caller calls it
 * not graded (decision 4), or not checked when that cell's data has no M_QUAL
 * at all. The leads used to rank the zones alone, so a finer band with no
 * zone read a coarser zone's A1 and could come out clear where the route drew
 * the same water amber 'ungraded'. Null when nothing charted covers the spot.
 */
export function surveyGradeAt(
    lon: number,
    lat: number,
    zones: readonly SurveyZone[],
    bands: readonly IndexedArea[],
    land: readonly IndexedArea[],
): { zoned: boolean; catzoc: number | null; finestRank: number | null } | null {
    const zs = zones.filter((z) => pointInArea(z.area, lon, lat));
    const ds = bands.filter((a) => pointInArea(a, lon, lat));
    const ls = land.filter((a) => pointInArea(a, lon, lat));
    if (zs.length + ds.length + ls.length === 0) return null;
    const ranks = [...zs.map((z) => z.area.rank), ...ds.map((a) => a.rank), ...ls.map((a) => a.rank)];
    let finestRank: number | null = null;
    for (const r of ranks) if (r !== null && (finestRank === null || r > finestRank)) finestRank = r;
    const zoneOwners = depthSurveyOwners(ranks).owners.filter((i) => i < zs.length);
    if (zoneOwners.length === 0) return { zoned: false, catzoc: null, finestRank };
    let catzoc: number | null = null;
    for (let k = 0; k < zoneOwners.length; k++) {
        const c = zs[zoneOwners[k]].catzoc;
        catzoc = k === 0 ? c : catzoc === null || c === null ? null : Math.max(catzoc, c);
    }
    return { zoned: true, catzoc, finestRank };
}

export type LeadHazardLayer = 'OBSTRN' | 'WRECKS' | 'UWTROC';
export type LeadStructureLayer = 'BRIDGE' | 'SLCONS' | 'PONTON' | 'CBLOHD' | 'PIPOHD' | 'CONVYR';
const HAZARD_LAYERS: readonly LeadHazardLayer[] = ['OBSTRN', 'WRECKS', 'UWTROC'];
const STRUCTURE_LAYERS: readonly LeadStructureLayer[] = ['BRIDGE', 'SLCONS', 'PONTON', 'CBLOHD', 'PIPOHD', 'CONVYR'];
/** Structures with a vertical clearance (VERCLR) a mast has to pass under —
 * the router's own list (overheadClearance CLEARANCE_STRUCTURE_LAYERS). */
export const LEAD_CLEARANCE_LAYERS: ReadonlySet<LeadStructureLayer> = new Set(CLEARANCE_STRUCTURE_LAYERS);
/**
 * The structure layers the data must CARRY (an empty collection counts)
 * before a lead can be reviewed for structures. SLCONS is not among them: the
 * pipelines do extract it, and an old cell without it cannot be told from a
 * cell with none — the bridge and overhead-clearance layers are the ones the
 * owner's "unknown clearance blocks" rule is about.
 */
export const LEAD_REQUIRED_STRUCTURE_LAYERS = S57_CLEARANCE_STRUCTURE_CLASSES;

/** The chart layers the review reads (merged the compiler's way). */
export interface LeadReviewLayers {
    OBSTRN?: ClipCollectionLike;
    WRECKS?: ClipCollectionLike;
    UWTROC?: ClipCollectionLike;
    BRIDGE?: ClipCollectionLike;
    SLCONS?: ClipCollectionLike;
    PONTON?: ClipCollectionLike;
    CBLOHD?: ClipCollectionLike;
    PIPOHD?: ClipCollectionLike;
    CONVYR?: ClipCollectionLike;
    M_QUAL?: ClipCollectionLike;
    /** Extents [w, s, e, n] of merged cells whose data carries no structure
     * layers (mergeLeadCells): a lead touching one is not reviewed for them. */
    structureGaps?: readonly (readonly [number, number, number, number])[];
}

export interface LeadHazardNear {
    layer: LeadHazardLayer;
    rcid?: number;
    /** Closest approach of the span, metres (0: the span runs through it). */
    distanceM: number;
    /** Charted depth over it (VALSOU); null when the chart gives none. */
    valsouM: number | null;
}

export interface LeadStructureOn {
    layer: LeadStructureLayer;
    rcid?: number;
    distanceM: number;
    /** BRIDGE / overhead line vertical clearance (VERCLR, m); null when not charted. */
    verclrM?: number | null;
    /** BRIDGE / overhead line: the GOVERNING clearance (the lowest charted of
     * VERCLR, VERCCL, VERCSA; overheadClearance.ts), null when none is. */
    clearanceM?: number | null;
    /** BRIDGE: it opens (CATBRG opening / swing / lifting / …): only a
     * clearance charted for it closed counts. */
    opening?: boolean;
    /** Its charted name (OBJNAM), when it has one — a blocked lead names the
     * structure that blocks it (round 2, 2026-09-30). */
    name?: string;
}

/** The metres of a span under one survey grade AND one charted depth (round-3
 * review, 2026-09-30: each piece is read against its own depth — one minimum
 * per grade let a shallow piece hide the margin of a deeper one). */
export interface LeadSurveyStretch {
    /** CATZOC of the finest survey owning these metres (the worst within its
     * rank); null: NOT GRADED — no M_QUAL covers them, the finest survey there
     * has no zone on them (surveyGradeAt), or its zone carries no CATZOC. */
    catzoc: number | null;
    /** Charted depth (the compiler's charted-depth rule) under these metres;
     * null where none is charted. */
    minDepthM: number | null;
    lengthM: number;
}

export interface LeadSpanReview {
    hazards: LeadHazardNear[];
    structures: LeadStructureOn[];
    /** Worst CATZOC under the span (finest survey per stretch); null when no
     * graded M_QUAL covers any of it. */
    worstCatzoc: number | null;
    /** The span by survey grade, worst grade first, ungraded last (see the
     * header). Empty only for a span too short to review. */
    survey: LeadSurveyStretch[];
    /** The data under the span does not carry the structure layers
     * (LEAD_REQUIRED_STRUCTURE_LAYERS): `structures` being empty proves
     * nothing about bridges or overhead lines here. */
    structuresUnknown: boolean;
}

/** Nothing charted on or beside the line (a fresh object each time). */
export const emptyLeadReview = (): LeadSpanReview => ({
    hazards: [],
    structures: [],
    worstCatzoc: null,
    survey: [],
    structuresUnknown: false,
});

type BBox = [number, number, number, number];

interface Shape {
    points: Position[];
    lines: Position[][];
    area: IndexedArea | null;
    bbox: BBox;
}

interface ReviewItem<L> {
    layer: L;
    rcid?: number;
    valsouM: number | null;
    verclrM: number | null;
    /** Clearance facts, for BRIDGE / CBLOHD / PIPOHD / CONVYR only. */
    clearance?: StructureClearance;
    name?: string;
    shape: Shape;
}

export interface LeadReviewIndex {
    hazards: ReviewItem<LeadHazardLayer>[];
    structures: ReviewItem<LeadStructureLayer>[];
    /** M_QUAL zones; catzoc null where the zone carries none (not graded). */
    zones: SurveyZone[];
    /** The layer set carries no collection for some required structure layer. */
    structuresMissing: boolean;
    /** Extents where the merged cells carry none (see LeadReviewLayers). */
    structureGaps: BBox[];
}

function bboxOf(points: readonly Position[]): BBox {
    const b: BBox = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of points) {
        if (p[0] < b[0]) b[0] = p[0];
        if (p[1] < b[1]) b[1] = p[1];
        if (p[0] > b[2]) b[2] = p[0];
        if (p[1] > b[3]) b[3] = p[1];
    }
    return b;
}

const finitePos = (c: unknown): c is Position =>
    Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]);

/** One or more shapes for a feature (a MultiPoint is one shape per point). */
function shapesOf(feature: ClipFeatureLike): Shape[] {
    const g = feature.geometry;
    if (!g || !Array.isArray(g.coordinates)) return [];
    const coords = g.coordinates as unknown[];
    const empty = { points: [], lines: [], area: null } as Omit<Shape, 'bbox'>;
    switch (g.type) {
        case 'Point':
            return finitePos(coords) ? [{ ...empty, points: [coords], bbox: bboxOf([coords]) }] : [];
        case 'MultiPoint':
            return coords.filter(finitePos).map((p) => ({ ...empty, points: [p], bbox: bboxOf([p]) }));
        case 'LineString':
        case 'MultiLineString': {
            const raw = (g.type === 'LineString' ? [coords] : coords) as unknown[][];
            const lines = raw.map((r) => (Array.isArray(r) ? r.filter(finitePos) : [])).filter((r) => r.length >= 1);
            if (lines.length === 0) return [];
            return [{ ...empty, lines, bbox: bboxOf(lines.flat()) }];
        }
        case 'Polygon':
        case 'MultiPolygon': {
            const geometry = areaGeometry(feature);
            if (!geometry) return [];
            const area = indexArea(geometry, readNum(feature.properties, '_scaleRank'));
            const lines = area.rings.map((r) => r.ring.filter(finitePos));
            return [{ ...empty, lines, area, bbox: area.bbox }];
        }
        default:
            return [];
    }
}

/** Build the review index for a merged layer set (cheap: bboxes + rings). */
export function buildLeadReviewIndex(layers: LeadReviewLayers): LeadReviewIndex {
    const items = <L extends LeadHazardLayer | LeadStructureLayer>(names: readonly L[]): ReviewItem<L>[] => {
        const out: ReviewItem<L>[] = [];
        for (const layer of names) {
            for (const f of layers[layer]?.features ?? []) {
                // Chart features only: synthetic router furniture (pair wings,
                // mark-inference discs, OSM reef/aeroway) never reaches here
                // from the cell merge, and is not the chart's claim if it does.
                if (!isS57Feature(f)) continue;
                const rcid = readNum(f.properties, 'rcid');
                const clearance = LEAD_CLEARANCE_LAYERS.has(layer as LeadStructureLayer)
                    ? chartStructureClearance(layer as ClearanceStructureLayer, f.properties)
                    : undefined;
                const objnam = f.properties?.OBJNAM;
                const name = typeof objnam === 'string' && objnam.trim() !== '' ? objnam.trim() : undefined;
                for (const shape of shapesOf(f)) {
                    out.push({
                        layer,
                        ...(rcid !== null ? { rcid } : {}),
                        valsouM: readNum(f.properties, 'VALSOU'),
                        verclrM: readNum(f.properties, 'VERCLR'),
                        ...(clearance ? { clearance } : {}),
                        ...(name ? { name } : {}),
                        shape,
                    });
                }
            }
        }
        return out;
    };
    const zones: LeadReviewIndex['zones'] = [];
    for (const f of layers.M_QUAL?.features ?? []) {
        if (!isS57Feature(f)) continue;
        const geometry = areaGeometry(f);
        if (!geometry) continue;
        // A zone without a CATZOC still OWNS its ground when it is the finest
        // survey there: it grades nothing, so the stretch is not graded
        // (decision 4) rather than falling through to a coarser zone's grade.
        zones.push({
            area: indexArea(geometry, readNum(f.properties, '_scaleRank')),
            catzoc: readNum(f.properties, 'CATZOC'),
        });
    }
    return {
        hazards: items(HAZARD_LAYERS),
        structures: items(STRUCTURE_LAYERS),
        zones,
        structuresMissing: LEAD_REQUIRED_STRUCTURE_LAYERS.some((k) => layers[k] === undefined),
        structureGaps: (layers.structureGaps ?? []).map((b) => [b[0], b[1], b[2], b[3]] as BBox),
    };
}

// ── Distances (local equirectangular metres around the span) ─────────

const M_PER_LAT = 110_540;

interface Frame {
    kx: number;
}
const toXY = (f: Frame, p: Position): [number, number] => [p[0] * f.kx, p[1] * M_PER_LAT];

function pointSegM(f: Frame, p: Position, a: Position, b: Position): number {
    const [px, py] = toXY(f, p);
    const [ax, ay] = toXY(f, a);
    const [bx, by] = toXY(f, b);
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
    return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

function segmentsCross(a: Position, b: Position, c: Position, d: Position): boolean {
    const o = (p: Position, q: Position, r: Position): number =>
        (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    const d1 = o(c, d, a);
    const d2 = o(c, d, b);
    const d3 = o(a, b, c);
    const d4 = o(a, b, d);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Closest approach between a polyline (≥ 2 vertices) and another polyline
 * or a single point (0 when they cross). Exact for straight segments:
 * without a crossing, the minimum is at a vertex of one of them. */
function polylineGapM(f: Frame, line: readonly Position[], other: readonly Position[]): number {
    for (let i = 0; i < line.length - 1; i++) {
        for (let j = 0; j < other.length - 1; j++) {
            if (segmentsCross(line[i], line[i + 1], other[j], other[j + 1])) return 0;
        }
    }
    let best = Infinity;
    for (let i = 0; i < line.length - 1; i++)
        for (const q of other) best = Math.min(best, pointSegM(f, q, line[i], line[i + 1]));
    for (let j = 0; j < other.length - 1; j++)
        for (const p of line) best = Math.min(best, pointSegM(f, p, other[j], other[j + 1]));
    return best;
}

function shapeGapM(f: Frame, span: readonly Position[], shape: Shape): number {
    if (shape.area) {
        const area = shape.area;
        if (span.some((p) => pointInArea(area, p[0], p[1]))) return 0;
        if (piecesAlong([area], span).some((q) => pointInArea(area, q.lon, q.lat))) return 0;
    }
    let best = Infinity;
    for (const p of shape.points) best = Math.min(best, polylineGapM(f, span, [p]));
    for (const l of shape.lines) best = Math.min(best, polylineGapM(f, span, l));
    return best;
}

const grow = (b: BBox, m: number, kx: number): BBox => [
    b[0] - m / kx,
    b[1] - m / M_PER_LAT,
    b[2] + m / kx,
    b[3] + m / M_PER_LAT,
];
const hits = (a: BBox, b: BBox): boolean => !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);

/**
 * The review facts for one span (draft-independent). `depth` is the charted
 * depth bands (leadLandClip's ChartAreaIndex.depth) the survey stretches read
 * their depth from; without it every stretch's depth is null. `land` is the
 * land paint (ChartAreaIndex.land): it ranks with the zones and bands for who
 * owns the survey (surveyGradeAt).
 */
export function reviewAlongLine(
    index: LeadReviewIndex,
    span: readonly Position[],
    depth: readonly IndexedDepthArea[] = [],
    land: readonly IndexedArea[] = [],
): LeadSpanReview {
    if (span.length < 2) return emptyLeadReview();
    const lat0 = span[0][1];
    const frame: Frame = { kx: 111_320 * Math.cos((lat0 * Math.PI) / 180) };
    const sb = bboxOf(span);

    const hazards: LeadHazardNear[] = [];
    const nearHaz = grow(sb, LEAD_HAZARD_BUFFER_M + 5, frame.kx);
    for (const h of index.hazards) {
        if (!hits(h.shape.bbox, nearHaz)) continue;
        const d = shapeGapM(frame, span, h.shape);
        if (d > LEAD_HAZARD_BUFFER_M) continue;
        hazards.push({
            layer: h.layer,
            ...(h.rcid !== undefined ? { rcid: h.rcid } : {}),
            distanceM: d,
            valsouM: h.valsouM,
        });
    }

    const structures: LeadStructureOn[] = [];
    const nearStr = grow(sb, LEAD_STRUCTURE_TOUCH_M + 5, frame.kx);
    for (const s of index.structures) {
        if (!hits(s.shape.bbox, nearStr)) continue;
        const d = shapeGapM(frame, span, s.shape);
        if (d > LEAD_STRUCTURE_TOUCH_M) continue;
        structures.push({
            layer: s.layer,
            ...(s.rcid !== undefined ? { rcid: s.rcid } : {}),
            distanceM: d,
            ...(LEAD_CLEARANCE_LAYERS.has(s.layer)
                ? {
                      verclrM: s.verclrM,
                      clearanceM: s.clearance?.clearanceM ?? null,
                      opening: s.clearance?.opening === true,
                  }
                : {}),
            ...(s.name ? { name: s.name } : {}),
        });
    }
    const structuresUnknown = index.structuresMissing || index.structureGaps.some((b) => hits(b, sb));

    // Survey quality: who owns each piece is the route's own rule
    // (surveyGradeAt — zones, depth bands and land paint ranked together, the
    // worst grade among the owning zones, never a coarser cell's grade
    // borrowed). Cut at zone, band AND land edges, so each piece has one
    // grade and one depth; each (grade, depth) is its own stretch.
    const zones = index.zones.filter((z) => hits(z.area.bbox, sb));
    const bands = depth.filter((d) => hits(d.bbox, sb));
    const landNear = land.filter((a) => hits(a.bbox, sb));
    const byGrade = new Map<string, LeadSurveyStretch>();
    for (const q of piecesAlong([...zones.map((z) => z.area), ...bands, ...landNear], span)) {
        const at = surveyGradeAt(q.lon, q.lat, zones, bands, landNear);
        const grade = at && at.zoned ? at.catzoc : null;
        const d = bands.length > 0 ? chartedDepthAt(bands, q.lon, q.lat) : null;
        const key = `${grade}|${d}`;
        const s = byGrade.get(key) ?? { catzoc: grade, minDepthM: d, lengthM: 0 };
        s.lengthM += q.m;
        byGrade.set(key, s);
    }
    const survey = [...byGrade.values()].sort(
        (a, b) =>
            Number(a.catzoc === null) - Number(b.catzoc === null) ||
            (b.catzoc ?? 0) - (a.catzoc ?? 0) ||
            b.lengthM - a.lengthM,
    );
    const graded = survey.filter((x) => x.catzoc !== null).map((x) => x.catzoc as number);
    const worstCatzoc = graded.length > 0 ? Math.max(...graded) : null;

    hazards.sort((a, b) => a.distanceM - b.distanceM);
    structures.sort((a, b) => a.distanceM - b.distanceM);
    return { hazards, structures, worstCatzoc, survey, structuresUnknown };
}
