import { describe, expect, it } from 'vitest';
import type { MarineWeatherReport } from '../types';
import {
    applyMarineModel,
    finalizeMarineForecast,
    marineForecastForDisplay,
} from '../services/weather/applyMarineModel';
import { mapMarineModelV2 } from '../services/weather/marineModelV2';
import { marineEnvelopeV2 } from '../supabase/functions/_shared/marine-v2';
import { marineFixtureSource, MARINE_FIXTURE_AT as at, MARINE_FIXTURE_POINT as point } from './fixtures/marineV2141';

function report(): MarineWeatherReport {
    return {
        locationName: 'Fictional point',
        coordinates: { lat: point.latitude, lon: point.longitude },
        locationType: 'offshore',
        timeZone: 'UTC',
        utcOffset: 0,
        generatedAt: new Date(at).toISOString(),
        modelUsed: 'om:ecmwf_ifs025',
        tides: [],
        boatingAdvice: '',
        current: {
            windSpeed: 12,
            windDirection: 'N',
            waveHeight: 20,
            swellPeriod: 20,
            swellDirection: 'N',
            airTemperature: 22,
            description: 'Fictional forecast',
            condition: 'Sunny',
            uvIndex: 0,
            waterTemperature: 99,
            currentSpeed: 99,
        },
        hourly: [at, at + 3600000, at + 13 * 86400000].map((time) => ({
            time: new Date(time).toISOString(),
            windSpeed: 12,
            waveHeight: 20,
            temperature: 22,
            condition: 'Sunny',
            waterTemperature: 99,
            currentSpeed: 99,
        })),
        forecast: ['2026-10-16', '2026-10-17', '2026-10-30'].map((date) => ({
            day: 'Fictional day',
            date,
            isoDate: date,
            highTemp: 24,
            lowTemp: 18,
            windSpeed: 12,
            waveHeight: 20,
            condition: 'Sunny',
            waterTemperature: 99,
            currentSpeed: 99,
        })),
    };
}
const source = () =>
    mapMarineModelV2(
        marineEnvelopeV2(point, at, marineFixtureSource('waves'), marineFixtureSource('motion')),
        point,
        at,
        'pi',
    )!;
