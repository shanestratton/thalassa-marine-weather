import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { ReadableStream } from 'node:stream/web';
import { createHandler, parseAdmission, LOCAL_INTERPRETER, compileLocalQuery } from './gateway.mjs';
import {
    ownedOperationForQuery,
    parseOwnedOsmRequest,
    parseOwnedOsmDocument,
    queryForOwnedOsm,
} from '../../services/osm/ownedOverpassContract.ts';

// Fictional control fixtures. They are not an installed/native planet proof.
const now = Date.parse('2026-10-17T09:00:00Z'),
    sourceAt = '2026-10-16T00:00:00Z';
const token = 'fixture_'.repeat(5);
const operation = { schema: 1, kind: 'coastline', bbox: [-28, 152, -27, 153] };
const row = {
    schema: 1,
    complete: true,
    coverage: 'planet',
    licence: 'ODbL-1.0',
    sourceAt,
    sourceUrl: 'https://planet.openstreetmap.org/pbf/planet-261016.osm.pbf',
    sourceBytes: 1_000_000_001,
    sourceSha256: 'a'.repeat(64),
    cohortSha256: 'b'.repeat(64),
    nativeImportProofSha256: 'c'.repeat(64),
};
const admission = (value) => parseAdmission(Buffer.from(JSON.stringify(value ?? row)), now);
const doc = (elements) => ({ osm3s: { timestamp_osm_base: sourceAt }, elements: elements ?? [] });
const request = (
    body = operation,
    headers = { authorization: 'Bearer ' + token },
    url = '/osm/query',
    method = 'POST',
) =>
    new Request('http://127.0.0.1:8092' + url, {
        method,
        headers,
        ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    });
const handler = (options) => createHandler({ token, now: () => now, admission: async () => admission(), ...options });

test('only exact bounded operations rebuild existing known recipes', () => {
    for (const kind of ['overlay', 'seamarks', 'references', 'names', 'coastline', 'pilotage']) {
        const input = { ...operation, kind };
        assert.deepEqual(ownedOperationForQuery(queryForOwnedOsm(input)), input);
    }
    const query = queryForOwnedOsm(operation).replaceAll('-28,152,-27,153', '-28.0000,152.0000,-27.0000,153.0000');
    assert.deepEqual(ownedOperationForQuery(query), operation);
});

test('global, mixed, arbitrary, quoted-value mutation and oversized QL refuse', () => {
    for (const query of [
        '[out:json];nwr;out;',
        queryForOwnedOsm(operation) + 'node(0,0,1,1);out;',
        queryForOwnedOsm(operation).replace('coastline', 'coast line'),
        'x'.repeat(8193),
        queryForOwnedOsm(operation).replace('-28,152,-27,153', '-90,-180,90,180'),
    ])
        assert.throws(() => ownedOperationForQuery(query));
    for (const body of [
        { ...operation, query: 'out;' },
        { ...operation, url: 'http://metadata/' },
        { ...operation, bbox: [-90, -180, 90, 180] },
        { ...operation, bbox: [-28, 153, -27, 152] },
        { ...operation, kind: 'names', bbox: [-28.1, 152, -27.1, 153] },
    ])
        assert.equal(parseOwnedOsmRequest(body), null);
});

test('no auth/body or arbitrary path/method can reach interpreter', async () => {
    const h = handler({ fetcher: () => assert.fail('no interpreter request') });
    assert.equal((await h(request(operation, {}))).status, 401);
    assert.equal((await h(request(operation, { authorization: 'Bearer public-user-jwt' }))).status, 401);
    assert.equal((await h(request(operation, undefined, '/osm/query?url=other'))).status, 400);
    assert.equal((await h(request(operation, undefined, '/osm/query', 'GET'))).status, 400);
    assert.equal((await h(request({ schema: 1, query: 'nwr;out;' }))).status, 400);
});

test('missing full private database admission holds before interpreter read', async () => {
    const h = handler({
        admission: async () => {
            throw Error('not installed');
        },
        fetcher: () => assert.fail('no query'),
    });
    assert.equal((await h(request())).status, 503);
});

test('partial/rights/attic-clock/future/unknown native proof admission refuses', () => {
    for (const change of [
        { complete: false },
        { coverage: 'regional-facilities' },
        { licence: 'unknown' },
        { nativeImportProofSha256: '' },
        { sourceAt: '2026-10-18T00:00:00Z' },
        { sourceAt: '2026-02-30T00:00:00Z' },
        { sourceAt: '2026-01-01T00:00:00Z' },
        { sourceUrl: 'https://public-mirror/planet.pbf' },
        { sourceBytes: 100 },
    ])
        assert.throws(() => admission({ ...row, ...change }));
    assert.throws(() => parseAdmission(Buffer.alloc(8193), now));
});

