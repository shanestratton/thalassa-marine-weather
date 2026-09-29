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
 *     PONTON, or overhead cable / pipe (CBLOHD / PIPOHD) on the span (within
 *     LEAD_STRUCTURE_TOUCH_M, or crossed). BRIDGE and the overhead lines keep
 *     their VERCLR for Phase 2, which has to BLOCK unknown clearances.
 *   • structuresUnknown — the data under the span does not CARRY the
 *     structure layers at all (LEAD_REQUIRED_STRUCTURE_LAYERS). Neither cell
 *     pipeline extracts BRIDGE, PONTON, CBLOHD or PIPOHD yet (the SENC
 *     extractor's "Deferred" list; the Pi's ENC_LAYERS), so "nothing on the
 *     line" cannot be known and the lead is never clear (Phase 1 review,
 *     2026-09-29). An EMPTY collection is the "extracted, none charted"
 *     contract a re-extracted cell has to meet; a missing key is unknown.
 *   • worstCatzoc — the worst M_QUAL CATZOC under the span, the finest survey
 *     owning each stretch (the same `_scaleRank` rule as depth): C, D or U
 *     (4, 5, 6) is a "verify visually" survey (services/enc/types.ts).
 *
 * Exact where it matters: areas are cut at their edges (leadLandClip's
 * piecesAlong) and distances are segment-to-segment, not sampled.
 */
import type { Position } from 'geojson';
import {
    areaGeometry,
    indexArea,
    isS57Feature,
    piecesAlong,
    pointInArea,
    readNum,
    type ClipCollectionLike,
    type ClipFeatureLike,
    type IndexedArea,
} from './leadLandClip';

/** The router's obstruction buffer (InshoreRouter.ts routeOpts
 *  obstructionBufferM): inside it the router flags a lead caution. */
export const LEAD_HAZARD_BUFFER_M = 60;
/** A structure this close to the line is on it (rounding at a crossing). */
export const LEAD_STRUCTURE_TOUCH_M = 10;
/** CATZOC C (4), D (5) and U (6): partial, poor or unassessed survey. */
export const LEAD_POOR_SURVEY_CATZOC = 4;

export type LeadHazardLayer = 'OBSTRN' | 'WRECKS' | 'UWTROC';
export type LeadStructureLayer = 'BRIDGE' | 'SLCONS' | 'PONTON' | 'CBLOHD' | 'PIPOHD';
const HAZARD_LAYERS: readonly LeadHazardLayer[] = ['OBSTRN', 'WRECKS', 'UWTROC'];
const STRUCTURE_LAYERS: readonly LeadStructureLayer[] = ['BRIDGE', 'SLCONS', 'PONTON', 'CBLOHD', 'PIPOHD'];
/** Structures with a vertical clearance (VERCLR) a mast has to pass under. */
const CLEARANCE_LAYERS: ReadonlySet<LeadStructureLayer> = new Set(['BRIDGE', 'CBLOHD', 'PIPOHD']);
/**
 * The structure layers the data must CARRY (an empty collection counts)
 * before a lead can be reviewed for structures. SLCONS is not among them: the
 * pipelines do extract it, and an old cell without it cannot be told from a
 * cell with none — the bridge and overhead-clearance layers are the ones the
 * owner's "unknown clearance blocks" rule is about.
 */
export const LEAD_REQUIRED_STRUCTURE_LAYERS = ['BRIDGE', 'PONTON', 'CBLOHD', 'PIPOHD'] as const;

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
}

export interface LeadSpanReview {
    hazards: LeadHazardNear[];
    structures: LeadStructureOn[];
    /** Worst CATZOC under the span (finest survey per stretch); null when no
     * M_QUAL covers any of it. */
    worstCatzoc: number | null;
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
    shape: Shape;
}

export interface LeadReviewIndex {
    hazards: ReviewItem<LeadHazardLayer>[];
    structures: ReviewItem<LeadStructureLayer>[];
    zones: { area: IndexedArea; catzoc: number }[];
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
                for (const shape of shapesOf(f)) {
                    out.push({
                        layer,
                        ...(rcid !== null ? { rcid } : {}),
                        valsouM: readNum(f.properties, 'VALSOU'),
                        verclrM: readNum(f.properties, 'VERCLR'),
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
        const catzoc = readNum(f.properties, 'CATZOC');
        const geometry = areaGeometry(f);
        if (catzoc === null || !geometry) continue;
        zones.push({ area: indexArea(geometry, readNum(f.properties, '_scaleRank')), catzoc });
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

/** The review facts for one span (draft-independent). */
export function reviewAlongLine(index: LeadReviewIndex, span: readonly Position[]): LeadSpanReview {
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
            ...(CLEARANCE_LAYERS.has(s.layer) ? { verclrM: s.verclrM } : {}),
        });
    }
    const structuresUnknown = index.structuresMissing || index.structureGaps.some((b) => hits(b, sb));

    // Survey quality: the finest zone owns each stretch; worst within a rank.
    let worstCatzoc: number | null = null;
    const zones = index.zones.filter((z) => hits(z.area.bbox, sb));
    if (zones.length > 0) {
        for (const q of piecesAlong(
            zones.map((z) => z.area),
            span,
        )) {
            let bestRank = -Infinity;
            let here: number | null = null;
            for (const z of zones) {
                const rank = z.area.rank ?? -Infinity;
                if (here !== null && rank < bestRank) continue;
                if (!pointInArea(z.area, q.lon, q.lat)) continue;
                if (here === null || rank > bestRank) {
                    bestRank = rank;
                    here = z.catzoc;
                } else here = Math.max(here, z.catzoc);
            }
            if (here !== null && (worstCatzoc === null || here > worstCatzoc)) worstCatzoc = here;
        }
    }

    hazards.sort((a, b) => a.distanceM - b.distanceM);
    structures.sort((a, b) => a.distanceM - b.distanceM);
    return { hazards, structures, worstCatzoc, structuresUnknown };
}
