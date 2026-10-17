import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import express from 'express';
import type { Cache } from '../cache.js';
import type { cachedJsonFetch } from '../proxy.js';
import { marineEnvelopeV2 } from '../marine/marine-v2.js';
import { createWeatherRoutes } from './weather.js';

const point = { latitude: -27.1234, longitude: 153.4567 };
const config = { supabaseUrl: 'https://pcisdplnodrphauixcau.supabase.co', supabaseAnonKey: 'fictional-public-anon' };
function sample(kind: 'waves' | 'motion', at: number) {
    const values: Record<string, number> =
        kind === 'waves'
            ? { wave_height: 1.5, wave_period: 8, wave_direction: 270 }
            : { sea_surface_temperature: 21, ocean_current_velocity: 3.6, ocean_current_direction: 45 };
    const units: Record<string, string> = {
        wave_height: 'm',
        wave_period: 's',
        wave_direction: '°',
        sea_surface_temperature: '°C',
        ocean_current_velocity: 'km/h',
        ocean_current_direction: '°',
    };
    const time = Math.floor(at / 3600000) * 3600;
    return {
        ...point,
        utc_offset_seconds: 0,
        current: { time, interval: 900, ...values },
        hourly: {
            time: [time, time + 3600],
            ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, [value, value]])),
        },
        current_units: { time: 'unixtime', interval: 'seconds', ...units },
        hourly_units: { time: 'unixtime', ...units },
    };
}
test('real marine route keeps source receipt and exact schema/cache/upstream boundary', async (t) => {
    const at = Date.now(),
        calls: Parameters<typeof cachedJsonFetch>[1][] = [];
    const data = marineEnvelopeV2(point, at, sample('waves', at), sample('motion', at));
    const app = express();
    app.use(
        '/api/weather',
        createWeatherRoutes({} as Cache, config, {
            marineFetch: async (_cache, options) => {
                calls.push(options);
                return { data, fromCache: true, stale: false };
            },
        }),
    );
    const server = app.listen(0, '127.0.0.1');
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const get = (query = `schema=2&lat=${point.latitude}&lon=${point.longitude}`) =>
        fetch(`${origin}/api/weather/marine?${query}`);
    const response = await get();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-cache'), 'HIT');
    const result = (await response.json()) as typeof data;
    assert.equal(result.fetched_at_ms, at);
    assert.equal(result.waves?.current.wave_height, 1.5);
    assert.equal(result.motion?.current.sea_surface_temperature, 21);
    assert.equal(calls.length, 1);
    const options = calls[0],
        url = new URL(options.url);
    assert.equal(url.origin, config.supabaseUrl);
    assert.equal(url.pathname, '/functions/v1/get-marine');
    assert.deepEqual(Object.fromEntries(url.searchParams), { lat: '-27.1234', lon: '153.4567', schema: '2' });
    assert.equal(options.cacheKey, 'weather:marine:v2:-27.1234:153.4567');
    assert.equal(options.ttlMs, 300000);
    assert.equal(options.staleWindowMs, 0);
    assert.equal(options.timeout, 4000);
    assert.equal(options.method, undefined);
    assert.equal(options.body, undefined);
    for (const query of [
        'schema=3&lat=1&lon=2',
        'schema=2&lat=91&lon=2',
        'schema=2&lat=1&lon=181',
        'schema=2&lat[]=1&lon=2',
        'schema=2&lat=NaN&lon=2',
        'schema=2&lat=1&lon=',
    ])
        assert.equal((await get(query)).status, 400, query);
    assert.equal(calls.length, 1, 'bad caller context never reaches upstream');
});
for (const mode of ['stale', 'old-receipt', 'legacy', 'wrong-point', 'empty'] as const)
    test(`real marine route refuses ${mode} without restamping`, async (t) => {
        const at = Date.now(),
            data = marineEnvelopeV2(point, at, sample('waves', at), null) as unknown as Record<string, unknown>;
        if (mode === 'old-receipt') data.fetched_at_ms = at - 3600001;
        if (mode === 'legacy') delete data.marine_schema;
        if (mode === 'wrong-point') data.requested = { latitude: 1, longitude: 2 };
        if (mode === 'empty') data.waves = null;
        const app = express();
        app.use(
            '/api/weather',
            createWeatherRoutes({} as Cache, config, {
                marineFetch: async () => ({ data, fromCache: true, stale: mode === 'stale' }),
            }),
        );
        const server = app.listen(0, '127.0.0.1');
        t.after(() => {
            server.closeAllConnections();
            server.close();
        });
        await new Promise<void>((resolve) => server.once('listening', resolve));
        const response = await fetch(
            `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/weather/marine?schema=2&lat=${point.latitude}&lon=${point.longitude}`,
        );
        assert.equal(response.status, 502);
        if (mode === 'old-receipt') assert.equal(data.fetched_at_ms, at - 3600001);
    });
