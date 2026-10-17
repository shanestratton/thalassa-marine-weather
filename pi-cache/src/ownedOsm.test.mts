import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { fetchOwnedOsmEdge, type OwnedOsmFetch } from './ownedOsm.js';
import type { ProxyConfig } from './proxy.js';
import { OWN_OSM_MAX_BYTES } from './ownedOsmContract.js';

// Fictional cohort: no installed full-planet/admission claim.
const sourceAt = new Date(Math.floor((Date.now() - 86400_000) / 1000) * 1000).toISOString();
const operation = {
    schema: 1 as const,
    kind: 'overlay' as const,
    bbox: [-28, 153, -27, 154] as [number, number, number, number],
};
const document = {
    elements: [],
    osm3s: { timestamp_osm_base: sourceAt },
    thalassaSource: {
        schema: 1,
        complete: true,
        licence: 'ODbL-1.0',
        sourceAt,
        cohortSha256: 'a'.repeat(64),
    },
};
const config: ProxyConfig = { supabaseUrl: 'https://project.example', supabaseAnonKey: 'public-test-key' };

test('Pi uses only existing public Edge credentials and retains original qualified source clock', async () => {
    const calls: unknown[][] = [];
    const fetcher: OwnedOsmFetch = async (...args) => {
        calls.push(args);
        return Response.json(document);
    };
    const actual = await fetchOwnedOsmEdge(config, operation, undefined, fetcher);
    assert.equal(actual.thalassaSource.sourceAt, sourceAt);
    assert.equal(actual.queryComplete, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'https://project.example/functions/v1/owned-overpass');
    const init = calls[0][1] as { body: string; headers: Record<string, string> };
    assert.deepEqual(JSON.parse(init.body), operation);
    assert.equal(init.headers.Authorization, 'Bearer public-test-key');
    assert.ok(!init.body.includes('out:json'));
    assert.ok(!JSON.stringify(init).includes('THALASSA_WX_OSM_TOKEN'));
});

test('Pi refuses pre-retired intent and missing current configuration before sending', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const fetcher: OwnedOsmFetch = async () => {
        calls++;
        return Response.json(document);
    };
    await assert.rejects(fetchOwnedOsmEdge(config, operation, controller.signal, fetcher));
    await assert.rejects(fetchOwnedOsmEdge({ ...config, supabaseAnonKey: '' }, operation, undefined, fetcher));
    assert.equal(calls, 0);
});

test('Pi keeps rejected, invalid, oversized and unqualified replies unavailable without another source', async () => {
    for (const reply of [
        new Response('no', { status: 503 }),
        new Response('{'),
        new Response('{}', { headers: { 'content-length': String(OWN_OSM_MAX_BYTES + 1) } }),
        Response.json({ elements: [] }),
        Response.json({ ...document, remark: 'partial' }),
        Response.json({ ...document, osm3s: { timestamp_osm_base: '2020-01-01T00:00:00Z' } }),
    ]) {
        let calls = 0;
        await assert.rejects(
            fetchOwnedOsmEdge(config, operation, undefined, async () => {
                calls++;
                return reply;
            }),
        );
        assert.equal(calls, 1);
    }
});

test('Pi bounds an ignored-abort body and cancels the actual reader', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let cancelled = 0;
    const fetcher: OwnedOsmFetch = async () =>
        new Response(
            new ReadableStream({
                cancel() {
                    cancelled++;
                },
            }),
        );
    const refused = assert.rejects(fetchOwnedOsmEdge(config, operation, undefined, fetcher));
    await nextTurn();
    t.mock.timers.tick(25_000);
    await refused;
    assert.equal(cancelled, 1);
});

test('Pi closing a caller lease refuses a late ignored-abort body', async () => {
    const controller = new AbortController();
    let release!: (value: Response) => void,
        cancelled = 0;
    const fetcher: OwnedOsmFetch = () =>
        new Promise((resolve) => {
            release = resolve;
        });
    const refused = assert.rejects(fetchOwnedOsmEdge(config, operation, controller.signal, fetcher));
    await nextTurn();
    controller.abort();
    await refused;
    release(
        new Response(
            new ReadableStream({
                cancel() {
                    cancelled++;
                },
            }),
        ),
    );
    await nextTurn();
    assert.equal(cancelled, 1);
});
