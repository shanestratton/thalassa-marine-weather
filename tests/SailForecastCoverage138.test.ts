import { describe, expect, it } from 'vitest';
import { sampleCoveredRouteWind, sampleRouteForecast, type RouteForecast } from '../services/routeForecastSampler';
const epoch = Date.parse('2026-10-17T12:00:00Z');
const fixture = (): RouteForecast => ({
    model: 'fixture-global',
    fetchedAt: epoch,
    totalNm: 10,
    stations: [0, 10].map((alongNm) => ({
        alongNm,
        lat: 0,
        lon: alongNm / 60,
        timesMs: [epoch, epoch + 3_600_000],
        speedKts: [10, 20],
        dirDeg: [0, 90],
        gustKts: [15, 25],
        precipMm: [0, 0],
        precipProb: [0, 0],
    })),
});
describe('strict covered sail-plan wind', () => {
    it('retains the display sampler while refusing its time and distance edge clamps for advice', () => {
        expect(sampleRouteForecast(fixture(), 0, epoch - 1000).twsKts).toBe(10);
        expect(sampleCoveredRouteWind(fixture(), 0, epoch - 1000)).toBeNull();
        expect(sampleCoveredRouteWind(fixture(), -0.01, epoch)).toBeNull();
        expect(sampleCoveredRouteWind(fixture(), 10.01, epoch)).toBeNull();
        expect(sampleCoveredRouteWind(fixture(), 10, epoch + 3_600_000)?.twsKts).toBe(20);
    });
    it('requires all participating space/time samples, and does not substitute the nearer station', () => {
        const input = fixture();
        input.stations[1].speedKts[1] = null;
        expect(sampleCoveredRouteWind(input, 5, epoch + 1_800_000)).toBeNull();
        expect(sampleCoveredRouteWind(input, 0, epoch)?.twsKts).toBe(10);
    });
    it('preserves missing gusts rather than borrowing a neighbouring forecast value', () => {
        const input = fixture();
        input.stations[1].gustKts[1] = null;
        expect(sampleCoveredRouteWind(input, 5, epoch + 1_800_000)?.gustKts).toBeNull();
        expect(sampleCoveredRouteWind(input, 5, epoch + 1_800_000)?.twsKts).toBe(15);
    });
    it('keeps finite zero wind and rejects missing or nonfinite direction', () => {
        const input = fixture();
        input.stations[0].speedKts[0] = 0;
        expect(sampleCoveredRouteWind(input, 0, epoch)?.twsKts).toBe(0);
        input.stations[0].dirDeg[0] = NaN;
        expect(sampleCoveredRouteWind(input, 0, epoch)).toBeNull();
    });
});
