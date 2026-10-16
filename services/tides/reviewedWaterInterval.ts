/** Whole original-sample interval proof. Unknown knots split the result; no
 * endpoint-only clearance/holding window or extrema interpolation. */
import { parseSampledTideSeries, type SampledTideSeries } from './sampledTideContract';
import {
    assessSampledTideNavigation,
    isReviewedStationTideEstimate,
    REVIEWED_SAMPLED_TIDE_AUTHORITY,
    type SampledTideAuthority,
    type TideNavigationContext,
    type ReviewedStationTideEstimate,
} from './sampledTideNavigation';
import { blendNearbyReviewedTides } from './nearbySampledTides';
export interface WaterIntervalContext extends Omit<TideNavigationContext, 'atMs'> {
    fromMs: number;
    untilMs: number;
}
const mark: unique symbol = Symbol('reviewed-full-water-interval');
const issued = new WeakSet<object>();
export interface ReviewedWaterInterval {
    readonly [mark]: true;
    readonly kind: 'reviewed-water-interval';
    readonly lifetimeKey: string;
    readonly lat: number;
    readonly lon: number;
    readonly fromMs: number;
    readonly untilMs: number;
    readonly checkedAtMs: number;
    readonly expiresAtMs: number;
    readonly chartContentKey: string;
    readonly targetDatumId: string;
    readonly targetDatumEpoch: string;
    readonly use: TideNavigationContext['use'];
    readonly aboardOnly: boolean;
    readonly minLowM: number;
    readonly maxHighM: number;
    readonly oldestSourceAtMs: number;
    readonly checkedInstants: number;
}
/** One day /512 instants. Every original knot and each intervening bracket
 * midpoint is checked; a reviewed cadence gap cannot hide at exact endpoints.
 * The actual provider predictions are piecewise linear inside those admitted
 * original brackets, so adverse extrema occur at these checked boundaries. */
export async function reviewWaterInterval(
    inputSeries: readonly SampledTideSeries[],
    inputContext: WaterIntervalContext,
    options: { signal: AbortSignal; assertCurrent: () => void },
    authority: SampledTideAuthority = REVIEWED_SAMPLED_TIDE_AUTHORITY,
): Promise<ReviewedWaterInterval | null> {
    const series = Object.freeze([...inputSeries]),
        c = Object.freeze({ ...inputContext });
    options.signal.throwIfAborted();
    options.assertCurrent();
    if (
        series.length < 1 ||
        series.length > 3 ||
        !Number.isFinite(c.fromMs) ||
        !Number.isFinite(c.untilMs) ||
        c.untilMs <= c.fromMs ||
        c.untilMs - c.fromMs > 86400000
    )
        return null;
    const admitted = series.map((s) => parseSampledTideSeries(s, c.nowMs));
    if (admitted.some((s) => !s)) return null;
    const boundaries = new Set([c.fromMs, c.untilMs]);
    for (const s of admitted)
        for (const knot of s!.samples)
            if (knot.timeMs > c.fromMs && knot.timeMs < c.untilMs) boundaries.add(knot.timeMs);
    const knots = [...boundaries].sort((a, b) => a - b),
        instants = [...knots];
    for (let i = 1; i < knots.length; i++) instants.push((knots[i - 1] + knots[i]) / 2);
    if (instants.length > 512) return null;
    let minLowM = Infinity,
        maxHighM = -Infinity,
        oldestSourceAtMs = Infinity,
        expiresAtMs = Infinity;
    for (let i = 0; i < instants.length; i++) {
        if (i % 16 === 0) {
            await new Promise<void>((done) => setTimeout(done, 0));
            options.signal.throwIfAborted();
            options.assertCurrent();
        }
        const point = { ...c, atMs: instants[i] };
        const stations = series.map((s) => assessSampledTideNavigation(s, point, authority));
        const eligible = stations.filter((s): s is ReviewedStationTideEstimate =>
            isReviewedStationTideEstimate(s, point),
        );
        if (eligible.length !== stations.length) return null;
        const value = eligible.length === 1 ? eligible[0] : blendNearbyReviewedTides(eligible, point);
        if (!value) return null;
        minLowM = Math.min(minLowM, value.lowM);
        maxHighM = Math.max(maxHighM, value.highM);
        oldestSourceAtMs = Math.min(oldestSourceAtMs, value.sourceAtMs);
        expiresAtMs = Math.min(expiresAtMs, value.expiresAtMs);
    }
    options.signal.throwIfAborted();
    options.assertCurrent();
    if (![minLowM, maxHighM, oldestSourceAtMs, expiresAtMs].every(Number.isFinite)) return null;
    const result = Object.freeze({
        [mark]: true as const,
        kind: 'reviewed-water-interval' as const,
        lifetimeKey: c.lifetimeKey,
        lat: c.lat,
        lon: c.lon,
        fromMs: c.fromMs,
        untilMs: c.untilMs,
        checkedAtMs: c.nowMs,
        expiresAtMs,
        chartContentKey: c.chartContentKey,
        targetDatumId: c.targetDatumId,
        targetDatumEpoch: c.targetDatumEpoch,
        use: c.use,
        aboardOnly: c.protectedChart,
        minLowM,
        maxHighM,
        oldestSourceAtMs,
        checkedInstants: instants.length,
    });
    issued.add(result);
    return result;
}
export function isReviewedWaterInterval(value: unknown, c: WaterIntervalContext): value is ReviewedWaterInterval {
    if (!value || typeof value !== 'object') return false;
    const v = value as ReviewedWaterInterval;
    return (
        issued.has(v) &&
        v[mark] === true &&
        v.lifetimeKey === c.lifetimeKey &&
        v.lat === c.lat &&
        v.lon === c.lon &&
        v.fromMs === c.fromMs &&
        v.untilMs === c.untilMs &&
        Number.isFinite(c.nowMs) &&
        c.nowMs >= v.checkedAtMs &&
        c.nowMs < v.expiresAtMs &&
        v.chartContentKey === c.chartContentKey &&
        v.targetDatumId === c.targetDatumId &&
        v.targetDatumEpoch === c.targetDatumEpoch &&
        v.use === c.use &&
        v.aboardOnly === c.protectedChart
    );
}
