/**
 * leadLandClip — which stretches of a lead line lie over charted land, and
 * how deep is the charted water under the rest (inshore router, Phase 1).
 *
 * PURE: no React, no I/O, no storage. Shared by the lead compiler
 * (services/routing/leadCompiler.ts) and the engine's final land audit
 * (services/engine/safetyAudit.ts), which agree on one answer to "is this bit
 * of the lead on CHART water?".
 *
 * NOT navGrid Pass 5b (Phase 1 review, 2026-09-29): the grid clips a lead
 * against its OWN land verdict, cell by cell. The grid knows water this module
 * deliberately does not count — the OSM canal carve and OSM-vouched water
 * under LNDARE — and clipping the grid's lead with this S-57-only rule cut the
 * Newport entrance lead with a ~590 m gap in the very channel the grid carves
 * as water, refusing the production-shape routes. The audit keeps this rule:
 * it vouches OSM water and the 125 m beside a canal line on its own, so the
 * route through that channel is vouched without the lead.
 *
 * Why: a charted leading line (NAVLNE CATNAV 3) is drawn between its leading
 * marks, and the rear mark is usually ashore. On the Newport cells NAVLNE 2379
 * runs ~1.1 km and 2387 ~0.95 km over LNDARE. Before Phase 1 the grid painted
 * those land runs as a preferred corridor (and could reopen land-painted cells
 * under them), and the land audit counted anything within 125 m of them as
 * proven water. Only the ON-WATER spans of a lead are evidence of anything.
 *
 * LAND here is the hard land the engine already treats as land: inside an
 * LNDARE polygon and NOT inside S-57 chart water that the grid lets beat
 * LNDARE —
 *   • a chart DEPARE with DRVAL1 > 0 (Pass 1/2: a deep band is a protected
 *     conflict, a shallow one a wet chart claim; both stay CAUTION water),
 *   • a chart DRGARE or FAIRWY (Pass 4 rescues those over LNDARE).
 * A drying band (DRVAL1 ≤ 0) under LNDARE is land: the grid keeps the land
 * paint there, and only the old NAVLNE reopen let a lead through it — the
 * very extension this module removes. Injected OSM/Mapbox water (no S-57
 * identity) is NOT chart evidence and never un-lands anything here.
 *
 * SCALE: where the features carry a fineness rank (`_scaleRank`, stamped at
 * merge time from the cell's bbox — higher is finer), chart water only beats
 * land charted at the SAME or a coarser scale: a 1:90k overview band cannot
 * erase an island a 1:22k harbour cell draws, while a harbour cell's water
 * still beats the overview's generalised landmask. The router's merge ranks
 * DEPARE only, so there LNDARE is unranked and any chart water beats it —
 * exactly the grid's rule. The lead compiler's merge ranks LNDARE too, so
 * it clips at least as much as the engine does (the safe direction).
 *
 * CHARTED DEPTH is S-57 DEPARE/DRGARE DRVAL1 only (DRGARE = the maintained
 * depth). The finest survey wins where ranked features overlap (the same
 * `_scaleRank` rule as the grid), and within that rank the shallowest wins.
 * The finest survey owns the point EVEN WHEN IT CHARTS NO DEPTH: a band with
 * no DRVAL1 at the finest covering rank makes the depth unknown there — it
 * never falls through to a coarser cell's band (Phase 1 review: a harbour
 * cell's undepthed DRGARE over an overview's 10 m band read 'clear').
 * Injected water with a made-up DRVAL1 is never charted depth.
 *
 * Exact, not sampled: each segment is cut at every crossing with a polygon
 * edge, and each piece is classified at its midpoint, so "zero land metres"
 * means zero, not "no 25 m sample happened to land ashore".
 */
import type { MultiPolygon, Polygon, Position } from 'geojson';
import { geometryBbox, haversineM } from '../engine/geometry';

/** The minimal GeoJSON shapes this module reads. */
export interface ClipFeatureLike {
    geometry?: { type?: string; coordinates?: unknown } | null;
    properties?: Record<string, unknown> | null;
}
export interface ClipCollectionLike {
    features: readonly ClipFeatureLike[];
}

/** The chart layers the land and depth verdicts read. */
export interface ClipLayers {
    LNDARE?: ClipCollectionLike;
    DEPARE?: ClipCollectionLike;
    DRGARE?: ClipCollectionLike;
    FAIRWY?: ClipCollectionLike;
}

