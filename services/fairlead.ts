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
    /** IALA-A side, from CATLAM (1 = port, 2 = starboard). */
    side: 'port' | 'stbd';
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
 * if it has a CATLAM of 1 (port) or 2 (starboard) AND an OBJNAM that starts
 * with an optional letter prefix + a number (e.g. "BC7, Coffee Pot West",
 * "12", "5F"). The channel key is the letters around the number (uppercased,
 * 'NUM' when purely numeric); the sequence is the number.
 */
export function parseLateralMarks(features: PointFeatureLike[]): LateralMark[] {
    const out: LateralMark[] = [];
    for (const f of features) {
        const g = f.geometry;
        if (!g || g.type !== 'Point' || !Array.isArray(g.coordinates)) continue;
        const props = f.properties ?? {};
        const cat = props.CATLAM;
        const side = cat === 1 ? 'port' : cat === 2 ? 'stbd' : null;
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
