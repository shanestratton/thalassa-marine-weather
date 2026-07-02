/**
 * fairlead — lateral-mark channel follower, ported from the proven spike
 * (~/Projects/MarinerEE/fairlead_demo.py). The routing-stack layer AFTER
 * the marina centerline (services/marinaCenterline.ts) and before coastal:
 * it takes over at the mouth of a marked channel and threads the buoyed
 * fairway out to open water, keeping red (port) and green (starboard) on
 * their IALA region-A sides.
 *
 * Self-contained, pure functions over lat/lon so they can be parity-tested
 * in isolation BEFORE being wired into the inshore engine. Nothing here
 * imports the engine.
 *
 * Pipeline (proven on real Moreton Bay AU SENC marks):
 *   1. parseLateralMarks — BOYLAT/BCNLAT GeoJSON → marks (side from CATLAM,
 *      key+seq from OBJNAM). Side authority is CATLAM, NOT COLOUR (beacon
 *      paint is noisy — many marks are COLOUR white/black).
 *   2. groupChannels     — group marks into channels (OBJNAM key + 1.5 km
 *      spatial union-find; splits reused numbering like two 1..16 runs).
 *   3. pickChannel       — the channel nearest the handoff point.
 *   4. corridorCenterline— interpolate the port-line + starboard-line by
 *      mark SEQUENCE, per-station midpoint → follows bends, tolerates a
 *      lopsided mark count.
 *   5. directRoute       — orient outbound: start nearest the handoff (the
 *      MarinerEE drop-off), exit at the open-water end.
 */

export interface LatLon {
    lat: number;
    lon: number;
}

export interface LateralMark extends LatLon {
    /** Treat-as side, from CATLAM: 1 = port, 2 = starboard, and the preferred-channel
     *  (modified lateral) marks 3/4 fold onto the side they are TREATED as when
     *  following the preferred channel — 3 (preferred channel to stbd) handles as a
     *  port-hand mark, 4 (preferred to port) as starboard-hand. CATLAM semantics are
     *  identical in IALA regions A and B (only the paint flips), so this is region-safe. */
    side: 'port' | 'stbd';
    /** True for CATLAM 3/4 — a bifurcation (preferred-channel) mark, not a plain lateral. */
    preferredChannel?: boolean;
    /** Channel key — the non-numeric part of OBJNAM (e.g. 'BC', 'F', 'NUM'). */
    key: string;
    /** Sequence number along the channel, from OBJNAM. */
    seq: number;
    name: string;
}

/** Minimal GeoJSON-ish shape so this module needn't depend on @types/geojson. */
interface PointFeatureLike {
    geometry?: { type?: string; coordinates?: number[] } | null;
    properties?: Record<string, unknown> | null;
}

/** Metres between two lat/lon points (local equirectangular — fine at the
 *  sub-10 km scale a channel spans). */
export function distM(a: LatLon, b: LatLon): number {
    const mPerLat = 110_540;
    const mPerLon = 111_320 * Math.cos((a.lat * Math.PI) / 180);
    const dx = (b.lon - a.lon) * mPerLon;
    const dy = (b.lat - a.lat) * mPerLat;
    return Math.hypot(dx, dy);
}

/**
 * Parse BOYLAT/BCNLAT point features into lateral marks. A mark is kept only
 * if it has a CATLAM of 1 (port), 2 (starboard), or a preferred-channel
 * modified lateral 3/4 (folded onto its treat-as side: 3 → port-hand,
 * 4 → starboard-hand), AND an OBJNAM that starts with an optional letter
 * prefix + a number (e.g. "BC7, Coffee Pot West", "12", "5F"). The channel
 * key is the letters around the number (uppercased, 'NUM' when purely
 * numeric); the sequence is the number.
 */
