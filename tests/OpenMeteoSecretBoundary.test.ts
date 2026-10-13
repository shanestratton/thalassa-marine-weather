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

/** Generated or vendored trees inside a source root (the iOS shell's copied web build, Pods). */
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'Pods', 'build', 'dist', 'DerivedData', 'public']);

function sourceFiles(root: string): string[] {
    const output: string[] = [];
    if (!fs.existsSync(root)) return output;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const absolute = path.join(root, entry.name);
        if (entry.isDirectory()) {
            if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
            output.push(...sourceFiles(absolute));
        } else if (/\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|py|sh|swift)$/.test(entry.name)) {
            output.push(absolute);
        }
    }
    return output;
}

const cwd = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(cwd, file), 'utf8');

/** Everything that ships to a phone, a browser or the boat's Pi. */
const CLIENT_FILES = [
    ...['services', 'components', 'src', 'hooks', 'utils', 'stores', 'pages', 'context', 'contexts', 'managers']
        .concat(['modules', path.join('pi-cache', 'src')])
        .flatMap((dir) => sourceFiles(path.join(cwd, dir))),
    ...['App.tsx', 'ApplicationShell.tsx', 'index.tsx', 'viewRegistry.tsx', 'utils.ts', 'types.ts', 'env.d.ts']
        .concat(['vite.config.ts'])
        .map((file) => path.join(cwd, file)),
];

/**
 * ...plus the server tiers (edge functions, Vercel routes, workers, the service
 * worker), the boat-side and back-office code (the whole Pi cache, Bosun's Pi
 * scripts, the backend, build scripts and tools) and the native iOS shell.
 */
const ALL_SOURCE_FILES = [
    ...new Set([
        ...CLIENT_FILES,
        ...['supabase/functions', 'api', 'workers', 'cloudflare-worker', 'public', 'pi-cache', 'bosun-pi', 'backend']
            .concat(['scripts', 'tools', 'ios', 'opencpn-bridge', 'pack-generator', 'vessel-scraper'])
            .flatMap((dir) => sourceFiles(path.join(cwd, dir))),
    ]),
];

/**
 * Open-Meteo's free hosts are for non-commercial use; Thalassa is a commercial
 * app, so every request goes to the customer endpoints with the key on the
 * server (127-H). Any `<name>-api.open-meteo.com` or `api.open-meteo.com` host,
 * with or without a scheme, except the `customer-` ones. The plain
 * https://open-meteo.com/ attribution link is not a request and stays allowed.
 *
 * This source scan is the real gate. The CSP change below only blocks the free
 * hosts in a browser on the production web: CapacitorHttp sends the iOS app's
 * requests through native HTTP, which no CSP governs, and index.html's meta CSP
 * still lists the bare `http:` scheme (for the boat LAN), which under CSP3
 * also matches any https URL.
 */
const FREE_OPEN_METEO_HOST = /(?<![a-z0-9-])(?!customer-)(?:[a-z0-9-]+-)?api\.open-meteo\.com/i;

