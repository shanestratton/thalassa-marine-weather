import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createSignalKClient, SignalKClientError, type SignalKCourseRequest } from './signalKClient.js';

const ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'fictional-device-access-token';
const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
async function server(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
    run: (origin: string) => Promise<void>,
) {
    const app = createServer(handler);
    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
    const address = app.address();
    assert(address && typeof address === 'object');
    try {
        await run(`http://127.0.0.1:${address.port}`);
    } finally {
        app.closeAllConnections();
        await new Promise<void>((resolve, reject) => app.close((error) => (error ? reject(error) : resolve())));
    }
}

test('actual local HTTP request uses fixed v2 resource, JSON and Bearer header', async () => {
    let requests = 0;
    await server(
        (req, res) => {
            requests++;
            assert.equal(req.url, `/signalk/v2/api/resources/routes/${ID}`);
            assert.equal(req.method, 'PUT');
            assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
            assert.equal(req.headers.cookie, undefined);
            const chunks: Buffer[] = [];
            req.on('data', (chunk) => chunks.push(chunk));
            req.on('end', () => {
                assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), {
                    name: 'Fictional route',
                    feature: { type: 'FeatureCollection', features: [] },
                });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end('{"state":"COMPLETED"}');
            });
        },
        async (origin) => {
            const client = createSignalKClient({ origin, accessToken: TOKEN });
            assert.deepEqual(
                await client.requestCourse({
                    target: 'route',
                    routeId: ID,
                    method: 'PUT',
                    body: { name: 'Fictional route', feature: { type: 'FeatureCollection', features: [] } },
                }),
                { status: 200, body: { state: 'COMPLETED' } },
            );
        },
    );
    assert.equal(requests, 1);
});

test('actual redirect cannot forward authorization to a second server', async () => {
    let escaped = 0;
    await server(
        (_req, res) => {
            escaped++;
            res.end('{}');
        },
        async (other) => {
            await server(
                (_req, res) => {
                    res.writeHead(302, { Location: `${other}/credentials` });
                    res.end();
                },
                async (origin) => {
                    const client = createSignalKClient({ origin, accessToken: TOKEN });
                    await assert.rejects(
                        client.getSelf(),
                        (error: unknown) =>
                            error instanceof SignalKClientError &&
                            error.code === 'unavailable' &&
                            !error.message.includes(TOKEN),
                    );
                },
            );
        },
    );
    assert.equal(escaped, 0);
});

test('configuration refuses embedded credentials, paths, public plaintext and prefix-host tricks', () => {
    for (const origin of [
        'https://user:pass@example.test',
        'https://example.test/path',
        'https://example.test?token=secret',
        'https://example.test#x',
        'file:///tmp/foo',
        'http://example.test',
        'http://10.evil.test',
    ]) {
        assert.throws(() => createSignalKClient({ origin, allowInsecureLan: true }), SignalKClientError);
    }
    assert.throws(() => createSignalKClient({ origin: 'http://192.168.1.1' }), SignalKClientError);
    assert.equal(
        createSignalKClient({ origin: 'http://192.168.1.1', allowInsecureLan: true }).origin,
        'http://192.168.1.1',
    );
    assert.throws(
        () => createSignalKClient({ origin: 'https://example.test', accessToken: 'token\r\nInjected: x' }),
        SignalKClientError,
    );
});

test('readonly default never sends a write without explicit approved access token', async () => {
    let calls = 0;
    const client = createSignalKClient({
        origin: 'http://127.0.0.1:3000',
        fetchImpl: async () => {
            calls++;
            return json({});
        },
    });
    await assert.rejects(
        client.requestCourse({ target: 'activeRoute', method: 'PUT', body: { href: `/resources/routes/${ID}` } }),
        (error: unknown) => error instanceof SignalKClientError && error.code === 'auth',
    );
    await assert.rejects(client.requestCourse({ target: 'course', method: 'DELETE' }), SignalKClientError);
    assert.deepEqual(await client.getSelf(), { status: 200, body: {} });
    assert.equal(calls, 1);
});

test('only reviewed target/method pairs can reach fetch; IDs cannot become URLs or model paths', async () => {
    let calls = 0;
    const client = createSignalKClient({
        origin: 'https://example.test',
        accessToken: TOKEN,
        fetchImpl: async () => {
            calls++;
            return json({});
        },
    });
    const invalid = [
        { target: 'course', method: 'PUT', body: {} },
        { target: 'activeRoute', method: 'GET' },
        { target: 'activeRoute', method: 'DELETE' },
        { target: 'route', method: 'DELETE', routeId: ID },
        { target: 'route', method: 'GET', routeId: 'https://evil.test' },
        { target: 'route', method: 'GET', routeId: '../navigation/autopilot' },
        { target: 'autopilot', method: 'PUT', body: {} },
        { target: 'course', method: 'POST' },
        { target: 'course', method: 'GET', routeId: ID },
        { target: 'course', method: 'GET', body: {} },
    ];
    for (const request of invalid)
        await assert.rejects(client.requestCourse(request as SignalKCourseRequest), SignalKClientError);
    assert.equal(calls, 0);
});

