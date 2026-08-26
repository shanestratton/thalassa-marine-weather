/**
 * Durable Route Tracer verification.
 *
 * A verdict belongs to one exact polyline.  The geometry key deliberately
 * contains the canonical coordinates rather than a short, collision-prone
 * hash: a saved acknowledgement must become invalid the instant a waypoint
 * moves, even when the route is later opened on another screen.
 */

import type { TraceGrade, TraceLegVerdict, TracePoint } from './routeTracer';
import { TRACE_LAND_CROSSING_MESSAGE } from './routeTracer';

export type TraceCheckStatus = 'idle' | 'loading' | 'ready' | 'marksonly' | 'toolarge' | 'nochart';

export interface TraceVerification {
    version: 1;
    graderVersion: 'route-tracer-v1';
    geometryKey: string;
    checkedAt: string;
    result: 'verified' | 'danger-acknowledged';
    legGrades: TraceGrade[];
    acknowledgedDangerLegs: number[];
    draftM: number;
    draftAssumed: boolean;
    encRegistryVersion: number;
    encRegistryFingerprint: string;
    /** Effective departure used for tide gates. `now` is resolved to a real
     * epoch before persistence so a check cannot float forward indefinitely. */
    departureMs: number;
    /** Empty means no leg needs tide. A tide-gated route must carry the
     * concrete computed result; unavailable tide data never earns release. */
    tideWindowLabel: string;
}

export interface TraceVerificationContext {
    draftM: number;
    draftAssumed: boolean;
    encRegistryVersion: number;
    encRegistryFingerprint: string;
    departureMs: number;
    tideWindowLabel: string | null;
}

export interface TraceReleaseGate {
    allowed: boolean;
    reason: string;
    verification: TraceVerification | null;
}

/** Prefix used in voyages.notes. Keep it one line so ordinary notes can
 * follow without making the machine-readable safety envelope ambiguous. */
export const TRACE_VERIFICATION_NOTES_PREFIX = '__thalassa_trace_verification_v1__::';

function validPoint(point: TracePoint): boolean {
    return (
        Number.isFinite(point.lat) &&
        Number.isFinite(point.lon) &&
        point.lat >= -90 &&
        point.lat <= 90 &&
        point.lon >= -180 &&
        point.lon <= 180
    );
}

/** Six decimals is sub-metre at the equator and matches GPX precision. */
export function traceGeometryKey(points: readonly TracePoint[]): string {
    if (points.length < 2 || !points.every(validPoint)) return '';
    return `trace-geometry-v1|${points.length}|${points
        .map((point) => `${point.lat.toFixed(6)},${point.lon.toFixed(6)}`)
        .join('|')}`;
}

function isTraceGrade(value: unknown): value is TraceGrade {
    return value === 'clear' || value === 'caution' || value === 'danger';
}

/** Return a defensive copy only when the envelope proves the supplied line. */
export function normaliseTraceVerification(value: unknown, points?: readonly TracePoint[]): TraceVerification | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const candidate = value as Partial<TraceVerification>;
    if (
        candidate.version !== 1 ||
        candidate.graderVersion !== 'route-tracer-v1' ||
        typeof candidate.geometryKey !== 'string' ||
        candidate.geometryKey.length === 0 ||
        typeof candidate.checkedAt !== 'string' ||
        !Number.isFinite(Date.parse(candidate.checkedAt)) ||
        (candidate.result !== 'verified' && candidate.result !== 'danger-acknowledged') ||
        !Array.isArray(candidate.legGrades) ||
        !candidate.legGrades.every(isTraceGrade) ||
        !Array.isArray(candidate.acknowledgedDangerLegs) ||
        !candidate.acknowledgedDangerLegs.every(
            (index) => typeof index === 'number' && Number.isInteger(index) && index >= 0,
        ) ||
        typeof candidate.draftM !== 'number' ||
        !Number.isFinite(candidate.draftM) ||
        candidate.draftM <= 0 ||
        typeof candidate.draftAssumed !== 'boolean' ||
        typeof candidate.encRegistryVersion !== 'number' ||
        !Number.isInteger(candidate.encRegistryVersion) ||
        candidate.encRegistryVersion < 0 ||
        typeof candidate.encRegistryFingerprint !== 'string' ||
        typeof candidate.departureMs !== 'number' ||
        !Number.isFinite(candidate.departureMs) ||
        typeof candidate.tideWindowLabel !== 'string'
    ) {
        return null;
    }

    if (points) {
        const key = traceGeometryKey(points);
        if (!key || key !== candidate.geometryKey || candidate.legGrades.length !== points.length - 1) return null;
    }

    const dangerLegs = candidate.legGrades
        .map((grade, index) => (grade === 'danger' ? index : -1))
        .filter((index) => index >= 0);
    const acknowledged = [...new Set(candidate.acknowledgedDangerLegs)].sort((a, b) => a - b);
    if (acknowledged.some((index) => candidate.legGrades![index] !== 'danger')) return null;
    if (candidate.result === 'verified' && dangerLegs.length > 0) return null;
    if (
        candidate.result === 'danger-acknowledged' &&
        (dangerLegs.length === 0 || dangerLegs.some((index) => !acknowledged.includes(index)))
    ) {
        return null;
    }

    return {
        version: 1,
        graderVersion: 'route-tracer-v1',
        geometryKey: candidate.geometryKey,
        checkedAt: candidate.checkedAt,
        result: candidate.result,
        legGrades: [...candidate.legGrades],
        acknowledgedDangerLegs: acknowledged,
        draftM: candidate.draftM,
        draftAssumed: candidate.draftAssumed,
        encRegistryVersion: candidate.encRegistryVersion,
        encRegistryFingerprint: candidate.encRegistryFingerprint,
        departureMs: candidate.departureMs,
        tideWindowLabel: candidate.tideWindowLabel,
    };
}

