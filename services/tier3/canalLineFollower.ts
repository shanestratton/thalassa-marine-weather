/**
 * Canal centre-line follower.
 *
 * The charted OSM canal lines (`waterway=canal/fairway/dock`, loaded into the
 * engine's CANAL layer) are drawn DOWN THE MIDDLE of every canal. So the
 * dead-centre route through a canal estate isn't something to reconstruct — it's
 * already in the chart. This follows it: build a graph from the canal lines and
 * route along it (Dijkstra). By construction the result rides the middle of the
 * canal — no medial-axis solve, no A* wall-hug, no mark reconstruction.
 *
 * TIER-AGNOSTIC BY DESIGN. The canal lines also carve navigable water into the
 * routing grid (so canal estates connect to open water), which makes the segmenter
 * read the canal as tier-2 open water, NOT tier-3. So a per-tier-3-span follow
 * would miss the very canal it targets. `snapRouteToCanalLines` instead operates
 * on the FINAL assembled route: it finds the contiguous run(s) of route points
 * that ride the canal network and replaces each with the centre-line — whatever
 * tier produced them. Verified on the real Newport estate (tests/repro).
 */
import type { LatLon } from '../routing/legContract';

interface LL {
    lat: number;
    lon: number;
}

const M_PER_LAT = 110_540;
const mPerLon = (lat: number): number => 111_320 * Math.cos((lat * Math.PI) / 180);
const distM = (a: LL, b: LL): number => Math.hypot((b.lon - a.lon) * mPerLon(a.lat), (b.lat - a.lat) * M_PER_LAT);

/** A point farther than this from the canal-line network is not on a charted
 *  canal. A wall-hugging route point in a ~40 m canal still sits ≤ ~25 m from the
 *  centre-line, so this comfortably catches a hug without grabbing open water. */
export const ON_CANAL_M = 80;
/** A span endpoint farther than this from the network means followCanalLines
 *  should decline rather than snap a long stub across unknown ground. */
export const CANAL_SNAP_MAX_M = 120;
/** A canal run continues across up to this many consecutive off-canal route
 *  points. The coarse A* corner-cuts a canal bend, briefly bulging out of the
 *  ON_CANAL_M band mid-estate (Newport: a single 146 m excursion between two
 *  on-canal stretches); bridging it keeps the whole estate traversal as ONE run
 *  that reroutes to a single centre-line. Small enough not to bridge the open
 *  bay between two separate canals (kilometres = many points). */
export const CANAL_RUN_GAP = 2;

interface CanalGraph {
    nodes: Map<string, LL>;
    adj: Map<string, Array<[string, number]>>;
    nearest(p: LL): { k: string; d: number } | null;
}

/** Build an undirected graph from the canal lines: nodes = vertices snapped to
 *  ~9 m (so lines that share a junction connect), edges = segments by length. */
function buildCanalGraph(canalLines: readonly (readonly LatLon[])[]): CanalGraph {
    const keyOf = (lon: number, lat: number): string => `${Math.round(lon * 1e4)}|${Math.round(lat * 1e4)}`;
    const nodes = new Map<string, LL>();
    const adj = new Map<string, Array<[string, number]>>();
    const link = (a: string, b: string, w: number): void => {
        let la = adj.get(a);
        if (!la) {
            la = [];
            adj.set(a, la);
        }
        let lb = adj.get(b);
        if (!lb) {
            lb = [];
            adj.set(b, lb);
        }
        la.push([b, w]);
        lb.push([a, w]);
    };
    for (const line of canalLines) {
        let prev: string | null = null;
        for (const [lon, lat] of line) {
            const k = keyOf(lon, lat);
            if (!nodes.has(k)) nodes.set(k, { lat, lon });
            if (prev !== null && prev !== k) link(prev, k, distM(nodes.get(prev) as LL, { lat, lon }));
            prev = k;
        }
    }
    const nearest = (p: LL): { k: string; d: number } | null => {
        let best: string | null = null;
        let bd = Infinity;
        for (const [k, node] of nodes) {
            const d = distM(node, p);
            if (d < bd) {
                bd = d;
                best = k;
            }
        }
        return best === null ? null : { k: best, d: bd };
    };
    return { nodes, adj, nearest };
}

/** Dijkstra from sKey to tKey over the canal graph. Returns the node path
 *  (vertices, inclusive of both ends) or null if disconnected / degenerate. */
function routeGraph(g: CanalGraph, sKey: string, tKey: string): LL[] | null {
    if (sKey === tKey) return null;
    const dist = new Map<string, number>([[sKey, 0]]);
    const prev = new Map<string, string>();
    const heap: Array<[number, string]> = [[0, sKey]];
    const swap = (i: number, j: number): void => {
        const tmp = heap[i];
        heap[i] = heap[j];
        heap[j] = tmp;
    };
    const push = (c: number, k: string): void => {
        heap.push([c, k]);
        let i = heap.length - 1;
        while (i > 0) {
            const par = (i - 1) >> 1;
            if (heap[par][0] <= heap[i][0]) break;
            swap(par, i);
            i = par;
        }
    };
    const pop = (): [number, string] => {
        const top = heap[0];
        const last = heap.pop() as [number, string];
        if (heap.length) {
            heap[0] = last;
            let i = 0;
            for (;;) {
                const l = 2 * i + 1;
                const r = 2 * i + 2;
                let m = i;
                if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
                if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
                if (m === i) break;
                swap(m, i);
                i = m;
            }
        }
        return top;
    };
    while (heap.length) {
        const [c, u] = pop();
        if (u === tKey) break;
        if (c > (dist.get(u) ?? Infinity)) continue;
        for (const [v, w] of g.adj.get(u) ?? []) {
            const nd = c + w;
            if (nd < (dist.get(v) ?? Infinity)) {
                dist.set(v, nd);
                prev.set(v, u);
                push(nd, v);
            }
        }
    }
    if (!prev.has(tKey)) return null;
    const out: LL[] = [];
    let cur: string | undefined = tKey;
    while (cur !== undefined) {
        out.push(g.nodes.get(cur) as LL);
        if (cur === sKey) break;
        cur = prev.get(cur);
    }
    out.reverse();
    return out.length >= 2 ? out : null;
}

