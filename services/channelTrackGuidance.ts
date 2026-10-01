/** Reviewed, finite channel-track constraints for the disposable SevenCs trial.
 * This never edits a proposal, infers a shipping-channel centreline, or proves
 * depth/traffic clearance. Source loading, cancellation and a fresh whole-route
 * chart review remain the caller's responsibility. All coordinates are [lon,lat]. */
import type { AutoroutingTrialRoute } from '../types/autorouting';
import { AUTOROUTING_TRIAL_MAX_POINTS } from '../types/autorouting';
import { isVerifiedCanalExitProfileCurrent } from './automaticCanalExit';
import { NEWPORT_CANAL_EXIT_PROFILE } from './newportCanalExitProfile';
import type { EncCell, EncConversionResult } from './enc/types';
import type { CuratedRetirement } from './curatedDataLifecycle';

export type ChannelCoordinate = readonly [number, number];
export const NEWPORT_CHANNEL_TRACK_ID = 'newport-rectrc-407-v1';
export const NEWPORT_CHANNEL_TRACK_CHART = Object.freeze({ cellId: 'OC-61-10RCS5', edition: 1, issued: '2022-03-07' });
export const CHANNEL_GUIDANCE_MAX_POINTS = 8;
/** Geometric conformity only. NOT under-keel, channel-width or safety clearance. */
export const CHANNEL_GUIDANCE_TOLERANCE_M = 20;
const RECTRC: readonly ChannelCoordinate[] = [
    [153.095128, -27.1675],
    [153.093142, -27.201389],
];
const NAVLNE: readonly ChannelCoordinate[] = [...RECTRC, [153.09273, -27.208418]];
const EPS = 0.001;
const MAX_TRACK_VERTICES = 64;
const MAX_MATCH_PIECES = 20_000;
const MIN_RUN_M = 100;
const NEAR_M = 150;

/** Explicit local policy, supplied from a separately reviewed source constant,
 * never user input or arbitrary chart properties. There is deliberately NO
 * default: the existing canal-gate review does not approve the lead's seaward
 * extension. The span must be a finite subset of the exact registered RECTRC. */
export interface ReviewedChannelTrackPolicy {
    id: typeof NEWPORT_CHANNEL_TRACK_ID;
    rule: 'reviewed-small-craft-centreline';
    sourceRevision: string;
    reviewedAt: string;
    validUntil: string;
    span: readonly [ChannelCoordinate, ChannelCoordinate];
    /** A retired policy never yields a candidate again, whatever the clock says. */
    retirement?: CuratedRetirement;
}

export interface ChannelTrackProvenance {
    policyId: string;
    policyRevision: string;
    parentProfileRevision: string;
    validUntil: string;
    cellId: string;
    edition: number;
    issued: string;
    objectClass: 'RECTRC';
    featureId: number;
    pairedNavigationLineId: number;
    category: 1;
    orientationDeg: number;
    traffic: 4;
    rule: 'reviewed-small-craft-centreline';
    /** Includes device registration revision and exact reviewed finite geometry. */
    fingerprint: string;
}

/** Obtain production candidates only through createNewportChannelTrackCandidate. */
export interface ChannelTrackCandidate {
    coordinates: readonly ChannelCoordinate[];
    provenance: ChannelTrackProvenance;
}

export interface ChannelTrackGuidance {
    /** Ordered provider MustGo points; coincident departure/arrival are omitted. */
    points: Array<[number, number]>;
    /** Entry, EVERY bend, exit, in travel order, including endpoint anchors. */
    coveredCoordinates: Array<[number, number]>;
    provenance: ChannelTrackProvenance;
    coveredSpan: {
        /** Original combined proposal indices; never includes the local prefix. */
        firstLeg: number;
        lastLeg: number;
        firstLegFraction: number;
        lastLegFraction: number;
        direction: 1 | -1;
        lengthM: number;
    };
}

type XY = { x: number; y: number };
const validCoordinate = (p: unknown): p is ChannelCoordinate =>
    Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 80;
