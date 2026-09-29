/**
 * leadCompiler — charted cells in, a typed, directed LEAD GRAPH out
 * (inshore router, Phase 1: shown on the chart only, routes nothing yet).
 *
 * PURE: no React, no storage, no network. The one I/O-free entry point is
 * compileLeadGraph(layers, options); mergeLeadCells() builds its input from
 * whole cells the same way the router merges them; the cache helpers keep one
 * compile per cell set (and one classification per draft).
 *
 * What counts as a lead (docs/INSHORE_ROUTING_MASTERPLAN.md, and the Phase 1
 * brief in thalassa-ux-audit/inshore-routing-research.json):
 *   • 'recommended-track' — RECTRC with CATTRK 1 (based on fixed marks) or 2
 *     (not based on fixed marks). The on-water, followable part of a lead.
 *     Segments that share an end point join into one network.
 *   • 'leading-line' — the ON-WATER span of a NAVLNE with CATNAV 3. A leading
 *     line is drawn on to its marks, usually ashore; the land extension is cut
 *     off (no compiled edge has any length over hard land — see
 *     leadLandClip.ts), and where a RECTRC runs along the same line the RECTRC
 *     span IS the edge: the leading line is not drawn over it again.
 *   • 'channel' — the lateral-gate chain of a numbered buoyed channel, from the
 *     Seaway gate extractor (services/seaway/*): "pass between the marks".
 *   CATNAV 1 (clearing line: the edge of a danger) and CATNAV 2 (transit /
 *   bearing) are NEVER leads. OSM seamark leading lines are compiled only when
 *   passed in separately, and carry trust 'osm'.
 *
 * Every edge is DIRECTED. A two-way track (TRAFIC 4, or none given), every
 * leading line and every buoyed channel become two edges, one each way. A
 * one-way track (TRAFIC 1/2/3) becomes one edge in its ORIENT direction.
 *
 * Class, against a given draft, with 0.5 m under-keel clearance:
 *   • 'clear' — THE CONTRACT: charted depth (S-57 DEPARE / DRGARE DRVAL1,
 *     finest survey wins, shallowest within a survey) is at least draft + UKC
 *     all along, AND nothing on the review list below applies, AND the draft
 *     is the skipper's own (not a fallback or onboarding guess). The only
 *     green state.
 *   • 'needs-review' — charted deep enough, but the chart says look again
 *     (services/routing/leadReview.ts): an obstruction / wreck / rock of
 *     unknown or too-shallow depth within the router's 60 m obstruction
 *     buffer ('hazard'), a bridge on the line ('bridge' — Phase 2 must BLOCK
 *     an unknown clearance), an overhead cable or pipe across it
 *     ('overhead'), a shoreline construction or pontoon on it ('structure'),
 *     chart data that does not carry bridges, pontoons or overhead lines at
 *     all ('structures-unknown' — true of every cell today: neither pipeline
 *     extracts them yet), a CATZOC C/D/U survey under it ('survey'), or no
 *     draft entered ('draft-not-set'). Amber, never green; the reasons travel
 *     with the edge.
 *   • 'needs-tide' — charted all along, but somewhere shallower than draft +
 *     UKC (offered amber, never refused and never green; no tide is solved
 *     here). Review reasons are listed too.
 *   • 'unknown' — some of the edge has no charted depth under it (including
 *     where the finest survey charts a band with no DRVAL1).
 * Injected OSM/Mapbox water is never charted depth.
 *
 * Never navigation-grade: the graph is chart furniture and, later, the
 * router's preference. It never overrides land, hazards or depth.
 */
import type { Position } from 'geojson';
import { haversineM } from '../engine/geometry';
import { featureIsShadowed, shadowingCells, cellScaleRank } from '../enc/scaleShadow';
import { parseChartTrackLines, type ChartTrackLine } from '../leadingLine';
import { compileSeawayGraph } from '../seaway/graphCompiler';
import { splitMarkFeatures, type PointFeatureLike } from '../seaway/markSplit';
import {
    chartAreaIndexFor,
    clipLineToWater,
    depthAlongLine,
    type ChartAreaIndex,
    type ClipCollectionLike,
    type ClipFeatureLike,
    type ClipLayers,
} from './leadLandClip';
import {
    buildLeadReviewIndex,
    LEAD_POOR_SURVEY_CATZOC,
    LEAD_REQUIRED_STRUCTURE_LAYERS,
    reviewAlongLine,
    type LeadReviewLayers,
    type LeadSpanReview,
} from './leadReview';

// ── Types ──────────────────────────────────────────────────────────

export type LeadEdgeKind = 'recommended-track' | 'leading-line' | 'channel';
export type LeadTrust = 'chart' | 'osm';
/** The lead's class: depth first, demoted by the review (see the header). */
export type LeadDepthClass = 'clear' | 'needs-review' | 'needs-tide' | 'unknown';
/** Why a lead is not clear beyond its depth, in this fixed order. */
export type LeadReviewReason =
    | 'hazard'
    | 'bridge'
    | 'overhead'
    | 'structure'
    | 'structures-unknown'
    | 'survey'
    | 'draft-not-set';
