import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Barometer, BAROMETER_HISTORY_MS } from './barometer.js';

const NOW = Date.UTC(2026, 9, 14, 12);
const MIN = 60_000;
const directory = () => mkdtemp(join(tmpdir(), 'thalassa-pressure-'));
test('BMP390 wins; Signal K fallback uses Pa and the original fresh timestamp', async () => {
    const dir = await directory();
    let now = NOW;
    let fail = false;
    const calls: string[] = [];
    const baro = new Barometer(dir, {
        now: () => now,
        readSensor: async () => {
            if (fail) throw new Error('no sensor');
            return { pressure_hpa: 1013, temp_c: 25 };
        },
        readPosition: async () => ({ lat: -16, lon: 146 }),
        fetchImpl: (async (url: string | URL | Request) => {
            calls.push(String(url));
            return new Response(JSON.stringify({ value: 101250, timestamp: new Date(now - 15_000).toISOString() }));
        }) as typeof fetch,
    });
    try {
        await baro.start();
        baro.stop();
        assert.equal(baro.state().latest!.source, 'bmp390');
        assert.equal(calls.length, 0);
        fail = true;
        now += MIN;
        await baro.sample();
        assert.equal(baro.state().latest!.source, 'signalk');
        assert.equal(baro.state().latest!.hpa, 1012.5);
        assert.equal(baro.state().latest!.at, now - 15_000);
        assert.equal(baro.state().latest!.lat, -16);
        assert.match(calls[0], /environment\/outside\/pressure$/);
        // Polling the same leaf must not manufacture new observations.
        await baro.sample();
        assert.equal(baro.state().samples.length, 2);
    } finally {
        baro.stop();
        await rm(dir, { recursive: true, force: true });
    }
});
test('stale, future, un-timestamped and impossible bus values do not become live pressure', async () => {
    const dir = await directory();
    let leaf: unknown = {};
    const baro = new Barometer(dir, {
        now: () => NOW,
        readSensor: async () => {
            throw new Error('absent');
        },
        readPosition: async () => null,
        fetchImpl: (async () => new Response(JSON.stringify(leaf))) as typeof fetch,
    });
    try {
        for (const candidate of [
            { value: 101300, timestamp: new Date(NOW - 3 * MIN).toISOString() },
            { value: 101300, timestamp: new Date(NOW + MIN).toISOString() },
            { value: 101300 },
            { value: 15, timestamp: new Date(NOW).toISOString() },
        ]) {
            leaf = candidate;
            await baro.sample();
            assert.equal(baro.state().available, false);
        }
        assert.equal(baro.state().samples.length, 0);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
test('ten-day history survives restart and a torn append, with bounded daily retention', async () => {
    const dir = await directory();
    const hist = join(dir, 'barometer');
    await mkdir(hist);
    for (let day = 12; day >= 0; day--) {
        const at = NOW - day * 24 * 60 * MIN;
        const sample = { hpa: 1010 + day / 10, at, tempC: 20, source: 'bmp390' };
        await writeFile(
            join(hist, 'pressure-' + new Date(at).toISOString().slice(0, 10) + '.jsonl'),
            JSON.stringify(sample) + '\n',
        );
    }
    const today = join(hist, 'pressure-2026-10-14.jsonl');
    await appendFile(today, '{"hpa":10'); // simulated power loss mid-write
    const before = await readFile(today, 'utf8');
    const options = {
        now: () => NOW + MIN,
        readSensor: async () => ({ pressure_hpa: 1012 }),
        readPosition: async () => null,
    };
    const baro = new Barometer(dir, options);
    try {
        await baro.start();
        baro.stop();
        assert.equal(baro.state().samples.length, 11); // 9 full prior days + today + new minute
        assert.ok(baro.state().samples.every((s) => s.at >= NOW + MIN - BAROMETER_HISTORY_MS));
        assert.ok((await readFile(today, 'utf8')).startsWith(before)); // append, never whole-history rewrite
        assert.equal((await readdir(hist)).length, 11);
        const reboot = new Barometer(dir, { ...options, now: () => NOW + 2 * MIN });
        await reboot.start();
        reboot.stop();
        assert.equal(reboot.state().samples.length, 12);
    } finally {
        baro.stop();
        await rm(dir, { recursive: true, force: true });
    }
});
