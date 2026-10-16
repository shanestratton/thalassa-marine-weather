/** Reviewed explicit UTC opening intervals only. A base schedule, OSM hours,
 * received time or generic acknowledgement cannot create opening permission. */
export interface ReviewedBridgeOperations {
    reviewId: string;
    bridgeFeatureKey: string;
    chartContentKey: string;
    revision: string;
    sourceReference: string;
    sourcePublishedAtMs: number;
    timezone: string;
    effectiveFromMs: number;
    effectiveUntilMs: number;
    /** Actual complete operating/closure check, not receipt time. */
    deviationsCheckedAtMs: number;
    expiresAtMs: number;
    maxCheckAgeMs: number;
    closureState: 'none-reported' | 'closed' | 'unknown';
    noticeMs: number;
    intervals: readonly { openMs: number; closeMs: number }[];
}
export interface BridgeOpeningRequest {
    lifetimeKey: string;
    boatId: string;
    bridgeFeatureKey: string;
    chartContentKey: string;
    fromMs: number;
    untilMs: number;
    nowMs: number;
}
/** Future local operator-confirmation action, separate from source data and
 * scope-bound to this boat, crossing, revision and request lifetime. */
export interface BridgeOpeningConfirmation {
    lifetimeKey: string;
    boatId: string;
    bridgeFeatureKey: string;
    revision: string;
    crossingFromMs: number;
    crossingUntilMs: number;
    confirmedAtMs: number;
    operatorReference: string;
}
export const REVIEWED_BRIDGE_OPERATIONS: readonly ReviewedBridgeOperations[] = Object.freeze([]);
const mark: unique symbol = Symbol('reviewed-bridge-opening-required');
const issued = new WeakSet<object>();
export interface ReviewedBridgeOpening {
    readonly [mark]: true;
    readonly kind: 'opening-required';
    readonly lifetimeKey: string;
    readonly boatId: string;
    readonly bridgeFeatureKey: string;
    readonly chartContentKey: string;
    readonly fromMs: number;
    readonly untilMs: number;
    readonly checkedAtMs: number;
    readonly expiresAtMs: number;
    readonly scheduledOpenMs: number;
    readonly scheduledCloseMs: number;
    readonly revision: string;
    readonly sourcePublishedAtMs: number;
    readonly deviationsCheckedAtMs: number;
    readonly sourceReference: string;
    readonly reviewId: string;
    /** Still conditional on the actual span opening; never unconditional green. */
    readonly requiresActualOpening: true;
}
export type BridgeOpeningAssessment = ReviewedBridgeOpening | { kind: 'unavailable' | 'closed'; reason: string };
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const text = (s: unknown, max = 512): s is string =>
    typeof s === 'string' && s.length > 0 && s.length <= max && !/\p{Cc}/u.test(s);
const reference = (s: string) => {
    if (!text(s)) return false;
    try {
        const u = new URL(s);
        return u.protocol === 'https:' && !u.username && !u.password && !u.port && !u.search && !u.hash;
    } catch {
        return false;
    }
};
function zone(value: string): boolean {
    try {
        return text(value, 80) && !!new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone;
    } catch {
        return false;
    }
}
/** This is operating evidence only. The closed/open chart clearance, exact
 * overhead water plane and full crossing interval still need their own proof. */
