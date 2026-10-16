/** Reviewed source authority is independent of the provider payload. Current
 * production registry is empty; no UI/env/payload field can add a review. */
import { calculateDistance } from '../../utils/navigationCalculations';
import {
    parseSampledTideSeries,
    sampleStationPrediction,
    type SampledTideProvider,
    type SampledTideSeries,
} from './sampledTideContract';
export type TideNavigationUse = 'sounding' | 'overhead' | 'holding';
type Bounds = readonly [number, number, number, number];
export interface ReviewedSampledTideSource {
    reviewId: string;
    provider: SampledTideProvider;
    productId: string;
    sourceUrlPrefix: string;
    rights: { basis: 'public-agency-navigation-use' | 'written-provider-permission'; reference: string };
    uses: readonly TideNavigationUse[];
    validFromMs: number;
    validUntilMs: number;
    maxIssueAgeMs: number;
    maxSampleGapMs: number;
    predictionUncertaintyM: number;
}
/** Review evidence for this exact station, datum epoch, current cell content,
 * target datum and bounded area. Sounding and overhead ties never substitute. */
export interface ReviewedStationDatumTie {
    reviewId: string;
    provider: SampledTideProvider;
    productId: string;
    stationId: string;
    sourceDatumId: string;
    sourceDatumEpoch: string;
    chartContentKey: string;
    targetDatumId: string;
    targetDatumEpoch: string;
    use: TideNavigationUse;
    sourceReference: string;
    validFromMs: number;
    validUntilMs: number;
    coverage: readonly Bounds[];
    maxDistanceKm: number;
    offsetM: number;
    uncertaintyM: number;
}
export interface SampledTideAuthority {
    sources: readonly ReviewedSampledTideSource[];
    ties: readonly ReviewedStationDatumTie[];
}
/** Populated only by a separately reviewed code/data change with real rights
 * and datum evidence. The optional assessment argument is a trusted authority
 * dependency for that integration and synthetic tests, never a source DTO. */
export const REVIEWED_SAMPLED_TIDE_AUTHORITY: SampledTideAuthority = Object.freeze({
    sources: Object.freeze([]),
    ties: Object.freeze([]),
});
export interface TideNavigationContext {
    /** Caller-owned account/boat/request generation; changes on A/B/A too. */
    lifetimeKey: string;
    lat: number;
    lon: number;
    atMs: number;
    nowMs: number;
    chartContentKey: string;
    targetDatumId: string;
    targetDatumEpoch: string;
    use: TideNavigationUse;
    protectedChart: boolean;
}
const reviewMark: unique symbol = Symbol('reviewed-station-tide-estimate');
export interface ReviewedStationTideEstimate {
    readonly [reviewMark]: true;
    readonly kind: 'reviewed-station-estimate';
    readonly stationId: string;
    readonly provider: SampledTideProvider;
    readonly productId: string;
    readonly distanceKm: number;
    readonly lifetimeKey: string;
    readonly checkedAtMs: number;
    readonly expiresAtMs: number;
    readonly atMs: number;
    readonly lat: number;
    readonly lon: number;
    readonly heightM: number;
    readonly lowM: number;
    readonly highM: number;
    readonly chartContentKey: string;
    readonly targetDatumId: string;
    readonly targetDatumEpoch: string;
    readonly use: TideNavigationUse;
    readonly aboardOnly: boolean;
    readonly sourceAtMs: number;
    readonly sourceReviewId: string;
    readonly datumReviewId: string;
}
export type TideNavigationAssessment = { kind: 'unavailable'; reason: string } | ReviewedStationTideEstimate;
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const id = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 512 && !/\p{Cc}/u.test(s);
const evidence = (s: string) => {
    try {
        const u = new URL(s);
        return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash;
    } catch {
        return false;
    }
};
const validTime = (from: number, until: number, c: TideNavigationContext) =>
    [from, until, c.atMs, c.nowMs].every(finite) &&
    from <= c.nowMs &&
    from <= c.atMs &&
    until >= c.nowMs &&
    until >= c.atMs &&
    until > from;
