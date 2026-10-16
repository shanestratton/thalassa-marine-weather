import { describe, expect, it } from 'vitest';
import { bridgeClearanceAtSample, type ChartBridgeHeightContext } from '../services/routing/bridgeTideEstimate';
import {
    assessSampledTideNavigation,
    type SampledTideAuthority,
    type TideNavigationContext,
} from '../services/tides/sampledTideNavigation';
import type { SampledTideSeries } from '../services/tides/sampledTideContract';
const T = Date.parse('2026-10-17T06:00:00Z');
const context = (): TideNavigationContext => ({
    lifetimeKey: 'fictional-lifetime',
    lat: 0,
    lon: 0,
    atMs: T,
    nowMs: T,
    chartContentKey: 'FICTIONAL-CELL@1',
    targetDatumId: 'fictional-HAT',
    targetDatumEpoch: 'fictional-height-epoch',
    use: 'overhead',
    protectedChart: true,
});
const source = (): SampledTideSeries => ({
    schema: 1,
    kind: 'sampled-prediction',
    provider: 'NOAA',
    productId: 'fictional-samples',
    stationId: 'fictional-station',
    stationName: 'Entirely fictional station',
    lat: 0,
    lon: 0,
    datumId: 'fictional-MLLW',
    datumLabel: 'Fictional MLLW',
    datumEpoch: 'fictional-station-epoch',
    sourceAtMs: T - 1000,
    receivedAtMs: T,
    expiresAtMs: T + 3600000,
    sourceUrl: 'https://tidesandcurrents.noaa.gov/',
    licenceUrl: 'https://tidesandcurrents.noaa.gov/',
    units: 'm',
    samples: [
        { timeMs: T, heightM: 2 },
        { timeMs: T + 1800000, heightM: 2.5 },
    ],
});
const authority = (): SampledTideAuthority => ({
    sources: [
        {
            reviewId: 'FICTIONAL-SOURCE',
            provider: 'NOAA',
            productId: 'fictional-samples',
            sourceUrlPrefix: 'https://tidesandcurrents.noaa.gov/',
            rights: {
                basis: 'public-agency-navigation-use',
                reference: 'https://tidesandcurrents.noaa.gov/fictional-rights',
            },
            uses: ['overhead'],
            validFromMs: T - 3600000,
            validUntilMs: T + 3600000,
            maxIssueAgeMs: 3600000,
            maxSampleGapMs: 1800000,
            predictionUncertaintyM: 0.2,
        },
    ],
    ties: [
        {
            reviewId: 'FICTIONAL-HEIGHT-TIE',
            provider: 'NOAA',
            productId: 'fictional-samples',
            stationId: 'fictional-station',
            sourceDatumId: 'fictional-MLLW',
            sourceDatumEpoch: 'fictional-station-epoch',
            chartContentKey: 'FICTIONAL-CELL@1',
            targetDatumId: 'fictional-HAT',
            targetDatumEpoch: 'fictional-height-epoch',
            use: 'overhead',
            sourceReference: 'https://tidesandcurrents.noaa.gov/fictional-height-tie',
            validFromMs: T - 3600000,
            validUntilMs: T + 3600000,
            coverage: [[-0.01, -0.01, 0.01, 0.01]],
            maxDistanceKm: 1,
            offsetM: -3,
            uncertaintyM: 0.1,
        },
    ],
});
const bridge = (): ChartBridgeHeightContext => ({
    featureKey: 'FICTIONAL-FEATURE',
    chartContentKey: 'FICTIONAL-CELL@1',
    heightDatumId: 'fictional-HAT',
    heightDatumEpoch: 'fictional-height-epoch',
    estimated: false,
    properties: { CATBRG: 1, VERCLR: 20 },
});
const water = (heightM = 2) =>
    assessSampledTideNavigation(
        { ...source(), samples: source().samples.map((p) => ({ ...p, heightM })) },
        context(),
        authority(),
    );
describe('instant overhead tide estimate with an independent height tie', () => {
    it('uses high water plus uncertainty adversely, keeps the 1m margin and never asserts an opening', () => {
        const result = bridgeClearanceAtSample(bridge(), 18, water(), context());
        expect(result.kind).toBe('instant-estimate');
        if (result.kind === 'unknown') throw Error(result.reason);
        expect(result.clearanceM).toBeCloseTo(20.7);
        expect(result.reserveAboveMarginM).toBeCloseTo(1.7);
        expect(result).toMatchObject({ aboveMargin: true, openingPermission: 'unknown', aboardOnly: true });
        const higher = bridgeClearanceAtSample(bridge(), 18, water(5), context());
        expect(higher).toMatchObject({ aboveMargin: false, openingPermission: 'unknown' });
    });
    it('refuses a sounding-plane result, unknown/default rights, expired lifetime and changed chart content', () => {
        expect(bridgeClearanceAtSample(bridge(), 18, water(), { ...context(), use: 'sounding' }).kind).toBe('unknown');
        expect(
            bridgeClearanceAtSample(bridge(), 18, assessSampledTideNavigation(source(), context()), context()).kind,
        ).toBe('unknown');
        expect(bridgeClearanceAtSample(bridge(), 18, water(), { ...context(), lifetimeKey: 'changed' }).kind).toBe(
            'unknown',
        );
        expect(bridgeClearanceAtSample(bridge(), 18, water(), { ...context(), nowMs: T + 3600000 }).kind).toBe(
            'unknown',
        );
        expect(bridgeClearanceAtSample({ ...bridge(), chartContentKey: 'changed' }, 18, water(), context()).kind).toBe(
            'unknown',
        );
    });
    it('keeps open-only clearance and estimated Australian references unknown, even with a valid sampled height', () => {
        expect(
            bridgeClearanceAtSample(
                { ...bridge(), properties: { CATBRG: 3, VERCLR: 100, VERCOP: 100 } },
                18,
                water(),
                context(),
            ).kind,
        ).toBe('unknown');
        expect(bridgeClearanceAtSample({ ...bridge(), estimated: true }, 18, water(), context()).kind).toBe('unknown');
        expect(bridgeClearanceAtSample(bridge(), null, water(), context()).kind).toBe('unknown');
        expect(
            bridgeClearanceAtSample({ ...bridge(), heightDatumEpoch: 'different' }, 18, water(), context()).kind,
        ).toBe('unknown');
        const opening = bridgeClearanceAtSample(
            { ...bridge(), properties: { CATBRG: 3, VERCCL: 15, VERCOP: 100 } },
            18,
            water(),
            context(),
        );
        expect(opening).toMatchObject({
            kind: 'instant-estimate',
            openingBridge: true,
            aboveMargin: false,
            openingPermission: 'unknown',
        });
    });
});
