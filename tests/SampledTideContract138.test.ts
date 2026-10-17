import { describe, expect, it } from 'vitest';
import {
    parseSampledTideSeries,
    sampleStationPrediction,
    type SampledTideSeries,
} from '../services/tides/sampledTideContract';
const T = Date.parse('2026-10-17T06:00:00Z'),
    HOUR = 3600000;
const fixture = (): SampledTideSeries => ({
    schema: 1,
    kind: 'sampled-prediction',
    provider: 'NOAA',
    productId: 'fictional-dense-product',
    stationId: 'fictional-station',
    stationName: 'Entirely fictional station',
    lat: 0,
    lon: 0,
    datumId: 'fixture:station-local-MLLW',
    datumLabel: 'Fictional station MLLW',
    datumEpoch: 'fictional-epoch',
    sourceAtMs: T - 10 * HOUR,
    receivedAtMs: T,
    expiresAtMs: T + HOUR,
    sourceUrl: 'https://tidesandcurrents.noaa.gov/',
    licenceUrl: 'https://tidesandcurrents.noaa.gov/',
    units: 'm',
    samples: [
        { timeMs: T, heightM: -0.3 },
        { timeMs: T + HOUR / 2, heightM: 1.1 },
        { timeMs: T + HOUR, heightM: 0.4 },
    ],
});
describe('original sampled tide source contract', () => {
    it('preserves signed station heights, original clocks and exact knot versus interpolation status', () => {
        const source = fixture(),
            actual = parseSampledTideSeries(source, T)!;
        expect(sampleStationPrediction(actual, T, T)).toMatchObject({
            heightM: -0.3,
            interpolated: false,
            sourceAtMs: T - 10 * HOUR,
            navigationEligible: false,
        });
        expect(sampleStationPrediction(actual, T + HOUR / 4, T)?.heightM).toBeCloseTo(0.4);
        expect(sampleStationPrediction(actual, T + HOUR / 4, T)?.interpolated).toBe(true);
        expect(sampleStationPrediction(actual, T + HOUR, T)?.heightM).toBe(0.4);
        source.samples[0].heightM = 99;
        expect(actual.samples[0].heightM).toBe(-0.3);
    });
    it('rejects official extrema/observations and a disguised extrema extension rather than inventing samples', () => {
        expect(
            parseSampledTideSeries(
                { schema: 1, events: [{ time: new Date(T).toISOString(), type: 'High', heightM: 2 }] },
                T,
            ),
        ).toBeNull();
        expect(parseSampledTideSeries({ ...fixture(), kind: 'extrema' }, T)).toBeNull();
        expect(parseSampledTideSeries({ ...fixture(), extremes: [] }, T)).toBeNull();
        expect(
            parseSampledTideSeries(
                { ...fixture(), samples: fixture().samples.map((p) => ({ ...p, type: 'High' })) },
                T,
            ),
        ).toBeNull();
    });
    it('keeps an unknown issue clock unknown; receiving a prediction does not renew it or grant navigation use', () => {
        const source = { ...fixture(), sourceAtMs: null };
        expect(sampleStationPrediction(source, T, T)?.sourceAtMs).toBeNull();
    });
    it.each([null, '', false, NaN, Infinity])('keeps a missing or invalid height %j unknown', (heightM) => {
        expect(
            parseSampledTideSeries(
                {
                    ...fixture(),
                    samples: [
                        { timeMs: T, heightM },
                        { timeMs: T + HOUR, heightM: 1 },
                    ],
                },
                T,
            ),
        ).toBeNull();
    });
    it('refuses duplicate/unordered knots, incorrect units, oversized inventories and unreviewed metadata', () => {
        const source = fixture();
        expect(parseSampledTideSeries({ ...source, samples: [source.samples[0], source.samples[0]] }, T)).toBeNull();
        expect(parseSampledTideSeries({ ...source, samples: [...source.samples].reverse() }, T)).toBeNull();
        expect(parseSampledTideSeries({ ...source, units: 'ft' }, T)).toBeNull();
        expect(
            parseSampledTideSeries(
                { ...source, samples: Array.from({ length: 674 }, (_, i) => ({ timeMs: T + i, heightM: 1 })) },
                T,
            ),
        ).toBeNull();
        expect(parseSampledTideSeries({ ...source, navigationEligible: true }, T)).toBeNull();
        expect(
            parseSampledTideSeries({ ...source, sourceUrl: 'https://tidesandcurrents.noaa.gov/?key=do-not-retain' }, T),
        ).toBeNull();
        expect(parseSampledTideSeries({ ...source, sourceUrl: 'https://www.worldtides.info/' }, T)).toBeNull();
    });
    it('never borrows endpoints, fills an absent original interval or uses expired data', () => {
        expect(sampleStationPrediction(fixture(), T - 1, T)).toBeNull();
        expect(sampleStationPrediction(fixture(), T + HOUR + 1, T)).toBeNull();
        const gap = {
            ...fixture(),
            samples: [
                { timeMs: T, heightM: 0 },
                { timeMs: T + 2 * HOUR, heightM: 2 },
            ],
        };
        expect(sampleStationPrediction(gap, T + HOUR, T)).toBeNull();
        expect(sampleStationPrediction(gap, T, T)?.heightM).toBe(0);
        expect(sampleStationPrediction(fixture(), T, T + HOUR)).toBeNull();
        expect(parseSampledTideSeries({ ...fixture(), sourceAtMs: T + HOUR }, T)).toBeNull();
        expect(parseSampledTideSeries({ ...fixture(), receivedAtMs: T + HOUR }, T)).toBeNull();
    });
});