/** One release rule for Save, GPX/PDF export, direct Follow and Cast Off. */
export function evaluateTraceRelease(
    points: readonly TracePoint[],
    status: TraceCheckStatus,
    verdicts: readonly (TraceLegVerdict | null)[],
    acknowledgedLegs: ReadonlySet<number>,
    context: TraceVerificationContext,
    checkedAt: string = new Date().toISOString(),
): TraceReleaseGate {
    if (!traceGeometryKey(points)) {
        return { allowed: false, reason: 'Add at least two valid waypoints first.', verification: null };
    }
    if (status === 'idle' || status === 'loading') {
        return { allowed: false, reason: 'Wait for every leg check to finish.', verification: null };
    }
    if (status === 'nochart') {
        return {
            allowed: false,
            reason: 'ENC chart coverage is unavailable here. Load the chart, then check the route again.',
            verification: null,
        };
    }
    if (status === 'toolarge') {
        return {
            allowed: false,
            reason: 'Part of this route is too large to check. Add a waypoint and try again.',
            verification: null,
        };
    }
    if (status === 'marksonly') {
        return {
            allowed: false,
            reason: 'Depth was not checked for every leg. Add waypoints or load detailed ENC coverage.',
            verification: null,
        };
    }
    if (verdicts.length !== points.length - 1 || verdicts.some((verdict) => verdict === null)) {
        return { allowed: false, reason: 'Wait for every leg check to finish.', verification: null };
    }

    const legGrades = verdicts.map((verdict) => verdict!.grade);
    const needsTide = verdicts.some((verdict) => verdict?.needsTide);
    if (needsTide && context.tideWindowLabel === null) {
        return { allowed: false, reason: 'Wait for the tide-window check to finish.', verification: null };
    }
    if (needsTide && context.tideWindowLabel === '') {
        return {
            allowed: false,
            reason: 'Tide data is unavailable for a shallow leg. Reconnect and check the route again.',
            verification: null,
        };
    }
    if (
        !Number.isFinite(context.draftM) ||
        context.draftM <= 0 ||
        !Number.isInteger(context.encRegistryVersion) ||
        context.encRegistryVersion < 0 ||
        typeof context.encRegistryFingerprint !== 'string' ||
        !Number.isFinite(context.departureMs)
    ) {
        return { allowed: false, reason: 'Vessel or chart-check context is incomplete.', verification: null };
    }
    // Land is the one danger no acknowledgment can accept (Shane 2026-08-10:
    // accepted issues are good to go — "just not ones that cross land"). A
    // hazard or berth crossing is a judgement call the skipper may own;
    // charted land is not a risk, it is a wall. Refusing here — before the
    // ack machinery — means a land-crossing route can never be saved, so it
    // can never surface as a followable choice anywhere downstream.
    const landLegs = verdicts
        .map((verdict, index) =>
            verdict?.issues.some(
                (issue) => issue.severity === 'danger' && issue.message === TRACE_LAND_CROSSING_MESSAGE,
            )
                ? index
                : -1,
        )
        .filter((index) => index >= 0);
    if (landLegs.length > 0) {
        return {
            allowed: false,
            reason: `Leg${landLegs.length === 1 ? '' : 's'} ${landLegs.map((index) => index + 1).join(', ')} cross${
                landLegs.length === 1 ? 'es' : ''
            } charted land. Move the waypoints — land legs cannot be acknowledged.`,
            verification: null,
        };
    }

    const dangerLegs = legGrades.map((grade, index) => (grade === 'danger' ? index : -1)).filter((index) => index >= 0);
    const unacknowledged = dangerLegs.filter((index) => !acknowledgedLegs.has(index));
    if (unacknowledged.length > 0) {
        return {
            allowed: false,
            reason: `Acknowledge ${unacknowledged.length === 1 ? 'the' : 'all'} no-go leg${
                unacknowledged.length === 1 ? '' : 's'
            } in Route report before saving, exporting or sailing.`,
            verification: null,
        };
    }

    const verification = normaliseTraceVerification(
        {
            version: 1,
            graderVersion: 'route-tracer-v1',
            geometryKey: traceGeometryKey(points),
            checkedAt,
            result: dangerLegs.length > 0 ? 'danger-acknowledged' : 'verified',
            legGrades,
            acknowledgedDangerLegs: dangerLegs,
            draftM: context.draftM,
            draftAssumed: context.draftAssumed,
            encRegistryVersion: context.encRegistryVersion,
            encRegistryFingerprint: context.encRegistryFingerprint,
            departureMs: context.departureMs,
            tideWindowLabel: context.tideWindowLabel ?? '',
        },
        points,
    );
    return verification
        ? { allowed: true, reason: '', verification }
        : {
              allowed: false,
              reason: 'Route verification could not be recorded. Check the route again.',
              verification: null,
          };
}