test('course read and explicit clear use exactly the same course endpoint and no request body', async () => {
    const paths: string[] = [];
    const client = createSignalKClient({
        origin: 'https://example.test',
        accessToken: TOKEN,
        fetchImpl: async (url, init) => {
            paths.push(`${init?.method} ${url}`);
            assert.equal(init?.body, undefined);
            assert.equal(init?.redirect, 'error');
            assert.equal(init?.credentials, 'omit');
            return init?.method === 'DELETE' ? new Response(null, { status: 204 }) : json({ activeRoute: null });
        },
    });
    await client.requestCourse({ target: 'course', method: 'GET' });
    assert.deepEqual(await client.requestCourse({ target: 'course', method: 'DELETE' }), { status: 204, body: null });
    assert.deepEqual(paths, [
        'GET https://example.test/signalk/v2/api/vessels/self/navigation/course',
        'DELETE https://example.test/signalk/v2/api/vessels/self/navigation/course',
    ]);
});

test('rejects oversized or nonfinite/cyclic/prototype request bodies before fetch', async () => {
    let calls = 0;
    const client = createSignalKClient({
        origin: 'https://example.test',
        accessToken: TOKEN,
        fetchImpl: async () => {
            calls++;
            return json({});
        },
    });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const body of [
        { name: 'x'.repeat(32769) },
        { value: NaN },
        { value: Infinity },
        cycle,
        JSON.parse('{"__proto__":{"polluted":true}}'),
        undefined,
    ]) {
        await assert.rejects(client.requestCourse({ target: 'activeRoute', method: 'PUT', body }), SignalKClientError);
    }
    assert.equal(calls, 0);
    assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test('bounds course responses to 64KiB including chunked bodies; allows separate 1MiB self documents', async () => {
    const large = { readings: 'x'.repeat(70_000) };
    const client = createSignalKClient({
        origin: 'https://example.test',
        accessToken: TOKEN,
        fetchImpl: async () => json(large),
    });
    await assert.rejects(
        client.requestCourse({ target: 'course', method: 'GET' }),
        (error: unknown) => error instanceof SignalKClientError && error.code === 'response',
    );
    assert.deepEqual((await client.getSelf()).body, large);
    const tooLarge = createSignalKClient({
        origin: 'https://example.test',
        fetchImpl: async () => json({ readings: 'x'.repeat(1024 * 1024) }),
    });
    await assert.rejects(tooLarge.getSelf(), SignalKClientError);
});

test('rejects malformed JSON, invalid UTF8, nonJSON MIME and returned-origin mismatch', async () => {
    for (const response of [
        new Response('{', { headers: { 'Content-Type': 'application/json' } }),
        new Response(Uint8Array.from([0xff]), { headers: { 'Content-Type': 'application/json' } }),
        new Response('{}', { headers: { 'Content-Type': 'text/html' } }),
        new Response('{}', { status: 302, headers: { 'Content-Type': 'application/json' } }),
    ]) {
        const client = createSignalKClient({ origin: 'https://example.test', fetchImpl: async () => response });
        await assert.rejects(client.getSelf(), SignalKClientError);
    }
    const moved = json({});
    Object.defineProperty(moved, 'url', { value: 'https://other.test/signalk/v1/api/vessels/self' });
    await assert.rejects(
        createSignalKClient({ origin: 'https://example.test', fetchImpl: async () => moved }).getSelf(),
        SignalKClientError,
    );
});

test('upstream authorization errors reveal status only, never response text', async () => {
    const client = createSignalKClient({
        origin: 'https://example.test',
        accessToken: TOKEN,
        fetchImpl: async () => new Response(`sensitive ${TOKEN}`, { status: 403 }),
    });
    assert.deepEqual(await client.requestCourse({ target: 'course', method: 'GET' }), { status: 403, body: null });
});

test('external cancellation settles even a nonconforming fetch and sends no pre-aborted request', async () => {
    let calls = 0,
        seenSignal: AbortSignal | undefined;
    const client = createSignalKClient({
        origin: 'https://example.test',
        fetchImpl: async (_url, init) => {
            calls++;
            seenSignal = init?.signal ?? undefined;
            return new Promise<Response>(() => undefined);
        },
    });
    const abort = new AbortController();
    const result = client.getSelf({ signal: abort.signal });
    abort.abort();
    await assert.rejects(result, (error: unknown) => error instanceof SignalKClientError && error.code === 'cancelled');
    assert.equal(seenSignal?.aborted, true);
    await assert.rejects(client.getSelf({ signal: abort.signal }), SignalKClientError);
    assert.equal(calls, 1);
});

test('hard ten-second deadline settles stalled fetch without leaking provider error details', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const client = createSignalKClient({
        origin: 'https://example.test',
        fetchImpl: async () => new Promise<Response>(() => undefined),
    });
    const result = client.getSelf();
    const proof = assert.rejects(
        result,
        (error: unknown) => error instanceof SignalKClientError && error.code === 'timeout',
    );
    context.mock.timers.tick(10_000);
    await proof;
});