/**
 * Follow the canal centre-lines from `entry` to `exit` (both endpoints must sit
 * on the network within CANAL_SNAP_MAX_M). Returns [entry, …centre-line…, exit],
 * or null when off-network. Used by the bench + as a span-level primitive.
 */
export function followCanalLines(entry: LL, exit: LL, canalLines: readonly (readonly LatLon[])[]): LL[] | null {
    const g = buildCanalGraph(canalLines);
    if (g.nodes.size < 2) return null;
    const s = g.nearest(entry);
    const t = g.nearest(exit);
    if (!s || !t || s.d > CANAL_SNAP_MAX_M || t.d > CANAL_SNAP_MAX_M) return null;
    const centre = routeGraph(g, s.k, t.k);
    if (!centre) return null;
    return [entry, ...centre, exit];
}

/**
 * Snap the canal portion(s) of an ASSEMBLED route onto the canal centre-lines.
 * Finds each maximal contiguous run of route points within ON_CANAL_M of the
 * network and replaces it with the Dijkstra centre-line between the run's ends —
 * so the canal rides dead centre no matter which tier produced those points. Open
 * water / river points (off-network) pass through untouched. Origin and dest are
 * preserved. A run that doesn't route on the graph keeps its original points.
 *
 * @param polyline the assembled route as [lon,lat] tuples.
 * @returns `polyline` (the snapped route, [lon,lat] tuples) plus a per-VERTEX
 *   `onCanal` mask (same length) flagging which output vertices ride the canal
 *   centre-line — so the caller can render the canal stretch caution-red (the
 *   grid calls carved canal cells navigable, so the engine's grid-based caution
 *   recompute would otherwise leave them green). Origin/dest stay false (pinned
 *   bridge points — keeps the seam to open water clean; the OR-of-endpoints in
 *   the renderer still reddens the entry/exit segment via the canal neighbour).
 */
export function snapRouteToCanalLines(
    polyline: readonly LatLon[],
    canalLines: readonly (readonly LatLon[])[],
): { polyline: LatLon[]; onCanal: boolean[] } {
    const asTuples = (): LatLon[] => polyline.map((p) => [p[0], p[1]] as LatLon);
    if (polyline.length < 2 || canalLines.length === 0)
        return { polyline: asTuples(), onCanal: polyline.map(() => false) };
    const g = buildCanalGraph(canalLines);
    if (g.nodes.size < 2) return { polyline: asTuples(), onCanal: polyline.map(() => false) };

    const pts: LL[] = polyline.map(([lon, lat]) => ({ lat, lon }));
    const n = pts.length;
    const onCanal = pts.map((p) => {
        const near = g.nearest(p);
        return near !== null && near.d <= ON_CANAL_M;
    });

    const out: LL[] = [];
    const outCanal: boolean[] = [];
    const emit = (p: LL, isCanal: boolean): void => {
        out.push(p);
        outCanal.push(isCanal);
    };
    let i = 0;
    while (i < n) {
        if (!onCanal[i]) {
            emit(pts[i], false);
            i++;
            continue;
        }
        // Extend the run to the last on-canal point, bridging gaps of ≤
        // CANAL_RUN_GAP off-canal points (the A* corner-cuts inside the estate).
        let j = i;
        for (let k = i + 1; k < n; k++) {
            if (onCanal[k]) j = k;
            else if (k - j > CANAL_RUN_GAP) break;
        }
        // Run [i..j] rides the canal. Route its ends along the centre-line.
        const s = g.nearest(pts[i]);
        const t = g.nearest(pts[j]);
        const centre = s && t ? routeGraph(g, s.k, t.k) : null;
        if (centre) {
            // Keep the route origin/dest exactly (pinned bridge points, flagged
            // NOT-canal for a clean open-water seam); the centre vertices between
            // ARE the canal and carry the flag so they render caution-red.
            if (i === 0) emit(pts[0], false);
            for (const c of centre) emit(c, true);
            if (j === n - 1) emit(pts[n - 1], false);
        } else {
            // Couldn't route on the graph — keep the original points with their own
            // on-canal flag (the run still rides the canal where flagged).
            for (let k = i; k <= j; k++) emit(pts[k], onCanal[k]);
        }
        i = j + 1;
    }
    return { polyline: out.map((p) => [p.lon, p.lat] as LatLon), onCanal: outCanal };
}

/** Parse CANAL-layer LineString features into [lon,lat] vertex arrays. */
export function parseCanalLines(
    features: ReadonlyArray<{ geometry?: { type?: string; coordinates?: unknown } | null }>,
): LatLon[][] {
    const out: LatLon[][] = [];
    for (const f of features) {
        const geom = f.geometry;
        if (!geom || !Array.isArray(geom.coordinates)) continue;
        if (geom.type === 'LineString') {
            out.push(geom.coordinates as LatLon[]);
        } else if (geom.type === 'MultiLineString') {
            for (const seg of geom.coordinates as LatLon[][]) out.push(seg);
        }
    }
    return out;
}