type AreaGeometry = Polygon | MultiPolygon;
type BBox = [number, number, number, number];

/**
 * One polygon ring with a lazily built latitude-band index of its edges. A
 * coarse overview cell's land or depth polygon can carry thousands of
 * vertices and cover every lead in a bay; scanning all of its edges for each
 * short segment (and for each point test) was most of the compile time. The
 * band index hands back every edge whose latitude span meets the query —
 * a superset — and the exact per-edge predicates below are unchanged.
 */
export interface IndexedRing {
    ring: Position[];
    minLat: number;
    maxLat: number;
    /** Edge i joins ring[i - 1] (ring[len - 1] for i = 0) to ring[i]. */
    bands: number[][] | null;
    bandStep: number;
}

export interface IndexedArea {
    geometry: AreaGeometry;
    bbox: BBox;
    /** Per polygon: [outer ring, ...holes]. */
    polys: IndexedRing[][];
    /** Every ring of the area, for the edge-crossing cut. */
    rings: IndexedRing[];
    /** Survey fineness (`_scaleRank`, higher = finer), or null when unranked. */
    rank: number | null;
}

export interface IndexedDepthArea extends IndexedArea {
    /** DRVAL1, or null where the band carries none (no depth claim). */
    drval1: number | null;
}

/** One layer set, indexed once: the land test, the chart water that beats
 * it, and the charted depth bands. */
export interface ChartAreaIndex {
    land: IndexedArea[];
    wet: IndexedArea[];
    depth: IndexedDepthArea[];
    /** Per-feature clip results for navLinesOnWater (feature identity). */
    clipCache: WeakMap<object, ClipFeatureLike | null>;
}

/** One piece of a segment between two polygon-edge crossings. */
interface SegmentPiece {
    t0: number;
    t1: number;
    land: boolean;
    /** Charted depth (m) over this piece, or null when no chart band with a
     * DRVAL1 covers it. Only computed when depth was asked for. */
    depthM: number | null;
}

/** A line cut to water, with the metres removed as land. */
export interface ClippedLine {
    /** The on-water runs, in the line's own order; each has ≥ 2 vertices. */
    pieces: Position[][];
    lengthM: number;
    landM: number;
}

/** Charted depth along a line. */
export interface DepthAlong {
    lengthM: number;
    /** Shallowest charted DRVAL1 anywhere along the line (null: none). */
    minDepthM: number | null;
    /** Metres with no charted depth under them. */
    uncoveredM: number;
    /** Metres over land (should be 0 for a compiled lead). */
    landM: number;
}

export const readNum = (props: Record<string, unknown> | null | undefined, key: string): number | null => {
    const raw = props?.[key] ?? props?.[key.toLowerCase()];
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : null;
};

/** An S-57 chart feature (the extractor's acronym, classCode or OBJL), as
 * opposed to injected OSM/Mapbox water, which carries none of them. */
export function isS57Feature(feature: ClipFeatureLike): boolean {
    const p = feature.properties ?? {};
    return (
        (typeof p.acronym === 'string' && p.acronym.trim() !== '') ||
        (typeof p.ACRONYM === 'string' && p.ACRONYM.trim() !== '') ||
        p.classCode !== undefined ||
        p.OBJL !== undefined
    );
}

export function areaGeometry(feature: ClipFeatureLike): AreaGeometry | null {
    const g = feature.geometry;
    if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon') || !Array.isArray(g.coordinates)) return null;
    return g as AreaGeometry;
}

function indexRing(ring: Position[]): IndexedRing {
    let minLat = Infinity;
    let maxLat = -Infinity;
    for (const p of ring) {
        if (p[1] < minLat) minLat = p[1];
        if (p[1] > maxLat) maxLat = p[1];
    }
    return { ring, minLat, maxLat, bands: null, bandStep: 0 };
}

export function indexArea(geometry: AreaGeometry, rank: number | null): IndexedArea {
    const raw = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    const polys = raw.map((poly) => poly.map(indexRing));
    return { geometry, bbox: geometryBbox(geometry), polys, rings: polys.flat(), rank };
}

/** Rings with fewer edges than this are scanned whole. */
const BAND_MIN_EDGES = 48;

