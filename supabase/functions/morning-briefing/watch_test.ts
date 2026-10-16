import { createWeatherWatchHandler, weatherWatchDependencies } from '../_shared/weather-watch/http.ts';
import { runWeatherWatch, type WatchClaim, type WeatherWatchDeps } from '../_shared/weather-watch/runner.ts';
import { cachedConvectiveMember } from '../../../utils/cachedConvective.ts';
import { CONVECTIVE_MODELS } from '../../../utils/convective.ts';
import { defaultWeatherWatch } from '../../../utils/weatherWatch.ts';
const H = 3_600_000, now = Date.parse('2026-10-17T07:00:00Z');
const boat = '20000000-0000-4000-8000-000000000001', revision = '30000000-0000-4000-8000-000000000001';
const equal = (a: unknown, b: unknown) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
        throw new Error(`Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
    }
};
const row = (model: string) => ({
    cell_id: '0_0',
    model: `wx2:${model}`,
    run_at: new Date(now - H).toISOString(),
    payload: {
        latitude: .125,
        longitude: .125,
        utc_offset_seconds: 0,
        timezone: 'GMT',
        thalassa_provenance: {
            version: 2,
            source: 'wx',
            model,
            run_at: new Date(now - H).toISOString(),
            sampling: 'cell-centre',
            cell_selection: 'sea',
            cell_id: '0_0',
            cell_degrees: .25,
            latitude: .125,
            longitude: .125,
            source_domains: [model],
            source_runs: [{
                domain: model,
                run_at: new Date(now - H).toISOString(),
                data_end_at: new Date(now + 25 * H).toISOString(),
            }],
        },
        hourly_units: { time: 'iso8601', weather_code: 'wmo code', wind_gusts_10m: 'km/h', cape: 'J/kg' },
        hourly: {
            time: Array.from({ length: 25 }, (_, i) => new Date(now + i * H).toISOString()),
            weather_code: Array(25).fill(95),
            wind_gusts_10m: Array(25).fill(55.56),
            cape: Array(25).fill(2000),
        },
    },
});
function setup() {
    const claims: WatchClaim[] = [], ticks: unknown[] = [], requests: string[] = [];
    const preferences = {
        ...defaultWeatherWatch(),
        morning: true,
        rain: true,
        storm: true,
        gust: true,
        gustKts: 25,
        samples: [{
            key: 'boat:position',
            kind: 'boat',
            label: 'Registered boat position',
            lat: 0,
            lon: 0,
            sourceAt: now - 1000,
            expiresAt: now + 899000,
        }],
    };
    const deps: WeatherWatchDeps = {
        now: () => now,
        work: async (_f, after) => after ? [] : [{ boat_id: boat, owner_id: boat, revision, preferences }],
        official: async () => ({ live: false, delivered: [] }),
        forecasts: async (cell) => {
            requests.push(cell);
            return CONVECTIVE_MODELS.map(row);
        },
        rain: async () => ({
            retrievedAt: now,
            body: {
                latitude: 0,
                longitude: 0,
                forecast: [0, .4, .5].map((precipRate, i) => ({
                    precipRate,
                    precipType: 'rain',
                    timestampBegin: now / 1000 + i * 300,
                    timestampEnd: now / 1000 + (i + 1) * 300,
                })),
            },
        }),
        claim: async (claim) => {
            claims.push(claim);
            return true;
        },
        tick: async (...args) => {
            ticks.push(args);
        },
    };
    return { deps, claims, ticks, requests, preferences };
}
Deno.test('cached parser preserves units, raw run and provenance; refuses legacy/source/cell/unit lies', () => {
    const valid = row(CONVECTIVE_MODELS[0]);
    equal(cachedConvectiveMember(valid, '0_0', now)?.hours[0].gustKts, 30);
    equal(cachedConvectiveMember(valid, '0_0', now)?.runAt, now - H);
    for (
        const change of [() => {
            valid.model = 'ecmwf_ifs025';
        }, () => {
            valid.payload.thalassa_provenance.source = 'unknown';
        }, () => {
            valid.cell_id = '25_0';
        }, () => {
            valid.payload.hourly_units.wind_gusts_10m = 'kn';
        }]
    ) {
        const fresh = row(CONVECTIVE_MODELS[0]);
        change();
        equal(cachedConvectiveMember(valid, '0_0', now), null);
        Object.assign(valid, fresh);
    }
});
Deno.test('same-window route/spot pushes use cache only, names and no coordinates or chart facts', async () => {
    const s = setup();
    await runWeatherWatch('storm', s.deps);
    equal(s.claims.length, 1);
    equal(s.requests, ['0_0']);
    equal(s.claims[0].p_source_at, new Date(now - H).toISOString());
    equal(s.claims[0].p_body.includes('3 of 3 models agree (ECMWF, ICON, UKMO)'), true);
    equal(s.claims[0].p_body.includes('lightning detection'), true);
    equal(Object.keys(s.claims[0]).some((k) => /lat|lon|chart/.test(k)), false);
});
Deno.test('morning uses boat-local hour and one deterministic two-line object', async () => {
    const s = setup();
    s.preferences.zone = 'Pacific/Auckland';
    s.preferences.hour = 20;
    await runWeatherWatch('morning', s.deps);
    equal(s.claims.length, 1);
    equal(s.claims[0].p_body.split('\n').length, 2);
    equal(s.claims[0].p_body.startsWith('Official warnings not checked'), true);
    s.claims.length = 0;
    s.preferences.zone = 'Asia/Kathmandu';
    s.preferences.hour = 12;
    await runWeatherWatch('morning', s.deps);
    equal(s.claims.length, 0);
});
Deno.test('expired positions, disabled features and missing forecast cache cannot fan out upstream', async () => {
    const s = setup();
    s.preferences.samples[0].expiresAt = now - 1;
    await runWeatherWatch('rain', s.deps);
    equal(s.claims.length, 0);
    equal(s.requests, []);
    s.preferences.samples[0].expiresAt = now + 1000;
    s.deps.forecasts = async () => [];
    await runWeatherWatch('storm', s.deps);
    equal(s.claims.length, 0);
    s.preferences.storm = false;
    await runWeatherWatch('storm', s.deps);
    equal(s.claims.length, 0);
});
Deno.test('rain uses actual response identity; snow and malformed/other-point payload are not rain arrival', async () => {
    const s = setup();
    await runWeatherWatch('rain', s.deps);
    equal(s.claims.length, 1);
    const body = (await s.deps.rain(0, 0))!;
    const snow = JSON.parse(JSON.stringify(body));
    for (const interval of snow.body.forecast) interval.precipType = 'snow';
    s.deps.rain = async () => snow;
    s.claims.length = 0;
    await runWeatherWatch('rain', s.deps);
    equal(s.claims.length, 0);
    s.deps.rain = async () => ({ ...body, body: { ...(body.body as object), latitude: 1 } });
    let failed = false;
    try {
        await runWeatherWatch('rain', s.deps);
    } catch {
        failed = true;
    }
    equal(failed, true);
    equal(s.ticks.at(-1), ['rain', false]);
});
Deno.test('only already-delivered official coverage suppresses a duplicate forecast notice', async () => {
    const s = setup();
    s.deps.official = async () => ({
        live: true,
        delivered: [{ provider: 'nws', infos: [{ event: 'Special Marine Warning' }] }],
    });
    await runWeatherWatch('storm', s.deps);
    equal(s.claims.length, 0);
    s.deps.official = async () => ({ live: true, delivered: [] });
    await runWeatherWatch('storm', s.deps);
    equal(s.claims.length, 1);
    await runWeatherWatch('morning', s.deps);
    equal(s.claims.at(-1)?.p_body.startsWith('Official warning:'), true);
});
Deno.test('cron has a service-only, empty fixed door before any work', async () => {
    const s = setup(),
        env = { get: (name: string) => name === 'SUPABASE_SERVICE_ROLE_KEY' ? 'synthetic-service-token' : undefined };
    const handle = createWeatherWatchHandler(['morning'], env, s.deps);
    const req = (body = '{}', auth = 'synthetic-service-token') =>
        new Request('https://fictional.invalid/morning-briefing', {
            method: 'POST',
            headers: { authorization: `Bearer ${auth}` },
            body,
        });
    equal((await handle(req('{}', 'wrong'))).status, 401);
    equal(s.ticks, []);
    equal((await handle(new Request('https://fictional.invalid/morning-briefing'))).status, 405);
    equal((await handle(req('{"lat":0,"lon":0}'))).status, 400);
    equal((await handle(req('x'.repeat(513)))).status, 400);
    equal((await handle(req())).status, 200);
});
Deno.test('provider auth stays in fixed header and redirect/body bounds apply', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetcher: typeof fetch = (_input, init) => {
        seen.push({ url: String(_input), init: init ?? {} });
        return Promise.resolve(
            new Response(JSON.stringify({ forecast: [] }), { headers: { 'content-type': 'application/json' } }),
        );
    };
    const deps = weatherWatchDependencies(
        {
            get: (n) => ({
                SUPABASE_URL: 'https://fictional.supabase.co',
                SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service',
                RAINBOW_API_KEY: 'synthetic-rainbow',
            }[n]),
        },
        fetcher,
        () => now,
    );
    await deps.rain(0, 0);
    equal(seen[0].url, 'https://api.rainbow.ai/nowcast/v1/precip-global/0.0000/0.0000');
    equal(seen[0].init.redirect, 'error');
    equal((seen[0].init.headers as Record<string, string>)['Ocp-Apim-Subscription-Key'], 'synthetic-rainbow');
    equal(seen[0].url.includes('synthetic'), false);
    const oversized = weatherWatchDependencies(
        {
            get: (n) => ({
                SUPABASE_URL: 'https://fictional.supabase.co',
                SUPABASE_SERVICE_ROLE_KEY: 'synthetic',
                RAINBOW_API_KEY: 'synthetic',
            }[n]),
        },
        () => Promise.resolve(new Response('x'.repeat(256001), { headers: { 'content-type': 'application/json' } })),
        () => now,
    );
    let failed = false;
    try {
        await oversized.rain(0, 0);
    } catch {
        failed = true;
    }
    equal(failed, true);
});