const REASON_ORDER: readonly LeadReviewReason[] = [
    'hazard',
    'bridge',
    'overhead',
    'structure',
    'structures-unknown',
    'survey',
    'draft-not-set',
];

/** Under-keel clearance on top of the draft (owner-confirmed default). */
export const LEAD_UKC_M = 0.5;

/** The merged chart layers the compiler reads. */
export interface LeadCompilerLayers extends ClipLayers, LeadReviewLayers {
    RECTRC?: ClipCollectionLike;
    /** Raw chart NAVLNE, every CATNAV: the compiler keeps CATNAV 3 only. */
    NAVLNE?: ClipCollectionLike;
    BOYLAT?: ClipCollectionLike;
    BCNLAT?: ClipCollectionLike;
}

/** Classification options (per draft, never per compile). */
export interface LeadClassifyOptions {
    /** The draft is a fallback or an onboarding estimate, not the skipper's
     * own (services/units.ts vesselDraftIsAssumed): nothing is clear. */
    draftAssumed?: boolean;
}

export interface LeadCompileOptions {
    /** OSM seamark navigation lines (Pi / cloud overlay). Compiled only when
     * given; only category=leading lines are kept, as trust 'osm'. */
    osmNavLines?: readonly ClipFeatureLike[];
    /** Compile buoyed-channel edges from the lateral marks (default true). */
    channels?: boolean;
}

export interface LeadNode {
    id: string;
    lon: number;
    lat: number;
}

export interface LeadSpanDepth {
    /** Shallowest charted DRVAL1 anywhere along the span (null: none). */
    minDepthM: number | null;
    /** Metres of the span with no charted depth under them. */
    uncoveredM: number;
}

/** One undirected on-water run of a lead, before direction and draft. */
export interface LeadSpan {
    id: string;
    kind: LeadEdgeKind;
    trust: LeadTrust;
    coordinates: [number, number][];
    lengthM: number;
    /** 'both' two-way; 'forward' / 'backward' one-way along / against the
     * coordinates' own order. */
    direction: 'both' | 'forward' | 'backward';
    /** One-way traffic whose direction the chart does not give (TRAFIC set,
     * ORIENT missing): compiled both ways and flagged. */
    directionUnresolved?: boolean;
    /** Source identities, e.g. 'RECTRC OC-61-10ENB5 2380' (a line charted in
     * two overlapping cells lists both). */
    sourceIds: string[];
    /** The S-57 record ids behind the span (rcid). */
    rcids: number[];
    name?: string;
    /** Metres of the source line(s) cut away as land. */
    sourceLandM: number;
    depth: LeadSpanDepth;
    /** Hazards beside it, structures on it, survey quality under it. */
    review: LeadSpanReview;
}

export interface LeadEdge {
    id: string;
    spanId: string;
    kind: LeadEdgeKind;
    trust: LeadTrust;
    from: string;
    to: string;
    coordinates: [number, number][];
    lengthM: number;
    /** True bearing from the edge's first point to its last. */
    bearingDeg: number;
    /** The same span run the other way, when the span is two-way. */
    reverseId?: string;
    oneWay: boolean;
    directionUnresolved?: boolean;
    networkId: string;
    sourceIds: string[];
    rcids: number[];
    name?: string;
    sourceLandM: number;
    /** `class` is the lead's class (the contract in the header); `review`
     * lists why it is not clear beyond its depth, if anything. */
    depth: LeadSpanDepth & { class: LeadDepthClass; review: LeadReviewReason[] };
}

export interface LeadNetwork {
    id: string;
    nodeIds: string[];
    spanIds: string[];
}

/** A source line that produced no span, and why — never a silent drop. */
export interface LeadDrop {
    sourceId: string;
    reason: 'on-land' | 'duplicate' | 'coincides-with-recommended-track' | 'too-short';
}

/** Draft-independent compile output (cached per cell set). */
export interface LeadSpanSet {
    spans: LeadSpan[];
    dropped: LeadDrop[];
    /** Total metres of lead lines cut away as land. */
    clippedLandM: number;
    compileMs: number;
}

export interface LeadGraph {
    draftM: number;
    ukcM: number;
    draftAssumed: boolean;
    nodes: LeadNode[];
    edges: LeadEdge[];
    networks: LeadNetwork[];
    spans: LeadSpan[];
    dropped: LeadDrop[];
    clippedLandM: number;
    compileMs: number;
}

// ── Tunables ───────────────────────────────────────────────────────

/** A leftover run shorter than this is rounding at a join, not a lead. */
export const MIN_SPAN_M = 25;
/** End points this close are the same node (S-57 shares nodes exactly
 * within a cell; overlapping cells can differ by a few metres). */
export const JOIN_M = 10;
/** A lead within this distance of an earlier lead, and parallel to it within
 * COINCIDE_DEG, is the same line drawn again. */
const COINCIDE_M = 12;
const COINCIDE_DEG = 3;

// ── Small geometry ─────────────────────────────────────────────────

const M_PER_LAT = 110_540;
const mPerLon = (lat: number): number => 111_320 * Math.cos((lat * Math.PI) / 180);

