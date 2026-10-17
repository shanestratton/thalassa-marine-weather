import { describe, expect, it } from 'vitest';
import {
    distanceToReplayLine,
    replayLeg,
    replayEngineConfig,
    replayWindField,
    validateReplayLeg,
    type ReplayLeg,
} from '../services/routing/replayBenchmark';
const polar = {
    angles: [40, 180],
    windSpeeds: [5, 25],
    matrix: [
        [3, 6],
        [4, 7],
    ],
};
const leg = (): ReplayLeg => ({
    track: [
        { lat: 0, lon: 179.5, at: '2026-01-01T00:00:00Z', mode: 'sail' },
        { lat: 0, lon: -179.5, at: '2026-01-01T06:00:00Z' },
    ],
    weather: {
        source: 'synthetic',
        model: 'synthetic-only',
        issuedAt: '2025-12-31T18:00:00Z',
        artifactSha256: 'a'.repeat(64),
        maxCellDistanceNm: 120,
        maxFrameGapHours: 6,
        frames: [0, 6].map((h) => ({
            at: `2026-01-01T0${h}:00:00Z`,
            cells: [{ lat: 0, lon: 180, speedKn: 12, fromDeg: h === 0 ? 350 : 10 }],
        })),
    },
    polars: (['generic', 'database-scaled', 'chosen'] as const).map((kind) => ({ kind, label: kind, data: polar })),
});
describe('offline passage replay', () => {
    it('keeps recorded engine-off evidence without relabelling it as sailing or filling unknown engine hours', async () => {
        const data = leg();
        data.track[0].mode = 'engine-off';
        const measured = await replayLeg(data, async () => ({ route: data.track, durationHours: 7, motorHours: 0 }));
        expect(measured.actualMotorHours).toBe(0);
        expect(measured.unknownPropulsionHours).toBe(0);
        data.track[0].mode = 'unknown';
        const unknown = await replayLeg(data, async () => ({ route: data.track, durationHours: 7, motorHours: 0 }));
        expect(unknown.actualMotorHours).toBeNull();
        expect(unknown.unknownPropulsionHours).toBe(6);
        expect(unknown.variants[0].metrics?.motorErrorHours).toBeNull();
    });
    it('can replay the planner step and vessel motor policy without changing the default baseline', () => {
        expect(replayEngineConfig()).toEqual({ minWindSpeed: 4, motoringSpeed: 5, timeStepHours: 6 });
        expect(replayEngineConfig({ motoringSpeed: 6.5, timeStepHours: 1 })).toEqual({
            minWindSpeed: 4,
            motoringSpeed: 6.5,
            timeStepHours: 1,
        });
        for (const bad of [
            { timeStepHours: 0 },
            { timeStepHours: 0.01 },
            { timeStepHours: 7 },
            { motoringSpeed: NaN },
            { minWindSpeed: -1 },
        ])
            expect(() => replayEngineConfig(bad)).toThrow(/Invalid replay/);
    });
    it('measures each separate polar with signed ETA error and dateline-safe track distance', async () => {
        const data = leg();
        const result = await replayLeg(data, async ({ wind }) => {
            expect(wind.getWind(0, 180, 3)?.direction).toBeCloseTo(0);
            return { route: data.track, durationHours: 7, motorHours: 0 };
        });
        expect(result.synthetic).toBe(true);
        expect(result.variants).toHaveLength(3);
        expect(result.variants[0].metrics).toMatchObject({
            etaErrorHours: 1,
            maxTrackDivergenceNm: 0,
            motorErrorHours: 0,
        });
        expect(JSON.stringify(result)).not.toMatch(/179\.5|2026-01-01|latitude|longitude/);
    });
    it('refuses future-issued weather, unordered tracks and missing polar variants', () => {
        const data = leg();
        data.weather.issuedAt = '2026-01-01T01:00:00Z';
        expect(() => validateReplayLeg(data)).toThrow(/issued by departure/);
        const reversed = leg();
        reversed.track.reverse();
        expect(() => validateReplayLeg(reversed)).toThrow(/ordered/);
        const incomplete = leg();
        incomplete.polars.pop();
        expect(() => validateReplayLeg(incomplete)).toThrow(/snapshots/);
    });
    it('keeps a missing nearest cell unknown, rather than borrowing a distant value', () => {
        const weather = leg().weather;
        weather.frames.forEach((f) => f.cells.push({ lat: 0, lon: 179.5, speedKn: null, fromDeg: null }));
        const wind = replayWindField(weather, leg().track[0].at);
        expect(wind.getWind(0, 179.5, 3)).toBeNull();
        expect(wind.missingQueries()).toBe(1);
    });
    it('marks incomplete forecasts unmeasured even if the router falls back to motoring', async () => {
        const data = leg();
        const result = await replayLeg(data, async ({ wind }) => {
            wind.getWind(20, 150, 3);
            return { route: data.track, durationHours: 6, motorHours: 6 };
        });
        expect(result.variants.every((v) => v.status === 'incomplete-forecast' && v.metrics === null)).toBe(true);
    });
    it('does not extend forecast times or interpolate across excessive gaps', () => {
        const data = leg(),
            wind = replayWindField(data.weather, data.track[0].at);
        expect(wind.getWind(0, 180, -1)).toBeNull();
        expect(wind.getWind(0, 180, 7)).toBeNull();
        data.weather.maxFrameGapHours = 3;
        expect(replayWindField(data.weather, data.track[0].at).getWind(0, 180, 3)).toBeNull();
    });
    it('leaves motor error unknown without explicit recorded propulsion', async () => {
        const data = leg();
        delete data.track[0].mode;
        const result = await replayLeg(data, async () => ({ route: data.track, durationHours: 6, motorHours: 1 }));
        expect(result.actualMotorHours).toBeNull();
        expect(result.unknownPropulsionHours).toBe(6);
        expect(result.variants[0].metrics?.motorErrorHours).toBeNull();
    });
    it('measures distance to segments and their ends, without a false dateline detour', () => {
        expect(distanceToReplayLine({ lat: 0, lon: 180 }, leg().track)).toBeCloseTo(0);
        expect(distanceToReplayLine({ lat: 1, lon: 180 }, leg().track)).toBeCloseTo(60.04, 1);
        expect(distanceToReplayLine({ lat: 0, lon: 179 }, leg().track)).toBeCloseTo(30.02, 1);
    });
    it('does not replace a failed router with a fabricated route', async () => {
        const result = await replayLeg(leg(), async () => null);
        expect(result.variants.every((v) => v.status === 'no-valid-route' && v.metrics === null)).toBe(true);
    });
});
