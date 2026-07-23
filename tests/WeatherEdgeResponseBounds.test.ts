import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const edgeSource = (name: string): string =>
    readFileSync(resolve(process.cwd(), `supabase/functions/${name}/index.ts`), 'utf8');

describe('weather Edge upstream response boundaries', () => {
    it.each(['get-weather', 'get-marine', 'check-weather-alerts'])(
        '%s uses timeout and bounded JSON helpers without response.json()',
        (name) => {
            const source = edgeSource(name);
            expect(source).toContain('fetchWithTimeout(');
            expect(source).toContain('readResponseJsonObjectLimited(');
            expect(source).not.toMatch(/(?:upstream|res|data|r)\.json\(\)/);
            expect(source).not.toContain('AbortSignal.timeout');
        },
    );

    it('caps and validates every get-weather provider payload', () => {
        const source = edgeSource('get-weather');
        expect(source).toContain('OPEN_METEO_MAX_BYTES = 1_500_000');
        expect(source).toContain('RAINBOW_MAX_BYTES = 750_000');
        expect(source).toContain('WEATHERKIT_MAX_BYTES = 3_000_000');
        expect(source).toContain('isOpenMeteoPayload(payload)');
        expect(source).toContain('parseRainbowPayload(payload)');
        expect(source).toContain('parseWeatherKitPayload(payload)');
        expect(source).toContain('value.forecast.length > 300');
        expect(source).toContain('hours.length > 240');
        expect(source).toContain('days.length > 10');
        expect(source).not.toContain("console.error('[get-weather] Fatal:', err)");
    });

    it('requires marine coordinates and bounded critical time series', () => {
        const source = edgeSource('get-marine');
        expect(source).toContain('MAX_UPSTREAM_BYTES = 2_000_000');
        expect(source).toContain('isValidMarinePayload(data)');
        expect(source).toContain("typeof value.current.time !== 'string'");
        expect(source).toContain('value.hourly.wave_height.length > 192');
        expect(source).not.toContain("console.error('[get-marine] fetch failed:', err)");
    });

    it('extracts only finite alert variables from a small current-weather payload', () => {
        const source = edgeSource('check-weather-alerts');
        expect(source).toContain('MAX_WEATHER_RESPONSE_BYTES = 128_000');
        expect(source).toContain('parseWeatherCurrent(data)');
        expect(source).toContain('for (const key of WEATHER_KEYS)');
        expect(source).toContain('Number.isFinite(field)');
        expect(source).not.toContain("console.error('Weather fetch failed:', err)");
    });
});
