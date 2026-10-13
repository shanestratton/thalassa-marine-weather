/**
 * Reverse geocodes are no longer cached (127-C-d decision 13, Mapbox Product
 * Terms §2.7.2: no storing or caching temporary geocodes). Every lookup goes
 * upstream and nothing is written to the kv cache; a one-time start-up purge
 * removes the geocode rows earlier builds kept, and nothing else.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import express from 'express';
import { Cache } from '../cache.js';
import { createMiscRoutes, purgeGeocodeCache } from './misc.js';

const config = { supabaseUrl: 'https://fictional.example.org', supabaseAnonKey: 'anon' };

test('two lookups of the same rounded point make two upstream fetches and write no kv row', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'geocode-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const cache = new Cache(dir);
    t.after(() => cache.close());
    const upstream: string[] = [];
    const app = express();
    app.use(
        '/api/misc',
        createMiscRoutes(cache, config, {
            fetchJson: async (url) => {
                upstream.push(url);
                return { place: 'The Solent' };
            },
        }),
    );
    const server = app.listen(0);
    t.after(() => server.close());
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/misc`;
    for (const [lat, lon] of [
        ['50.7712', '-1.3011'],
        ['50.7698', '-1.2995'],
    ]) {
        const res = await fetch(`${base}/geocode?lat=${lat}&lon=${lon}`);
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { place: 'The Solent' });
        assert.equal(res.headers.get('x-cache'), null, 'never says HIT or MISS: there is no cache');
    }
    assert.equal(upstream.length, 2);
    assert.match(upstream[0], /lat=50\.77/);
    assert.equal(cache.getStats().kvEntries, 0);
});

test('the start-up purge removes geocode rows only', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'geocode-purge-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const cache = new Cache(dir);
    t.after(() => cache.close());
    cache.set('geocode:50.77:-1.3', { place: 'The Solent' }, 60_000);
    cache.set('geocode:-41.29:174.78', { place: 'Wellington Harbour' }, 60_000);
    cache.set('tides:station:1', { extremes: [] }, 60_000);
    cache.set('geocodex:not-a-geocode', { other: true }, 60_000);
    assert.equal(purgeGeocodeCache(cache), 2);
    assert.equal(cache.get('geocode:50.77:-1.3'), null);
    assert.ok(cache.get('tides:station:1'));
    assert.ok(cache.get('geocodex:not-a-geocode'));
    assert.equal(purgeGeocodeCache(cache), 0);
});
