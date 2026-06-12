/**
 * gateExtractor — unify the mark pipelines into GateNodes (Phase 10, §3).
 *
 * Three frontends, in descending trust:
 *   tier 1 CHART     — numbered OBJNAM laterals via fairlead's
 *                      parseLateralMarks + groupChannels, paired by
 *                      SEQUENCE ADJACENCY (confidence 0.95);
 *   tier 2 REGIONAL  — the orchestrator's cluster→PCA→pair pipeline
 *                      (confidence 0.7), consumed via the ACCEPTED PAIRS
 *                      fetchRegionalMarkers exposes (regionalGates
 *                      below; full Steps 1–3 purification deferred to
 *                      the Phase 16 routing-core extraction);
 *   tier 3 GEOMETRIC — the TS port of MarinerEE's find_entrance_gate
 *                      (newport_demo.py:517-595), generalised from one
 *                      entrance to ALL unnumbered marks: mutual-best
 *                      pairing under a width window with midpoint-in-
 *                      navigable-water rejection and an optional FAIRWY
 *                      bonus (confidence 0.4).
 *
 * Dedup at 80 m; chart wins geometry (masterplan §3 Phase 10).
 */

import { parseLateralMarks, groupChannels, corridorCenterline, type LateralMark } from '../fairlead';
import { metres, type GateNode, type SeawayLatLon, type SeawayMark } from './types';

export const CHART_CONFIDENCE = 0.95;
export const REGIONAL_CONFIDENCE = 0.7;
export const GEOMETRIC_CONFIDENCE = 0.4;
/** Gates below this never form edges without DEPARE/DRGARE corroboration. */
export const EDGE_CONFIDENCE_FLOOR = 0.6;
/** Max port↔stbd separation for any pair construction (§4). */
export const MAX_GATE_WIDTH_M = 600;
export const MIN_GATE_WIDTH_M = 20;
/** Dedup radius — duplicate gates from different tiers within this merge,
 *  chart geometry winning. */
export const GATE_DEDUP_M = 80;

const M_PER_LAT = 110_540;
const mPerLonAt = (lat: number): number => 111_320 * Math.cos((lat * Math.PI) / 180);

export function gateDistM(a: SeawayLatLon, b: SeawayLatLon): number {
    const mPerLon = mPerLonAt((a.lat + b.lat) / 2);
    return Math.hypot((b.lon - a.lon) * mPerLon, (b.lat - a.lat) * M_PER_LAT);
}

function bearingDeg(a: SeawayLatLon, b: SeawayLatLon): number {
    const mPerLon = mPerLonAt((a.lat + b.lat) / 2);
    const dx = (b.lon - a.lon) * mPerLon;
    const dy = (b.lat - a.lat) * M_PER_LAT;
    let deg = (Math.atan2(dx, dy) * 180) / Math.PI;
    if (deg < 0) deg += 360;
    return deg;
}

const toSeawayMark = (m: LateralMark, source: SeawayMark['source']): SeawayMark => ({
    lat: m.lat,
    lon: m.lon,
    side: m.side,
    source,
    key: m.key,
    seq: m.seq,
    name: m.name,
});