export function parseLateralMarks(features: PointFeatureLike[]): LateralMark[] {
    const out: LateralMark[] = [];
    for (const f of features) {
        const g = f.geometry;
        if (!g || g.type !== 'Point' || !Array.isArray(g.coordinates)) continue;
        const props = f.properties ?? {};
        const cat = props.CATLAM;
        const side = cat === 1 || cat === 3 ? 'port' : cat === 2 || cat === 4 ? 'stbd' : null;
        if (!side) continue;
        const name = typeof props.OBJNAM === 'string' ? props.OBJNAM : '';
        const m = /^([A-Za-z]*)(\d+)([A-Za-z]*)/.exec(name);
        if (!m) continue;
        const [lon, lat] = g.coordinates;
        out.push({
            lat,
            lon,
            side,
            key: (m[1] + m[3]).toUpperCase() || 'NUM',
            seq: parseInt(m[2], 10),
            name,
            ...(cat === 3 || cat === 4 ? { preferredChannel: true } : {}),
        });
    }
    return out;
}

/**
 * Group marks into channels: same OBJNAM key AND spatially within
 * `proximityM` (union-find). Only groups with ≥ 3 marks are returned — a
 * couple of stray marks don't make a channel.
 */
export function groupChannels(marks: LateralMark[], proximityM = 1500): LateralMark[][] {
    const byKey = new Map<string, LateralMark[]>();
    for (const m of marks) {
        const arr = byKey.get(m.key);
        if (arr) arr.push(m);
        else byKey.set(m.key, [m]);
    }

    const channels: LateralMark[][] = [];
    for (const group of byKey.values()) {
        const parent = group.map((_, i) => i);
        const find = (i: number): number => {
            while (parent[i] !== i) {
                parent[i] = parent[parent[i]];
                i = parent[i];
            }
            return i;
        };
        for (let i = 0; i < group.length; i++) {
            for (let j = i + 1; j < group.length; j++) {
                if (distM(group[i], group[j]) < proximityM) parent[find(i)] = find(j);
            }
        }
        const clusters = new Map<number, LateralMark[]>();
        for (let i = 0; i < group.length; i++) {
            const r = find(i);
            const arr = clusters.get(r);
            if (arr) arr.push(group[i]);
            else clusters.set(r, [group[i]]);
        }
        for (const c of clusters.values()) if (c.length >= 3) channels.push(c);
    }
    return channels;
}

/** The channel whose nearest mark is closest to the handoff point. */
export function pickChannel(channels: LateralMark[][], handoff: LatLon): LateralMark[] | null {
    let best: LateralMark[] | null = null;
    let bestD = Infinity;
    for (const ch of channels) {
        let d = Infinity;
        for (const m of ch) d = Math.min(d, distM(m, handoff));
        if (d < bestD) {
            bestD = d;
            best = ch;
        }
    }
    return best;
}

/** Linear-interpolate a sequence-ordered mark line at sequence value `q`
 *  (clamped to the endpoints outside the range). */
function interpBySeq(line: LateralMark[], q: number): LatLon {
    if (q <= line[0].seq) return { lat: line[0].lat, lon: line[0].lon };
    const last = line[line.length - 1];
    if (q >= last.seq) return { lat: last.lat, lon: last.lon };
    for (let i = 0; i < line.length - 1; i++) {
        const a = line[i];
        const b = line[i + 1];
        if (a.seq <= q && q <= b.seq) {
            const f = b.seq > a.seq ? (q - a.seq) / (b.seq - a.seq) : 0;
            return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
        }
    }
    return { lat: last.lat, lon: last.lon };
}

/**
 * Corridor centreline: interpolate the port-line and starboard-line by mark
 * sequence, and take the per-station midpoint. Follows channel bends (the
 * lines are interpolated along their real positions) and tolerates a
 * lopsided mark count. Returns [] if either side is empty.
 */
