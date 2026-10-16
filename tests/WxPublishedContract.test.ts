import { describe, expect, it } from 'vitest';
import {
    projectCoarseForecast,
    publishedRawModel,
    publishedStorageModel,
} from '../services/weather/wxPublishedContract';
import { utcMarineLookup } from '../services/weather/wxMarineAlignment';
import { marineFixture, wxFixture } from './fixtures/wxPublishedFixture';
const NOW = Date.parse('2026-10-16T12:30:00Z');
function project(fixture = wxFixture(), now = NOW) {
    return projectCoarseForecast(
        fixture.payload,
        fixture.payload.thalassa_provenance.model,
        -27.2,
        153.1,
        fixture.runAt,
        now,
    );
}
describe('retained wx runs are selected by current valid time', () => {
    it('uses the current forecast hour after six hours, not the stored current snapshot', () => {
        const result = project();
        expect(result?.current).toMatchObject({
            wind_speed_10m: 22,
            wind_direction_10m: 90,
            temperature_2m: 20,
            wind_gusts_10m: null,
            rain: null,
            apparent_temperature: null,
        });
        expect(wxFixture().payload.current.wind_speed_10m).toBe(200);
    });
    it('trims hourly and daily axes together at midnight without changing source age', () => {
        const input = wxFixture(),
            result = project(input, Date.parse('2026-10-17T00:30:00Z'));
        expect((result?.hourly as Record<string, unknown[]>).time[0]).toBe('2026-10-17T00:00:00.000Z');
        expect((result?.daily as Record<string, unknown[]>).time[0]).toBe('2026-10-17');
        expect(result?.current).toMatchObject({ wind_speed_10m: 34 });
        expect(result?.thalassa_provenance).toEqual(input.payload.thalassa_provenance);
        expect(input.payload.hourly.time).toHaveLength(72);
    });
    it('retains genuine calm zero and unavailable null values', () => {
        const input = wxFixture();
        input.payload.hourly.wind_speed_10m[12] = 0;
        expect(project(input)?.current).toMatchObject({ wind_speed_10m: 0, wind_gusts_10m: null });
    });
    it('compares real run instants across PostgREST +00:00 and provenance Z spellings', () => {
        const input = wxFixture();
        input.runAt = input.runAt.replace('Z', '+00:00');
        expect(project(input)?.current).toMatchObject({ wind_speed_10m: 22 });
    });
    it.each(['ecmwf_ifs', 'meteofrance_arome_france_hd', 'wx2:dwd_icon', 'unknown'])(
        'does not upgrade coarse data to %s',
        (model) => {
            const input = wxFixture();
            expect(projectCoarseForecast(input.payload, model, -27.2, 153.1, input.runAt, NOW)).toBeNull();
        },
    );
    it.each([
        'model',
        'cell',
        'source',
        'run',
        'domain',
        'oldest',
        'future',
        'stale',
        'short-horizon',
        'units',
        'naive',
        'duplicate',
        'missing-hour',
        'null-wind',
        'daily-string',
        'daily-gap',
        'daily-units',
        'extra-field',
    ])('falls back for invalid %s evidence', (kind) => {
        const input = wxFixture(),
            p = input.payload.thalassa_provenance;
        if (kind === 'model') p.model = 'ecmwf_ifs025';
        if (kind === 'cell') p.cell_id = '-2750_15300';
        if (kind === 'source') p.source = 'other';
        if (kind === 'run') p.run_at = '2026-10-16T03:00:00Z';
        if (kind === 'domain') p.source_domains = ['ncep_gfs025'];
        if (kind === 'oldest') p.source_runs[0].run_at = '2026-10-16T03:00:00Z';
        if (kind === 'future') input.runAt = p.run_at = p.source_runs[0].run_at = '2026-10-16T15:00:00Z';
        if (kind === 'stale') input.runAt = p.run_at = p.source_runs[0].run_at = '2026-10-15T09:00:00Z';
        if (kind === 'short-horizon') p.source_runs[0].data_end_at = '2026-10-16T18:00:00Z';
        if (kind === 'units') input.payload.hourly_units.wind_speed_10m = 'kn';
        if (kind === 'naive') input.payload.hourly.time[0] = '2026-10-16T00:00';
        if (kind === 'duplicate') input.payload.hourly.time[1] = input.payload.hourly.time[0];
        if (kind === 'missing-hour') input.payload.hourly.time.splice(12, 1);
        if (kind === 'null-wind') input.payload.hourly.wind_speed_10m[12] = null;
        if (kind === 'daily-string') input.payload.daily.temperature_2m_max[0] = '26';
        if (kind === 'daily-gap') input.payload.daily.time[1] = '2026-10-19';
        if (kind === 'daily-units') input.payload.daily_units.temperature_2m_max = '°F';
        if (kind === 'extra-field') input.payload.hourly.unknown = Array(72).fill(1);
        expect(project(input)).toBeNull();
    });
    it.each([
        ['wind_speed_10m', -1],
        ['wind_direction_10m', 361],
        ['relative_humidity_2m', 101],
        ['cloud_cover', -1],
        ['pressure_msl', 101325],
        ['temperature_2m', 150],
        ['wind_gusts_10m', ''],
        ['cape', -99.9],
    ])('rejects invalid %s optional/core readings', (field, value) => {
        const input = wxFixture();
        input.payload.hourly[String(field)][12] = value;
        expect(project(input)).toBeNull();
    });
    it('recognises only wx2 global aliases and the existing Spitfire marker', () => {
        expect(publishedStorageModel('dwd_icon')).toBe('wx2:dwd_icon');
        expect(publishedRawModel('wx2:dwd_icon')).toBe('dwd_icon');
        expect(publishedStorageModel('ecmwf_ifs')).toBe('ecmwf_ifs');
        for (const model of ['unknown', 'wx2:ecmwf_ifs', 'wx3:dwd_icon', 'dwd_icon'])
            expect(publishedRawModel(model)).toBeNull();
        expect(publishedRawModel('spitfire')).toBe('spitfire');
    });
});
describe('UTC marine alignment', () => {
    it('joins by valid hour even when an older cached marine axis has a different start', () => {
        const marine = utcMarineLookup(marineFixture('2026-10-16T12:00:00Z'));
        expect(marine.at('2026-10-17T00:00:00Z')?.wave_height).toBe(1.12);
        expect(marine.maximumForDay('2026-10-17')).toBeCloseTo(1.35);
    });
    it('withholds unknown timezone/units and incomplete-day maxima, keeping real calm', () => {
        const input = marineFixture();
        input.utc_offset_seconds = 36000;
        expect(utcMarineLookup(input).at('2026-10-17T00:00:00Z')).toBeNull();
        const incomplete = marineFixture();
        incomplete.hourly.wave_height[3] = null as unknown as number;
        expect(utcMarineLookup(incomplete).maximumForDay('2026-10-17')).toBeNull();
        const calm = marineFixture();
        calm.hourly.wave_height.fill(0);
        expect(utcMarineLookup(calm).maximumForDay('2026-10-17')).toBe(0);
    });
});
