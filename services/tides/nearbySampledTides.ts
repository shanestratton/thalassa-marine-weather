/** Two or three already reviewed station-to-point transfers only. No nearest
 * station fallback, cross-datum averaging, fetch, storage or chart geometry. */
import {
    isReviewedStationTideEstimate,
    type ReviewedStationTideEstimate,
    type TideNavigationContext,
} from './sampledTideNavigation';
const spatialMark: unique symbol = Symbol('reviewed-spatial-tide-estimate');
export interface ReviewedSpatialTideEstimate {
    readonly [spatialMark]: true;
    readonly kind: 'reviewed-spatial-estimate';
    readonly lifetimeKey: string;
    readonly atMs: number;
    readonly checkedAtMs: number;
    readonly expiresAtMs: number;
    readonly lat: number;
    readonly lon: number;
    readonly heightM: number;
    /** Full source/transfer envelope, not a reduced error from averaging. */
    readonly lowM: number;
    readonly highM: number;
    readonly spreadM: number;
    readonly chartContentKey: string;
    readonly targetDatumId: string;
    readonly targetDatumEpoch: string;
    readonly use: TideNavigationContext['use'];
    readonly aboardOnly: boolean;
    readonly sourceAtMs: number;
    readonly stations: readonly string[];
    readonly reviews: readonly string[];
}
export function blendNearbyReviewedTides(
    input: readonly unknown[],
    c: TideNavigationContext,
): ReviewedSpatialTideEstimate | null {
    if (input.length < 2 || input.length > 3 || !input.every((v) => isReviewedStationTideEstimate(v, c))) return null;
    const stations = input as readonly ReviewedStationTideEstimate[];
    const ids = stations.map((s) => `${s.provider}:${s.stationId}`);
    if (new Set(ids).size !== stations.length) return null;
    const exact = stations.some((s) => s.distanceKm < 1e-6);
    const weights = stations.map((s) => (exact ? (s.distanceKm < 1e-6 ? 1 : 0) : 1 / Math.max(0.1, s.distanceKm) ** 2));
    const sum = weights.reduce((a, b) => a + b, 0);
    const heightM = stations.reduce((height, s, i) => height + (s.heightM * weights[i]) / sum, 0);
    if (!Number.isFinite(heightM)) return null;
    return Object.freeze({
        [spatialMark]: true as const,
        kind: 'reviewed-spatial-estimate' as const,
        lifetimeKey: c.lifetimeKey,
        atMs: c.atMs,
        checkedAtMs: Math.max(...stations.map((s) => s.checkedAtMs)),
        expiresAtMs: Math.min(...stations.map((s) => s.expiresAtMs)),
        lat: c.lat,
        lon: c.lon,
        heightM,
        lowM: Math.min(...stations.map((s) => s.lowM)),
        highM: Math.max(...stations.map((s) => s.highM)),
        spreadM: Math.max(...stations.map((s) => s.heightM)) - Math.min(...stations.map((s) => s.heightM)),
        chartContentKey: c.chartContentKey,
        targetDatumId: c.targetDatumId,
        targetDatumEpoch: c.targetDatumEpoch,
        use: c.use,
        aboardOnly: stations.some((s) => s.aboardOnly),
        sourceAtMs: Math.min(...stations.map((s) => s.sourceAtMs)),
        stations: Object.freeze(ids),
        reviews: Object.freeze(stations.flatMap((s) => [s.sourceReviewId, s.datumReviewId])),
    });
}
export function isReviewedSpatialTideEstimate(
    value: unknown,
    c: TideNavigationContext,
): value is ReviewedSpatialTideEstimate {
    if (!value || typeof value !== 'object') return false;
    const v = value as ReviewedSpatialTideEstimate;
    return (
        v[spatialMark] === true &&
        v.lifetimeKey === c.lifetimeKey &&
        v.atMs === c.atMs &&
        v.lat === c.lat &&
        v.lon === c.lon &&
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