export function corridorCenterline(channel: LateralMark[], samples = 140): LatLon[] {
    const port = channel.filter((m) => m.side === 'port').sort((a, b) => a.seq - b.seq);
    const stbd = channel.filter((m) => m.side === 'stbd').sort((a, b) => a.seq - b.seq);
    if (port.length === 0 || stbd.length === 0) return [];
    const portLo = port[0].seq;
    const portHi = port[port.length - 1].seq;
    const stbdLo = stbd[0].seq;
    const stbdHi = stbd[stbd.length - 1].seq;
    const qmin = Math.min(portLo, stbdLo);
    const qmax = Math.max(portHi, stbdHi);
    const n = Math.max(2, samples);
    const inPort = (q: number): boolean => q >= portLo && q <= portHi;
    const inStbd = (q: number): boolean => q >= stbdLo && q <= stbdHi;

    // Cross-channel vector (port − starboard) at the paired stations — gives
    // both the local channel direction-across and its width. Used to centre
    // the single-side ends (where only one mark line exists) by offsetting
    // the present line half a channel width toward the interior, instead of
    // clamping the missing line (which drifts the centreline off the mouth).
    const paired: { q: number; dLat: number; dLon: number }[] = [];
    for (let i = 0; i < n; i++) {
        const q = qmin + ((qmax - qmin) * i) / (n - 1);
        if (inPort(q) && inStbd(q)) {
            const p = interpBySeq(port, q);
            const s = interpBySeq(stbd, q);
            paired.push({ q, dLat: p.lat - s.lat, dLon: p.lon - s.lon });
        }
    }
    const crossNear = (q: number): { dLat: number; dLon: number } => {
        if (paired.length === 0) return { dLat: 0, dLon: 0 };
        let best = paired[0];
        let bd = Math.abs(q - best.q);
        for (const pr of paired) {
            const d = Math.abs(q - pr.q);
            if (d < bd) {
                bd = d;
                best = pr;
            }
        }
        return best;
    };

    const out: LatLon[] = [];
    for (let i = 0; i < n; i++) {
        const q = qmin + ((qmax - qmin) * i) / (n - 1);
        if (inPort(q) && inStbd(q)) {
            const p = interpBySeq(port, q);
            const s = interpBySeq(stbd, q);
            out.push({ lat: (p.lat + s.lat) / 2, lon: (p.lon + s.lon) / 2 });
        } else if (inStbd(q)) {
            const s = interpBySeq(stbd, q);
            const c = crossNear(q); // starboard → interior is +half the cross vector
            out.push({ lat: s.lat + c.dLat / 2, lon: s.lon + c.dLon / 2 });
        } else {
            const p = interpBySeq(port, q);
            const c = crossNear(q); // port → interior is −half the cross vector
            out.push({ lat: p.lat - c.dLat / 2, lon: p.lon - c.dLon / 2 });
        }
    }
    return out;
}

/** Centred moving-average smoothing, endpoints pinned. */
export function smoothPath(pts: LatLon[], window = 11): LatLon[] {
    if (pts.length < 3) return pts.slice();
    const half = window >> 1;
    const out: LatLon[] = [];
    for (let i = 0; i < pts.length; i++) {
        const lo = Math.max(0, i - half);
        const hi = Math.min(pts.length, i + half + 1);
        let lat = 0;
        let lon = 0;
        for (let j = lo; j < hi; j++) {
            lat += pts[j].lat;
            lon += pts[j].lon;
        }
        out.push({ lat: lat / (hi - lo), lon: lon / (hi - lo) });
    }
    out[0] = pts[0];
    out[out.length - 1] = pts[pts.length - 1];
    return out;
}

/** Orient so the route STARTS at the channel end nearest the handoff (the
 *  MarinerEE drop-off) and EXITS at the far, open-water end. */
export function directRoute(centre: LatLon[], handoff: LatLon): LatLon[] {
    if (centre.length < 2) return centre;
    const d0 = distM(centre[0], handoff);
    const d1 = distM(centre[centre.length - 1], handoff);
    return d1 < d0 ? centre.slice().reverse() : centre;
}

export interface FairleadOptions {
    /** If the nearest channel's closest mark is further than this from the
     *  handoff, Fairlead doesn't apply (no marked channel here) → null. */
    maxHandoffM?: number;
    /** Smoothing window for the centreline. */
    smoothWindow?: number;
}

