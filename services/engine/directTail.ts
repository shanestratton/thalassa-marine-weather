/**
 * A pin in shallow charted water goes DIRECT (Shane, 2026-10-03: "A start pin
 * in very shallow water sends the route out to deep water and back, instead of
 * going direct with an amber warning. - fix that"). Pure geometry; the engine
 * (routeInshoreOnceEnds) supplies the grid and chart checks.
 *
 * Owner decision 7 gives such a pin a 'needs tide' tail: its own charted water,
 * walked cell by cell to the cheapest deep-enough water. Built that way the
 * tail is the grid's 8-connected staircase, and where the route does not come
 * back past the pin (the no-out-and-back cut) the deep water it reaches can lie
 * behind the pin: two pins in one shallow bay went out to the deep water and
 * back. Here the tail becomes ONE straight line from the pin to the point on
 * the route that makes the whole route shortest — or, shallow to shallow,
 * straight to the other pin. The line:
 *   • is never longer than the tail it replaces plus two cells (plus the other
 *     pin's tail, shallow to shallow), so it never becomes a long shortcut
 *     across shallows the router chose to go round;
 *   • passes `lineFault`, the engine's grid and exact chart checks: never land,
 *     a drying bank, water no chart covers or no tide clears, a charted
 *     hazard's keep-out, a mark's keep-out or a low structure;
 *   • leaves the pin's shallow water once: from the pin it reads shallow, then
 *     deep to its end — or, to the other pin, shallow again into that pin's own
 *     water. Never a shortcut through other shallows;
 *   • is never shallower than the way it replaces: its shallowest charted
 *     depth (the finest survey's, on the tail check's 5 m walk) is no less
 *     than the shallowest the route charts between the pin and the line's
 *     end (fix-up review, 2026-10-03). The charted tail takes the deeper way
 *     out — a 2 m gutter, not the 0 m flats beside it — and a straight line
 *     ranked by length alone cut across the flats: +2.9 m of tide where the
 *     gutter needed +0.9 m;
 *   • never skips a gate the route threads, a canal or an offshore leg: its
 *     junction lies at or before the first of them.
 * The stretch from the pin to where the line first reaches deep-enough water
 * is the tail (caution, 'needs tide'); the rest is ordinary deep route. Where a
 * shorter line exists but none passes, the tail stays as it was and `refused`
 * says why, in the words of the line to the tail's own junction.
 */
import { haversineM } from './geometry';

type Pt = [number, number];
export type PinEnd = 'origin' | 'destination';

export interface DirectTailInput {
    polyline: readonly Pt[];
    caution: readonly boolean[];
    /** Per-segment masks; an empty array means "none" (the monolith path). */
    canal: readonly boolean[];
    channel: readonly boolean[];
    offshore: readonly boolean[];
    /** Last segment of the origin's charted tail, or -1. */
    originTailEndSeg: number;
    /** First segment of the destination's charted tail, or -1. */
    destinationTailStartSeg: number;
    /** `${lon},${lat}` of vertices the route keeps (lateral-mark gate crossings). */
    gateAnchors: ReadonlySet<string>;
    resolutionM: number;
    /** Why the straight line from `end`'s pin to `to` cannot be its tail; null when it can.
     *  `toOtherPin`: the line ends at the other pin, in that pin's own water. */
    lineFault: (from: Pt, to: Pt, end: PinEnd, toOtherPin: boolean) => string | null;
    /** The grid reads this spot deep enough for the keel. */
    isDeep: (lon: number, lat: number) => boolean;
    /** The spot lies in a pin's own grid cell (its own water, whatever the cell's centre reads). */
    inPinCell: (lon: number, lat: number) => boolean;
    /** The shallowest depth the finest survey charts along the line through
     *  `pts` (m; drying negative), on the tail check's 5 m walk — +Infinity
     *  where no band charts any of it. */
    leastDepthAlong: (pts: readonly Pt[]) => number;
}