export function assessBridgeOpening(
    request: BridgeOpeningRequest,
    confirmation: BridgeOpeningConfirmation | null = null,
    registry: readonly ReviewedBridgeOperations[] = REVIEWED_BRIDGE_OPERATIONS,
): BridgeOpeningAssessment {
    const unknown = (reason: string): BridgeOpeningAssessment => ({ kind: 'unavailable', reason });
    if (
        ![request.lifetimeKey, request.boatId, request.bridgeFeatureKey, request.chartContentKey].every((s) =>
            text(s),
        ) ||
        ![request.fromMs, request.untilMs, request.nowMs].every(finite) ||
        request.untilMs <= request.fromMs ||
        request.fromMs < request.nowMs ||
        request.untilMs - request.fromMs > 6 * 3600000 ||
        request.untilMs - request.nowMs > 14 * 86400000 ||
        !Array.isArray(registry) ||
        registry.length > 256
    )
        return unknown('Current crossing context unavailable.');
    const matches = registry.filter(
        (row) =>
            row && row.bridgeFeatureKey === request.bridgeFeatureKey && row.chartContentKey === request.chartContentKey,
    );
    if (matches.length !== 1) return unknown('No unique reviewed opening record for this charted bridge.');
    const r = matches[0];
    if (
        !text(r.reviewId) ||
        !text(r.revision, 160) ||
        !reference(r.sourceReference) ||
        !zone(r.timezone) ||
        ![
            r.sourcePublishedAtMs,
            r.effectiveFromMs,
            r.effectiveUntilMs,
            r.deviationsCheckedAtMs,
            r.expiresAtMs,
            r.maxCheckAgeMs,
            r.noticeMs,
        ].every(finite) ||
        r.sourcePublishedAtMs > request.nowMs ||
        r.effectiveFromMs > request.fromMs ||
        r.effectiveUntilMs < request.untilMs ||
        r.deviationsCheckedAtMs > request.nowMs ||
        r.maxCheckAgeMs <= 0 ||
        r.maxCheckAgeMs > 7 * 86400000 ||
        request.nowMs - r.deviationsCheckedAtMs > r.maxCheckAgeMs ||
        r.expiresAtMs <= request.nowMs ||
        r.expiresAtMs > r.deviationsCheckedAtMs + r.maxCheckAgeMs ||
        r.noticeMs < 0 ||
        r.noticeMs > 7 * 86400000
    )
        return unknown('Operating revision, source clock, closure check or notice requirements unavailable.');
    if (r.closureState === 'closed')
        return { kind: 'closed', reason: 'The reviewed operating record reports a closure.' };
    if (r.closureState !== 'none-reported') return unknown('Current closure/deviation status unknown.');
    if (
        !Array.isArray(r.intervals) ||
        r.intervals.length < 1 ||
        r.intervals.length > 128 ||
        r.intervals.some(
            (span: ReviewedBridgeOperations['intervals'][number], i: number) =>
                !span ||
                !finite(span.openMs) ||
                !finite(span.closeMs) ||
                span.closeMs <= span.openMs ||
                span.openMs < r.effectiveFromMs ||
                span.closeMs > r.effectiveUntilMs ||
                (i > 0 && span.openMs < r.intervals[i - 1].closeMs),
        )
    )
        return unknown('Complete explicit UTC opening intervals unavailable.');
    const interval = r.intervals.find(
        (s: ReviewedBridgeOperations['intervals'][number]) =>
            s.openMs <= request.fromMs && s.closeMs >= request.untilMs,
    );
    if (!interval) return { kind: 'closed', reason: 'No reviewed opening covers the complete proposed crossing.' };
    if (
        r.noticeMs > 0 &&
        (!confirmation ||
            !text(confirmation.operatorReference, 200) ||
            confirmation.lifetimeKey !== request.lifetimeKey ||
            confirmation.boatId !== request.boatId ||
            confirmation.bridgeFeatureKey !== request.bridgeFeatureKey ||
            confirmation.revision !== r.revision ||
            confirmation.crossingFromMs !== request.fromMs ||
            confirmation.crossingUntilMs !== request.untilMs ||
            !finite(confirmation.confirmedAtMs) ||
            confirmation.confirmedAtMs > request.nowMs ||
            confirmation.confirmedAtMs > request.fromMs - r.noticeMs ||
            confirmation.confirmedAtMs < r.sourcePublishedAtMs)
    )
        return unknown('Required operator notice/confirmation is not bound to this crossing.');
    const result = Object.freeze({
        [mark]: true as const,
        kind: 'opening-required' as const,
        lifetimeKey: request.lifetimeKey,
        boatId: request.boatId,
        bridgeFeatureKey: request.bridgeFeatureKey,
        chartContentKey: request.chartContentKey,
        fromMs: request.fromMs,
        untilMs: request.untilMs,
        checkedAtMs: request.nowMs,
        expiresAtMs: Math.min(r.expiresAtMs, r.effectiveUntilMs),
        scheduledOpenMs: interval.openMs,
        scheduledCloseMs: interval.closeMs,
        revision: r.revision,
        sourcePublishedAtMs: r.sourcePublishedAtMs,
        deviationsCheckedAtMs: r.deviationsCheckedAtMs,
        sourceReference: r.sourceReference,
        reviewId: r.reviewId,
        requiresActualOpening: true as const,
    });
    issued.add(result);
    return result;
}
export function isReviewedBridgeOpening(value: unknown, request: BridgeOpeningRequest): value is ReviewedBridgeOpening {
    if (!value || typeof value !== 'object') return false;
    const v = value as ReviewedBridgeOpening;
    return (
        issued.has(v) &&
        v[mark] === true &&
        v.lifetimeKey === request.lifetimeKey &&
        v.boatId === request.boatId &&
        v.bridgeFeatureKey === request.bridgeFeatureKey &&
        v.chartContentKey === request.chartContentKey &&
        v.fromMs === request.fromMs &&
        v.untilMs === request.untilMs &&
        finite(request.nowMs) &&
        request.nowMs >= v.checkedAtMs &&
        request.nowMs < v.expiresAtMs
    );
}