export interface FairleadResult {
    /** Directed channel centreline, handoff → open water. */
    centerline: LatLon[];
    /** The channel that was followed (its marks). */
    channel: LateralMark[];
}

/**
 * Full Fairlead pipeline. Given all lateral marks and the handoff point
 * (MarinerEE's drop-off / the channel mouth), identify the channel, build
 * its directed corridor centreline, and return it. Returns null when there
 * is no marked channel near the handoff (Fairlead simply doesn't apply —
 * the caller falls back to coastal routing).
 */
export function routeFairlead(
    marks: LateralMark[],
    handoff: LatLon,
    opts: FairleadOptions = {},
): FairleadResult | null {
    const channels = groupChannels(marks);
    const channel = pickChannel(channels, handoff);
    if (!channel) return null;

    const nearest = Math.min(...channel.map((m) => distM(m, handoff)));
    if (nearest > (opts.maxHandoffM ?? 3000)) return null;

    let centre = corridorCenterline(channel);
    if (centre.length < 2) return null;
    centre = smoothPath(centre, opts.smoothWindow ?? 11);
    centre = directRoute(centre, handoff);
    return { centerline: centre, channel };
}

export interface RefineOptions extends FairleadOptions {
    /** Max distance from the route to a mark for it to count as "near". */
    traverseM?: number;
    /** Only consider a channel transited at/after this polyline SEGMENT index
     *  (the marina exit — Fairlead stays out of the canal). */
    fromIdx?: number;
    /** Min fraction of a channel's marks that must lie near the route for it
     *  to count as a genuine transit (not two stray ends). Default 0.6. */
    minAlongFraction?: number;
    /** Per-segment caution of the input polyline (length = points − 1). When
     *  provided, the result carries a correctly re-aligned caution mask:
     *  original kept segments keep their flag, every spliced bridge/centreline
     *  segment is clean. The caller (engine) passes this so multi-channel
     *  splices don't desync the red-rendering mask. */
    cautionMask?: boolean[];
}

export interface RefineResult {
    /** Route polyline with each transited buoyed channel replaced by its
     *  Fairlead centreline; unchanged if nothing is transited / validates. */
    polyline: LatLon[];
    /** Outer hull [firstEntrySegIdx, lastExitSegIdx] of the replaced ranges,
     *  or null when nothing was spliced. */
    replacedRange: [number, number] | null;
    /** '+'-joined keys of every channel spliced (route order), or null. */
    channelKey: string | null;
    /** Re-aligned per-segment caution, present iff opts.cautionMask was given. */
    cautionMask?: boolean[];
}

/** Project p onto segment a→b (local planar metres). */
function projectPointToSegment(p: LatLon, a: LatLon, b: LatLon): { point: LatLon; t: number } {
    const mLat = 110_540;
    const mLon = 111_320 * Math.cos((a.lat * Math.PI) / 180);
    const bx = (b.lon - a.lon) * mLon;
    const by = (b.lat - a.lat) * mLat;
    const px = (p.lon - a.lon) * mLon;
    const py = (p.lat - a.lat) * mLat;
    const len2 = bx * bx + by * by;
    let t = len2 > 0 ? (px * bx + py * by) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return { point: { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t }, t };
}

/** Nearest point on a polyline to p (robust to sparse polylines). */
function projectToPolyline(p: LatLon, poly: LatLon[]): { segIdx: number; along: number; point: LatLon; dist: number } {
    let best = { segIdx: 0, along: 0, point: poly[0], dist: Infinity };
    for (let i = 0; i < poly.length - 1; i++) {
        const pr = projectPointToSegment(p, poly[i], poly[i + 1]);
        const d = distM(p, pr.point);
        if (d < best.dist) best = { segIdx: i, along: i + pr.t, point: pr.point, dist: d };
    }
    return best;
}

/** True if any point sampled densely (≈ every `stepM`) along the polyline
 *  satisfies the predicate. */
