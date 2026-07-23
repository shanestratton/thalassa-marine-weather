import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const supabaseMock = vi.hoisted(() => ({
    getSession: vi.fn(),
}));

vi.mock('../services/supabase', () => ({
    supabaseUrl: 'https://example.supabase.co',
    supabaseAnonKey: 'public-anon-key',
    supabase: {
        auth: {
            getSession: supabaseMock.getSession,
        },
    },
}));

import { fetchOpenMeteoPoints, fetchOpenMeteoProxy } from '../services/weather/openMeteoProxy';

function sourceFiles(root: string): string[] {
    const output: string[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const absolute = path.join(root, entry.name);
        if (entry.isDirectory()) {
            output.push(...sourceFiles(absolute));
        } else if (/\.(?:ts|tsx|js|mjs|d\.ts)$/.test(entry.name)) {
            output.push(absolute);
        }
    }
    return output;
}

describe('Open-Meteo commercial secret boundary', () => {
    beforeEach(() => {
        supabaseMock.getSession.mockReset();
        supabaseMock.getSession.mockResolvedValue({ data: { session: null }, error: null });
        vi.unstubAllGlobals();
    });

    it('keeps commercial credentials and provider hosts out of client and Pi source', () => {
        const cwd = process.cwd();
        const files = [
            ...sourceFiles(path.join(cwd, 'services')),
            ...sourceFiles(path.join(cwd, 'components')),
            ...sourceFiles(path.join(cwd, 'src')),
            ...sourceFiles(path.join(cwd, 'pi-cache', 'src')),
            path.join(cwd, 'env.d.ts'),
            path.join(cwd, 'vite.config.ts'),
        ];
        const source = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');

        expect(source).not.toContain('VITE_OPEN_METEO_API_KEY');
        expect(source).not.toContain('getOpenMeteoKey');
        expect(source).not.toContain('openMeteoApiKey');
        expect(source).not.toContain('customer-api.open-meteo.com');
        expect(source).not.toContain('customer-marine-api.open-meteo.com');
        expect(source).not.toContain('process.env.OPEN_METEO_API_KEY');

        // Deliberate exception: the standalone public voyage-map bundle has
        // no Supabase/auth dependency and uses only Open-Meteo's keyless API.
        // Keep that exception singular; the installed app uses the proxy.
        const freeForecastConsumers = files
            .filter((file) => /https:\/\/(?:api|marine-api)\.open-meteo\.com/.test(fs.readFileSync(file, 'utf8')))
            .map((file) => path.relative(cwd, file));
        expect(freeForecastConsumers).toEqual(['src/windField.ts']);
    });

    it('pins hosts and enforces the edge request/response safety contract', () => {
        const edge = fs.readFileSync(
            path.join(process.cwd(), 'supabase', 'functions', 'proxy-openmeteo', 'index.ts'),
            'utf8',
        );

        expect(edge).toContain("forecast: 'https://customer-api.open-meteo.com/v1/forecast'");
        expect(edge).toContain("marine: 'https://customer-marine-api.open-meteo.com/v1/marine'");
        expect(edge).toContain("Deno.env.get('OPEN_METEO_API_KEY')");
        expect(edge).toContain("operation !== 'forecast' && operation !== 'marine'");
        expect(edge).toContain('Object.keys(params).some((name) => !COMMON_PARAMETERS.has(name))');
        expect(edge).toContain('latitude.length !== longitude.length');
        expect(edge).toContain('values.length > 50');
        expect(edge).toContain('requireAuthenticatedOrPublicQuota(');
        expect(edge).toContain('fetchWithTimeout(');
        expect(edge).toContain('readResponseTextLimited(upstream, 16_000_000)');
        expect(edge).not.toContain('await upstream.json()');
    });

    it('makes the Pi a cache client of the edge boundary, never a key holder', () => {
        const piProxy = fs.readFileSync(path.join(process.cwd(), 'pi-cache', 'src', 'proxy.ts'), 'utf8');
        const piServer = fs.readFileSync(path.join(process.cwd(), 'pi-cache', 'src', 'server.ts'), 'utf8');

        expect(piProxy).toContain("supabaseEdgeUrl(config, 'proxy-openmeteo')");
        expect(piProxy).toContain("method: 'POST'");
        expect(piProxy).toContain('body: { operation, params: parameterRecord }');
        expect(piProxy).not.toContain('customer-api.open-meteo.com');
        expect(piProxy).not.toContain('customer-marine-api.open-meteo.com');
        expect(piServer).toContain('delete process.env[LEGACY_PROVIDER_ENV]');
        expect(piServer).not.toContain('openMeteoApiKey');
    });

    it('posts only operation and parameters to the Supabase proxy', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ current: { wind_speed_10m: 12 } }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
        );
        vi.stubGlobal('fetch', fetchMock);

        const result = await fetchOpenMeteoProxy<{ current: { wind_speed_10m: number } }>('forecast', {
            latitude: -27.4,
            longitude: 153.1,
            current: 'wind_speed_10m',
        });

        expect(result.current.wind_speed_10m).toBe(12);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://example.supabase.co/functions/v1/proxy-openmeteo');
        expect(init.method).toBe('POST');
        expect(init.headers).toMatchObject({
            Authorization: 'Bearer public-anon-key',
            apikey: 'public-anon-key',
        });
        expect(JSON.parse(String(init.body))).toEqual({
            operation: 'forecast',
            params: {
                latitude: -27.4,
                longitude: 153.1,
                current: 'wind_speed_10m',
            },
        });
        expect(String(init.body)).not.toContain('apikey');
        expect(url).not.toContain('open-meteo.com');
    });

    it('splits coordinate requests at 50 and preserves result alignment', async () => {
        const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
            const request = JSON.parse(String(init.body)) as {
                params: { latitude: string; longitude: string };
            };
            const latitudes = request.params.latitude.split(',');
            const longitudes = request.params.longitude.split(',');
            const payload = latitudes.map((latitude, index) => ({
                latitude: Number(latitude),
                longitude: Number(longitudes[index]),
            }));
            return new Response(JSON.stringify(payload), { status: 200 });
        });
        vi.stubGlobal('fetch', fetchMock);
        const points = Array.from({ length: 51 }, (_, index) => ({
            lat: -30 + index * 0.01,
            lon: 150 + index * 0.01,
        }));

        const result = await fetchOpenMeteoPoints<{ latitude: number; longitude: number }>(
            'forecast',
            points,
            { current: 'wind_speed_10m' },
            2,
        );

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(result).toHaveLength(51);
        expect(result[0]).toEqual({ latitude: -30, longitude: 150 });
        expect(result[50]).toEqual({ latitude: -29.5, longitude: 150.5 });
    });

    it('rejects oversized and misaligned upstream responses', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                new Response('[]', {
                    status: 200,
                    headers: { 'Content-Length': '16000001' },
                }),
            ),
        );
        await expect(
            fetchOpenMeteoProxy('forecast', {
                latitude: 0,
                longitude: 0,
                current: 'wind_speed_10m',
            }),
        ).rejects.toThrow('safe size limit');

        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('[]', { status: 200 })));
        await expect(
            fetchOpenMeteoPoints(
                'forecast',
                [
                    { lat: 0, lon: 0 },
                    { lat: 1, lon: 1 },
                ],
                { current: 'wind_speed_10m' },
            ),
        ).rejects.toThrow('misaligned coordinate batch');
    });
});
