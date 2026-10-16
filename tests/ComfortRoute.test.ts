import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IsochroneConfig, IsochroneResult, WaveField, ExclusionField } from '../services/isochrone/types';
const mocked = vi.hoisted(() => ({ compute: vi.fn() }));
vi.mock('../services/IsochroneRouter', () => ({ computeIsochrones: mocked.compute }));
import { computeComfortIsochrones } from '../services/routing/comfortRoute';
const polar = { windSpeeds: [5], angles: [90], matrix: [[6]] };
function candidate(): IsochroneResult {
    return {
        route: [
            { lat: 0, lon: 0, timeHours: 0, bearing: 90, speed: 6, tws: 12, twa: 90, parentIndex: null, distance: 0 },
            { lat: 0, lon: 1, timeHours: 10, bearing: 90, speed: 6, tws: 12, twa: 90, parentIndex: 0, distance: 60 },
        ],
        routeCoordinates: [
            [0, 0],
            [1, 0],
        ],
        isochrones: [],
        totalDistanceNM: 60,
        totalDurationHours: 10,
        arrivalTime: '2026-10-17T10:00:00Z',
        shallowFlags: [false, false],
    };
}
const compute = (
    config: Partial<IsochroneConfig>,
    waves: WaveField | null = { getWave: () => ({ heightM: 2.8, periodS: 8, directionFromDeg: 90 }) },
    exclusions: ExclusionField | null = null,
) =>
    computeComfortIsochrones(
        { lat: 0, lon: 0 },
        { lat: 0, lon: 1 },
        '2026-10-17T00:00:00Z',
        polar,
        { getWind: () => ({ speed: 12, direction: 0 }) },
        config,
        null,
        null,
        exclusions,
        waves,
    );
beforeEach(() => {
    vi.clearAllMocks();
    mocked.compute.mockImplementation(async () => candidate());
});
describe('bounded and explicit wave relaxation', () => {
    it('tries +15% only after strict failure, preserving every other limit and naming the encountered seas', async () => {
        mocked.compute.mockResolvedValueOnce(null);
        const result = await compute({
            comfortParams: { maxWaveM: 2.5, maxWindKts: 20, maxGustKts: 30 },
            waveLimitCeilingM: 3,
        });
        expect(mocked.compute).toHaveBeenCalledTimes(2);
        expect(mocked.compute.mock.calls[1][5].comfortParams).toMatchObject({
            maxWaveM: 2.875,
            maxWindKts: 20,
            maxGustKts: 30,
        });
        expect(result!.comfort).toMatchObject({
            maxWaveM: 2.8,
            relaxedFromM: 2.5,
            usedLimitM: 2.875,
            coverage: 'complete',
        });
        expect(result!.comfort!.maxWaveAt).not.toBeNull();
    });
    it('checks the displayed smoothed line, including high seas between engine endpoints', async () => {
        const waves = {
            getWave: (_lat: number, lon: number) => ({
                heightM: lon > 0.4 && lon < 0.6 ? 2.9 : 1,
                periodS: 8,
                directionFromDeg: 90,
            }),
        };
        const result = await compute({ comfortParams: { maxWaveM: 2.5 } }, waves);
        expect(mocked.compute).toHaveBeenCalledTimes(3);
        expect(result!.comfort).toMatchObject({ maxWaveM: 2.9, relaxedFromM: 2.5, usedLimitM: 3.25 });
    });
    it('cannot relax a vessel mechanical ceiling or retry indefinitely', async () => {
        mocked.compute.mockResolvedValue(null);
        expect(await compute({ comfortParams: { maxWaveM: 2.5 }, waveLimitCeilingM: 2.6 })).toBeNull();
        expect(mocked.compute.mock.calls.map((call) => call[5].comfortParams.maxWaveM)).toEqual([2.5, 2.6]);
    });
    it('keeps missing sheltered cells partial and never labels them within-limit', async () => {
        const result = await compute(
            { comfortParams: { maxWaveM: 2.5 } },
            { getWave: (_lat, lon) => (lon < 0.5 ? null : { heightM: 1, periodS: 8, directionFromDeg: 90 }) },
        );
        expect(result!.comfort!.coverage).toBe('partial');
        expect(result!.comfort!.unknownHours).toBeGreaterThan(0);
    });
    it('rejects a smoothed shortcut through a cyclone even when endpoints are outside', async () => {
        const result = await compute({}, null, { isExcluded: (_lat, lon) => lon > 0.4 && lon < 0.6 });
        expect(result).toBeNull();
        expect(mocked.compute).toHaveBeenCalledOnce();
    });
    it('does not start or return a stale operation', async () => {
        expect(await compute({ shouldContinue: () => false })).toBeNull();
        expect(mocked.compute).not.toHaveBeenCalled();
    });
});