function lineLengthM(coords: readonly Position[]): number {
    let m = 0;
    for (let i = 1; i < coords.length; i++)
        m += haversineM(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
    return m;
}

function bearingDeg(a: Position, b: Position): number {
    const k = mPerLon((a[1] + b[1]) / 2);
    let deg = (Math.atan2((b[0] - a[0]) * k, (b[1] - a[1]) * M_PER_LAT) * 180) / Math.PI;
    if (deg < 0) deg += 360;
    return deg;
}

/** Undirected angle between two bearings, [0, 90]. */
function lineAngleDeg(a: number, b: number): number {
    let d = Math.abs(a - b) % 180;
    if (d > 90) d = 180 - d;
    return d;
}

const round7 = (n: number): string => n.toFixed(7);

/** Direction-independent identity of a line's exact geometry. */
function geometryKey(coords: readonly Position[]): string {
    const f = coords.map((c) => `${round7(c[0])},${round7(c[1])}`).join(';');
    const r = [...coords]
        .reverse()
        .map((c) => `${round7(c[0])},${round7(c[1])}`)
        .join(';');
    return f < r ? f : r;
}

const toPos = (pts: { lat: number; lon: number }[]): Position[] => pts.map((p) => [p.lon, p.lat]);

// ── Coincidence: the stretch of a line that is another lead drawn again ──

/**
 * Parameter intervals along segment a→b that lie within COINCIDE_M of an
 * earlier line segment c→d running parallel within COINCIDE_DEG. Exact for
 * straight segments: the signed offset of c→d from the line through a→b is
 * linear along c→d, so the near stretch is solved, not sampled.
 */
function coincidentIntervals(a: Position, b: Position, others: readonly Position[][]): [number, number][] {
    const k = mPerLon((a[1] + b[1]) / 2);
    const bx = (b[0] - a[0]) * k;
    const by = (b[1] - a[1]) * M_PER_LAT;
    const len = Math.hypot(bx, by);
    if (len < 1e-6) return [];
    const ux = bx / len;
    const uy = by / len;
    const segBearing = bearingDeg(a, b);
    const out: [number, number][] = [];
    for (const line of others) {
        for (let i = 0; i < line.length - 1; i++) {
            const c = line[i];
            const d = line[i + 1];
            if (lineAngleDeg(segBearing, bearingDeg(c, d)) > COINCIDE_DEG) continue;
            const cx = (c[0] - a[0]) * k;
            const cy = (c[1] - a[1]) * M_PER_LAT;
            const dx = (d[0] - a[0]) * k;
            const dy = (d[1] - a[1]) * M_PER_LAT;
            // Along (t, metres) and signed across (s) for both ends of c→d.
            const tc = cx * ux + cy * uy;
            const td = dx * ux + dy * uy;
            const sc = cx * -uy + cy * ux;
            const sd = dx * -uy + dy * ux;
            // Stretch of c→d (u ∈ [0,1]) with |s| ≤ COINCIDE_M.
            let u0 = 0;
            let u1 = 1;
            const ds = sd - sc;
            if (Math.abs(ds) < 1e-9) {
                if (Math.abs(sc) > COINCIDE_M) continue;
            } else {
                const ua = (-COINCIDE_M - sc) / ds;
                const ub = (COINCIDE_M - sc) / ds;
                u0 = Math.max(0, Math.min(ua, ub));
                u1 = Math.min(1, Math.max(ua, ub));
                if (u1 <= u0) continue;
            }
            const t0 = (tc + (td - tc) * u0) / len;
            const t1 = (tc + (td - tc) * u1) / len;
            const lo = Math.max(0, Math.min(t0, t1));
            const hi = Math.min(1, Math.max(t0, t1));
            if (hi > lo) out.push([lo, hi]);
        }
    }
    return out;
}

/** Cut the stretches of `coords` that coincide with `others` out; return the
 * remaining runs (each ≥ 2 vertices, in the line's own order). */
function subtractCoincident(coords: readonly Position[], others: readonly Position[][]): Position[][] {
    if (others.length === 0) return [coords.slice()];
    const runs: Position[][] = [];
    let run: Position[] = [];
    const flush = (): void => {
        if (run.length >= 2) runs.push(run);
        run = [];
    };
    for (let i = 0; i < coords.length - 1; i++) {
        const a = coords[i];
        const b = coords[i + 1];
        const cuts = coincidentIntervals(a, b, others).sort((x, y) => x[0] - y[0]);
        // Merge the cut intervals, then walk the kept gaps between them.
        const merged: [number, number][] = [];
        for (const iv of cuts) {
            const last = merged[merged.length - 1];
            if (last && iv[0] <= last[1] + 1e-9) last[1] = Math.max(last[1], iv[1]);
            else merged.push([iv[0], iv[1]]);
        }
        let t = 0;
        const at = (s: number): Position =>
            s <= 0 ? a : s >= 1 ? b : [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s];
        for (const [c0, c1] of merged) {
            if (c0 > t + 1e-9) {
                if (run.length === 0) run.push(at(t));
                run.push(at(c0));
            }
            flush();
            t = Math.max(t, c1);
        }
        if (t < 1 - 1e-9) {
            if (run.length === 0) run.push(at(t));
            run.push(b);
        }
    }
    flush();
    return runs;
}

// ── Source lines ───────────────────────────────────────────────────

interface SourceLine {
    kind: LeadEdgeKind;
    trust: LeadTrust;
    coords: Position[];
    sourceId: string;
    rcid?: number;
    name?: string;
    rank: number | null;
    traffic?: number;
    orientationDeg?: number;
}

const readRank = (props: Record<string, unknown> | null | undefined): number | null => {
    const r = props?._scaleRank;
    return typeof r === 'number' && Number.isFinite(r) ? r : null;
};

function sourceId(line: ChartTrackLine): string {
    const t = line.chartTrack;
    const cls = t.objectClass === 'OSM_NAVLINE' ? 'OSM' : t.objectClass;
    return [cls, t.sourceCell, t.featureId].filter(Boolean).join(' ');
}

function chartLines(
    features: readonly ClipFeatureLike[],
    layerClass: 'RECTRC' | 'NAVLNE' | undefined,
    wantObjectClass: 'RECTRC' | 'NAVLNE' | 'OSM_NAVLINE',
    kind: LeadEdgeKind,
    trust: LeadTrust,
): SourceLine[] {
    const out: SourceLine[] = [];
    for (const feature of features) {
        const rank = readRank(feature.properties);
        for (const line of parseChartTrackLines([feature], layerClass)) {
            const t = line.chartTrack;
            if (t.objectClass !== wantObjectClass) continue;
            if (kind === 'recommended-track' && t.kind !== 'recommended-track') continue;
            if (kind === 'leading-line' && t.kind !== 'leading-line') continue;
            const rcid = t.featureId !== undefined && /^\d+$/.test(t.featureId) ? Number(t.featureId) : undefined;
            out.push({
                kind,
                trust,
                coords: toPos(line.pts),
                sourceId: sourceId(line),
                rcid,
                name: t.name,
                rank,
                traffic: t.traffic,
                orientationDeg: t.orientationDeg,
            });
        }
    }
    // Finest survey first (a line charted in an overview and a harbour cell
    // keeps the harbour cell's geometry); otherwise input order.
    return out
        .map((l, i) => ({ l, i }))
        .sort((x, y) => (y.l.rank ?? -Infinity) - (x.l.rank ?? -Infinity) || x.i - y.i)
        .map(({ l }) => l);
}

function channelLines(layers: LeadCompilerLayers): SourceLine[] {
    const marks = [...(layers.BOYLAT?.features ?? []), ...(layers.BCNLAT?.features ?? [])] as PointFeatureLike[];
    if (marks.length === 0) return [];
    const { chartFeatures, unnumberedMarks } = splitMarkFeatures(marks);
    if (chartFeatures.length === 0) return [];
    // No land test here: the compiler's own clip below is the land law for
    // every lead kind alike.
    const { graph } = compileSeawayGraph({ chartFeatures, unnumberedMarks });
    const gates = new Map(graph.gates.map((g) => [g.id, g]));
    return graph.edges
        .filter((e) => e.kind === 'channel' && e.polyline.length >= 2)
        .map((e) => {
            const from = gates.get(e.fromGateId);
            const to = gates.get(e.toGateId);
            const names = [from, to]
                .flatMap((g) => [g?.portMark?.name, g?.stbdMark?.name])
                .filter((n): n is string => typeof n === 'string' && n.length > 0);
            return {
                kind: 'channel' as const,
                trust: 'chart' as const,
                coords: e.polyline.map((p) => [p.lon, p.lat]),
                sourceId: `CHANNEL ${e.id}${names.length ? ` (${[...new Set(names)].join(', ')})` : ''}`,
                rank: null,
            };
        });
}

// ── Compile ────────────────────────────────────────────────────────

/** One-way direction from S-57 TRAFIC + ORIENT (IHO UOC: ORIENT is the
 * direction of travel on a one-way track). */
function spanDirection(src: SourceLine, coords: Position[]): Pick<LeadSpan, 'direction' | 'directionUnresolved'> {
    const oneWay = src.traffic === 1 || src.traffic === 2 || src.traffic === 3;
    if (!oneWay) return { direction: 'both' };
    if (src.orientationDeg === undefined) return { direction: 'both', directionUnresolved: true };
    const b = bearingDeg(coords[0], coords[coords.length - 1]);
    let d = Math.abs(b - src.orientationDeg) % 360;
    if (d > 180) d = 360 - d;
    return { direction: d <= 90 ? 'forward' : 'backward' };
}

/**
 * The draft-independent part: every lead line cut to water, de-duplicated,
 * with its charted-depth profile. Deterministic for the same input.
 */
export function compileLeadSpans(layers: LeadCompilerLayers, options: LeadCompileOptions = {}): LeadSpanSet {
    const t0 = Date.now();
    const index: ChartAreaIndex = chartAreaIndexFor(layers);
    const reviewIndex = buildLeadReviewIndex(layers);
    const spans: LeadSpan[] = [];
    const dropped: LeadDrop[] = [];
    let clippedLandM = 0;
    // Pieces are numbered per source across ALL its parts: a MultiLineString
    // lead (or OSM lines with no id, which share the source id 'OSM') used to
    // restart at :0 per part, giving duplicate span and edge ids.
    const pieceNo = new Map<string, number>();

    // Accepted raw geometry per group, for de-duplication.
    const tracks: Position[][] = [];
    const chartLeads: Position[][] = [];
    const seen = new Map<string, LeadSpan[]>();

    /** `against`: earlier leads, in order; a line wholly covered by one
     * group is dropped with that group's reason. */
    const accept = (
        src: SourceLine,
        against: readonly { lines: readonly Position[][]; reason: LeadDrop['reason'] }[],
    ): void => {
        const key = `${src.kind}|${geometryKey(src.coords)}`;
        const twin = seen.get(key);
        if (twin) {
            // The same line charted in another cell: one span, both sources.
            for (const s of twin) {
                if (!s.sourceIds.includes(src.sourceId)) s.sourceIds.push(src.sourceId);
                if (src.rcid !== undefined && !s.rcids.includes(src.rcid)) s.rcids.push(src.rcid);
            }
            dropped.push({ sourceId: src.sourceId, reason: 'duplicate' });
            return;
        }
        let remaining: Position[][] = [src.coords];
        for (const group of against) {
            remaining = remaining.flatMap((run) => subtractCoincident(run, group.lines));
            if (remaining.reduce((m, r) => m + lineLengthM(r), 0) < MIN_SPAN_M) {
                dropped.push({ sourceId: src.sourceId, reason: group.reason });
                return;
            }
        }
        let landM = 0;
        const pieces: Position[][] = [];
        for (const run of remaining) {
            const clip = clipLineToWater(index, run);
            landM += clip.landM;
            pieces.push(...clip.pieces.filter((p) => lineLengthM(p) >= MIN_SPAN_M));
        }
        clippedLandM += landM;
        if (pieces.length === 0) {
            dropped.push({ sourceId: src.sourceId, reason: landM > 0 ? 'on-land' : 'too-short' });
            return;
        }
        const made: LeadSpan[] = [];
        const idBase = `${src.kind}:${src.sourceId}`;
        for (const piece of pieces) {
            const n = pieceNo.get(idBase) ?? 0;
            pieceNo.set(idBase, n + 1);
            const profile = depthAlongLine(index, piece);
            const coords = piece.map((p) => [p[0], p[1]] as [number, number]);
            const span: LeadSpan = {
                id: `${idBase}:${n}`,
                kind: src.kind,
                trust: src.trust,
                coordinates: coords,
                lengthM: profile.lengthM,
                ...spanDirection(src, coords),
                sourceIds: [src.sourceId],
                rcids: src.rcid !== undefined ? [src.rcid] : [],
                ...(src.name ? { name: src.name } : {}),
                sourceLandM: landM,
                depth: { minDepthM: profile.minDepthM, uncoveredM: profile.uncoveredM },
                review: reviewAlongLine(reviewIndex, piece),
            };
            spans.push(span);
            made.push(span);
        }
        seen.set(key, made);
    };

    // 1. Recommended tracks — the hydrographer's own on-water lead. A track
    //    charted again in another cell is one span.
    for (const src of chartLines(layers.RECTRC?.features ?? [], 'RECTRC', 'RECTRC', 'recommended-track', 'chart')) {
        accept(src, [{ lines: tracks, reason: 'duplicate' }]);
        tracks.push(src.coords);
    }
    // 2. Leading lines (CATNAV 3 only), minus any stretch a RECTRC already is.
    for (const src of chartLines(layers.NAVLNE?.features ?? [], 'NAVLNE', 'NAVLNE', 'leading-line', 'chart')) {
        accept(src, [
            { lines: tracks, reason: 'coincides-with-recommended-track' },
            { lines: chartLeads, reason: 'duplicate' },
        ]);
        chartLeads.push(src.coords);
    }
    // 3. Buoyed channels (a gate chain's corridor pieces can repeat a stretch
    //    of the previous edge: drawn once).
    if (options.channels !== false) {
        const chain: Position[][] = [];
        for (const src of channelLines(layers)) {
            accept(src, [{ lines: chain, reason: 'duplicate' }]);
            chain.push(src.coords);
        }
    }
    // 4. OSM leading lines, only when asked, and never where the chart already
    //    has the lead (nor twice).
    if (options.osmNavLines && options.osmNavLines.length > 0) {
        const osm: Position[][] = [];
        for (const src of chartLines(options.osmNavLines, undefined, 'OSM_NAVLINE', 'leading-line', 'osm')) {
            accept(src, [
                { lines: tracks, reason: 'coincides-with-recommended-track' },
                { lines: chartLeads, reason: 'duplicate' },
                { lines: osm, reason: 'duplicate' },
            ]);
            osm.push(src.coords);
        }
    }

    return { spans, dropped, clippedLandM, compileMs: Date.now() - t0 };
}

/** Draft class for a span's charted depth alone (no review). */
export function leadDepthClass(
    depth: LeadSpanDepth,
    draftM: number,
    ukcM = LEAD_UKC_M,
): Exclude<LeadDepthClass, 'needs-review'> {
    // Floating-point slivers between touching bands are not coverage gaps.
    if (depth.minDepthM === null || depth.uncoveredM > 1) return 'unknown';
    return depth.minDepthM >= draftM + ukcM - 1e-9 ? 'clear' : 'needs-tide';
}

/** Why a span is not clear beyond its depth, for this draft. */
export function leadReviewReasons(
    span: Pick<LeadSpan, 'review' | 'depth'>,
    draftM: number,
    ukcM = LEAD_UKC_M,
    options: LeadClassifyOptions = {},
): LeadReviewReason[] {
    const r = span.review;
    const found = new Set<LeadReviewReason>();
    // Depth over the hazard unknown, or shallower than this keel needs.
    if (r.hazards.some((h) => h.valsouM === null || h.valsouM < draftM + ukcM - 1e-9)) found.add('hazard');
    for (const s of r.structures) {
        found.add(
            s.layer === 'BRIDGE' ? 'bridge' : s.layer === 'CBLOHD' || s.layer === 'PIPOHD' ? 'overhead' : 'structure',
        );
    }
    // The data cannot show a bridge or an overhead line here: "nothing on the
    // line" is unknown, and unknown is never clear.
    if (r.structuresUnknown) found.add('structures-unknown');
    if (r.worstCatzoc !== null && r.worstCatzoc >= LEAD_POOR_SURVEY_CATZOC) found.add('survey');
    // Against a guessed keel, charted depth proves nothing either way.
    if (options.draftAssumed && span.depth.minDepthM !== null) found.add('draft-not-set');
    return REASON_ORDER.filter((x) => found.has(x));
}

/** The lead's class and review reasons for this draft (the header's contract). */
export function leadClass(
    span: Pick<LeadSpan, 'review' | 'depth'>,
    draftM: number,
    ukcM = LEAD_UKC_M,
    options: LeadClassifyOptions = {},
): { class: LeadDepthClass; review: LeadReviewReason[] } {
    const byDepth = leadDepthClass(span.depth, draftM, ukcM);
    // Unknown depth is already grey whatever the keel: the draft is moot.
    const review =
        byDepth === 'unknown'
            ? leadReviewReasons(span, draftM, ukcM, { ...options, draftAssumed: false })
            : leadReviewReasons(span, draftM, ukcM, options);
    return { class: byDepth === 'clear' && review.length > 0 ? 'needs-review' : byDepth, review };
}

/** Directed graph for one draft: nodes (shared end points joined), edges,
 * networks. Cheap — no geometry beyond the end points. */
export function classifyLeadGraph(
    set: LeadSpanSet,
    draftM: number,
    ukcM = LEAD_UKC_M,
    options: LeadClassifyOptions = {},
): LeadGraph {
    // Nodes: end points within JOIN_M are one node, on a ~JOIN_M spatial hash.
    const nodes: LeadNode[] = [];
    const bucket = new Map<string, number[]>();
    const cellOf = (lon: number, lat: number): [number, number] => [
        Math.floor((lon * mPerLon(lat)) / JOIN_M),
        Math.floor((lat * M_PER_LAT) / JOIN_M),
    ];
    const nodeFor = (p: [number, number]): string => {
        const [cx, cy] = cellOf(p[0], p[1]);
        let best = -1;
        let bestM = Infinity;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (const i of bucket.get(`${cx + dx},${cy + dy}`) ?? []) {
                    const m = haversineM(p[1], p[0], nodes[i].lat, nodes[i].lon);
                    if (m <= JOIN_M && m < bestM) {
                        bestM = m;
                        best = i;
                    }
                }
            }
        }
        if (best >= 0) return nodes[best].id;
        const i = nodes.length;
        nodes.push({ id: `n${i}`, lon: p[0], lat: p[1] });
        const k = `${cx},${cy}`;
        bucket.set(k, [...(bucket.get(k) ?? []), i]);
        return nodes[i].id;
    };

    // Union-find over nodes for networks.
    const parent = new Map<string, string>();
    const find = (x: string): string => {
        let r = x;
        while (parent.get(r) !== r) r = parent.get(r)!;
        let c = x;
        while (parent.get(c) !== r) {
            const n = parent.get(c)!;
            parent.set(c, r);
            c = n;
        }
        return r;
    };
    const ends = set.spans.map((s) => {
        const a = nodeFor(s.coordinates[0]);
        const b = nodeFor(s.coordinates[s.coordinates.length - 1]);
        for (const n of [a, b]) if (!parent.has(n)) parent.set(n, n);
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) parent.set(ra, rb);
        return [a, b] as const;
    });

    const networkOf = new Map<string, string>();
    const networks: LeadNetwork[] = [];
    set.spans.forEach((s, i) => {
        const root = find(ends[i][0]);
        let id = networkOf.get(root);
        if (!id) {
            id = `net${networks.length}`;
            networkOf.set(root, id);
            networks.push({ id, nodeIds: [], spanIds: [] });
        }
        const net = networks.find((n) => n.id === id)!;
        net.spanIds.push(s.id);
        for (const n of ends[i]) if (!net.nodeIds.includes(n)) net.nodeIds.push(n);
    });

    const edges: LeadEdge[] = [];
    set.spans.forEach((s, i) => {
        const depth = { ...s.depth, ...leadClass(s, draftM, ukcM, options) };
        const networkId = networkOf.get(find(ends[i][0]))!;
        const make = (dir: '>' | '<'): LeadEdge => {
            const coordinates = dir === '>' ? s.coordinates : [...s.coordinates].reverse();
            return {
                id: `${s.id}${dir}`,
                spanId: s.id,
                kind: s.kind,
                trust: s.trust,
                from: dir === '>' ? ends[i][0] : ends[i][1],
                to: dir === '>' ? ends[i][1] : ends[i][0],
                coordinates,
                lengthM: s.lengthM,
                bearingDeg: bearingDeg(coordinates[0], coordinates[coordinates.length - 1]),
                oneWay: s.direction !== 'both',
                ...(s.directionUnresolved ? { directionUnresolved: true } : {}),
                networkId,
                sourceIds: s.sourceIds,
                rcids: s.rcids,
                ...(s.name ? { name: s.name } : {}),
                sourceLandM: s.sourceLandM,
                depth,
            };
        };
        if (s.direction === 'both') {
            const f = make('>');
            const r = make('<');
            f.reverseId = r.id;
            r.reverseId = f.id;
            edges.push(f, r);
        } else {
            edges.push(make(s.direction === 'forward' ? '>' : '<'));
        }
    });

    return {
        draftM,
        ukcM,
        draftAssumed: options.draftAssumed === true,
        nodes,
        edges,
        networks,
        spans: set.spans,
        dropped: set.dropped,
        clippedLandM: set.clippedLandM,
        compileMs: set.compileMs,
    };
}