export function serialiseTraceVerificationNote(verification: TraceVerification): string {
    return `${TRACE_VERIFICATION_NOTES_PREFIX}${JSON.stringify(verification)}`;
}

export function parseTraceVerificationNote(
    notes: string | null | undefined,
    points?: readonly TracePoint[],
): TraceVerification | null {
    if (typeof notes !== 'string' || !notes.startsWith(TRACE_VERIFICATION_NOTES_PREFIX)) return null;
    const line = notes.slice(TRACE_VERIFICATION_NOTES_PREFIX.length).split('\n', 1)[0];
    try {
        return normaliseTraceVerification(JSON.parse(line), points);
    } catch {
        return null;
    }
}

/**
 * The bbox a route's chart-library fingerprint is scoped to: the route's
 * own extent plus a corridor pad. Writer (route check) and checker (Cast
 * Off) MUST derive it from the same points with the same pad, or the
 * comparison is meaningless. [west, south, east, north].
 */
export function traceRegistryScope(
    points: readonly TracePoint[] | undefined,
    padDeg = 0.5,
): [number, number, number, number] | undefined {
    if (!points || points.length === 0) return undefined;
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    for (const point of points) {
        if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) continue;
        west = Math.min(west, point.lon);
        east = Math.max(east, point.lon);
        south = Math.min(south, point.lat);
        north = Math.max(north, point.lat);
    }
    if (!Number.isFinite(west)) return undefined;
    return [west - padDeg, Math.max(-90, south - padDeg), east + padDeg, Math.min(90, north + padDeg)];
}

export interface TraceCastOffContext {
    draftM: number;
    draftAssumed: boolean;
    encRegistryFingerprint: string;
    voyageDepartureMs: number | null;
    nowMs: number;
}

/**
 * Final client-side Cast Off check. The SQL RPC repeats the structural and
 * saved_routes geometry checks atomically; this layer additionally knows the
 * current device's vessel profile and chart library and gives the skipper an
 * actionable explanation before the RPC is attempted.
 */