export interface DirectTailResult {
    polyline: Pt[];
    caution: boolean[];
    canal: boolean[];
    channel: boolean[];
    offshore: boolean[];
    originTailEndSeg: number;
    destinationTailStartSeg: number;
    /** Ends whose tail now runs direct: metres of route the line replaced, and its own. */
    done: { origin?: { fromM: number; toM: number }; destination?: { fromM: number; toM: number } };
    /** Ends where a shorter line exists but none passes: why. */
    refused: { origin?: string; destination?: string };
}

/** Candidates tried per end, best first; each costs a line check. */
const MAX_TRIES = 24;
/** Shorter than today's way by less than this is no improvement. */
const SAME_M = 1;

const dist = (a: readonly number[], b: readonly number[]): number => haversineM(a[1], a[0], b[1], b[0]);
const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const vertexKey = (p: readonly number[]): string => `${p[0]},${p[1]}`;

type State = Omit<DirectTailResult, 'done' | 'refused'>;

/**
 * The line's shallow stretches, read every ~10 m: `firstDeep` where it first
 * reads deep (null: never), and — to the other pin — `lastDeep`, the last deep
 * spot before that pin's water (null: it never turns shallow again). Null when
 * it breaks the one-shallow-stretch rule.
 */
function shallowStretches(
    a: Pt,
    b: Pt,
    toOtherPin: boolean,
    input: DirectTailInput,
): { firstDeep: number | null; lastDeep: number | null } | null {
    const steps = Math.max(2, Math.ceil(dist(a, b) / 10));
    let firstDeep: number | null = null;
    let lastDeep: number | null = null;
    let shallowAgain = false;
    for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const [lon, lat] = lerp(a, b, t);
        const deep = input.isDeep(lon, lat) && !input.inPinCell(lon, lat);
        if (deep) {
            if (shallowAgain) return null; // shallow, deep, shallow, deep: other shallows
            firstDeep ??= t;
            lastDeep = t;
        } else if (firstDeep !== null) shallowAgain = true;
    }
    if (shallowAgain && !toOtherPin) return null;
    return { firstDeep, lastDeep: shallowAgain ? lastDeep : null };
}

