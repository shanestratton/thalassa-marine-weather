/** Reviewed channel exits only. This module selects a known departure area; it
 * never infers a terminal gate from buoy numbers, colours, proximity or distance.
 * A resolved exit is a plotting proposal, not a depth/traffic clearance. */
import type { Polygon, Position } from 'geojson';
import type { CanalPoint } from './canalDepartureGeometry';
import type { CuratedRetirement } from './curatedDataLifecycle';
import { NEWPORT_CANAL_EXIT_PROFILE } from './newportCanalExitProfile';

export interface VerifiedLateralMarker extends CanalPoint {
    id: string;
    objectClass: 'BOYLAT' | 'BCNLAT';
    catlam: 1 | 2;
}

export interface VerifiedCanalExitProfile {
    id: string;
    label: string;
    departureArea: Polygon;
    sourceRevision: string;
    source: { authority: string; reference: string; publishedAt: string };
    /** Exact installed chart editions whose real mark objects must be rechecked
     * on this device before enabling an automatic trial exit. */
    chartEvidence?: readonly { cellId: string; edition: number; issued: string }[];
    reviewedAt: string;
    validUntil: string;
    terminalVerified: true;
    rule: 'centreline-permitted';
    /** Authoritatively reviewed inner-to-outer order, not a sortable buoy list.
     * Both marks must be real lateral objects, never synthetic corridor halves. */
    gates: readonly { port: VerifiedLateralMarker; starboard: VerifiedLateralMarker }[];
    /** Reviewed outward direction at the final gate, in true degrees. */
    outboundBearingDeg: number;
    /** Set when the owner takes the profile out of service. A retired profile
     * never resolves again, whatever the clock says; renewal is a new record. */
    retirement?: CuratedRetirement;
}

/** Why an applicable reviewed exit did not resolve, for callers that word
 * their own refusal (Plan My Day). The reason text stays authoritative. */
export type CanalExitManualCode = 'retired' | 'out-of-date';

export type AutomaticCanalExitResolution =
    | {
          status: 'resolved';
          profileId: string;
          label: string;
          sourceRevision: string;
          validUntil: string;
          gateCentres: CanalPoint[];
          outboundBearingDeg: number;
          exit: CanalPoint;
      }
    | { status: 'manual-required'; reason: string; code?: CanalExitManualCode; profileLabel?: string };

/** Explicit source review, never the old guessed exit or regional marker file.
 * Runtime chart matching is additionally required by verifyCanalExitChart.
 * Other canal/marina regions deliberately remain manual until reviewed. */
export const VERIFIED_CANAL_EXIT_PROFILES: readonly VerifiedCanalExitProfile[] = Object.freeze([
    NEWPORT_CANAL_EXIT_PROFILE,
]);

const manual = (reason: string): AutomaticCanalExitResolution => ({ status: 'manual-required', reason });
const NO_REVIEWED_EXIT = 'No reviewed channel exit covers this departure. Choose Canal Exit on the chart.';
const OUT_OF_DATE = 'Reviewed channel-exit data is unavailable or out of date. Choose Canal Exit on the chart.';
const EPS = 1e-10;
const M_LAT = 111_320;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 1024;
const validPoint = (p: unknown): p is CanalPoint & Record<string, unknown> =>
    isRecord(p) &&
    typeof p.lat === 'number' &&
    typeof p.lon === 'number' &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lon) &&
    Math.abs(p.lat) <= 80 &&
    Math.abs(p.lon) <= 180;
const distanceM = (a: CanalPoint, b: CanalPoint) =>
    Math.hypot((a.lon - b.lon) * M_LAT * Math.cos(((a.lat + b.lat) * Math.PI) / 360), (a.lat - b.lat) * M_LAT);
const pair = (p: CanalPoint): Position => [p.lon, p.lat];
const same = (a: Position, b: Position) => a[0] === b[0] && a[1] === b[1];
const cross = (a: Position, b: Position, p: Position) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
const onSegment = (p: Position, a: Position, b: Position) =>
    Math.abs(cross(a, b, p)) <= EPS * Math.hypot(b[0] - a[0], b[1] - a[1]) &&
    p[0] >= Math.min(a[0], b[0]) - EPS &&
    p[0] <= Math.max(a[0], b[0]) + EPS &&
    p[1] >= Math.min(a[1], b[1]) - EPS &&
    p[1] <= Math.max(a[1], b[1]) + EPS;