function anyAlong(pts: LatLon[], stepM: number, pred: (p: LatLon) => boolean): boolean {
    for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        const n = Math.max(1, Math.ceil(distM(a, b) / stepM));
        for (let k = 0; k <= n; k++) {
            const t = k / n;
            if (pred({ lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t })) return true;
        }
    }
    return false;
}

/** Max deflection (deg) allowed at a spliced-centreline vertex. A turn
 *  sharper than this is a near-reversal — physically impossible between two
 *  ~50 m centreline samples of a dredged channel, so it can only be the
 *  single-side end-DRIFT of corridorCenterline (one sample thrown out-and-
 *  back across the channel mouth; the field "stepping" double-back). Same
 *  turn-discipline family as the leading-line approach guard (a6c2419d).
 *  cos(120°) = −0.5. */
const MAX_FAIRLEAD_REVERSAL_DEG = 120;

/** Remove near-reversal spike vertices (deflection > maxTurnDeg) from a
 *  polyline, KEEPING the endpoints (they connect to the surrounding route).
 *  Iterative with step-back so a run of drift samples collapses cleanly. The
 *  moving-average smoother can't fix these — it PINS the drifted endpoint. */
function dropSpikes(pts: LatLon[], maxTurnDeg: number): LatLon[] {
    if (pts.length < 3) return pts.slice();
    const cosLimit = Math.cos((maxTurnDeg * Math.PI) / 180);
    const out = pts.slice();
    let i = 1;
    while (i < out.length - 1) {
        const a = out[i - 1];
        const b = out[i];
        const c = out[i + 1];
        const mLon = 111_320 * Math.cos((b.lat * Math.PI) / 180);
        const ax = (b.lon - a.lon) * mLon;
        const ay = (b.lat - a.lat) * 110_540;
        const cx = (c.lon - b.lon) * mLon;
        const cy = (c.lat - b.lat) * 110_540;
        const la = Math.hypot(ax, ay);
        const lc = Math.hypot(cx, cy);
        const cos = la > 0 && lc > 0 ? (ax * cx + ay * cy) / (la * lc) : 1;
        if (cos < cosLimit) {
            out.splice(i, 1); // b is a near-reversal spike → drop it
            if (i > 1) i--; // re-check the neighbourhood the removal opened
        } else {
            i++;
        }
    }
    return out;
}

/**
 * Splice the Fairlead centreline into a route where it genuinely transits a
 * buoyed channel. A channel counts as transited only if:
 *   • a good FRACTION of its marks (not just two stray ends) lie within
 *     `traverseM` of the route — i.e. the route runs ALONG the channel; AND
 *   • the transit begins at/after `fromIdx` (the marina exit — Fairlead never
 *     touches the in-canal portion MarinerEE owns).
 * The spliced segment (entry bridge + centreline + exit bridge) is validated
 * end-to-end against `isLand`; ANY point on land aborts the splice and the
 * route is returned unchanged (defer to the grid route — never fabricate).
 */