/** One end, worked with that end's pin first. Returns the new state, and whether the line reached the other pin. */
function oneEnd(s: State, end: PinEnd, input: DirectTailInput, out: DirectTailResult): [State, boolean] {
    const rev = end === 'destination';
    const flip = <T>(m: readonly T[]): T[] => (rev ? m.slice().reverse() : m.slice());
    const pts = flip(s.polyline);
    const nSeg = pts.length - 1;
    if (nSeg < 1) return [s, false];
    const caution = flip(s.caution);
    const canal = flip(s.canal);
    const channel = flip(s.channel);
    const offshore = flip(s.offshore);
    // A canal or offshore leg is never cut into. A marked channel's gates are
    // anchors, and its marks' keep-outs and wings are in the grid the line is
    // held to — but a tier-2 leg as such is not a wall: a non-charted pin's
    // carve bubble makes the far end's open water a tier-2 'channel' too.
    const masked = (i: number): boolean => canal[i] === true || offshore[i] === true;
    // This end's tail is segments 0..tailEnd; the other end's, otherStart..nSeg-1.
    const tailEnd = rev
        ? s.destinationTailStartSeg >= 0
            ? nSeg - 1 - s.destinationTailStartSeg
            : -1
        : s.originTailEndSeg;
    if (tailEnd < 0 || tailEnd >= nSeg) return [s, false];
    const otherStart = rev ? (s.originTailEndSeg >= 0 ? nSeg - 1 - s.originTailEndSeg : -1) : s.destinationTailStartSeg;
    const cum = [0];
    for (let i = 0; i < nSeg; i++) cum.push(cum[i] + dist(pts[i], pts[i + 1]));
    const totalM = cum[nSeg];
    const limitM = cum[tailEnd + 1] + 2 * input.resolutionM;
    const P = pts[0];

    interface Cand {
        J: Pt;
        seg: number;
        t: number;
        total: number;
        toOtherPin: boolean;
    }
    const cands: Cand[] = [];
    const push = (seg: number, t: number, J: Pt, toOtherPin = false): void => {
        const dP = dist(P, J);
        if (dP > limitM + (toOtherPin ? totalM - cum[otherStart] : 0)) return;
        const rest = toOtherPin ? 0 : totalM - (cum[seg] + t * (cum[seg + 1] - cum[seg]));
        cands.push({ J, seg, t, total: dP + rest, toOtherPin });
    };
    const mainEnd = otherStart >= 0 ? otherStart : nSeg;
    const stepM = Math.max(10, input.resolutionM / 2);
    let walkedToEnd = true;
    for (let i = tailEnd + 1; i < mainEnd; i++) {
        if (masked(i) || (i > tailEnd + 1 && input.gateAnchors.has(vertexKey(pts[i])))) {
            push(i, 0, pts[i]);
            walkedToEnd = false;
            break;
        }
        const n = Math.max(1, Math.ceil((cum[i + 1] - cum[i]) / stepM));
        for (let k = 0; k < n; k++) push(i, k / n, k === 0 ? pts[i] : lerp(pts[i], pts[i + 1], k / n));
        // No junction beyond can be within reach.
        if (cum[i + 1] - cum[tailEnd + 1] > 4 * limitM) {
            walkedToEnd = false;
            break;
        }
    }
    if (walkedToEnd) {
        if (mainEnd < nSeg) push(mainEnd, 0, pts[mainEnd]);
        else push(nSeg - 1, 1, pts[nSeg]);
    }
    if (otherStart >= 0) push(otherStart, 0, pts[nSeg], true);
    cands.sort((a, b) => a.total - b.total);

    const shorter = cands.filter((c) => c.total < totalM - SAME_M);
    const J0 = pts[tailEnd + 1];
    const tries = shorter.slice(0, MAX_TRIES);
    // The line to the tail's own junction is always tried (failing lines can crowd it out).
    const j0 = shorter.find((c) => !c.toOtherPin && c.seg === tailEnd + 1 && c.t === 0);
    if (j0 && !tries.includes(j0)) tries.push(j0);
    // The shallowest the route charts from the pin to a junction: whole
    // segments memoised, the last one cut at the junction.
    const segLeast: number[] = [];
    const leastOfSeg = (i: number): number => (segLeast[i] ??= input.leastDepthAlong([pts[i], pts[i + 1]]));
    const replacedLeast = (c: Cand): number => {
        const lastSeg = c.toOtherPin ? nSeg : c.seg;
        let least = Infinity;
        for (let i = 0; i < lastSeg; i++) least = Math.min(least, leastOfSeg(i));
        if (!c.toOtherPin && c.t > 0) least = Math.min(least, input.leastDepthAlong([pts[c.seg], c.J]));
        return least;
    };
    /** Why the line to `c` is shallower than the way it replaces; null when it is not. */
    const shallowerFault = (c: Cand): string | null => {
        const line = input.leastDepthAlong([P, c.J]);
        const way = replacedLeast(c);
        return line < way - 1e-6
            ? `shallower water than its charted way (${line.toFixed(1)} m charted, against ${way.toFixed(1)} m)`
            : null;
    };
    let chosen: { c: Cand; firstDeep: number | null; lastDeep: number | null } | null = null;
    for (const c of tries) {
        if (input.lineFault(P, c.J, end, c.toOtherPin) !== null) continue;
        const st = shallowStretches(P, c.J, c.toOtherPin, input);
        if (!st) continue;
        if (shallowerFault(c) !== null) continue;
        chosen = { c, ...st };
        break;
    }
    if (!chosen) {
        // Said in the words of the line to the tail's own junction; nothing
        // to say when that line is the tail already (it was straight).
        const why =
            shorter.length === 0
                ? null
                : (input.lineFault(P, J0, end, false) ??
                  (shallowStretches(P, J0, false, input) === null
                      ? 'other shallow water'
                      : shallowerFault(j0 ?? { J: J0, seg: tailEnd + 1, t: 0, total: 0, toOtherPin: false })));
        if (why) out.refused[end] = why;
        return [s, false];
    }

    // Rebuild as [P, (where it reaches deep water), (where the other pin's water starts), J, the route on].
    const { c, firstDeep, lastDeep } = chosen;
    const L = dist(P, c.J);
    const head: Pt[] = [P];
    const headCaution: boolean[] = [];
    let a = firstDeep !== null && (1 - firstDeep) * L >= 1 ? firstDeep : null;
    const b =
        a !== null && c.toOtherPin && lastDeep !== null && (lastDeep - a) * L >= 1 && (1 - lastDeep) * L >= 1
            ? lastDeep
            : null;
    // To the other pin the line ends in that pin's own water: where its deep
    // stretch is too short to split at (one ~10 m sample of a narrow deep
    // strip), it is that water throughout — caution to the other pin, which
    // keeps its tail (fix-up review, 2026-10-03: the rest of the line was
    // marked deep, 1.2 km of charted 1.2 m into the destination pin).
    if (c.toOtherPin && b === null) a = null;
    if (a !== null) {
        head.push(lerp(P, c.J, a));
        headCaution.push(true); // the pin's own water
        if (b !== null) {
            head.push(lerp(P, c.J, b));
            headCaution.push(false, true); // deep, then the other pin's water
        } else headCaution.push(false); // deep to J
    } else headCaution.push(true); // shallow all the way
    head.push(c.J);
    const added = head.length - 1;
    // J is the route's end (the other pin, or where the route stops): nothing on from it.
    const atEnd = c.toOtherPin || (c.t >= 1 && c.seg === nSeg - 1);
    // Otherwise the route on from J: its segment split at J when J lies inside it.
    const restPts = atEnd ? [] : pts.slice(c.seg + 1);
    const rest = <T>(m: T[]): T[] => (atEnd ? [] : m.slice(c.seg));
    const withHead = (m: boolean[]): boolean[] => (m.length === 0 ? [] : [...new Array(added).fill(false), ...rest(m)]);
    const newPts = [...head, ...restPts];
    const next: State = {
        polyline: newPts,
        caution: [...headCaution, ...rest(caution)],
        canal: withHead(canal),
        channel: withHead(channel),
        offshore: withHead(offshore),
        originTailEndSeg: 0,
        destinationTailStartSeg: -1,
    };
    const newSeg = newPts.length - 1;
    // The other end's tail: its own water at the end of the line, or where it was.
    const otherTail = c.toOtherPin
        ? a === null
            ? 0
            : b === null
              ? -1
              : newSeg - 1
        : otherStart >= 0
          ? otherStart - c.seg + added
          : -1;
    next.destinationTailStartSeg = otherTail;
    out.done[end] = {
        fromM: Math.round(c.toOtherPin ? totalM : cum[c.seg] + c.t * (cum[c.seg + 1] - cum[c.seg])),
        toM: Math.round(L),
    };
    if (!rev) return [next, c.toOtherPin];
    // Back to the route's own direction.
    const r = <T>(m: T[]): T[] => m.slice().reverse();
    const back = (seg: number): number => (seg < 0 ? -1 : newSeg - 1 - seg);
    return [
        {
            polyline: r(next.polyline),
            caution: r(next.caution),
            canal: r(next.canal),
            channel: r(next.channel),
            offshore: r(next.offshore),
            originTailEndSeg: back(next.destinationTailStartSeg),
            destinationTailStartSeg: back(next.originTailEndSeg),
        },
        c.toOtherPin,
    ];
}

/**
 * Straighten each charted pin's tail, origin first. The masks are per segment
 * and follow the new geometry, as do the tail markers.
 */
export function directTails(input: DirectTailInput, ends: { origin: boolean; destination: boolean }): DirectTailResult {
    const out: DirectTailResult = {
        polyline: input.polyline.map((p) => [p[0], p[1]] as Pt),
        caution: input.caution.slice(),
        canal: input.canal.slice(),
        channel: input.channel.slice(),
        offshore: input.offshore.slice(),
        originTailEndSeg: input.originTailEndSeg,
        destinationTailStartSeg: input.destinationTailStartSeg,
        done: {},
        refused: {},
    };
    let s: State = out;
    let reachedOther = false;
    if (ends.origin && s.originTailEndSeg >= 0) [s, reachedOther] = oneEnd(s, 'origin', input, out);
    // Shallow to shallow, the origin's line already runs into the destination pin's water.
    if (ends.destination && !reachedOther && s.destinationTailStartSeg >= 0) [s] = oneEnd(s, 'destination', input, out);
    return { ...out, ...s };
}
