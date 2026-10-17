/** Proposed wait only. Current reader facts and independent navigation rights
 * must both qualify. No route mutation here. */
import { isReviewedWaterInterval, type WaterIntervalContext } from '../tides/reviewedWaterInterval';
import type { HoldingEvidence } from './completeHoldingReader';
export interface TideWaitRequest extends WaterIntervalContext {
    boatId: string;
    routeIdentity: string;
    holdingAlongNm: number;
    gateAlongNm: number;
    radiusM: number;
}
export interface HoldingLimits {
    draftM: number;
    ukcM: number;
    maxWindKts: number;
    maxGustKts: number;
    maxWaveM: number;
    maxCurrentKts: number;
}
/** Dependency contract for a separately reviewed complete local reader. These
 * are not accepted from settings, a source payload, an acknowledgement or the
 * existing point-sample holdingGroundAt advisory. The future adapter must
 * establish the complete circle/approach and every declared interval fact. */
export interface CompleteHoldingFacts {
    lifetimeKey: string;
    chartContentKey: string;
    lat: number;
    lon: number;
    radiusM: number;
    readAtMs: number;
    completeCircleAndApproach: boolean;
    minimumChartedDepthM: number | null;
    datumId: string;
    datumEpoch: string;
    hazards: 'clear' | 'blocked' | 'unknown';
    permission: 'allowed' | 'prohibited' | 'unknown';
    bottom: 'charted' | 'poor' | 'unknown';
    bottomIsPointSample: boolean;
    weather: null | {
        source: string;
        originalIssueMs: number;
        expiresAtMs: number;
        maxIssueAgeMs: number;
        fromMs: number;
        untilMs: number;
        completeIntervalAndExposure: boolean;
        maxWindKts: number | null;
        maxGustKts: number | null;
        maxWaveM: number | null;
        maxCurrentKts: number | null;
        includesTidalStreams: boolean;
    };
}
export type CompleteHoldingReader = (
    request: TideWaitRequest,
    options: { signal: AbortSignal; assertCurrent: () => void },
) => Promise<CompleteHoldingFacts | null>;
const noReader: CompleteHoldingReader = async () => null;
export interface HoldingReviewOptions {
    signal: AbortSignal;
    assertCurrent: () => void;
    now?: () => number;
}
const mark: unique symbol = Symbol('reviewed-proposed-tide-wait');
const issued = new WeakSet<object>();
export interface ProposedTideWait {
    readonly [mark]: true;
    readonly kind: 'proposed-wait';
    readonly needsExplicitAcceptance: true;
    readonly actualHoldingVerified: false;
    readonly identity: string;
    readonly lat: number;
    readonly lon: number;
    readonly fromMs: number;
    readonly untilMs: number;
    readonly checkedAtMs: number;
    readonly expiresAtMs: number;
    readonly minimumUkcM: number;
    readonly aboardOnly: boolean;
}
export type TideWaitAssessment = ProposedTideWait | { kind: 'unavailable'; reason: string; evidence?: HoldingEvidence };
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const text = (s: unknown): s is string =>
    typeof s === 'string' && s.length > 0 && s.length <= 100000 && !/\p{Cc}/u.test(s);
const key = (r: TideWaitRequest, limits: HoldingLimits) =>
    JSON.stringify([
        r.lifetimeKey,
        r.boatId,
        r.routeIdentity,
        r.lat,
        r.lon,
        r.fromMs,
        r.untilMs,
        r.chartContentKey,
        r.targetDatumId,
        r.targetDatumEpoch,
        r.use,
        r.protectedChart,
        r.holdingAlongNm,
        r.gateAlongNm,
        r.radiusM,
        limits,
    ]);
/** Bounded read-only review. Future UI may offer an explicit waypoint only
 * after these independent facts exist; it must never manufacture them. */