export function traceCastOffBlockReason(
    value: unknown,
    points: readonly TracePoint[] | undefined,
    context: TraceCastOffContext,
): string | null {
    const verification = normaliseTraceVerification(value, points);
    if (!verification)
        return 'This traced route has no valid check for its current waypoints. Open Route Tracer and check it again.';
    if (context.draftAssumed) return 'Set your vessel draft, then recheck this traced route before Cast Off.';
    if (verification.draftAssumed !== context.draftAssumed || Math.abs(verification.draftM - context.draftM) > 0.01) {
        return 'Your vessel draft has changed since this route was checked. Recheck it before Cast Off.';
    }
    if (verification.encRegistryFingerprint !== context.encRegistryFingerprint) {
        // Self-diagnosing (Shane 2026-08-26 — this message survived two fix
        // layers and every screenshot left us guessing WHY). An old-format
        // stamp still carries the '@cloud-' delivery marker; otherwise name
        // the first chart that actually differs.
        if (verification.encRegistryFingerprint.includes('@cloud-')) {
            return 'This route was checked by an older app version. Recheck it once on this version before Cast Off.';
        }
        const cellIds = (fingerprint: string): Set<string> =>
            new Set(
                fingerprint
                    .split('|')
                    .map((entry) => entry.trim())
                    .filter(Boolean),
            );
        const checked = cellIds(verification.encRegistryFingerprint);
        const current = cellIds(context.encRegistryFingerprint);
        const differing =
            [...current].find((entry) => !checked.has(entry)) ?? [...checked].find((entry) => !current.has(entry));
        const cellName = differing ? differing.split('@')[0] : null;
        return `Your ENC chart library has changed under this route since it was checked${
            cellName ? ` (${cellName})` : ''
        }. Recheck it before Cast Off.`;
    }
    if (context.voyageDepartureMs === null || Math.abs(verification.departureMs - context.voyageDepartureMs) > 60_000) {
        return 'The planned departure changed after the tide/route check. Recheck the route before Cast Off.';
    }
    const checkedMs = Date.parse(verification.checkedAt);
    const maxAgeMs = verification.tideWindowLabel ? 48 * 3_600_000 : 30 * 24 * 3_600_000;
    if (!Number.isFinite(checkedMs) || context.nowMs - checkedMs > maxAgeMs || checkedMs - context.nowMs > 5 * 60_000) {
        return 'This route check is stale. Recheck the route against current charts before Cast Off.';
    }
    if (verification.tideWindowLabel && Math.abs(context.nowMs - verification.departureMs) > 6 * 3_600_000) {
        return 'Cast Off is outside the checked tide-departure window. Recheck the route for the new time.';
    }
    return null;
}

export interface TraceFollowContext {
    draftM: number;
    draftAssumed: boolean;
    nowMs: number;
}

/**
 * FOLLOW-mode gate — deliberately gentler than Cast Off (Shane 2026-08-10:
 * "once a punter accepts certain issues with routes then they are good to
 * go"). Cast Off is a publication event with tide-window and departure
 * commitments; following a saved line from the Log is re-sailing a track the
 * skipper already checked and accepted. So this keeps only the blocks that
 * make the acceptance itself void:
 *
 *  - no valid check for the exact waypoints being steered — the acceptance
 *    was for a different line;
 *  - the vessel draft changed since the check — a deeper keel voids every
 *    depth verdict the acceptance rested on;
 *  - the check is older than 30 days — charts and accepted risk both age.
 *
 * Dropped relative to Cast Off, on purpose: ENC-library-changed, the 48 h
 * tide-tightened staleness, the ±6 h tide-departure window, and the
 * assumed-draft hard stop (an assumed draft was visible at save time; the
 * skipper accepted it). Land can never reach here at all —
 * evaluateTraceRelease refuses to save a land-crossing route outright.
 */
export function traceFollowBlockReason(
    value: unknown,
    points: readonly TracePoint[] | undefined,
    context: TraceFollowContext,
): string | null {
    const verification = normaliseTraceVerification(value, points);
    if (!verification)
        return 'This traced route has no valid check for its current waypoints. Open Route Tracer and check it again.';
    if (verification.draftAssumed !== context.draftAssumed || Math.abs(verification.draftM - context.draftM) > 0.01) {
        return 'Your vessel draft has changed since this route was checked. Recheck it in Route Tracer.';
    }
    const checkedMs = Date.parse(verification.checkedAt);
    if (
        !Number.isFinite(checkedMs) ||
        context.nowMs - checkedMs > 30 * 24 * 3_600_000 ||
        checkedMs - context.nowMs > 5 * 60_000
    ) {
        return 'This route check is over a month old. Recheck it in Route Tracer before following it.';
    }
    return null;
}

export function traceVerificationSummary(verification: TraceVerification): string {
    if (verification.result === 'danger-acknowledged') {
        const count = verification.acknowledgedDangerLegs.length;
        return `CHECKED — ${count} NO-GO LEG${count === 1 ? '' : 'S'} ACKNOWLEDGED${
            verification.draftAssumed ? ' — ASSUMED DRAFT' : ''
        }`;
    }
    const assumed = verification.draftAssumed ? ' — ASSUMED DRAFT' : '';
    return verification.legGrades.includes('caution')
        ? `CHECKED — CAUTIONS PRESENT${assumed}`
        : `CHECKED — ALL LEGS CLEAR${assumed}`;
}
