import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const edgeSource = (name: string): string =>
    readFileSync(resolve(process.cwd(), `supabase/functions/${name}/index.ts`), 'utf8');

describe('weather Edge upstream response boundaries', () => {
    it.each(['get-weather', 'get-marine'])(
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

        // Sanity caps must EXIST and must clear what Apple actually sends.
        // Pinning the literal number made CI red for a fix rather than a
        // regression: the old hours cap of 240 was exceeded on every single
        // request (Apple sends ~250), which 502'd this endpoint, and days sat
        // at 10 against 10 sent — passing with no headroom at all. One rejected
        // element fails the WHOLE payload, so a cap set at the observed value is
        // a latent outage. Assert the guarantee, not the digits.
        const capOf = (series: string): number => {
            const found = source.match(new RegExp(`${series}\\.length > (\\d[\\d_]*)`));
            expect(found, `no sanity cap found on ${series}`).not.toBeNull();
            return Number(found![1].replace(/_/g, ''));
        };
        expect(capOf('hours')).toBeGreaterThan(250);
        expect(capOf('days')).toBeGreaterThan(10);
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

    // check-weather-alerts asks many places a request since 129-07, and Open-Meteo
    // answers a list of places with a JSON array, which readResponseJsonObjectLimited
    // refuses by design. So it reads the bounded text itself, checks the media type,
    // and parses a list of exactly as many places as it asked
    // (_shared/forecast-alerts/lookahead.ts parseReplies).
    it('check-weather-alerts reads each batch bounded, typed and timed, without response.json()', () => {
        const source = edgeSource('check-weather-alerts');
        expect(source).toContain('fetchWithTimeout(');
        expect(source).toContain('MAX_BATCH_RESPONSE_BYTES = 2_000_000');
        expect(source).toContain('readResponseTextLimited(res, MAX_BATCH_RESPONSE_BYTES)');
        expect(source).toContain("isJsonContentType(res.headers.get('content-type'))");
        expect(source).toContain('parseReplies(JSON.parse(text), batch.length)');
        expect(source).not.toMatch(/(?:upstream|res|data|r)\.json\(\)/);
        expect(source).not.toContain('AbortSignal.timeout');
    });

    it('extracts only finite alert variables from each place’s reply', () => {
        const shared = readFileSync(
            resolve(process.cwd(), 'supabase/functions/_shared/forecast-alerts/lookahead.ts'),
            'utf8',
        );
        expect(shared).toContain("typeof v === 'number' && Number.isFinite(v) ? v : null");
        expect(shared).toMatch(/if \(!list \|\| list\.length !== expected\) return null;/);
        expect(edgeSource('check-weather-alerts')).not.toContain("console.error('Weather fetch failed:', err)");
    });
});