export function refineWithFairlead(
    polyline: LatLon[],
    marks: LateralMark[],
    isLand?: (p: LatLon) => boolean,
    opts: RefineOptions = {},
): RefineResult {
    const unchanged: RefineResult = {
        polyline,
        replacedRange: null,
        channelKey: null,
        cautionMask: opts.cautionMask,
    };
    if (polyline.length < 2 || marks.length < 3) return unchanged;

    const traverseM = opts.traverseM ?? 500;
    const fromIdx = opts.fromIdx ?? 0;
    const minFrac = opts.minAlongFraction ?? 0.6;
    const channels = groupChannels(marks);

    // Collect EVERY channel the route genuinely transits, each with a land-
    // valid, de-spiked spliced centreline. (Was: pick the single longest-span
    // channel — which left every OTHER transited channel, e.g. a marina exit,
    // as raw stepped A*: the Newport-end stepping.)
    interface Cand {
        ei: number; // entry polyline segment index
        xi: number; // exit polyline segment index
        spliced: LatLon[]; // [entry.point, …centreline, exit.point], de-spiked
        key: string;
    }
    const cands: Cand[] = [];
    for (const ch of channels) {
        // The route must run ALONG the channel: enough of its marks near the line.
        let near = 0;
        for (const m of ch) if (projectToPolyline(m, polyline).dist < traverseM) near++;
        if (near / ch.length < minFrac) continue;

        const seqSorted = ch.slice().sort((a, b) => a.seq - b.seq);
        const p0 = projectToPolyline(seqSorted[0], polyline);
        const p1 = projectToPolyline(seqSorted[seqSorted.length - 1], polyline);
        if (!(p0.dist < traverseM && p1.dist < traverseM && Math.abs(p0.along - p1.along) > 1e-6)) continue;
        const [entry, exit] = p0.along <= p1.along ? [p0, p1] : [p1, p0];
        if (entry.segIdx < fromIdx) continue; // before the marina exit → skip

        // This channel's OWN centreline (not routeFairlead, which re-picks the
        // nearest — we want each channel, directed toward its entry).
        let centre = corridorCenterline(ch);
        if (centre.length < 2) continue;
        centre = smoothPath(centre, opts.smoothWindow ?? 11);
        centre = directRoute(centre, entry.point);

        // De-spike the single-side mouth drift (the ~175° double-back) BEFORE
        // the land check, endpoints kept; then validate the WHOLE spliced run
        // (entry bridge + centreline + exit bridge) against land — the grid
        // isLand catches estate land LNDARE misses. ANY land point ⇒ drop THIS
        // channel (defer to the grid route there — never fabricate water).
        const spliced = dropSpikes([entry.point, ...centre, exit.point], MAX_FAIRLEAD_REVERSAL_DEG);
        if (isLand && anyAlong(spliced, 25, isLand)) continue;
        cands.push({ ei: entry.segIdx, xi: exit.segIdx, spliced, key: ch[0].key });
    }
    if (cands.length === 0) return unchanged;

    // Greedy longest-first, keep only non-overlapping segment ranges (a stretch
    // of route belongs to at most one channel).
    cands.sort((a, b) => b.xi - b.ei - (a.xi - a.ei));
    const chosen: Cand[] = [];
    for (const c of cands) if (chosen.every((o) => c.xi < o.ei || c.ei > o.xi)) chosen.push(c);
    chosen.sort((a, b) => a.ei - b.ei); // route order, to splice in sequence

    // Build the refined polyline + re-aligned caution mask in lockstep. Kept
    // original segments retain their caution; every spliced bridge/centreline
    // segment is clean (deep) — the single-channel semantics, generalised to
    // any number of non-overlapping splices.
    const cm = opts.cautionMask;
    const out: LatLon[] = [];
    const outCaution: boolean[] = [];
    const pushOrig = (from: number, to: number, afterSplice: boolean): void => {
        for (let k = from; k <= to; k++) {
            if (out.length > 0) {
                // First point after a splice ⇒ exit-bridge segment (clean);
                // otherwise the original segment (k−1 → k).
                outCaution.push(k === from && afterSplice ? false : cm ? (cm[k - 1] ?? false) : false);
            }
            out.push(polyline[k]);
        }
    };
    const pushSplice = (pts: LatLon[]): void => {
        for (const p of pts) {
            if (out.length > 0) outCaution.push(false); // entry bridge + centreline = clean
            out.push(p);
        }
    };
    let cur = 0;
    let afterSplice = false;
    for (const c of chosen) {
        pushOrig(cur, c.ei, afterSplice);
        pushSplice(c.spliced);
        cur = c.xi + 1;
        afterSplice = true;
    }
    pushOrig(cur, polyline.length - 1, afterSplice);

    return {
        polyline: out,
        replacedRange: [chosen[0].ei, chosen[chosen.length - 1].xi],
        channelKey: chosen.map((c) => c.key).join('+'),
        cautionMask: cm ? outCaution : undefined,
    };
}