export async function reviewTideWait(
    r: TideWaitRequest,
    limits: HoldingLimits,
    water: unknown,
    options: HoldingReviewOptions,
    reader: CompleteHoldingReader = noReader,
): Promise<TideWaitAssessment> {
    const no = (reason: string): TideWaitAssessment => ({ kind: 'unavailable', reason });
    const now = options.now ?? Date.now;
    const initialNow = now(),
        identity = key(r, limits);
    options.signal.throwIfAborted();
    options.assertCurrent();
    if (
        !finite(initialNow) ||
        !finite(r.nowMs) ||
        Math.abs(initialNow - r.nowMs) > 30000 ||
        !text(r.boatId) ||
        !text(r.routeIdentity) ||
        r.use !== 'holding' ||
        ![
            r.holdingAlongNm,
            r.gateAlongNm,
            r.radiusM,
            limits.draftM,
            limits.ukcM,
            limits.maxWindKts,
            limits.maxGustKts,
            limits.maxWaveM,
            limits.maxCurrentKts,
        ].every(finite) ||
        r.holdingAlongNm < 0 ||
        r.holdingAlongNm >= r.gateAlongNm ||
        r.radiusM < 10 ||
        r.radiusM > 500 ||
        limits.draftM <= 0 ||
        limits.ukcM < 0.5 ||
        limits.ukcM > 3 ||
        limits.maxWindKts <= 0 ||
        limits.maxGustKts <= 0 ||
        limits.maxWaveM <= 0 ||
        limits.maxCurrentKts <= 0 ||
        !isReviewedWaterInterval(water, r)
    )
        return no('A prior holding point, exact current policy and complete reviewed tide interval are required.');
    const controller = new AbortController(),
        abort = () => controller.abort();
    options.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 30000);
    let listener: (() => void) | undefined;
    const stopped = new Promise<never>((_, reject) => {
        listener = () => reject(new DOMException('Holding review stopped or exceeded 30 seconds.', 'AbortError'));
        controller.signal.addEventListener('abort', listener, { once: true });
        if (options.signal.aborted) abort();
    });
    try {
        controller.signal.throwIfAborted();
        const facts = await Promise.race([
            reader(Object.freeze({ ...r }), { signal: controller.signal, assertCurrent: options.assertCurrent }),
            stopped,
        ]);
        controller.signal.throwIfAborted();
        options.assertCurrent();
        const readNow = now();
        if (
            !finite(readNow) ||
            readNow < initialNow ||
            readNow - initialNow > 30000 ||
            key(r, limits) !== identity ||
            !isReviewedWaterInterval(water, { ...r, nowMs: readNow })
        )
            return no('Holding context, clock or source validity changed during the read.');
        if (
            !facts ||
            facts.lifetimeKey !== r.lifetimeKey ||
            facts.chartContentKey !== r.chartContentKey ||
            facts.lat !== r.lat ||
            facts.lon !== r.lon ||
            !finite(facts.radiusM) ||
            facts.radiusM < r.radiusM ||
            facts.radiusM > 500 ||
            !finite(facts.readAtMs) ||
            facts.readAtMs < initialNow - 2000 ||
            facts.readAtMs > readNow + 2000 ||
            facts.completeCircleAndApproach !== true ||
            !finite(facts.minimumChartedDepthM) ||
            facts.datumId !== r.targetDatumId ||
            facts.datumEpoch !== r.targetDatumEpoch ||
            facts.hazards !== 'clear' ||
            facts.permission !== 'allowed' ||
            facts.bottom !== 'charted' ||
            facts.bottomIsPointSample !== false
        )
            return no('Complete local circle/approach, datum, depth, holding and permission evidence is unavailable.');
        const weather = facts.weather;
        if (
            !weather ||
            !text(weather.source) ||
            !finite(weather.originalIssueMs) ||
            weather.originalIssueMs > r.nowMs ||
            !finite(weather.expiresAtMs) ||
            weather.expiresAtMs <= readNow ||
            !finite(weather.maxIssueAgeMs) ||
            weather.maxIssueAgeMs <= 0 ||
            weather.maxIssueAgeMs > 72 * 3600000 ||
            readNow - weather.originalIssueMs > weather.maxIssueAgeMs ||
            weather.completeIntervalAndExposure !== true ||
            !finite(weather.fromMs) ||
            !finite(weather.untilMs) ||
            weather.fromMs > r.fromMs ||
            weather.untilMs < r.untilMs ||
            !finite(weather.maxWindKts) ||
            weather.maxWindKts < 0 ||
            weather.maxWindKts > limits.maxWindKts ||
            !finite(weather.maxGustKts) ||
            weather.maxGustKts < 0 ||
            weather.maxGustKts < weather.maxWindKts ||
            weather.maxGustKts > limits.maxGustKts ||
            !finite(weather.maxWaveM) ||
            weather.maxWaveM < 0 ||
            weather.maxWaveM > limits.maxWaveM ||
            weather.includesTidalStreams !== true ||
            !finite(weather.maxCurrentKts) ||
            weather.maxCurrentKts < 0 ||
            weather.maxCurrentKts > limits.maxCurrentKts
        )
            return no('Complete interval weather/exposure within the stated vessel limits is unavailable.');
        const minimumUkcM = facts.minimumChartedDepthM + water.minLowM - limits.draftM;
        if (minimumUkcM < limits.ukcM)
            return no('The complete holding interval does not meet this boat’s under-keel allowance.');
        options.assertCurrent();
        const result = Object.freeze({
            [mark]: true as const,
            kind: 'proposed-wait' as const,
            needsExplicitAcceptance: true as const,
            actualHoldingVerified: false as const,
            identity,
            lat: r.lat,
            lon: r.lon,
            fromMs: r.fromMs,
            untilMs: r.untilMs,
            checkedAtMs: readNow,
            expiresAtMs: Math.min(water.expiresAtMs, weather.expiresAtMs, readNow + 300000),
            minimumUkcM,
            aboardOnly: r.protectedChart,
        });
        issued.add(result);
        return result;
    } finally {
        clearTimeout(timer);
        controller.abort();
        options.signal.removeEventListener('abort', abort);
        if (listener) controller.signal.removeEventListener('abort', listener);
    }
}
/** Explicit acceptance must rerun the complete read. The returned intent
 * contains only a user-chosen point/label; derived chart/tide facts and times
 * stay in RAM and are not added to a saved/cloud route DTO by this function. */
export async function recheckTideWaitForAcceptance(
    draft: unknown,
    r: TideWaitRequest,
    limits: HoldingLimits,
    water: unknown,
    options: HoldingReviewOptions,
    reader: CompleteHoldingReader = noReader,
): Promise<{ lat: number; lon: number; name: 'Wait' } | null> {
    if (!draft || typeof draft !== 'object') return null;
    const value = draft as ProposedTideWait;
    if (
        !issued.has(value) ||
        value[mark] !== true ||
        value.identity !== key(r, limits) ||
        !finite(r.nowMs) ||
        r.nowMs < value.checkedAtMs ||
        r.nowMs >= value.expiresAtMs
    )
        return null;
    const checked = await reviewTideWait(r, limits, water, options, reader);
    options.signal.throwIfAborted();
    options.assertCurrent();
    return checked.kind === 'proposed-wait' ? { lat: checked.lat, lon: checked.lon, name: 'Wait' } : null;
}