const distance = (a: XY, b: XY) => Math.hypot(a.x - b.x, a.y - b.y);
const mix = (a: XY, b: XY, t: number): XY => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const dot = (a: XY, b: XY) => a.x * b.x + a.y * b.y;
const sub = (a: XY, b: XY): XY => ({ x: a.x - b.x, y: a.y - b.y });
const cross = (a: XY, b: XY) => a.x * b.y - a.y * b.x;
const project = (p: XY, a: XY, b: XY) => {
    const ab = sub(b, a);
    const length2 = dot(ab, ab);
    const raw = length2 ? dot(sub(p, a), ab) / length2 : 0;
    const t = Math.max(0, Math.min(1, raw));
    return { raw, t, point: mix(a, b, t), distance: distance(p, mix(a, b, t)) };
};
function plane(origin: ChannelCoordinate) {
    const mx = 111_320 * Math.cos((origin[1] * Math.PI) / 180);
    return {
        xy: (p: ChannelCoordinate): XY => ({ x: (p[0] - origin[0]) * mx, y: (p[1] - origin[1]) * 110_540 }),
        coord: (p: XY): [number, number] => [origin[0] + p.x / mx, origin[1] + p.y / 110_540],
    };
}
function validCoordinates(points: readonly ChannelCoordinate[], max: number): boolean {
    return (
        Array.isArray(points) &&
        points.length >= 2 &&
        points.length <= max &&
        points.every(validCoordinate) &&
        points.every((p, i) => !i || Math.abs(p[0] - points[i - 1][0]) <= 180)
    );
}
function cumulative(points: readonly XY[]): number[] {
    const out = [0];
    for (let i = 1; i < points.length; i++) out.push(out[i - 1] + distance(points[i - 1], points[i]));
    return out;
}
function exactCoordinates(value: unknown, expected: readonly ChannelCoordinate[]): boolean {
    return (
        Array.isArray(value) &&
        value.length === expected.length &&
        value.every((p, i) => validCoordinate(p) && p[0] === expected[i][0] && p[1] === expected[i][1])
    );
}

function hasExactFeature(
    chart: EncConversionResult,
    layer: string,
    rcid: number,
    expected: readonly ChannelCoordinate[],
): boolean {
    const collection = (chart.layers as unknown as Record<string, { type?: string; features?: unknown[] }>)[layer];
    if (
        !collection ||
        (collection.type !== undefined && collection.type !== 'FeatureCollection') ||
        !Array.isArray(collection.features) ||
        collection.features.length > 20_000
    )
        return false;
    let found = false;
    for (const value of collection.features) {
        if (!value || typeof value !== 'object') continue;
        const f = value as {
            type?: unknown;
            properties?: Record<string, unknown>;
            geometry?: { type?: unknown; coordinates?: unknown };
        };
        const p = f.properties;
        if (!p || (String(p.rcid) !== String(rcid) && String(p.RCID) !== String(rcid))) continue;
        // These qualifiers were absent from the independently reviewed records.
        // A newly qualified/restricted/seasonal track requires a fresh review,
        // even if its edition fields and centreline coordinates stayed the same.
        if (
            ['STATUS', 'CONDTN', 'DATSTA', 'DATEND', 'PERSTA', 'PEREND', 'RESTRN'].some(
                (key) => p[key] !== undefined || p[key.toLowerCase()] !== undefined,
            )
        )
            return false;
        if (
            f.type !== 'Feature' ||
            p.rcid !== rcid ||
            (p.RCID !== undefined && p.RCID !== rcid) ||
            p.acronym !== layer ||
            p.ORIENT !== 183 ||
            (layer === 'RECTRC' ? p.CATTRK !== 1 || p.TRAFIC !== 4 : p.CATNAV !== 3) ||
            f.geometry?.type !== 'LineString' ||
            !exactCoordinates(f.geometry.coordinates, expected)
        )
            return false;
        found = true;
    }
    return found;
}

/** Pure, fail-closed source check. Root must also ensure registration does not
 * change during asynchronous reads/recalculation. A recent import is not a
 * recent chart issue; no source or review date is silently refreshed here. */