describe('Open-Meteo commercial secret boundary', () => {
    beforeEach(() => {
        supabaseMock.getSession.mockReset();
        supabaseMock.getSession.mockResolvedValue({ data: { session: null }, error: null });
        vi.unstubAllGlobals();
    });

    it('keeps commercial credentials and provider hosts out of client and Pi source', () => {
        expect(CLIENT_FILES.length).toBeGreaterThan(500);
        const source = CLIENT_FILES.map((file) => fs.readFileSync(file, 'utf8')).join('\n');

        expect(source).not.toContain('VITE_OPEN_METEO_API_KEY');
        expect(source).not.toContain('getOpenMeteoKey');
        expect(source).not.toContain('openMeteoApiKey');
        expect(source).not.toContain('customer-api.open-meteo.com');
        expect(source).not.toContain('customer-marine-api.open-meteo.com');
        expect(source).not.toContain('customer-geocoding-api.open-meteo.com');
        expect(source).not.toContain('process.env.OPEN_METEO_API_KEY');
    });

    it.each([
        ['https://api.open-meteo.com/v1/forecast', true],
        ['https://marine-api.open-meteo.com/v1/marine', true],
        ['https://geocoding-api.open-meteo.com/v1/search', true],
        ['https://ensemble-api.open-meteo.com/v1/ensemble', true],
        ['https://archive-api.open-meteo.com/v1/archive', true],
        ['https://historical-forecast-api.open-meteo.com/v1/forecast', true],
        ['https://air-quality-api.open-meteo.com/v1/air-quality', true],
        ['http://api.open-meteo.com/v1/forecast', true],
        ["HOST = 'flood-api.open-meteo.com'", true],
        ['https://customer-api.open-meteo.com/v1/forecast', false],
        ['https://customer-marine-api.open-meteo.com/v1/marine', false],
        ['https://customer-geocoding-api.open-meteo.com/v1/search', false],
        ['<a href="https://open-meteo.com/">Open-Meteo</a>', false],
    ])('the free-host guard reads %s as free: %s', (text, free) => {
        expect(FREE_OPEN_METEO_HOST.test(text)).toBe(free);
    });

    it('calls no free Open-Meteo host from anywhere: app, Pi, edge, Vercel, workers, scripts, iOS or the service worker', () => {
        const relative = ALL_SOURCE_FILES.map((file) => path.relative(cwd, file));
        for (const covered of [path.join('public', 'sw.js'), path.join('ios', 'App', 'App', 'AppDelegate.swift')]) {
            expect(relative, covered).toContain(covered);
        }
        for (const dir of ['bosun-pi', 'backend', 'scripts', 'tools', path.join('pi-cache', 'src')]) {
            expect(
                relative.some((file) => file.startsWith(dir + path.sep)),
                dir,
            ).toBe(true);
        }
        expect(relative.some((file) => file.endsWith('.py'))).toBe(true);
        expect(relative.some((file) => file.split(path.sep).includes('node_modules'))).toBe(false);
        const freeHostCallers = ALL_SOURCE_FILES.filter((file) =>
            FREE_OPEN_METEO_HOST.test(fs.readFileSync(file, 'utf8')),
        ).map((file) => path.relative(cwd, file));
        // No exceptions: the public voyage page's parked wind barbs, the last
        // one, were deleted with their free-API fetch (127-H).
        expect(freeHostCallers).toEqual([]);
    });

    it('lists no free host in any page CSP (a browser-only backstop; the source scan above is the gate)', () => {
        const vercel = JSON.parse(read('vercel.json')) as {
            headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
        };
        const policies = [
            /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(read('index.html'))?.[1] ?? '',
            ...vercel.headers
                .flatMap((entry) => entry.headers)
                .filter((header) => header.key.toLowerCase() === 'content-security-policy')
                .map((header) => header.value),
        ];
        expect(policies.length).toBeGreaterThanOrEqual(2);
        for (const policy of policies) {
            expect(policy).toContain('connect-src');
            expect(policy).not.toContain('open-meteo.com');
        }
    });

    it('deletes the public page wind barbs rather than parking them', () => {
        expect(fs.existsSync(path.join(cwd, 'src', 'windField.ts'))).toBe(false);
        expect(fs.existsSync(path.join(cwd, 'src', 'components', 'WindBarb.tsx'))).toBe(false);
        const importers = ALL_SOURCE_FILES.filter((file) =>
            /from ['"](?:\.\.?\/)+(?:src\/)?(?:windField|components\/WindBarb|WindBarb)['"]/.test(
                fs.readFileSync(file, 'utf8'),
            ),
        )
            .map((file) => path.relative(cwd, file))
            .filter((file) => file.startsWith('src'));
        expect(importers).toEqual([]);
        expect(read('src/components/MapContainer.tsx')).not.toMatch(/windOn|WindSample|fetchWindGrid|PUBLIC_WIND/);
    });

    it('pins hosts and enforces the edge request/response safety contract', () => {
        // The request vocabulary lives in validation.ts since build 125 (SND), so
        // its allowlist has a deno test; the contract reads the function whole.
        const edge = ['index.ts', 'validation.ts']
            .map((file) =>
                fs.readFileSync(path.join(process.cwd(), 'supabase', 'functions', 'proxy-openmeteo', file), 'utf8'),
            )
            .join('\n');
        expect(edge).toContain("import { isOperation, UPSTREAMS, validateRequest } from './validation.ts'");

        expect(edge).toContain("forecast: 'https://customer-api.open-meteo.com/v1/forecast'");
        expect(edge).toContain("marine: 'https://customer-marine-api.open-meteo.com/v1/marine'");
        expect(edge).toContain("geocode: 'https://customer-geocoding-api.open-meteo.com/v1/search'");
        expect(edge).toContain("Deno.env.get('OPEN_METEO_API_KEY')");
        // Three fixed operations (127-H added geocode); anything else is a 400.
        expect(edge).toContain("export const OPERATIONS = ['forecast', 'marine', 'geocode'] as const;");
        expect(edge).toContain('!isOperation(operation) ||');
        expect(edge).toContain('const GEOCODE_PARAMETERS = new Set([');
        expect(edge).toContain('Object.keys(params).some((name) => !COMMON_PARAMETERS.has(name))');
        expect(edge).toContain('latitude.length !== longitude.length');
        expect(edge).toContain('values.length > 50');
        expect(edge).toContain('requireAuthenticatedOrPublicQuota(');
        expect(edge).toContain('fetchWithTimeout(');
        expect(edge).toContain('readResponseTextLimited(upstream, 16_000_000)');
        expect(edge).not.toContain('await upstream.json()');
    });

    it('keeps every customer-host caller on the server, with the key read from its secrets', () => {
        const functionsRoot = path.join(cwd, 'supabase', 'functions');
        const byFunction = new Map<string, string>();
        for (const file of sourceFiles(functionsRoot)) {
            const name = path.relative(functionsRoot, file).split(path.sep)[0];
            byFunction.set(name, `${byFunction.get(name) ?? ''}\n${fs.readFileSync(file, 'utf8')}`);
        }
        const callers = [...byFunction]
            .filter(([, source]) => /customer-(?:api|marine-api|geocoding-api)\.open-meteo\.com/.test(source))
            .map(([name]) => name)
            .sort();
        expect(callers).toEqual(
            expect.arrayContaining(['check-weather-alerts', 'proxy-bosun-fallback', 'proxy-openmeteo']),
        );
        for (const name of callers) {
            expect(byFunction.get(name), name).toContain("Deno.env.get('OPEN_METEO_API_KEY')");
        }
    });

    it('never logs or throws a URL in the two edge functions that call Open-Meteo directly', () => {
        for (const dir of ['proxy-bosun-fallback', 'check-weather-alerts']) {
            const files = sourceFiles(path.join(cwd, 'supabase', 'functions', dir)).filter(
                (file) => !file.endsWith('_test.ts'),
            );
            const source = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
            // The key rides in the upstream query string, so the URL is a secret.
            const reports = [...source.matchAll(/(?:console\.\w+|new Error|new TypeError)\(([^;]*?)\);?\n/g)].map(
                (match) => match[1],
            );
            expect(reports.length, dir).toBeGreaterThan(0);
            for (const args of reports) {
                expect(args, `${dir}: ${args}`).not.toMatch(
                    /\burl\b|\bURL\b|\bquery\b|apikey|apiKey|\.message\b.*open/i,
                );
            }
            expect(source, dir).not.toMatch(FREE_OPEN_METEO_HOST);
        }
        const fallback = read('supabase/functions/proxy-bosun-fallback/index.ts');
        expect(fallback).toContain("createOpenMeteoClient(Deno.env.get('OPEN_METEO_API_KEY'))");
        expect(fallback).not.toContain('free, no key');
        expect(fallback).toMatch(/Required Supabase Secrets:[\s\S]*OPEN_METEO_API_KEY/);
        const alerts = read('supabase/functions/check-weather-alerts/index.ts');
        expect(alerts).toContain("const openMeteoKey = Deno.env.get('OPEN_METEO_API_KEY');");
        expect(alerts).not.toMatch(/apiKey\s*\?\s*['"]https:\/\/customer-api/);
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