/** Visit every edge (index i: ring[i-1]→ring[i]) whose latitude span may meet
 * [lat0, lat1]; may visit an edge more than once. */
function forEachEdgeNear(r: IndexedRing, lat0: number, lat1: number, visit: (i: number) => void): void {
    const n = r.ring.length;
    if (lat1 < r.minLat || lat0 > r.maxLat || n < 2) return;
    if (n < BAND_MIN_EDGES) {
        for (let i = 0; i < n; i++) visit(i);
        return;
    }
    if (!r.bands) {
        const count = Math.min(512, Math.ceil(n / 8));
        const step = (r.maxLat - r.minLat) / count || 1e-12;
        const bands: number[][] = Array.from({ length: count }, () => []);
        const band = (lat: number): number => Math.max(0, Math.min(count - 1, Math.floor((lat - r.minLat) / step)));
        for (let i = 0, j = n - 1; i < n; j = i++) {
            const lo = Math.min(r.ring[i][1], r.ring[j][1]);
            const hi = Math.max(r.ring[i][1], r.ring[j][1]);
            for (let b = band(lo); b <= band(hi); b++) bands[b].push(i);
        }
        r.bands = bands;
        r.bandStep = step;
    }
    const count = r.bands.length;
    const b0 = Math.max(0, Math.min(count - 1, Math.floor((lat0 - r.minLat) / r.bandStep)));
    const b1 = Math.max(0, Math.min(count - 1, Math.floor((lat1 - r.minLat) / r.bandStep)));
    for (let b = b0; b <= b1; b++) for (const i of r.bands[b]) visit(i);
}

/** The engine's ray cast (services/engine/geometry pointInRing), over only
 * the edges that can cross the point's latitude. */
function pointInIndexedRing(lon: number, lat: number, r: IndexedRing): boolean {
    const ring = r.ring;
    const n = ring.length;
    let inside = false;
    forEachEdgeNear(r, lat, lat, (i) => {
        const j = i === 0 ? n - 1 : i - 1;
        const xi = ring[i][0];
        const yi = ring[i][1];
        const xj = ring[j][0];
        const yj = ring[j][1];
        if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    });
    return inside;
}

/** pointInGeometry (outer ring contains, holes subtract), on the index. */
export function pointInArea(area: IndexedArea, lon: number, lat: number): boolean {
    const [minLon, minLat, maxLon, maxLat] = area.bbox;
    if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) return false;
    for (const poly of area.polys) {
        if (poly.length === 0 || !pointInIndexedRing(lon, lat, poly[0])) continue;
        let inHole = false;
        for (let h = 1; h < poly.length; h++) {
            if (pointInIndexedRing(lon, lat, poly[h])) {
                inHole = true;
                break;
            }
        }
        if (!inHole) return true;
    }
    return false;
}

/** Build the index for a layer set. Cheap (bboxes only); memoized on the
 * layer collections' identity by chartAreaIndexFor. */
export function buildChartAreaIndex(layers: ClipLayers): ChartAreaIndex {
    const land: IndexedArea[] = [];
    const wet: IndexedArea[] = [];
    const depth: IndexedDepthArea[] = [];
    for (const f of layers.LNDARE?.features ?? []) {
        const g = areaGeometry(f);
        if (g) land.push(indexArea(g, readNum(f.properties, '_scaleRank')));
    }
    for (const [layer, isDredged] of [
        [layers.DEPARE, false],
        [layers.DRGARE, true],
    ] as const) {
        for (const f of layer?.features ?? []) {
            const g = areaGeometry(f);
            if (!g || !isS57Feature(f)) continue;
            const acronym = String(f.properties?.acronym ?? f.properties?.ACRONYM ?? '').toUpperCase();
            // The display merge folds DRGARE into DEPARE; the acronym still says which.
            const dredged = isDredged || acronym === 'DRGARE';
            const drval1 = readNum(f.properties, 'DRVAL1');
            const area = indexArea(g, readNum(f.properties, '_scaleRank'));
            depth.push({ ...area, drval1 });
            if (dredged || (drval1 !== null && drval1 > 0)) wet.push(area);
        }
    }
    for (const f of layers.FAIRWY?.features ?? []) {
        const g = areaGeometry(f);
        if (g && isS57Feature(f)) wet.push(indexArea(g, readNum(f.properties, '_scaleRank')));
    }
    return { land, wet, depth, clipCache: new WeakMap() };
}