function covers(bounds: readonly Bounds[], c: TideNavigationContext): boolean {
    return (
        Array.isArray(bounds) &&
        bounds.length >= 1 &&
        bounds.length <= 4 &&
        bounds.every(
            (b) =>
                Array.isArray(b) &&
                b.length === 4 &&
                b.every(finite) &&
                b[0] >= -180 &&
                b[2] <= 180 &&
                b[1] >= -85 &&
                b[3] <= 85 &&
                b[0] <= b[2] &&
                b[1] <= b[3],
        ) &&
        bounds.some(([w, s, e, n]) => c.lon >= w && c.lon <= e && c.lat >= s && c.lat <= n)
    );
}
/** Fail-closed admission, not a route/clearance verdict. A future approved
 * dataset can qualify with complete independent proof; current inputs cannot. */
export function assessSampledTideNavigation(
    series: SampledTideSeries,
    c: TideNavigationContext,
    authority: SampledTideAuthority = REVIEWED_SAMPLED_TIDE_AUTHORITY,
): TideNavigationAssessment {
    const no = (reason: string): TideNavigationAssessment => ({ kind: 'unavailable', reason });
    const value = parseSampledTideSeries(series, c.nowMs);
    if (
        !value ||
        !finite(c.lat) ||
        Math.abs(c.lat) > 85 ||
        !finite(c.lon) ||
        Math.abs(c.lon) > 180 ||
        !id(c.lifetimeKey) ||
        !id(c.chartContentKey) ||
        !id(c.targetDatumId) ||
        !id(c.targetDatumEpoch) ||
        !['sounding', 'overhead', 'holding'].includes(c.use)
    )
        return no('Sample, point or current chart context unavailable.');
    if (
        !authority ||
        !Array.isArray(authority.sources) ||
        authority.sources.length > 64 ||
        !Array.isArray(authority.ties) ||
        authority.ties.length > 256
    )
        return no('Reviewed authority inventory unavailable.');
    const sources = authority.sources.filter(
        (r) => r && r.provider === value.provider && r.productId === value.productId,
    );
    if (sources.length !== 1)
        return no(
            value.provider === 'WorldTides'
                ? 'WorldTides navigation permission unverified.'
                : 'Sampled provider/product has no unique reviewed navigation source.',
        );
    const source = sources[0];
    if (
        !id(source.reviewId) ||
        !evidence(source.rights?.reference) ||
        !['public-agency-navigation-use', 'written-provider-permission'].includes(source.rights?.basis) ||
        (value.provider === 'WorldTides' && source.rights.basis !== 'written-provider-permission')
    )
        return no('Navigation rights evidence unavailable.');
    if (
        !validTime(source.validFromMs, source.validUntilMs, c) ||
        !Array.isArray(source.uses) ||
        !source.uses.includes(c.use) ||
        !evidence(source.sourceUrlPrefix) ||
        !value.sourceUrl.startsWith(source.sourceUrlPrefix) ||
        !finite(source.maxIssueAgeMs) ||
        source.maxIssueAgeMs <= 0 ||
        source.maxIssueAgeMs > 366 * 86400000 ||
        value.sourceAtMs === null ||
        value.sourceAtMs > c.nowMs ||
        value.sourceAtMs < source.validFromMs ||
        c.nowMs - value.sourceAtMs > source.maxIssueAgeMs ||
        !finite(source.maxSampleGapMs) ||
        source.maxSampleGapMs <= 0 ||
        source.maxSampleGapMs > 3600000 ||
        !finite(source.predictionUncertaintyM) ||
        source.predictionUncertaintyM < 0 ||
        source.predictionUncertaintyM > 10
    )
        return no('Reviewed source scope, original clock or uncertainty unavailable.');
    const sample = sampleStationPrediction(value, c.atMs, c.nowMs);
    if (!sample) return no('Original sampled prediction does not cover this time.');
    if (sample.interpolated) {
        const right = value.samples.findIndex((p) => p.timeMs > c.atMs);
        if (right < 1 || value.samples[right].timeMs - value.samples[right - 1].timeMs > source.maxSampleGapMs)
            return no('Original prediction bracket exceeds the reviewed cadence.');
    }
    const ties = authority.ties.filter(
        (r) =>
            r &&
            r.provider === value.provider &&
            r.productId === value.productId &&
            r.stationId === value.stationId &&
            r.sourceDatumId === value.datumId &&
            value.datumEpoch !== null &&
            r.sourceDatumEpoch === value.datumEpoch &&
            r.chartContentKey === c.chartContentKey &&
            r.targetDatumId === c.targetDatumId &&
            r.targetDatumEpoch === c.targetDatumEpoch &&
            r.use === c.use,
    );
    if (ties.length !== 1) return no('Exact station-to-current-cell datum/epoch tie unavailable.');
    const tie = ties[0];
    if (
        !id(tie.reviewId) ||
        !evidence(tie.sourceReference) ||
        !validTime(tie.validFromMs, tie.validUntilMs, c) ||
        !covers(tie.coverage, c) ||
        !finite(tie.maxDistanceKm) ||
        tie.maxDistanceKm <= 0 ||
        tie.maxDistanceKm > 15 ||
        calculateDistance(value.lat, value.lon, c.lat, c.lon) * 1.852 > tie.maxDistanceKm ||
        !finite(tie.offsetM) ||
        Math.abs(tie.offsetM) > 100 ||
        !finite(tie.uncertaintyM) ||
        tie.uncertaintyM < 0 ||
        tie.uncertaintyM > 10
    )
        return no('Reviewed datum transfer does not cover this location/time.');
    const heightM = sample.heightM + tie.offsetM,
        uncertainty = tie.uncertaintyM + source.predictionUncertaintyM;
    return Object.freeze({
        [reviewMark]: true as const,
        kind: 'reviewed-station-estimate' as const,
        stationId: value.stationId,
        provider: value.provider,
        productId: value.productId,
        distanceKm: calculateDistance(value.lat, value.lon, c.lat, c.lon) * 1.852,
        lifetimeKey: c.lifetimeKey,
        checkedAtMs: c.nowMs,
        expiresAtMs: Math.min(value.expiresAtMs, source.validUntilMs, tie.validUntilMs),
        atMs: c.atMs,
        lat: c.lat,
        lon: c.lon,
        heightM,
        lowM: heightM - uncertainty,
        highM: heightM + uncertainty,
        chartContentKey: c.chartContentKey,
        targetDatumId: c.targetDatumId,
        targetDatumEpoch: c.targetDatumEpoch,
        use: c.use,
        aboardOnly: c.protectedChart,
        sourceAtMs: value.sourceAtMs,
        sourceReviewId: source.reviewId,
        datumReviewId: tie.reviewId,
    });
}

/** Only genuine in-process assessments can become inputs to a future blend.
 * A serialized/source-invented navigationEligible flag is not this authority. */
export function isReviewedStationTideEstimate(
    value: unknown,
    c: TideNavigationContext,
): value is ReviewedStationTideEstimate {
    if (!value || typeof value !== 'object') return false;
    const v = value as ReviewedStationTideEstimate;
    return (
        v[reviewMark] === true &&
        v.lifetimeKey === c.lifetimeKey &&
        v.atMs === c.atMs &&
        v.lat === c.lat &&
        v.lon === c.lon &&
        finite(c.nowMs) &&
        c.nowMs >= v.checkedAtMs &&
        c.nowMs < v.expiresAtMs &&
        v.chartContentKey === c.chartContentKey &&
        v.targetDatumId === c.targetDatumId &&
        v.targetDatumEpoch === c.targetDatumEpoch &&
        v.use === c.use &&
        v.aboardOnly === c.protectedChart
    );
}