export function createNewportChannelTrackCandidate({
    metadata,
    chart,
    policy,
    now = Date.now(),
}: {
    metadata: EncCell | null;
    chart: EncConversionResult | null;
    policy?: ReviewedChannelTrackPolicy | null;
    now?: number;
}): ChannelTrackCandidate | null {
    const evidence = NEWPORT_CHANNEL_TRACK_CHART;
    if (
        !metadata ||
        !chart ||
        !policy ||
        policy.retirement !== undefined ||
        !Number.isFinite(now) ||
        !isVerifiedCanalExitProfileCurrent(NEWPORT_CANAL_EXIT_PROFILE, now) ||
        metadata.id !== evidence.cellId ||
        metadata.edition !== evidence.edition ||
        metadata.issued !== evidence.issued ||
        metadata.sourceHO !== 'OC' ||
        (metadata.usage !== undefined && metadata.usage !== 'navigation') ||
        !Number.isFinite(metadata.hazardCount) ||
        metadata.hazardCount <= 0 ||
        chart.cellId !== evidence.cellId ||
        chart.edition !== evidence.edition ||
        chart.issued !== evidence.issued ||
        chart.sourceHO !== 'OC' ||
        !chart.layers ||
        policy.id !== NEWPORT_CHANNEL_TRACK_ID ||
        policy.rule !== 'reviewed-small-craft-centreline' ||
        typeof policy.sourceRevision !== 'string' ||
        !policy.sourceRevision.trim() ||
        policy.sourceRevision === NEWPORT_CANAL_EXIT_PROFILE.sourceRevision ||
        policy.sourceRevision.length > 256 ||
        !Array.isArray(policy.span) ||
        policy.span.length !== 2 ||
        !policy.span.every(validCoordinate)
    )
        return null;
    const reviewed = Date.parse(policy.reviewedAt),
        expiry = Date.parse(policy.validUntil);
    if (
        ![reviewed, expiry].every(Number.isFinite) ||
        reviewed > now ||
        reviewed < Date.parse(NEWPORT_CANAL_EXIT_PROFILE.reviewedAt) ||
        expiry <= now ||
        expiry > Date.parse(NEWPORT_CANAL_EXIT_PROFILE.validUntil) ||
        !hasExactFeature(chart, 'RECTRC', 407, RECTRC) ||
        !hasExactFeature(chart, 'NAVLNE', 406, NAVLNE)
    )
        return null;
    const local = plane(RECTRC[0]),
        a = local.xy(RECTRC[0]),
        b = local.xy(RECTRC[1]);
    const projections = policy.span.map((p) => project(local.xy(p), a, b));
    if (
        projections.some((p) => p.distance > EPS || p.raw < 0 || p.raw > 1) ||
        distance(projections[0].point, projections[1].point) < MIN_RUN_M
    )
        return null;
    projections.sort((x, y) => x.t - y.t);
    const coordinates = projections.map((p) => Object.freeze(local.coord(p.point)));
    const provenance: ChannelTrackProvenance = {
        policyId: policy.id,
        policyRevision: policy.sourceRevision,
        parentProfileRevision: NEWPORT_CANAL_EXIT_PROFILE.sourceRevision,
        validUntil: policy.validUntil,
        ...evidence,
        objectClass: 'RECTRC',
        featureId: 407,
        pairedNavigationLineId: 406,
        category: 1,
        orientationDeg: 183,
        traffic: 4,
        rule: policy.rule,
        fingerprint: JSON.stringify([
            metadata.id,
            metadata.edition,
            metadata.issued,
            metadata.usage,
            metadata.importedAt,
            metadata.geojsonPath,
            metadata.sizeBytes,
            metadata.cloudManifestVersion,
            metadata.personalManifestVersion,
            policy,
            RECTRC,
            NAVLNE,
        ]),
    };
    return Object.freeze({ coordinates: Object.freeze(coordinates), provenance: Object.freeze(provenance) });
}

interface MatchPiece {
    leg: number;
    lo: number;
    hi: number;
    routeStart: number;
    routeEnd: number;
    trackStart: number;
    trackEnd: number;
    trackSegment: number;
    direction: 1 | -1;
    maxOffset: number;
    minSide: number;
    maxSide: number;
}