const EMPTY_KEY = {};
const indexMemo = new WeakMap<object, { parts: object[]; index: ChartAreaIndex }>();

/** The memoized index for a layer set, keyed on the collections' identity —
 * the grid and the audit hand the same merged collections in for a route. */
export function chartAreaIndexFor(layers: ClipLayers): ChartAreaIndex {
    const parts = [layers.LNDARE, layers.DEPARE, layers.DRGARE, layers.FAIRWY].map((c) => c ?? EMPTY_KEY);
    const hit = indexMemo.get(parts[0]);
    if (hit && hit.parts.every((p, i) => p === parts[i])) return hit.index;
    const index = buildChartAreaIndex(layers);
    indexMemo.set(parts[0], { parts, index });
    return index;
}

const bboxHitsSegment = (b: BBox, s: BBox): boolean => !(b[2] < s[0] || b[0] > s[2] || b[3] < s[1] || b[1] > s[3]);

/** Hard land at a point: inside LNDARE, and not inside chart water charted
 * at the same or a finer scale than the finest land claim there (unranked
 * land loses to any chart water; unranked water beats any land). */
function landAt(index: ChartAreaIndex, lon: number, lat: number): boolean {
    let landRank: number | undefined;
    for (const a of index.land) {
        const r = a.rank ?? -Infinity;
        if (landRank !== undefined && r <= landRank) continue;
        if (pointInArea(a, lon, lat)) landRank = r;
    }
    if (landRank === undefined) return false;
    for (const w of index.wet) {
        if ((w.rank ?? Infinity) < landRank) continue;
        if (pointInArea(w, lon, lat)) return false;
    }
    return true;
}

/** Charted depth at a point: the finest-ranked covering bands own it, and
 * the shallowest DRVAL1 among them wins. Null when no band covers the point,
 * or when any band at that finest rank carries no DRVAL1 — the finest survey
 * charts no depth here, and a coarser cell's band is not evidence for it. */
export function chartedDepthAt(areas: readonly IndexedDepthArea[], lon: number, lat: number): number | null {
    let bestRank = -Infinity;
    let covered = false;
    let undepthed = false;
    let depth: number | null = null;
    for (const a of areas) {
        const rank = a.rank ?? -Infinity;
        // A coarser band can never change the answer once a finer one covers.
        if (covered && rank < bestRank) continue;
        if (!pointInArea(a, lon, lat)) continue;
        if (!covered || rank > bestRank) {
            covered = true;
            bestRank = rank;
            undepthed = a.drval1 === null;
            depth = a.drval1;
        } else if (a.drval1 === null) {
            undepthed = true;
        } else if (depth === null || a.drval1 < depth) {
            depth = a.drval1;
        }
    }
    return undepthed ? null : depth;
}

/** Parameters t ∈ (0,1) where segment a→b crosses any edge of the areas. */
function crossings(areas: readonly IndexedArea[], a: Position, b: Position, sb: BBox, out: number[]): void {
    const ax = a[0];
    const ay = a[1];
    const bx = b[0] - ax;
    const by = b[1] - ay;
    for (const area of areas) {
        if (!bboxHitsSegment(area.bbox, sb)) continue;
        for (const r of area.rings) {
            const ring = r.ring;
            const n = ring.length;
            // A repeated edge (it spans several bands) repeats its t; the
            // zero-length piece between the twins is skipped downstream.
            forEachEdgeNear(r, sb[1], sb[3], (i) => {
                const c = ring[i === 0 ? n - 1 : i - 1];
                const d = ring[i];
                // Edge bbox reject before the solve.
                if (
                    (c[0] < sb[0] && d[0] < sb[0]) ||
                    (c[0] > sb[2] && d[0] > sb[2]) ||
                    (c[1] < sb[1] && d[1] < sb[1]) ||
                    (c[1] > sb[3] && d[1] > sb[3])
                )
                    return;
                const dx = d[0] - c[0];
                const dy = d[1] - c[1];
                const denom = bx * dy - by * dx;
                if (denom === 0) return; // parallel: no single crossing
                const cx = c[0] - ax;
                const cy = c[1] - ay;
                const t = (cx * dy - cy * dx) / denom;
                const u = (cx * by - cy * bx) / denom;
                if (t > 0 && t < 1 && u >= 0 && u <= 1) out.push(t);
            });
        }
    }
}