/** Cells → lead graph for one draft. */
export function compileLeadGraph(
    layers: LeadCompilerLayers,
    draftM: number,
    options: LeadCompileOptions = {},
    ukcM = LEAD_UKC_M,
    classify: LeadClassifyOptions = {},
): LeadGraph {
    return classifyLeadGraph(compileLeadSpans(layers, options), draftM, ukcM, classify);
}

// ── Merge whole cells (pure; mirrors the router's multi-scale merge) ──

export interface LeadCellInput {
    id: string;
    bbox: [number, number, number, number];
    layers: Record<string, { features?: readonly ClipFeatureLike[] } | undefined>;
}

const MERGED = [
    'LNDARE',
    'DEPARE',
    'DRGARE',
    'FAIRWY',
    'RECTRC',
    'NAVLNE',
    'BOYLAT',
    'BCNLAT',
    // The review (leadReview.ts): hazards, structures, survey quality.
    'OBSTRN',
    'WRECKS',
    'UWTROC',
    'BRIDGE',
    'SLCONS',
    'PONTON',
    'CBLOHD',
    'PIPOHD',
    'M_QUAL',
] as const;

/**
 * Concatenate the layers the compiler reads, the router's way: a much
 * coarser cell's LNDARE / DEPARE lying wholly inside a finer cell is dropped
 * (scaleShadow), and every area and line is stamped with its cell's fineness
 * rank and id — on COPIES, so cached cell blobs are never mutated. Ranking
 * LNDARE as well as DEPARE lets the land rule refuse coarse water that would
 * erase a finer cell's island (stricter than the router's merge).
 *
 * A cell whose data does not carry every LEAD_REQUIRED_STRUCTURE_LAYERS key
 * (an empty collection counts: "extracted, none charted") adds its extent to
 * `structureGaps`: no lead touching it can be reviewed for bridges,
 * pontoons or overhead lines, so none is clear. Today that is every cell.
 */