const intersects = (a: Position, b: Position, c: Position, d: Position) =>
    onSegment(a, c, d) ||
    onSegment(b, c, d) ||
    onSegment(c, a, b) ||
    onSegment(d, a, b) ||
    (Math.sign(cross(a, b, c)) !== Math.sign(cross(a, b, d)) &&
        Math.sign(cross(c, d, a)) !== Math.sign(cross(c, d, b)));

/** -1 outside, 0 on the boundary, 1 strictly inside. Boundaries never select a
 * profile, including hole boundaries and shared edges between two regions. */
function inRing(p: Position, ring: Position[]): -1 | 0 | 1 {
    let inside = false;
    for (let i = 1; i < ring.length; i++) {
        const a = ring[i - 1],
            b = ring[i];
        if (onSegment(p, a, b)) return 0;
        if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0])
            inside = !inside;
    }
    return inside ? 1 : -1;
}

function inArea(p: CanalPoint, area: Polygon): -1 | 0 | 1 {
    const outer = inRing(pair(p), area.coordinates[0]);
    if (outer !== 1) return outer;
    for (const hole of area.coordinates.slice(1)) {
        const hit = inRing(pair(p), hole);
        if (hit >= 0) return hit === 0 ? 0 : -1;
    }
    return 1;
}

function validArea(value: unknown): value is Polygon {
    if (!isRecord(value) || value.type !== 'Polygon' || !Array.isArray(value.coordinates)) return false;
    const rings: Position[][] = value.coordinates;
    if (
        rings.length === 0 ||
        rings.length > 16 ||
        rings.reduce((n, r) => n + (Array.isArray(r) ? r.length : 257), 0) > 256
    )
        return false;
    for (const ring of rings) {
        if (
            !Array.isArray(ring) ||
            ring.length < 4 ||
            !ring.every((p) => Array.isArray(p) && p.length === 2 && validPoint({ lon: p[0], lat: p[1] })) ||
            !same(ring[0], ring[ring.length - 1])
        )
            return false;
        // An open, degenerate or self-intersecting geofence cannot select an exit.
        let area = 0;
        for (let i = 1; i < ring.length; i++) {
            if (same(ring[i - 1], ring[i])) return false;
            area += cross(ring[0], ring[i - 1], ring[i]);
            for (let j = i + 2; j < ring.length; j++) {
                if (i === 1 && j === ring.length - 1) continue;
                if (intersects(ring[i - 1], ring[i], ring[j - 1], ring[j])) return false;
            }
        }
        if (Math.abs(area) <= EPS * EPS) return false;
    }
    for (let i = 1; i < rings.length; i++) {
        if (inRing(rings[i][0], rings[0]) !== 1) return false;
        for (let j = 0; j < i; j++) {
            if (j > 0 && (inRing(rings[i][0], rings[j]) >= 0 || inRing(rings[j][0], rings[i]) >= 0)) return false;
            for (let a = 1; a < rings[i].length; a++)
                for (let b = 1; b < rings[j].length; b++)
                    if (intersects(rings[i][a - 1], rings[i][a], rings[j][b - 1], rings[j][b])) return false;
        }
    }
    return true;
}

function timestamp(value: unknown): number {
    if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)) return NaN;
    const result = Date.parse(value);
    if (
        !Number.isFinite(result) ||
        new Date(result).toISOString().replace('.000Z', 'Z') !== value.replace('.000Z', 'Z')
    )
        return NaN;
    return result;
}

export type CanalExitProfileState = 'current' | 'retired' | 'out-of-date' | 'invalid';

export function isVerifiedCanalExitProfileCurrent(
    profile: unknown,
    now = Date.now(),
): profile is VerifiedCanalExitProfile {
    return canalExitProfileState(profile, now) === 'current';
}

/** 'invalid' = the record itself is malformed; 'retired' = taken out of service
 * (never current again); 'out-of-date' = a sound record outside its review
 * window (expired, or reviewed in the future of this clock). */
