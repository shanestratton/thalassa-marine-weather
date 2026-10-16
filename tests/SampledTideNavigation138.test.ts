/** Fictional authority records test the gate, never real source/rights proof. */
import { describe, expect, it } from 'vitest';
import {
    assessSampledTideNavigation,
    isReviewedStationTideEstimate,
    REVIEWED_SAMPLED_TIDE_AUTHORITY,
    type SampledTideAuthority,
    type TideNavigationContext,
} from '../services/tides/sampledTideNavigation';
import type { SampledTideSeries } from '../services/tides/sampledTideContract';
import { blendNearbyReviewedTides, isReviewedSpatialTideEstimate } from '../services/tides/nearbySampledTides';
const T = Date.parse('2026-10-17T06:00:00Z'),
    HOUR = 3600000;
const source = (): SampledTideSeries => ({
    schema: 1,
    kind: 'sampled-prediction',
    provider: 'NOAA',
    productId: 'fictional-dense-product',
    stationId: 'fictional-station',
    stationName: 'Entirely fictional station',
    lat: 0,
    lon: 0,
    datumId: 'fictional-station-MLLW',
    datumLabel: 'Fictional MLLW',
    datumEpoch: 'fictional-epoch-a',
    sourceAtMs: T - 10 * HOUR,
    receivedAtMs: T,
    expiresAtMs: T + HOUR,
    sourceUrl: 'https://tidesandcurrents.noaa.gov/',
    licenceUrl: 'https://tidesandcurrents.noaa.gov/',
    units: 'm',
    samples: [
        { timeMs: T, heightM: -0.3 },
        { timeMs: T + HOUR / 2, heightM: 1.1 },
    ],
});
const context = (): TideNavigationContext => ({
    lifetimeKey: 'fictional-owner/boat/lifetime-1',
    lat: 0,
    lon: 0.01,
    atMs: T + HOUR / 4,
    nowMs: T,
    chartContentKey: 'FICTIONAL-CELL@1@content-a',
    targetDatumId: 'fictional-cell-LAT',
    targetDatumEpoch: 'fictional-chart-epoch',
    use: 'sounding',
    protectedChart: true,
});
const authority = (): SampledTideAuthority => ({
    sources: [
        {
            reviewId: 'FICTIONAL-SOURCE-REVIEW',
            provider: 'NOAA',
            productId: 'fictional-dense-product',
            sourceUrlPrefix: 'https://tidesandcurrents.noaa.gov/',
            rights: {
                basis: 'public-agency-navigation-use',
                reference: 'https://tidesandcurrents.noaa.gov/fictional-test-reference',
            },
            uses: ['sounding', 'overhead', 'holding'],
            validFromMs: T - 100 * HOUR,
            validUntilMs: T + 100 * HOUR,
            maxIssueAgeMs: 24 * HOUR,
            maxSampleGapMs: HOUR / 2,
            predictionUncertaintyM: 0.3,
        },
    ],
    ties: [
        {
            reviewId: 'FICTIONAL-DATUM-REVIEW',
            provider: 'NOAA',
            productId: 'fictional-dense-product',
            stationId: 'fictional-station',
            sourceDatumId: 'fictional-station-MLLW',
            sourceDatumEpoch: 'fictional-epoch-a',
            chartContentKey: 'FICTIONAL-CELL@1@content-a',
            targetDatumId: 'fictional-cell-LAT',
            targetDatumEpoch: 'fictional-chart-epoch',
            use: 'sounding',
            sourceReference: 'https://tidesandcurrents.noaa.gov/fictional-test-datum',
            validFromMs: T - 100 * HOUR,
            validUntilMs: T + 100 * HOUR,
            coverage: [[-0.05, -0.05, 0.05, 0.05]],
            maxDistanceKm: 5,
            offsetM: 0.1,
            uncertaintyM: 0.2,
        },
    ],
});
describe('independently reviewed sampled navigation authority', () => {
    it('blends only two or three independently tied stations without shrinking the source envelope or renewing the oldest issue', () => {
        const reviewed = authority();
        const other = {
            ...source(),
            stationId: 'fictional-station-b',
            datumId: 'fictional-station-b-MLLW',
            lon: 0.02,
            sourceAtMs: T - 12 * HOUR,
            samples: source().samples.map((p) => ({ ...p, heightM: p.heightM + 2 })),
        };
        reviewed.ties = [
            ...reviewed.ties,
            {
                ...reviewed.ties[0],
                stationId: other.stationId,
                sourceDatumId: other.datumId,
                reviewId: 'FICTIONAL-SECOND-TIE',
            },
        ];
        const first = assessSampledTideNavigation(source(), context(), reviewed);
        const second = assessSampledTideNavigation(other, context(), reviewed);
        const blend = blendNearbyReviewedTides([first, second], context());
        expect(blend?.kind).toBe('reviewed-spatial-estimate');
        expect(blend?.heightM).toBeCloseTo(1.5);
        expect(blend?.lowM).toBeCloseTo(0);
        expect(blend?.highM).toBeCloseTo(3);
        expect(blend?.spreadM).toBeCloseTo(2);
        expect(blend?.sourceAtMs).toBe(T - 12 * HOUR);
        expect(blend?.stations).toHaveLength(2);
        expect(isReviewedSpatialTideEstimate(blend, context())).toBe(true);
        expect(isReviewedSpatialTideEstimate(JSON.parse(JSON.stringify(blend)), context())).toBe(false);
        expect(blendNearbyReviewedTides([first], context())).toBeNull();
        expect(blendNearbyReviewedTides([first, first], context())).toBeNull();
        expect(blendNearbyReviewedTides([first, second, first, second], context())).toBeNull();
        expect(blendNearbyReviewedTides([first, JSON.parse(JSON.stringify(second))], context())).toBeNull();
        expect(blendNearbyReviewedTides([first, second], { ...context(), lifetimeKey: 'next-generation' })).toBeNull();
        expect(blendNearbyReviewedTides([first, second], { ...context(), nowMs: T + HOUR })).toBeNull();
        const thirdSource = {
            ...source(),
            stationId: 'fictional-station-c',
            datumId: 'fictional-station-c-MLLW',
            lat: 0.01,
        };
        reviewed.ties = [
            ...reviewed.ties,
            {
                ...reviewed.ties[0],
                stationId: thirdSource.stationId,
                sourceDatumId: thirdSource.datumId,
                reviewId: 'FICTIONAL-THIRD-TIE',
            },
        ];
        const third = assessSampledTideNavigation(thirdSource, context(), reviewed);
        expect(blendNearbyReviewedTides([first, second, third], context())?.stations).toHaveLength(3);
    });
    it('uses split reviewed dateline scope without a world-spanning station transfer', () => {
        const c = { ...context(), lon: 179.99 },
            reviewed = authority();
        const a = { ...source(), lon: 179.98 },
            b = { ...source(), stationId: 'dateline-b', datumId: 'dateline-b-MLLW', lon: -179.98 };
        const coverage: [number, number, number, number][] = [
            [179.95, -0.05, 180, 0.05],
            [-180, -0.05, -179.95, 0.05],
        ];
        reviewed.ties = [
            { ...reviewed.ties[0], coverage },
            { ...reviewed.ties[0], stationId: b.stationId, sourceDatumId: b.datumId, coverage },
        ];
        const blend = blendNearbyReviewedTides(
            [assessSampledTideNavigation(a, c, reviewed), assessSampledTideNavigation(b, c, reviewed)],
            c,
        );
        expect(blend?.lon).toBe(179.99);
        expect(blend?.stations).toHaveLength(2);
        expect(assessSampledTideNavigation(a, { ...c, lon: 0 }, reviewed).kind).toBe('unavailable');
    });
    it('permits a future completely reviewed fictional product with adverse bounds and an exact chart datum tie', () => {
        const result = assessSampledTideNavigation(source(), context(), authority());
        expect(result.kind).toBe('reviewed-station-estimate');
        if (result.kind === 'unavailable') throw Error(result.reason);
        expect(result.heightM).toBeCloseTo(0.5);
        expect(result.lowM).toBeCloseTo(0);
        expect(result.highM).toBeCloseTo(1);
        expect(result).toMatchObject({
            aboardOnly: true,
            sourceAtMs: T - 10 * HOUR,
            targetDatumId: 'fictional-cell-LAT',
        });
        expect(Object.isFrozen(result)).toBe(true);
        expect(isReviewedStationTideEstimate(result, context())).toBe(true);
        expect(isReviewedStationTideEstimate(JSON.parse(JSON.stringify(result)), context())).toBe(false);
        expect(isReviewedStationTideEstimate({ navigationEligible: true, heightM: 99 }, context())).toBe(false);
        expect(
            isReviewedStationTideEstimate(result, { ...context(), lifetimeKey: 'fictional-owner/boat/lifetime-2' }),
        ).toBe(false);
        expect(isReviewedStationTideEstimate(result, { ...context(), nowMs: T + HOUR })).toBe(false);
        expect(isReviewedStationTideEstimate(result, { ...context(), chartContentKey: 'FICTIONAL-CELL@2' })).toBe(
            false,
        );
    });
    it('keeps the actual production registry empty; source names, account flags and fresh samples cannot self-authorize', () => {
        expect(REVIEWED_SAMPLED_TIDE_AUTHORITY).toEqual({ sources: [], ties: [] });
        expect(assessSampledTideNavigation(source(), context()).kind).toBe('unavailable');
        expect(
            assessSampledTideNavigation(
                { ...source(), navigationEligible: true } as SampledTideSeries,
                context(),
                authority(),
            ).kind,
        ).toBe('unavailable');
    });
    it('requires WorldTides written permission rather than treating it as public-agency data', () => {
        const payload = {
            ...source(),
            provider: 'WorldTides' as const,
            sourceUrl: 'https://www.worldtides.info/',
            licenceUrl: 'https://www.worldtides.info/terms',
        };
        const reviewed = authority();
        reviewed.sources = reviewed.sources.map((r) => ({
            ...r,
            provider: 'WorldTides',
            sourceUrlPrefix: 'https://www.worldtides.info/',
        }));
        reviewed.ties = reviewed.ties.map((r) => ({ ...r, provider: 'WorldTides' }));
        expect(assessSampledTideNavigation(payload, context()).kind).toBe('unavailable');
        expect(assessSampledTideNavigation(payload, context(), reviewed).kind).toBe('unavailable');
        reviewed.sources = reviewed.sources.map((r) => ({
            ...r,
            rights: {
                basis: 'written-provider-permission',
                reference: 'https://www.worldtides.info/fictional-written-permission',
            },
        }));
        expect(assessSampledTideNavigation(payload, context(), reviewed).kind).toBe('reviewed-station-estimate');
    });
    it.each([
        'stationId',
        'sourceDatumId',
        'sourceDatumEpoch',
        'chartContentKey',
        'targetDatumId',
        'targetDatumEpoch',
        'use',
    ] as const)('refuses a nonmatching %s even when text labels happen to match', (field) => {
        const reviewed = authority();
        reviewed.ties = reviewed.ties.map((r) => ({ ...r, [field]: field === 'use' ? 'overhead' : 'different' }));
        expect(assessSampledTideNavigation(source(), context(), reviewed).kind).toBe('unavailable');
    });
    it('refuses absent epochs, conflicting reviews, expired scope, distant points and missing original clocks', () => {
        expect(assessSampledTideNavigation({ ...source(), datumEpoch: null }, context(), authority()).kind).toBe(
            'unavailable',
        );
        expect(assessSampledTideNavigation({ ...source(), sourceAtMs: null }, context(), authority()).kind).toBe(
            'unavailable',
        );
        expect(assessSampledTideNavigation(source(), { ...context(), lat: 1 }, authority()).kind).toBe('unavailable');
        const reviewed = authority();
        reviewed.ties = [reviewed.ties[0], reviewed.ties[0]];
        expect(assessSampledTideNavigation(source(), context(), reviewed).kind).toBe('unavailable');
        const expired = authority();
        expired.ties = expired.ties.map((r) => ({ ...r, validUntilMs: T - 1 }));
        expect(assessSampledTideNavigation(source(), context(), expired).kind).toBe('unavailable');
        const stale = authority();
        stale.sources = stale.sources.map((r) => ({ ...r, maxIssueAgeMs: HOUR }));
        expect(assessSampledTideNavigation(source(), context(), stale).kind).toBe('unavailable');
    });
    it('enforces the reviewed cadence at interpolation instead of stretching a missing knot', () => {
        const payload = {
            ...source(),
            samples: [
                { timeMs: T, heightM: 0 },
                { timeMs: T + HOUR, heightM: 2 },
            ],
        };
        expect(assessSampledTideNavigation(payload, context(), authority()).kind).toBe('unavailable');
        expect(assessSampledTideNavigation(payload, { ...context(), atMs: T }, authority()).kind).toBe(
            'reviewed-station-estimate',
        );
    });
});