test('qualified empty result retains original source clock and has no diagnostic echo', async () => {
    const calls = [];
    const h = handler({
        fetcher: async (url, init) => {
            calls.push([url, init]);
            return Response.json({ ...doc(), generator: 'private implementation', extra: 'do not echo' });
        },
    });
    const reply = await h(request());
    assert.equal(reply.status, 200);
    const body = await reply.json();
    assert.equal(body.thalassaSource.sourceAt, sourceAt);
    assert.equal(body.osm3s.timestamp_osm_base, sourceAt);
    assert.deepEqual(body.elements, []);
    assert.equal(body.extra, undefined);
    assert.equal(body.generator, undefined);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], LOCAL_INTERPRETER);
    assert.equal(calls[0][1].redirect, 'error');
    assert.equal(calls[0][1].headers.Authorization, undefined);
    assert.equal(calls[0][1].body, 'data=' + encodeURIComponent(compileLocalQuery(operation)));
    assert.match(compileLocalQuery(operation), /\[maxsize:134217728\]\[timeout:20\]/);
});

test('original element IDs and geometry are retained byte-for-value', async () => {
    const elements = [
        {
            type: 'way',
            id: 125,
            tags: { natural: 'coastline' },
            geometry: [
                { lat: -27.2, lon: 152.2 },
                { lat: -27.3, lon: 152.3 },
            ],
        },
    ];
    const reply = await handler({ fetcher: async () => Response.json(doc(elements)) })(request());
    assert.equal(reply.status, 200);
    assert.deepEqual((await reply.json()).elements, elements);
});

test('native partial remark, missing source clock and wrong cohort clocks never become empty success', async () => {
    for (const body of [
        { ...doc(), remark: 'runtime error' },
        { elements: [] },
        { ...doc(), osm3s: { timestamp_osm_base: '2026-10-17T00:00:00Z' } },
        doc([{ type: 'way', id: -1 }]),
        doc([{ type: 'area', id: 2 }]),
    ]) {
        let calls = 0;
        const h = handler({
            fetcher: async () => {
                calls++;
                return Response.json(body);
            },
        });
        assert.equal((await h(request())).status, 503);
        assert.equal(calls, 1);
    }
});

test('cohort retirement across an outstanding native query refuses adoption', async () => {
    let reads = 0;
    const h = handler({
        admission: async () => ({ ...admission(), rawSha256: String(reads++) }),
        fetcher: async () => Response.json(doc()),
    });
    assert.equal((await h(request())).status, 503);
    assert.equal(reads, 2);
});

test('oversize input/body and crowded complete-inventory sentinel refuse without fallback', async () => {
    let calls = 0;
    const fetcher = async () => {
        calls++;
        return new Response('{}', { headers: { 'content-length': '20000001' } });
    };
    const h = handler({ fetcher });
    assert.equal((await h(request('x'.repeat(4097)))).status, 503);
    assert.equal(calls, 0);
    assert.equal((await h(request())).status, 503);
    assert.equal(calls, 1);
    assert.equal(
        parseOwnedOsmDocument(
            {
                ...doc(Array(3001).fill({ type: 'node', id: 1 })),
                thalassaSource: {
                    schema: 1,
                    complete: true,
                    licence: 'ODbL-1.0',
                    sourceAt,
                    cohortSha256: 'b'.repeat(64),
                },
            },
            { ...operation, kind: 'seamarks' },
            now,
        ).queryComplete,
        false,
    );
});

test('HTTP/transport failure has one attempt, no source URL/bearer/body echo', async () => {
    for (const fetcher of [
        async () => new Response('private echo', { status: 500 }),
        async () => {
            throw Error('private position / secret');
        },
    ]) {
        const reply = await handler({ fetcher })(request());
        assert.equal(reply.status, 503);
        assert.deepEqual(await reply.json(), { code: 'OWN_OSM_UNAVAILABLE' });
    }
});

test('ignored abort header stall stays bounded and keeps its lease until actual retirement', async () => {
    let release,
        calls = 0;
    const h = handler({
        deadlineMs: 10,
        fetcher: async () => {
            calls++;
            return new Promise((resolve) => {
                release = resolve;
            });
        },
    });
    assert.equal((await h(request())).status, 503);
    assert.equal((await h(request())).status, 429);
    assert.equal(calls, 1);
    release(Response.json(doc()));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // No second request is automatically started when the orphan retires.
    assert.equal(calls, 1);
});

test('body stall is inside deadline, not a fabricated qualified empty result', async () => {
    let close;
    const h = handler({
        deadlineMs: 10,
        fetcher: async () =>
            new Response(
                new ReadableStream({
                    start(c) {
                        close = () => c.close();
                    },
                }),
            ),
    });
    assert.equal((await h(request())).status, 503);
    assert.equal((await h(request())).status, 429);
    close();
    await new Promise((resolve) => setTimeout(resolve, 0));
});

test('an explicitly retired caller cannot start a local interpreter query', async () => {
    const controller = new AbortController();
    controller.abort();
    const req = new Request('http://127.0.0.1:8092/osm/query', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token },
        body: JSON.stringify(operation),
        signal: controller.signal,
    });
    assert.equal((await handler({ fetcher: () => assert.fail('retired intent') })(req)).status, 503);
});