/** Nearest point on a polyline to p (planar metres at p's latitude). */
function projectToPolyline(p: SeawayLatLon, line: SeawayLatLon[]): SeawayLatLon {
    const mPerLon = mPerLonAt(p.lat);
    let best: SeawayLatLon = line[0];
    let bestD = Infinity;
    for (let i = 0; i < line.length - 1; i++) {
        const a = line[i];
        const b = line[i + 1];
        const bx = (b.lon - a.lon) * mPerLon;
        const by = (b.lat - a.lat) * M_PER_LAT;
        const px = (p.lon - a.lon) * mPerLon;
        const py = (p.lat - a.lat) * M_PER_LAT;
        const len2 = bx * bx + by * by;
        let t = len2 > 0 ? (px * bx + py * by) / len2 : 0;
        t = Math.max(0, Math.min(1, t));
        const q = { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
        const d = gateDistM(p, q);
        if (d < bestD) {
            bestD = d;
            best = q;
        }
    }
    return best;
}

/**
 * TIER 1 — chart gates by sequence adjacency. Within each fairlead
 * channel (OBJNAM key + spatial union-find), a port mark pairs with the
 * stbd mark whose sequence number is ADJACENT (|Δseq| = 1, e.g. green 5
 * with red 6) and within the width window. Marks left over become
 * HALF-GATES at their centreline projection — they're real charted
 * laterals, just unpartnered (common at channel ends).
 *
 * Gates are stationed in mark-sequence order; buoyageBearingDeg is the
 * local corridor-centreline direction at the gate (central difference),
 * falling back to the gate-perpendicular for degenerate channels.
 */
export function extractChartGates(features: Parameters<typeof parseLateralMarks>[0]): {
    gates: GateNode[];
    channels: Map<string, GateNode[]>;
} {
    const marks = parseLateralMarks(features);
    const channels = groupChannels(marks);
    const gates: GateNode[] = [];
    const byChannel = new Map<string, GateNode[]>();

    for (let c = 0; c < channels.length; c++) {
        const channel = channels[c];
        const channelKey = `${channel[0].key}#${c}`;
        const centre = corridorCenterline(channel);
        const ports = channel.filter((m) => m.side === 'port').sort((a, b) => a.seq - b.seq);
        const stbds = channel.filter((m) => m.side === 'stbd').sort((a, b) => a.seq - b.seq);

        const pairedPort = new Set<LateralMark>();
        const pairedStbd = new Set<LateralMark>();
        const channelGates: GateNode[] = [];

        for (const p of ports) {
            const partner = stbds.find(
                (s) =>
                    !pairedStbd.has(s) &&
                    Math.abs(s.seq - p.seq) === 1 &&
                    gateDistM(p, s) >= MIN_GATE_WIDTH_M &&
                    gateDistM(p, s) <= MAX_GATE_WIDTH_M,
            );
            if (!partner) continue;
            pairedPort.add(p);
            pairedStbd.add(partner);
            const mid = { lat: (p.lat + partner.lat) / 2, lon: (p.lon + partner.lon) / 2 };
            channelGates.push({
                id: `${channelKey}/g${Math.min(p.seq, partner.seq)}`,
                channelKey,
                station: Math.min(p.seq, partner.seq),
                portMark: toSeawayMark(p, 'chart'),
                stbdMark: toSeawayMark(partner, 'chart'),
                mid,
                gateWidthM: metres(gateDistM(p, partner)),
                buoyageBearingDeg: 0, // filled below from the centreline
                confidence: CHART_CONFIDENCE,
            });
        }

        // Unpaired charted laterals → half-gates at their centreline projection.
        for (const m of channel) {
            const taken = m.side === 'port' ? pairedPort.has(m) : pairedStbd.has(m);
            if (taken) continue;
            const mid = centre.length >= 2 ? projectToPolyline(m, centre) : { lat: m.lat, lon: m.lon };
            channelGates.push({
                id: `${channelKey}/h${m.seq}`,
                channelKey,
                station: m.seq,
                portMark: m.side === 'port' ? toSeawayMark(m, 'chart') : undefined,
                stbdMark: m.side === 'stbd' ? toSeawayMark(m, 'chart') : undefined,
                mid,
                buoyageBearingDeg: 0,
                confidence: CHART_CONFIDENCE,
            });
        }

        channelGates.sort((a, b) => a.station - b.station);
        // buoyageBearingDeg = local along-channel direction (central diff
        // over neighbouring gate midpoints; endpoints use one-sided diff).
        for (let i = 0; i < channelGates.length; i++) {
            const prev = channelGates[Math.max(0, i - 1)];
            const next = channelGates[Math.min(channelGates.length - 1, i + 1)];
            channelGates[i].buoyageBearingDeg = prev === next ? 0 : bearingDeg(prev.mid, next.mid);
        }

        byChannel.set(channelKey, channelGates);
        gates.push(...channelGates);
    }

    return { gates, channels: byChannel };
}

export interface GeometricGateOptions {
    /** Reject a pair whose midpoint is NOT navigable water — the single
     *  check that kills cross-channel mispairs (find_entrance_gate). */
    isNavigableWater?: (p: SeawayLatLon) => boolean;
    /** Strong "genuinely in-channel" bonus when the midpoint sits inside
     *  a FAIRWY polygon. */
    inFairway?: (p: SeawayLatLon) => boolean;
    minWidthM?: number;
    maxWidthM?: number;
}

/** An unnumbered lateral as raw chart data emits it: CATLAM only. */
export interface UnnumberedMark extends SeawayLatLon {
    side: 'port' | 'stbd';
}

/**
 * TIER 3 — the generalised find_entrance_gate: MUTUAL-BEST pairing of
 * unnumbered laterals. Score = width (tight gates win) with a large
 * bonus for in-FAIRWY midpoints; a pair forms only when each mark is the
 * other's best-scoring partner, the width is in-window, and the midpoint
 * lies in navigable water. Confidence 0.4 — below the edge floor, so
 * these gates render on the overlay but form edges only with charted
 * corroboration (graphCompiler).
 */
export function extractGeometricGates(marks: UnnumberedMark[], opts: GeometricGateOptions = {}): GateNode[] {
    const minW = opts.minWidthM ?? MIN_GATE_WIDTH_M;
    const maxW = opts.maxWidthM ?? MAX_GATE_WIDTH_M;
    const ports = marks.filter((m) => m.side === 'port');
    const stbds = marks.filter((m) => m.side === 'stbd');
    if (ports.length === 0 || stbds.length === 0) return [];

    const score = (p: UnnumberedMark, s: UnnumberedMark): number | null => {
        const w = gateDistM(p, s);
        if (w < minW || w > maxW) return null;
        const mid = { lat: (p.lat + s.lat) / 2, lon: (p.lon + s.lon) / 2 };
        if (opts.isNavigableWater && !opts.isNavigableWater(mid)) return null;
        let sc = w;
        if (opts.inFairway?.(mid)) sc -= 10_000; // the strongest in-channel signal
        return sc;
    };

    const bestFor = <A extends UnnumberedMark, B extends UnnumberedMark>(
        from: A,
        candidates: B[],
        scoreFn: (a: A, b: B) => number | null,
    ): B | null => {
        let best: B | null = null;
        let bestScore = Infinity;
        for (const c of candidates) {
            const sc = scoreFn(from, c);
            if (sc !== null && sc < bestScore) {
                bestScore = sc;
                best = c;
            }
        }
        return best;
    };

    const gates: GateNode[] = [];
    let n = 0;
    for (const p of ports) {
        const s = bestFor(p, stbds, score);
        if (!s) continue;
        const back = bestFor(s, ports, (a, b) => score(b, a));
        if (back !== p) continue; // mutual-best only
        const mid = { lat: (p.lat + s.lat) / 2, lon: (p.lon + s.lon) / 2 };
        gates.push({
            id: `geo#${n}`,
            channelKey: `geo`,
            station: n++,
            portMark: { ...p, source: 'geometric' },
            stbdMark: { ...s, source: 'geometric' },
            mid,
            gateWidthM: metres(gateDistM(p, s)),
            buoyageBearingDeg: (bearingDeg(p, s) + 90) % 360, // gate-perpendicular until a corridor stations it
            confidence: GEOMETRIC_CONFIDENCE,
        });
    }
    return gates;
}

/**
 * Dedup gates across tiers: any gate whose mid sits within GATE_DEDUP_M
 * of a HIGHER-confidence gate's mid is dropped (chart wins geometry).
 */
export function dedupGates(gates: GateNode[]): GateNode[] {
    const sorted = [...gates].sort((a, b) => b.confidence - a.confidence);
    const kept: GateNode[] = [];
    for (const g of sorted) {
        if (kept.some((k) => gateDistM(k.mid, g.mid) < GATE_DEDUP_M)) continue;
        kept.push(g);
    }
    return kept;
}

/** A Step-3 accepted pair as the orchestrator exposes it
 *  (RegionalChannelData.acceptedPairs). */
export interface RegionalPair {
    port: SeawayLatLon;
    stbd: SeawayLatLon;
}

/**
 * TIER 2 — regional gates from the orchestrator's ACCEPTED PAIRS
 * (confidence 0.7). The pairs arrive pre-validated by fetchRegionalMarkers
 * Steps 1–3 — metre-space PCA clustering, the 500 m stagger gate,
 * LNDARE-between rejection with OSM/DEPARE water rescue — so this
 * frontend only re-checks the width window and adapts shapes. The full
 * Steps 1–3 purification (a ~400-line cut of the hot orchestrator file)
 * is deferred to the Phase 16 routing-core extraction, where it has to
 * happen anyway; consuming the exposed pairs delivers the tier NOW
 * without duplicating the pipeline.
 *
 * Visible limitation: regional pairs carry no OBJNAM sequence, so each
 * becomes a SINGLE-GATE channel (`regional#i`, station 1) — they merge
 * with chart gates through dedup (chart wins geometry), serve as
 * connector targets, and form no edge chains until a chaining pass
 * exists. buoyageBearingDeg is the span-perpendicular — advisory only,
 * like every inferred bearing (§4).
 */
export function regionalGates(pairs: RegionalPair[]): GateNode[] {
    const gates: GateNode[] = [];
    for (let i = 0; i < pairs.length; i++) {
        const { port, stbd } = pairs[i];
        const widthM = gateDistM(port, stbd);
        if (widthM < MIN_GATE_WIDTH_M || widthM > MAX_GATE_WIDTH_M) continue;
        const channelKey = `regional#${i}`;
        gates.push({
            id: `${channelKey}/g1`,
            channelKey,
            station: 1,
            portMark: { lat: port.lat, lon: port.lon, side: 'port', source: 'regional' },
            stbdMark: { lat: stbd.lat, lon: stbd.lon, side: 'stbd', source: 'regional' },
            mid: { lat: (port.lat + stbd.lat) / 2, lon: (port.lon + stbd.lon) / 2 },
            gateWidthM: metres(widthM),
            buoyageBearingDeg: (bearingDeg(port, stbd) + 90) % 360,
            confidence: REGIONAL_CONFIDENCE,
        });
    }
    return gates;
}