/** Cut one segment at every land/water/depth boundary and classify each
 * piece at its midpoint. */
function profileSegment(index: ChartAreaIndex, a: Position, b: Position, withDepth: boolean): SegmentPiece[] {
    const sb: BBox = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    const ts: number[] = [0, 1];
    crossings(index.land, a, b, sb, ts);
    // Wet areas only matter where land is: skip their edges when no land
    // area touches this segment (the common open-water case).
    const landNear = index.land.some((area) => bboxHitsSegment(area.bbox, sb));
    if (landNear) crossings(index.wet, a, b, sb, ts);
    if (withDepth) crossings(index.depth, a, b, sb, ts);
    ts.sort((x, y) => x - y);
    const pieces: SegmentPiece[] = [];
    for (let i = 0; i < ts.length - 1; i++) {
        const t0 = ts[i];
        const t1 = ts[i + 1];
        if (t1 - t0 < 1e-12) continue;
        const tm = (t0 + t1) / 2;
        const lon = a[0] + (b[0] - a[0]) * tm;
        const lat = a[1] + (b[1] - a[1]) * tm;
        const land = landNear && landAt(index, lon, lat);
        const depthM = withDepth ? chartedDepthAt(index.depth, lon, lat) : null;
        const prev = pieces[pieces.length - 1];
        if (prev && prev.land === land && prev.depthM === depthM) prev.t1 = t1;
        else pieces.push({ t0, t1, land, depthM });
    }
    return pieces;
}

/**
 * A line cut at every edge of `areas`: each piece's midpoint and length
 * (m), in the line's own order. Exact, like the land cut: anything that
 * differs along the line only differs across an edge, so one midpoint
 * test per piece classifies the whole piece.
 */
export function piecesAlong(
    areas: readonly IndexedArea[],
    coords: readonly Position[],
): { lon: number; lat: number; m: number }[] {
    const out: { lon: number; lat: number; m: number }[] = [];
    for (let i = 0; i < coords.length - 1; i++) {
        const a = coords[i];
        const b = coords[i + 1];
        const sb: BBox = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
        const ts: number[] = [0, 1];
        crossings(areas, a, b, sb, ts);
        ts.sort((x, y) => x - y);
        const len = haversineM(a[1], a[0], b[1], b[0]);
        for (let k = 0; k < ts.length - 1; k++) {
            if (ts[k + 1] - ts[k] < 1e-12) continue;
            const tm = (ts[k] + ts[k + 1]) / 2;
            out.push({
                lon: a[0] + (b[0] - a[0]) * tm,
                lat: a[1] + (b[1] - a[1]) * tm,
                m: (ts[k + 1] - ts[k]) * len,
            });
        }
    }
    return out;
}

const lerp = (a: Position, b: Position, t: number): Position => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const segM = (a: Position, b: Position): number => haversineM(a[1], a[0], b[1], b[0]);

/** Lines this short are rounding, not a lead (one 1 m step either side). */
const MIN_PIECE_M = 1;

/** The areas that can touch a line at all (its bbox), so each of its
 * segments scans a short list instead of the whole chart. */
function indexNear(index: ChartAreaIndex, coords: readonly Position[]): ChartAreaIndex {
    if (coords.length === 0) return index;
    const lb: BBox = [Infinity, Infinity, -Infinity, -Infinity];
    for (const c of coords) {
        if (c[0] < lb[0]) lb[0] = c[0];
        if (c[1] < lb[1]) lb[1] = c[1];
        if (c[0] > lb[2]) lb[2] = c[0];
        if (c[1] > lb[3]) lb[3] = c[1];
    }
    const near = <A extends IndexedArea>(areas: A[]): A[] => areas.filter((a) => bboxHitsSegment(a.bbox, lb));
    return { land: near(index.land), wet: near(index.wet), depth: near(index.depth), clipCache: index.clipCache };
}

/**
 * Cut a line to its on-water runs. A run continues through a vertex when
 * the water continues; land splits it. Runs shorter than `minPieceM` are
 * dropped (their metres are neither land nor kept).
 */