export function mergeLeadCells(cells: readonly LeadCellInput[]): LeadCompilerLayers {
    const out: Record<string, { features: ClipFeatureLike[] }> = {};
    for (const name of MERGED) out[name] = { features: [] };
    const structureGaps: [number, number, number, number][] = [];
    const extents = cells.map((c) => ({ id: c.id, bbox: c.bbox }));
    for (const cell of cells) {
        if (LEAD_REQUIRED_STRUCTURE_LAYERS.some((k) => cell.layers[k] === undefined)) {
            structureGaps.push([cell.bbox[0], cell.bbox[1], cell.bbox[2], cell.bbox[3]]);
        }
        const shadows = shadowingCells({ id: cell.id, bbox: cell.bbox }, extents);
        const rank = cellScaleRank(cell.bbox);
        for (const name of MERGED) {
            for (const f of cell.layers[name]?.features ?? []) {
                if (
                    (name === 'LNDARE' || name === 'DEPARE') &&
                    shadows.length > 0 &&
                    featureIsShadowed(f as Parameters<typeof featureIsShadowed>[0], shadows)
                )
                    continue;
                out[name].features.push({
                    ...f,
                    properties: { ...(f.properties ?? {}), _scaleRank: rank, _cellId: cell.id },
                });
            }
        }
    }
    return { ...(out as LeadCompilerLayers), structureGaps };
}

