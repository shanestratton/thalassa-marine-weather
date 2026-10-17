// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { aromeStaticFixture } from './fixtures/aromeStatic142';
import { AROME_TEST_RUN as run } from './fixtures/arome142';
import { aromePointFromTile } from '../services/weather/aromeStaticContract';
import { aromeContext, aromeReport } from '../services/weather/aromeReport';

describe('142 optional RH display unavailable, unchanged actual consumer', () => {
    it('preserves the nearest original sea cell and each gap through tile, point and report', async () => {
        const gaps = new Set([6, 7, 8, 11]);
        const f = await aromeStaticFixture({
            mask: (i, j) => (j === 240 && (i === 300 || i === 301) ? 0 : 1),
            sample: (field, hour, i, j) =>
                field === 0
                    ? 5
                    : field === 1
                      ? -2
                      : field === 2
                        ? 101234.5
                        : field === 3
                          ? 290
                          : i === 300 && j === 240
                            ? gaps.has(hour)
                                ? Number.NaN
                                : hour === 9
                                  ? 100
                                  : hour === 10
                                    ? 0
                                    : 75
                            : 99,
        });
        const original = f.raw.slice();
        const point = aromePointFromTile(f.raw, f.manifest, f.slot, f.tile, f.point, run)!;
        expect(point.seaCell).toMatchObject({ i: 300, j: 240 });
        expect(point.hourly.relative_humidity_2m).toEqual(
            Array.from({ length: 49 }, (_, hour) => (gaps.has(hour) ? null : hour === 9 ? 100 : hour === 10 ? 0 : 75)),
        );
        const now = run + 3600_000;
        const base = aromeContext(f.point, 'Fictional original sea cell', 'coastal', now);
        const supplement = structuredClone(base);
        supplement.current.humidity = 88;
        supplement.hourly = point.hourly.time.map((time) => ({
            time: new Date(time * 1000).toISOString(),
            temperature: 90,
            windSpeed: 99,
            humidity: 88,
        }));
        const report = aromeReport(base, point, f.point, now, supplement)!;
        expect(report).not.toBeNull();
        expect(report.hourly).toHaveLength(49);
        for (const hour of gaps) {
            expect(report.hourly[hour]).toMatchObject({
                humidity: null,
                pressure: 1012.345,
                temperature: 290 - 273.15,
                windSpeed: Math.hypot(5, -2) / 0.5144444444444445,
            });
        }
        expect(report.hourly[9].humidity).toBe(100);
        expect(report.hourly[10].humidity).toBe(0);
        expect(report.forecastRunAt).toBe(point.runUtc);
        expect(report.regionalAtmosphere).toMatchObject({ latitude: -20, longitude: 166 });
        expect(f.raw).toEqual(original);
    });

    it('allows entirely unavailable optional RH while retaining independent wind, temperature and pressure', async () => {
        const f = await aromeStaticFixture({
            sample: (field) => [5, -2, 101234.5, 290, Number.NaN][field],
        });
        const point = aromePointFromTile(f.raw, f.manifest, f.slot, f.tile, f.point, run)!;
        expect(point.hourly.relative_humidity_2m).toEqual(Array(49).fill(null));
        const now = run + 3600_000;
        const report = aromeReport(aromeContext(f.point, 'Fictional cell', 'coastal', now), point, f.point, now)!;
        expect(report).not.toBeNull();
        expect(report.current.humidity).toBeNull();
        expect(report.hourly.every((hour) => hour.humidity === null)).toBe(true);
        expect(report.hourly.every((hour) => hour.temperature === 290 - 273.15 && hour.pressure === 1012.345)).toBe(
            true,
        );
        expect(report.hourly[0].time).toBe('2026-10-17T00:00:00.000Z');
        expect(report.hourly.at(-1)?.time).toBe('2026-10-19T00:00:00.000Z');
    });

    it.each([100 + Number.EPSILON * 100, 150, 1e6, -1, Infinity])(
        'still refuses unqualified numeric RH %s at the consumer boundary',
        async (value) => {
            const f = await aromeStaticFixture({
                sample: (field) => [5, -2, 101234.5, 290, value][field],
            });
            expect(aromePointFromTile(f.raw, f.manifest, f.slot, f.tile, f.point, run)).toBeNull();
        },
    );
});
