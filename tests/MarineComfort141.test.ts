import { describe, expect, it } from 'vitest';
import { admittedComfortMarine, comfortForMarine } from '../utils/marineComfort';
import { partitionTimeline } from '../utils/partitionTimeline';
import { qualifyComfortPreference } from '../services/comfort/qualifyPreference';
import { inspectRouteEnvironment } from '../services/isochrone/routeComfort';
import type { HourlyForecast, MarineModelSnapshot } from '../types/weather';
const now = Date.parse('2026-10-17T05:00:00Z'),
    profile = { type: 'sail' as const, length: 40, revision: 1 };
const part = { hM: 1, periodS: 8, fromDeg: 90 };
const marine: MarineModelSnapshot = {
    status: 'available',
    reason: null,
    waveModel: 'meteofrance_wave',
    motionModel: 'best_match',
    fetchedAtMs: now,
    waveValidAtMs: now,
    motionValidAtMs: now,
    requested: { latitude: 0, longitude: 0 },
    parts: { total: part, windSea: null, swell: null, secondarySwell: null },
};
const hour = (n: number): HourlyForecast => ({
    time: new Date(now + n * 3600000).toISOString(),
    temperature: 22,
    condition: 'Cloudy',
    windSpeed: 12,
    waveHeight: 1 / 0.3048,
    marine: {
        ...marine,
        waveValidAtMs: now + n * 3600000,
        parts: { total: { ...part, hM: 1 + n / 10 }, windSea: { ...part, hM: 0.2 }, swell: part, secondarySwell: null },
    },
});
describe('source-clock bounded marine comfort and partition timeline', () => {
    it('keeps original units, current clock and receipt age independent', () => {
        expect(comfortForMarine(marine, profile, null, true, now)?.word).toBe('Lively');
        expect(admittedComfortMarine({ ...marine, fetchedAtMs: now - 3600001 }, false, now)).toBeNull();
        expect(admittedComfortMarine({ ...marine, waveValidAtMs: now - 1800001 }, true, now)).toBeNull();
        expect(admittedComfortMarine({ ...marine, waveValidAtMs: now + 3600000 }, true, now)).toBeNull();
        expect(admittedComfortMarine({ ...marine, waveValidAtMs: now + 3600000 }, false, now)).not.toBeNull();
    });
    it('refuses malformed partitions, missing point and enclosed water without a false calm word', () => {
        for (const value of [
            { ...marine, status: 'enclosed' },
            { ...marine, requested: null },
            { ...marine, parts: {} },
            { ...marine, parts: { ...marine.parts, total: { ...part, hM: '1' } } },
            { ...marine, parts: { ...marine.parts, total: { ...part, fromDeg: NaN } } },
        ])
            expect(comfortForMarine(value as unknown as MarineModelSnapshot, profile, null, true, now)).toBeNull();
    });
    it('draws each exact-cohort partition independently and breaks missing hours', () => {
        const chart = partitionTimeline([hour(0), hour(1), hour(3)], marine, now)!;
        expect(chart.paths).toHaveLength(4);
        expect(chart.paths[0].path.match(/M/g)).toHaveLength(2);
        expect(chart.paths[0].path.match(/L/g)).toHaveLength(1);
        expect(chart.paths[3].path).toBe('');
        expect(chart.maximum).toBe(1.3);
        const foreign = hour(1);
        foreign.marine = { ...foreign.marine!, fetchedAtMs: now - 1 };
        expect(partitionTimeline([hour(0), foreign, hour(2)], marine, now)?.paths[0].path.match(/M/g)).toHaveLength(2);
    });
    it('refuses duplicate/nonmonotonic clocks or an oversized timeline', () => {
        expect(partitionTimeline([hour(1), hour(0)], marine, now)).toBeNull();
        expect(partitionTimeline([hour(0), hour(0)], marine, now)).toBeNull();
        expect(
            partitionTimeline(
                Array.from({ length: 241 }, (_, n) => hour(n)),
                marine,
                now,
            ),
        ).toBeNull();
    });
    it('personal preference cannot relax a configured hard wave ceiling in a departure check', () => {
        const preference = qualifyComfortPreference(
            profile,
            Array.from({ length: 6 }, (_, n) => ({
                qualified: true,
                operation: `fixture${n}`,
                voyageId: `v${n % 3}`,
                capturedAt: new Date(now).toISOString(),
                fetchedAt: new Date(now).toISOString(),
                validAt: new Date(now).toISOString(),
                level: 0,
                parts: marine.parts,
            })),
        );
        const route = [
            { lat: 0, lon: 0, timeHours: 0, bearing: 90, speed: 6, tws: 12, twa: 90, parentIndex: null, distance: 0 },
            { lat: 0, lon: 0.1, timeHours: 1, bearing: 90, speed: 6, tws: 12, twa: 90, parentIndex: 0, distance: 6 },
        ];
        const result = inspectRouteEnvironment(
            route,
            { getWave: () => ({ heightM: 3, periodS: 8, directionFromDeg: 90 }) },
            null,
            2.5,
            profile,
            preference,
        );
        expect(result.rejected).toBe(true);
        expect(result.comfort.level).toBeGreaterThanOrEqual(2);
    });
});
