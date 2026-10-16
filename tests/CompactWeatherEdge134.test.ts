import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expandMinifiedWeather, minifyWeather } from '../utils/compactWeather';
import {
    parseCoordinate,
    readJsonObject,
    readResponseJsonObjectLimited,
} from '../supabase/functions/_shared/http-security';
import { COMPACT_NOW } from './fixtures/compactWeatherFixture';

// Run the actual handler and provider mappers, replacing only external auth,
// storage, HTTP and Apple signing. Synthetic environment values never leave
// this in-memory harness. The shared quota/auth helper has its own tests.
const source = readFileSync('supabase/functions/get-weather/index.ts', 'utf8').replace(
    /^import\s[\s\S]*?from ['"][^'"]+['"];\s*$/gm,
    '',
);
const code = ts.transpileModule(source, {
    compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.None,
    },
}).outputText;

function harness(premium: boolean) {
    let handle!: (request: Request) => Promise<Response>;
    const caller = premium ? { kind: 'authenticated', userId: 'verified-skipper' } : { kind: 'public', userId: null };
    const eq = vi.fn().mockReturnThis();
    const createClient = vi.fn(() => ({
        from: () => ({
            select: () => ({
                eq,
                maybeSingle: async () => ({
                    data: { subscription_status: 'active', subscription_expiry: null },
                    error: null,
                }),
            }),
        }),
    }));
    // eq must return the fluent query object, not the test function's this.
    const query = {
        eq,
        maybeSingle: async () => ({
            data: { subscription_status: 'active', subscription_expiry: null },
            error: null,
        }),
    };
    eq.mockReturnValue(query);
    createClient.mockReturnValue({ from: () => ({ select: () => query }) });
    const auth = vi.fn(async () => caller);
    const fetchProvider = vi.fn(
        async (url: string) =>
            new Response(
                JSON.stringify(
                    url.includes('weatherkit.apple.com') ? apple() : url.includes('open-meteo.com') ? openMeteo() : {},
                ),
                { headers: { 'Content-Type': 'application/json' } },
            ),
    );
    new Function(
        'Deno',
        'createClient',
        'requireAuthenticatedOrPublicQuota',
        'withCors',
        'fetchWithTimeout',
        'parseCoordinate',
        'readJsonObject',
        'readResponseJsonObjectLimited',
        'minifyWeather',
        `${code}\nimportP8Key = async () => ({}); getAppleJWT = async () => 'synthetic-jwt';`,
    )(
        {
            serve: (handler: typeof handle) => {
                handle = handler;
            },
            env: { get: () => 'synthetic-only' },
        },
        createClient,
        auth,
        (response: Response) => response,
        fetchProvider,
        parseCoordinate,
        readJsonObject,
        readResponseJsonObjectLimited,
        minifyWeather,
    );
    return { handle, fetchProvider, createClient, eq, auth };
}
function openMeteo() {
    const hours = Array.from({ length: 48 }, (_, i) =>
        new Date(Date.parse('2026-10-16T00:00:00Z') + i * 3_600_000).toISOString().slice(0, 16),
    );
    const dates = Array.from({ length: 5 }, (_, i) => `2026-10-${16 + i}`);
    return {
        timezone: 'GMT',
        current: {
            temperature_2m: null,
            apparent_temperature: null,
            relative_humidity_2m: null,
            pressure_msl: 1010,
            wind_speed_10m: 0,
            wind_direction_10m: 0,
            wind_gusts_10m: null,
            weather_code: null,
            cloud_cover: null,
            precipitation: null,
            dew_point_2m: null,
            is_day: 1,
        },
        hourly: {
            time: hours,
            temperature_2m: hours.map(() => null),
            wind_speed_10m: hours.map((_, i) => (i === 2 ? null : 0)),
        },
        daily: {
            time: dates,
            temperature_2m_max: dates.map(() => null),
            temperature_2m_min: dates.map(() => 0),
            sunrise: dates.map((d) => d + 'T05:00'),
            sunset: dates.map((d) => d + 'T18:00'),
        },
    };
}
function apple() {
    return {
        currentWeather: { temperature: 0, conditionCode: 'Clear', windSpeed: 0 },
        forecastHourly: {
            hours: Array.from({ length: 48 }, (_, i) => ({
                forecastStart: new Date(Date.parse('2026-10-16T00:00:00Z') + i * 3_600_000).toISOString(),
                temperature: 0,
                windSpeed: 0,
                conditionCode: 'Clear',
            })),
        },
        forecastDaily: {
            days: Array.from({ length: 7 }, (_, i) => ({
                forecastStart: `2026-10-${16 + i}T00:00:00Z`,
                temperatureMax: 0,
                temperatureMin: 0,
                conditionCode: 'Clear',
            })),
        },
    };
}
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(COMPACT_NOW);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('get-weather compact handler provider and auth lanes', () => {
    it.each([false, true])('serves a decodable v2 forecast with real UTC times for premium=%s', async (premium) => {
        const h = harness(premium);
        const response = await h.handle(
            new Request('https://example.test/get-weather?lat=-27.12&lon=153.12&minified=1&user_id=forged-owner'),
        );
        expect(response.status).toBe(200);
        expect(response.headers.get('Cache-Control')).toBe(premium ? 'private, max-age=300' : 'public, max-age=300');
        expect(response.headers.get('Vary')).toBe('Authorization');
        const packed = await response.json();
        const expanded = expandMinifiedWeather(packed, -27.12, 153.12, COMPACT_NOW)!;
        expect(expanded).not.toBeNull();
        expect(expanded.provider).toBe(premium ? 'rainbow+openmeteo' : 'weatherkit');
        expect(expanded.hourly).toHaveLength(24);
        expect(expanded.hourly[0].time).toBe('2026-10-16T02:00:00.000Z');
        expect(expanded.current.windSpeed).toBe(0);
        expect(expanded.current.windGust).toBeNull();
        expect(expanded.hourly[0].windGust).toBeNull();
        expect(expanded.daily[0].windSpeedMax).toBeNull();
        expect(expanded.hourly[0].precipProbability).toBeNull();
        if (premium) {
            expect(h.eq).toHaveBeenCalledWith('user_id', 'verified-skipper');
            const upstream = new URL(h.fetchProvider.mock.calls.find(([url]) => url.includes('open-meteo.com'))![0]);
            expect(upstream.searchParams.get('timezone')).toBe('UTC');
            expect(upstream.searchParams.get('forecast_days')).toBe('5');
            expect(expanded.hourly[0].windSpeed).toBeNull();
            expect(expanded.daily[0].sunrise).toBe('2026-10-16T05:00:00.000Z');
            expect(expanded.current.condition).toBe('Unknown');
        } else {
            expect(h.createClient).not.toHaveBeenCalled();
            expect(h.fetchProvider.mock.calls.every(([url]) => url.includes('weatherkit.apple.com'))).toBe(true);
        }
    });
    it('preserves the full premium response timezone and horizon when compact was not requested', async () => {
        const h = harness(true);
        const response = await h.handle(new Request('https://example.test/get-weather?lat=-27.12&lon=153.12'));
        const body = await response.json();
        expect(body.provider).toBe('rainbow+openmeteo');
        expect(body.v).toBeUndefined();
        expect(body.hourly).toHaveLength(48);
        const upstream = new URL(h.fetchProvider.mock.calls.find(([url]) => url.includes('open-meteo.com'))![0]);
        expect(upstream.searchParams.get('timezone')).toBe('auto');
        expect(upstream.searchParams.get('forecast_days')).toBe('7');
    });
    it('refuses an invalid compact flag before any upstream provider request', async () => {
        const h = harness(false);
        const response = await h.handle(
            new Request('https://example.test/get-weather?lat=-27.12&lon=153.12&minified=maybe'),
        );
        expect(response.status).toBe(400);
        expect(h.fetchProvider).not.toHaveBeenCalled();
    });
});