/** Select one sustained, unambiguous run on the PROVIDER portion. Curves are
 * represented by every source bend; >8 required constraints declines rather
 * than simplifying. Neither the original geometry nor local canal is changed. */
export function selectChannelTrackGuidance(
    // Retired with the server trial's canal handover (2026-10-01): the shape is
    // kept here so this guarded module stays as it was until it is deleted.
    route: { coordinates: AutoroutingTrialRoute['coordinates']; canalDeparture?: { handoverIndex: number } },
    candidate: ChannelTrackCandidate | null,
): ChannelTrackGuidance | null {
    if (
        !candidate ||
        !validCoordinates(candidate.coordinates, MAX_TRACK_VERTICES) ||
        !validCoordinates(route.coordinates, AUTOROUTING_TRIAL_MAX_POINTS)
    )
        return null;
    const start = route.canalDeparture?.handoverIndex ?? 0;
    if (!Number.isInteger(start) || start < 0 || start >= route.coordinates.length - 1) return null;
    const local = plane(candidate.coordinates[0]);
    const track = candidate.coordinates.map(local.xy),
        points = route.coordinates.map(local.xy);
    const tc = cumulative(track),
        rc = cumulative(points);
    if (tc.at(-1)! > 20_000 || tc.some((v, i) => i > 0 && v - tc[i - 1] < EPS)) return null;
    const pieces: MatchPiece[] = [];
    for (let leg = start; leg < points.length - 1; leg++) {
        const a = points[leg],
            b = points[leg + 1],
            ab = sub(b, a),
            length = distance(a, b);
        if (length < EPS) continue;
        for (let j = 1; j < track.length; j++) {
            const c = track[j - 1],
                d = track[j],
                cd = sub(d, c),
                segLength = distance(c, d);
            const cosine = dot(ab, cd) / (length * segLength);
            if (Math.abs(cosine) < Math.cos((15 * Math.PI) / 180)) continue;
            const sa = dot(sub(a, c), cd) / (segLength * segLength);
            const sb = dot(sub(b, c), cd) / (segLength * segLength),
                delta = sb - sa;
            if (Math.abs(delta) < 1e-12) continue;
            const lo = Math.max(0, Math.min(-sa / delta, (1 - sa) / delta));
            const hi = Math.min(1, Math.max(-sa / delta, (1 - sa) / delta));
            if ((hi - lo) * length < EPS) continue;
            const p0 = mix(a, b, lo),
                p1 = mix(a, b, hi);
            const o0 = cross(cd, sub(p0, c)) / segLength,
                o1 = cross(cd, sub(p1, c)) / segLength;
            // A genuine crossing is not a request to redirect along the track.
            if (o0 * o1 < -EPS * EPS || Math.max(Math.abs(o0), Math.abs(o1)) > NEAR_M) continue;
            pieces.push({
                leg,
                lo,
                hi,
                routeStart: rc[leg] + lo * length,
                routeEnd: rc[leg] + hi * length,
                trackStart: tc[j - 1] + Math.max(0, Math.min(1, sa + lo * delta)) * segLength,
                trackEnd: tc[j - 1] + Math.max(0, Math.min(1, sa + hi * delta)) * segLength,
                trackSegment: j,
                direction: delta > 0 ? 1 : -1,
                maxOffset: Math.max(Math.abs(o0), Math.abs(o1)),
                minSide: Math.min(o0, o1),
                maxSide: Math.max(o0, o1),
            });
            if (pieces.length > MAX_MATCH_PIECES) return null;
        }
    }
    pieces.sort((x, y) => x.routeStart - y.routeStart || x.routeEnd - y.routeEnd);
    const runs: MatchPiece[][] = [];
    for (const p of pieces) {
        const previous = runs.at(-1)?.at(-1);
        if (previous && p.routeStart < previous.routeEnd - EPS) return null; // competing parallel branches/corner ambiguity
        const gap = previous ? (p.trackStart - previous.trackEnd) * p.direction : Infinity;
        const followsCorner =
            previous && p.trackSegment - previous.trackSegment === p.direction && gap >= -EPS && gap <= NEAR_M * 2;
        if (
            previous &&
            p.direction === previous.direction &&
            Math.abs(p.routeStart - previous.routeEnd) <= EPS &&
            (Math.abs(gap) <= EPS || followsCorner)
        )
            runs.at(-1)!.push(p);
        else runs.push([p]);
    }
    const sustained = runs.filter((run) => Math.abs(run.at(-1)!.trackEnd - run[0].trackStart) >= MIN_RUN_M);
    if (sustained.length !== 1) return null; // do not choose one of multiple visits/loops
    const run = sustained[0],
        first = run[0],
        last = run.at(-1)!;
    if (run.some((p) => p.minSide < -EPS) && run.some((p) => p.maxSide > EPS)) return null;
    if (Math.max(...run.map((p) => p.maxOffset)) <= CHANNEL_GUIDANCE_TOLERANCE_M + EPS) return null;
    const atTrack = (arc: number): XY => {
        const j = tc.findIndex((v, i) => i > 0 && v >= arc - EPS);
        return j < 1 ? track.at(-1)! : mix(track[j - 1], track[j], (arc - tc[j - 1]) / (tc[j] - tc[j - 1]));
    };
    const lower = Math.min(first.trackStart, last.trackEnd),
        upper = Math.max(first.trackStart, last.trackEnd);
    const interior = track.filter(
        (_, i) => i > 0 && i < track.length - 1 && tc[i] > lower + EPS && tc[i] < upper - EPS,
    );
    if (first.direction < 0) interior.reverse();
    const covered = [atTrack(first.trackStart), ...interior, atTrack(last.trackEnd)];
    // Endpoint positions already within the SAME geometric conformity tolerance
    // need no tiny lateral MustGo manoeuvre, especially at the canal seam. Keep
    // those anchors in coveredCoordinates so the returned corridor is checked.
    const mustGo = covered.filter(
        (p) =>
            distance(p, points[start]) > CHANNEL_GUIDANCE_TOLERANCE_M &&
            distance(p, points.at(-1)!) > CHANNEL_GUIDANCE_TOLERANCE_M,
    );
    if (
        mustGo.length === 0 ||
        mustGo.length > CHANNEL_GUIDANCE_MAX_POINTS ||
        mustGo.some((p, i) => mustGo.some((q, j) => j < i && distance(p, q) < 1))
    )
        return null;
    return {
        points: mustGo.map(local.coord),
        coveredCoordinates: covered.map(local.coord),
        provenance: { ...candidate.provenance },
        coveredSpan: {
            firstLeg: first.leg,
            lastLeg: last.leg,
            firstLegFraction: first.lo,
            lastLegFraction: last.hi,
            direction: first.direction,
            lengthM: upper - lower,
        },
    };
}