export function clipLineToWater(
    index: ChartAreaIndex,
    coords: readonly Position[],
    minPieceM = MIN_PIECE_M,
): ClippedLine {
    index = indexNear(index, coords);
    const pieces: Position[][] = [];
    let lengthM = 0;
    let landM = 0;
    let run: Position[] = [];
    let runM = 0;
    const flush = (): void => {
        if (run.length >= 2 && runM >= minPieceM) pieces.push(run);
        run = [];
        runM = 0;
    };
    for (let i = 0; i < coords.length - 1; i++) {
        const a = coords[i];
        const b = coords[i + 1];
        const len = segM(a, b);
        lengthM += len;
        if (index.land.length === 0) {
            if (run.length === 0) run.push(a);
            run.push(b);
            runM += len;
            continue;
        }
        for (const piece of profileSegment(index, a, b, false)) {
            const m = (piece.t1 - piece.t0) * len;
            if (piece.land) {
                landM += m;
                flush();
                continue;
            }
            const p0 = piece.t0 === 0 ? a : lerp(a, b, piece.t0);
            const p1 = piece.t1 === 1 ? b : lerp(a, b, piece.t1);
            if (run.length === 0) run.push(p0);
            run.push(p1);
            runM += m;
        }
    }
    flush();
    return { pieces, lengthM, landM };
}

/** Charted depth, uncovered metres and land metres along a line. */
export function depthAlongLine(index: ChartAreaIndex, coords: readonly Position[]): DepthAlong {
    index = indexNear(index, coords);
    let lengthM = 0;
    let uncoveredM = 0;
    let landM = 0;
    let minDepthM: number | null = null;
    for (let i = 0; i < coords.length - 1; i++) {
        const a = coords[i];
        const b = coords[i + 1];
        const len = segM(a, b);
        lengthM += len;
        for (const piece of profileSegment(index, a, b, true)) {
            const m = (piece.t1 - piece.t0) * len;
            if (piece.land) landM += m;
            if (piece.depthM === null) uncoveredM += m;
            else if (minDepthM === null || piece.depthM < minDepthM) minDepthM = piece.depthM;
        }
    }
    return { lengthM, minDepthM, uncoveredM, landM };
}

/** LineString / MultiLineString coordinates of a feature (malformed vertices
 * split the line rather than being joined across). */
export function lineRings(feature: ClipFeatureLike): Position[][] {
    const g = feature.geometry;
    if (!g || !Array.isArray(g.coordinates)) return [];
    const raw: unknown[] =
        g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? (g.coordinates as unknown[]) : [];
    const out: Position[][] = [];
    for (const ring of raw) {
        if (!Array.isArray(ring)) continue;
        let cur: Position[] = [];
        for (const c of ring) {
            if (Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1])) {
                cur.push([c[0] as number, c[1] as number]);
            } else {
                if (cur.length >= 2) out.push(cur);
                cur = [];
            }
        }
        if (cur.length >= 2) out.push(cur);
    }
    return out;
}

/**
 * The same line features, each cut to its on-water spans (a MultiLineString
 * with the feature's own properties), for the engine's raw-lead consumers.
 * A feature with no land under it comes back as the SAME object; one wholly
 * ashore is dropped. Returns the input array itself when nothing changed, so
 * callers keep identity. Memoized per feature per layer set.
 */
export function navLinesOnWater<T extends ClipFeatureLike>(features: readonly T[], layers: ClipLayers): T[] {
    if (features.length === 0 || !(layers.LNDARE?.features.length ?? 0)) return features as T[];
    const index = chartAreaIndexFor(layers);
    let changed = false;
    const out: T[] = [];
    for (const feature of features) {
        let clipped = index.clipCache.get(feature);
        if (clipped === undefined) {
            const rings = lineRings(feature);
            const cut = rings.map((ring) => clipLineToWater(index, ring));
            const landM = cut.reduce((s, c) => s + c.landM, 0);
            if (rings.length === 0 || landM === 0) clipped = feature;
            else {
                const pieces = cut.flatMap((c) => c.pieces);
                clipped =
                    pieces.length === 0
                        ? null
                        : { ...feature, geometry: { type: 'MultiLineString', coordinates: pieces } };
            }
            index.clipCache.set(feature, clipped);
        }
        if (clipped !== feature) changed = true;
        if (clipped) out.push(clipped as T);
    }
    return changed ? out : (features as T[]);
}