// ── Cache: one compile per cell set, one classification per draft ──
//
// Keyed on each cell's CONTENT identity (services/enc/cellContentIdentity:
// id, edition, issue date, size, update number, content hash), never on the
// id alone. S-57 ids survive new editions and same-edition updates, so an id
// key kept drawing superseded leads — a lead withdrawn by a Notice to
// Mariners — after the chart was updated (Phase 1 review). The identity is
// stable across no-op sync laps, so an unchanged library never recompiles.

const SPAN_CACHE_MAX = 4;
const GRAPH_CACHE_MAX = 8;
const spanCache = new Map<string, LeadSpanSet>();
const graphCache = new Map<string, LeadGraph>();

const touch = <V>(m: Map<string, V>, k: string, v: V, max: number): void => {
    m.delete(k);
    m.set(k, v);
    while (m.size > max) m.delete(m.keys().next().value as string);
};

/** Cache key for a cell set (order-independent). `cellKeys` are the cells'
 * content identities (encCellContentIdentity) — bare ids only in tests. */
export function leadCellSetKey(cellKeys: readonly string[], options: LeadCompileOptions = {}): string {
    return `${[...cellKeys].sort().join('|')}#${options.channels === false ? 'nochan' : 'chan'}#${options.osmNavLines?.length ?? 0}`;
}