describe('final source-qualified marine report enrichment', () => {
    it('preserves atmosphere, uses total period/direction in legacy Glass fields, and carries raw metre partitions', () => {
        const input = report(),
            result = applyMarineModel(input, source());
        expect(result.current).toMatchObject({
            windSpeed: 12,
            airTemperature: 22,
            waveHeight: 4.92,
            swellPeriod: 8,
            wavePeriod: 8,
            swellDirection: 'W',
            waterTemperature: 21,
            currentSpeed: 1,
        });
        expect(result.current.marine?.parts).toMatchObject({
            total: { hM: 1.5, periodS: 8, fromDeg: 270 },
            swell: { hM: 1.2, periodS: 10, fromDeg: 280 },
        });
        expect(result.current.marine?.waveValidAtMs).toBe(at);
        expect(result.current.sources?.waveHeight?.source).toBe('marine_model');
        expect(input.current.waveHeight).toBe(20);
        expect(input.current.marine).toBeUndefined();
    });
    it('matches actual UTC instants and removes numbers beyond the independent marine horizon', () => {
        const result = applyMarineModel(report(), source());
        expect(result.hourly[0].marine?.waveValidAtMs).toBe(at);
        expect(result.hourly[1].marine?.waveValidAtMs).toBe(at + 3600000);
        expect(result.hourly[2].waveHeight).toBeNull();
        expect(result.hourly[2].currentSpeed).toBeNull();
        expect(result.hourly[2].marine?.status).toBe('unavailable');
        expect(result.forecast[2].waveHeight).toBeNull();
    });
    it('keeps mismatched motion clocks unknown rather than assigning the wave clock to them', () => {
        const raw = marineEnvelopeV2(point, at, marineFixtureSource('waves'), marineFixtureSource('motion'));
        raw.motion!.hourly.time = raw.motion!.hourly.time.map((time) => time + 3600);
        const result = applyMarineModel(report(), mapMarineModelV2(raw, point, at, 'pi'));
        expect(result.hourly[0].currentSpeed).toBeNull();
        expect(result.hourly[0].marine?.motionValidAtMs).toBeNull();
        expect(result.hourly[0].marine?.waveValidAtMs).toBe(at);
    });
    it('aggregates the day by the actual location date and retains its representative peak-sea clock', () => {
        const input = report();
        input.timeZone = 'America/New_York';
        const result = applyMarineModel(input, source());
        expect(result.forecast[0].waveHeight).toBe(4.92);
        expect(result.forecast[0].marine?.waveValidAtMs).toBe(at);
        expect(result.forecast[0].waterTemperature).toBeUndefined();
        expect(result.forecast[0].currentSpeed).toBeUndefined();
        expect(result.forecast[1].waveHeight).toBeNull();
    });
    it.each(['inshore', 'inland', 'enclosed'] as const)(
        'keeps %s seas and coarse currents unknown with an explicit reason',
        (mode) => {
            const input = report();
            if (mode !== 'enclosed') input.locationType = mode;
            const result = applyMarineModel(input, source(), mode === 'enclosed');
            expect(result.current.waveHeight).toBeNull();
            expect(result.current.currentSpeed).toBeNull();
            expect(result.current.marine?.parts.total).toBeNull();
            expect(result.current.marine?.status).toBe('enclosed');
            expect(result.current.marine?.reason).toMatch(/do not resolve/);
            expect(result.hourly.every((hour) => hour.waveHeight === null)).toBe(true);
            expect(result.forecast.every((day) => day.waveHeight === null)).toBe(true);
        },
    );
    it('overwrites every legacy sea placeholder on source failure instead of carrying it as calm/known', () => {
        const result = applyMarineModel(report(), null);
        expect(result.current.waveHeight).toBeNull();
        expect(result.current.swellPeriod).toBeNull();
        expect(result.current.waterTemperature).toBeNull();
        expect(result.current.sources?.waveHeight?.value).toBeNull();
        expect(result.current.marine?.reason).toMatch(/unavailable/);
        expect(result.hourly.every((hour) => hour.waveHeight === null && hour.currentSpeed === null)).toBe(true);
    });
    it('cannot guess daily marine date coverage without a trustworthy timezone', () => {
        const input = report();
        input.timeZone = 'unknown';
        input.utcOffset = undefined;
        expect(applyMarineModel(input, source()).forecast.every((day) => day.waveHeight === null)).toBe(true);
    });

    it('recomputes actual sea alerts after the final merge and never describes unknown seas as calm', () => {
        const input = report();
        input.alerts = ['Dangerous seas from the replaced source'];
        const known = finalizeMarineForecast(applyMarineModel(input, source()), at);
        expect(known.current.waveHeight).toBe(4.92);
        expect(known.alerts?.join(' ')).not.toMatch(/dangerous seas|rough seas/i);
        const unknown = finalizeMarineForecast(applyMarineModel(input, null));
        expect(unknown.current.waveHeight).toBeNull();
        expect(unknown.boatingAdvice).toMatch(/Sea state unavailable/);
        expect(unknown.boatingAdvice).not.toMatch(/Tranquil|Mirror-like|Excellent for all|Good conditions for sailing/);
        input.current.windSpeed = 55;
        expect(finalizeMarineForecast(applyMarineModel(input, null)).alerts?.join(' ')).toMatch(/storm-force/i);
    });
    it('retains a fresh source without renewing clocks or changing identity', () => {
        const input = applyMarineModel(report(), source());
        expect(marineForecastForDisplay(input, at)).toBe(input);
        expect(input.current.marine?.fetchedAtMs).toBe(at);
    });
    it('expires original current sea independently from newer motion while retaining the same-cohort forecast', () => {
        const sourceValue = source();
        sourceValue.fetchedAtMs = at + 600000;
        sourceValue.motionCurrentAtMs = at + 600000;
        const input = applyMarineModel(report(), sourceValue);
        const output = marineForecastForDisplay(input, at + 1800001);
        expect(output.current.waveHeight).toBeNull();
        expect(output.current.marine?.parts.total).toBeNull();
        expect(output.current.marine?.waveValidAtMs).toBeNull();
        expect(output.current.waterTemperature).toBe(21);
        expect(output.current.currentSpeed).toBe(1);
        expect(output.current.marine?.motionValidAtMs).toBe(at + 600000);
        expect(output.current.marine?.fetchedAtMs).toBe(at + 600000);
        expect(output.hourly[0].waveHeight).toBe(4.92);
        expect(input.current.waveHeight).toBe(4.92);
    });
    it('expires a whole persisted source cohort from its original receipt at one hour plus1ms', () => {
        const input = applyMarineModel(report(), source());
        const output = marineForecastForDisplay(input, at + 3600001);
        expect(output.current.waveHeight).toBeNull();
        expect(output.current.currentSpeed).toBeNull();
        expect(output.hourly.every((hour) => hour.waveHeight === null)).toBe(true);
        expect(output.forecast.every((day) => day.waveHeight === null)).toBe(true);
    });
    it('refuses legacy placeholders and another coordinate cohort at the display boundary', () => {
        expect(marineForecastForDisplay(report(), at).current.waveHeight).toBeNull();
        const input = applyMarineModel(report(), source());
        input.coordinates!.lat += 0.01;
        expect(marineForecastForDisplay(input, at).current.waveHeight).toBeNull();
    });
});