/** Exact segment/disk intersection interval, in segment-fraction coordinates. */
function diskInterval(a: XY, b: XY, centre: XY, radius: number): [number, number] | null {
    const d = sub(b, a),
        f = sub(a, centre),
        aa = dot(d, d);
    if (aa < EPS * EPS) return distance(a, centre) <= radius ? [0, 1] : null;
    const bb = 2 * dot(f, d),
        cc = dot(f, f) - radius * radius,
        discriminant = bb * bb - 4 * aa * cc;
    if (discriminant < 0) return null;
    const lo = Math.max(0, (-bb - Math.sqrt(discriminant)) / (2 * aa));
    const hi = Math.min(1, (-bb + Math.sqrt(discriminant)) / (2 * aa));
    return lo <= hi ? [lo, hi] : null;
}

/** Conformity verification only, not navigational validation. All ordered
 * anchors must be visited exactly once; every segment between entry and exit
 * must stay continuously within the finite track's geometric tolerance, with
 * forward progress. No samples can jump over an unverified bend or loop. */
export function validateChannelTrackGuidanceResponse(
    guidance: ChannelTrackGuidance,
    coordinates: readonly ChannelCoordinate[],
): boolean {
    if (
        !validCoordinates(coordinates, AUTOROUTING_TRIAL_MAX_POINTS) ||
        !validCoordinates(guidance.coveredCoordinates, CHANNEL_GUIDANCE_MAX_POINTS + 2) ||
        !Array.isArray(guidance.points) ||
        guidance.points.length < 1 ||
        guidance.points.length > CHANNEL_GUIDANCE_MAX_POINTS ||
        !guidance.points.every(validCoordinate)
    )
        return false;
    const local = plane(guidance.coveredCoordinates[0]);
    const track = guidance.coveredCoordinates.map(local.xy),
        route = coordinates.map(local.xy);
    let constraintIndex = -1;
    for (const point of guidance.points) {
        const index = track.findIndex((p, i) => i > constraintIndex && distance(p, local.xy(point)) <= EPS);
        if (index < 0) return false;
        constraintIndex = index;
    }
    const tc = cumulative(track),
        rc = cumulative(route),
        tolerance = CHANNEL_GUIDANCE_TOLERANCE_M;
    if (tc.at(-1)! > 20_000 || tc.some((v, i) => i > 0 && v - tc[i - 1] < EPS)) return false;
    const visits: number[] = [];
    for (const anchor of track) {
        const groups: Array<{ end: number; bestArc: number; bestDistance: number }> = [];
        for (let i = 1; i < route.length; i++) {
            const hit = diskInterval(route[i - 1], route[i], anchor, tolerance);
            if (!hit) continue;
            const length = rc[i] - rc[i - 1],
                lo = rc[i - 1] + hit[0] * length,
                hi = rc[i - 1] + hit[1] * length;
            const projection = project(anchor, route[i - 1], route[i]);
            const arc = rc[i - 1] + projection.t * length;
            const previous = groups.at(-1);
            if (!previous || lo > previous.end + EPS)
                groups.push({ end: hi, bestArc: arc, bestDistance: projection.distance });
            else {
                previous.end = Math.max(previous.end, hi);
                if (projection.distance < previous.bestDistance) {
                    previous.bestArc = arc;
                    previous.bestDistance = projection.distance;
                }
            }
        }
        if (groups.length !== 1) return false;
        const visit = groups[0].bestArc;
        if (visits.length && visit <= visits.at(-1)! + EPS) return false;
        visits.push(visit);
    }
    const locate = (arc: number): XY => {
        const j = rc.findIndex((v, i) => i > 0 && v >= arc);
        return j < 1 ? route.at(-1)! : mix(route[j - 1], route[j], (arc - rc[j - 1]) / (rc[j] - rc[j - 1] || 1));
    };
    const entry = visits[0],
        exit = visits.at(-1)!;
    const covered = [locate(entry), ...route.filter((_, i) => rc[i] > entry + EPS && rc[i] < exit - EPS), locate(exit)];
    const trackProjection = (p: XY) => {
        let best = { distance: Infinity, arc: 0 };
        for (let j = 1; j < track.length; j++) {
            const projection = project(p, track[j - 1], track[j]);
            if (projection.distance < best.distance)
                best = { distance: projection.distance, arc: tc[j - 1] + projection.t * (tc[j] - tc[j - 1]) };
        }
        return best;
    };
    let budget = 100_000;
    const inside = (a: XY, b: XY, depth = 0): boolean => {
        if (--budget < 0) return false;
        const pa = trackProjection(a),
            pb = trackProjection(b);
        if (
            pa.distance > tolerance + EPS ||
            pb.distance > tolerance + EPS ||
            (distance(a, b) > EPS && pb.arc <= pa.arc + EPS)
        )
            return false;
        // A finite segment buffer is convex: endpoints in the SAME capsule
        // prove the whole segment, without hiding an excursion between samples.
        for (let j = 1; j < track.length; j++) {
            if (
                project(a, track[j - 1], track[j]).distance <= tolerance &&
                project(b, track[j - 1], track[j]).distance <= tolerance
            )
                return true;
        }
        if (depth >= 16 || distance(a, b) < 0.01) return false;
        const mid = mix(a, b, 0.5);
        return inside(a, mid, depth + 1) && inside(mid, b, depth + 1);
    };
    return covered.every((p, i) => !i || distance(p, covered[i - 1]) < EPS || inside(covered[i - 1], p));
}