export function canalExitProfileState(profile: unknown, now = Date.now()): CanalExitProfileState {
    if (!Number.isFinite(now) || !isReviewedProfileRecord(profile)) return 'invalid';
    if (profile.retirement !== undefined) return 'retired';
    return timestamp(profile.reviewedAt) <= now && now < timestamp(profile.validUntil) ? 'current' : 'out-of-date';
}

/** Everything about a reviewed profile that does not depend on the clock. */
function isReviewedProfileRecord(profile: unknown): profile is VerifiedCanalExitProfile {
    if (
        !isRecord(profile) ||
        !text(profile.id) ||
        !text(profile.label) ||
        !text(profile.sourceRevision) ||
        !isRecord(profile.source) ||
        !text(profile.source.authority) ||
        !text(profile.source.reference) ||
        profile.terminalVerified !== true ||
        profile.rule !== 'centreline-permitted' ||
        !validArea(profile.departureArea) ||
        !Array.isArray(profile.gates) ||
        profile.gates.length < 1 ||
        profile.gates.length > 24 ||
        typeof profile.outboundBearingDeg !== 'number' ||
        !Number.isFinite(profile.outboundBearingDeg) ||
        profile.outboundBearingDeg < 0 ||
        profile.outboundBearingDeg >= 360
    )
        return false;
    if (profile.chartEvidence !== undefined) {
        if (
            !Array.isArray(profile.chartEvidence) ||
            profile.chartEvidence.length < 1 ||
            profile.chartEvidence.length > 4
        )
            return false;
        const cells = new Set<string>();
        for (const evidence of profile.chartEvidence) {
            if (
                !isRecord(evidence) ||
                typeof evidence.cellId !== 'string' ||
                !/^[A-Z0-9][A-Z0-9_-]{1,63}$/.test(evidence.cellId) ||
                cells.has(evidence.cellId) ||
                !Number.isInteger(evidence.edition) ||
                Number(evidence.edition) < 1 ||
                typeof evidence.issued !== 'string' ||
                !/^\d{4}-\d\d-\d\d$/.test(evidence.issued) ||
                !Number.isFinite(timestamp(`${evidence.issued}T00:00:00Z`)) ||
                timestamp(`${evidence.issued}T00:00:00Z`) > timestamp(profile.reviewedAt)
            )
                return false;
            cells.add(evidence.cellId);
        }
    }
    const published = timestamp(profile.source.publishedAt),
        reviewed = timestamp(profile.reviewedAt),
        expires = timestamp(profile.validUntil);
    if (![published, reviewed, expires].every(Number.isFinite) || published > reviewed || expires <= reviewed)
        return false;
    const ids = new Set<string>();
    const positions = new Set<string>();
    const all = profile.departureArea.coordinates.flat().map(([lon, lat]) => ({ lon, lat }));
    const centres: CanalPoint[] = [];
    for (const gate of profile.gates) {
        if (!isRecord(gate)) return false;
        for (const [side, category] of [
            ['port', 1],
            ['starboard', 2],
        ] as const) {
            const mark = gate[side];
            if (
                !validPoint(mark) ||
                !isRecord(mark) ||
                !text(mark.id) ||
                (mark.objectClass !== 'BOYLAT' && mark.objectClass !== 'BCNLAT') ||
                mark.catlam !== category ||
                ids.has(mark.id) ||
                positions.has(`${mark.lon},${mark.lat}`)
            )
                return false;
            ids.add(mark.id);
            positions.add(`${mark.lon},${mark.lat}`);
            all.push(mark);
        }
        const port = gate.port as VerifiedLateralMarker,
            starboard = gate.starboard as VerifiedLateralMarker;
        const width = distanceM(port, starboard);
        if (width < 12 || width > 600) return false;
        centres.push({ lat: (port.lat + starboard.lat) / 2, lon: (port.lon + starboard.lon) / 2 });
    }
    // Local profiles only: no polar/date-line midpoint or world-sized geofence.
    if (
        Math.max(...all.map((p) => p.lat)) - Math.min(...all.map((p) => p.lat)) > 1 ||
        Math.max(...all.map((p) => p.lon)) - Math.min(...all.map((p) => p.lon)) > 1
    )
        return false;
    for (let i = 1; i < centres.length; i++) if (distanceM(centres[i - 1], centres[i]) < 10) return false;
    // This does not establish gate order; review does. It only rejects an obvious
    // reversed final approach, without resorting any gate or guessing an exit.
    if (centres.length > 1) {
        const a = centres[centres.length - 2],
            b = centres[centres.length - 1];
        const rad = (profile.outboundBearingDeg * Math.PI) / 180;
        if (
            (b.lon - a.lon) * Math.cos(((a.lat + b.lat) * Math.PI) / 360) * Math.sin(rad) +
                (b.lat - a.lat) * Math.cos(rad) <=
            0
        )
            return false;
    }
    return true;
}