const graphKey = (setKey: string, draftM: number, ukcM: number, classify: LeadClassifyOptions): string =>
    `${setKey}@${draftM}/${ukcM}${classify.draftAssumed ? '/assumed' : ''}`;

/** The cached graph for a cell set and draft, if it has been compiled. */
export function peekLeadGraph(
    cellKeys: readonly string[],
    draftM: number,
    options: LeadCompileOptions = {},
    ukcM = LEAD_UKC_M,
    classify: LeadClassifyOptions = {},
): LeadGraph | null {
    const key = graphKey(leadCellSetKey(cellKeys, options), draftM, ukcM, classify);
    const hit = graphCache.get(key);
    if (hit) touch(graphCache, key, hit, GRAPH_CACHE_MAX);
    return hit ?? null;
}

/**
 * Compile (or reuse) the lead graph for a cell set. `layers` is only called
 * on a cache miss for the cell set; a new draft reuses the compiled spans.
 * Peek and compile with the SAME key list.
 */
export function cachedLeadGraph(
    cellKeys: readonly string[],
    draftM: number,
    layers: () => LeadCompilerLayers,
    options: LeadCompileOptions = {},
    ukcM = LEAD_UKC_M,
    classify: LeadClassifyOptions = {},
): LeadGraph {
    const setKey = leadCellSetKey(cellKeys, options);
    const key = graphKey(setKey, draftM, ukcM, classify);
    const hit = graphCache.get(key);
    if (hit) {
        touch(graphCache, key, hit, GRAPH_CACHE_MAX);
        return hit;
    }
    let spans = spanCache.get(setKey);
    if (!spans) spans = compileLeadSpans(layers(), options);
    touch(spanCache, setKey, spans, SPAN_CACHE_MAX);
    const graph = classifyLeadGraph(spans, draftM, ukcM, classify);
    touch(graphCache, key, graph, GRAPH_CACHE_MAX);
    return graph;
}

/** Test seam: forget every cached compile. */
export function clearLeadGraphCache(): void {
    spanCache.clear();
    graphCache.clear();
}

// ── Chart overlay GeoJSON ──────────────────────────────────────────

export interface LeadOverlayProperties {
    spanId: string;
    kind: LeadEdgeKind;
    /** 'lead' (recommended tracks and leading lines) or 'channel'. */
    ink: 'lead' | 'channel';
    depthClass: LeadDepthClass;
    trust: LeadTrust;
    label: string;
    minDepthM: number | null;
    /** The review reasons, comma-joined ('' when none). */
    review: string;
}

/** Short label text per review reason (the line label on the chart). */
export const LEAD_REVIEW_LABEL: Record<LeadReviewReason, string> = {
    hazard: 'charted hazard near',
    bridge: 'bridge — check clearance',
    overhead: 'overhead line — check clearance',
    structure: 'structure on the line',
    'structures-unknown': 'bridges not in chart data',
    survey: 'poor survey',
    'draft-not-set': 'draft not set',
};

/** One line per span (both directions draw the same ink once). */
export function leadGraphOverlayGeoJSON(graph: LeadGraph | null | undefined): {
    type: 'FeatureCollection';
    features: {
        type: 'Feature';
        properties: LeadOverlayProperties;
        geometry: { type: 'LineString'; coordinates: [number, number][] };
    }[];
} {
    const features = [];
    const drawn = new Set<string>();
    for (const e of graph?.edges ?? []) {
        if (drawn.has(e.spanId)) continue;
        drawn.add(e.spanId);
        const ink = e.kind === 'channel' ? 'channel' : 'lead';
        const what = ink === 'channel' ? 'Channel' : e.trust === 'osm' ? 'Lead (OSM)' : 'Lead';
        const reasons = e.depth.review.map((r) => LEAD_REVIEW_LABEL[r]);
        const state =
            e.depth.class === 'clear'
                ? []
                : e.depth.class === 'needs-tide'
                  ? ['needs tide', ...reasons]
                  : e.depth.class === 'needs-review'
                    ? reasons
                    : ['depth not charted', ...reasons];
        features.push({
            type: 'Feature' as const,
            properties: {
                spanId: e.spanId,
                kind: e.kind,
                ink,
                depthClass: e.depth.class,
                trust: e.trust,
                label: [what, ...state].join(' · '),
                minDepthM: e.depth.minDepthM,
                review: e.depth.review.join(','),
            } satisfies LeadOverlayProperties,
            geometry: { type: 'LineString' as const, coordinates: e.coordinates },
        });
    }
    return { type: 'FeatureCollection', features };
}