export function resolveAutomaticCanalExit(
    start: CanalPoint,
    destination: CanalPoint | null,
    profiles: readonly VerifiedCanalExitProfile[],
    now = Date.now(),
): AutomaticCanalExitResolution {
    if (!validPoint(start) || (destination !== null && !validPoint(destination)) || !Number.isFinite(now))
        return manual('Choose valid departure and destination positions before selecting a channel exit.');
    // A record whose geofence cannot be read cannot be confined to its own
    // area, so it still fails closed for every departure. Any other lapse —
    // expired, retired or malformed provenance/gates — is confined to
    // departures inside that record's own area: an expired profile elsewhere
    // must not force a manual exit here.
    if (
        !Array.isArray(profiles as unknown) ||
        profiles.length > 128 ||
        profiles.some((p) => !isRecord(p) || !validArea(p.departureArea))
    )
        return manual(OUT_OF_DATE);
    const states = profiles.map((p) => canalExitProfileState(p, now));
    const current = profiles.filter((_, i) => states[i] === 'current');
    // Identity checks across the records that could resolve, exactly as before
    // when every record had to be current.
    const profileIds = new Set<string>();
    const markers = new Map<string, VerifiedLateralMarker>();
    for (const profile of current) {
        if (profileIds.has(profile.id)) return manual('Channel-exit records conflict. Choose Canal Exit on the chart.');
        profileIds.add(profile.id);
        for (const gate of profile.gates)
            for (const mark of [gate.port, gate.starboard]) {
                const old = markers.get(mark.id);
                if (
                    old &&
                    (old.lon !== mark.lon ||
                        old.lat !== mark.lat ||
                        old.catlam !== mark.catlam ||
                        old.objectClass !== mark.objectClass)
                )
                    return manual('Channel-marker records conflict. Choose Canal Exit on the chart.');
                markers.set(mark.id, mark);
            }
    }
    const hits = profiles.map((p) => inArea(start, p.departureArea));
    if (hits.includes(0) || hits.filter((hit) => hit === 1).length > 1)
        return manual('Departure is on an ambiguous channel-area boundary. Choose Canal Exit on the chart.');
    const index = hits.indexOf(1);
    if (index < 0) return manual(NO_REVIEWED_EXIT);
    if (states[index] === 'retired') {
        const { label } = profiles[index];
        return {
            status: 'manual-required',
            reason: `The automatic ${label} canal exit is retired. Choose Canal exit on the chart.`,
            code: 'retired',
            profileLabel: label,
        };
    }
    if (states[index] === 'out-of-date')
        return {
            status: 'manual-required',
            reason: OUT_OF_DATE,
            code: 'out-of-date',
            profileLabel: profiles[index].label,
        };
    if (states[index] !== 'current') return manual(OUT_OF_DATE);
    const profile = profiles[index];
    const gateCentres = profile.gates.map(({ port, starboard }) => ({
        lat: (port.lat + starboard.lat) / 2,
        lon: (port.lon + starboard.lon) / 2,
    }));
    const exit = gateCentres[gateCentres.length - 1];
    if (distanceM(start, exit) < 20)
        return manual(
            'Departure is already at the channel exit. Choose the appropriate routing mode or an exit manually.',
        );
    if (destination && (inArea(destination, profile.departureArea) >= 0 || distanceM(destination, exit) <= 20))
        return manual('This destination does not need the reviewed departure exit. Plot this local section manually.');
    return {
        status: 'resolved',
        profileId: profile.id,
        label: profile.label,
        sourceRevision: profile.sourceRevision,
        validUntil: profile.validUntil,
        gateCentres,
        outboundBearingDeg: profile.outboundBearingDeg,
        exit: { ...exit },
    };
}
