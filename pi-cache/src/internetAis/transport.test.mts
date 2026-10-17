import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConnection, createServer } from 'node:net';
import { once } from 'node:events';
import { createInternetAisTcp, internetAisEndpoint, internetAisFetcher } from './transport.js';
import { Response } from 'undici';
import { internetAisAuthority } from './publisher.js';
import { startInternetAisRuntime } from './runtime.js';

test('actual response stream enforces bytes/chunks/abort and uses only the fixed reader with scoped headers', async () => {
    const authority = internetAisAuthority({
        enabled: true,
        reviewed: true,
        allowInternet: true,
        generation: 1,
        anonKey: 'synthetic-public',
        credentials: {
            ownerId: '11111111-1111-4111-8111-111111111111',
            relayId: 'synthetic-relay-0001',
            token: 'a'.repeat(64),
        },
    })!;
    const request = {
        schema: 1 as const,
        lat: -27.2,
        lon: 153.1,
        measuredAt: Date.now(),
        ownMmsi: 503111111,
        radiusNm: 25 as const,
        limit: 100 as const,
    };
    const endpoint = internetAisEndpoint('https://synthetic.supabase.co');
    const controller = new AbortController();
    const fetcher = internetAisFetcher(endpoint, async (url, init) => {
        assert.equal(url, endpoint);
        assert.equal(init.redirect, 'error');
        assert.equal(init.signal, controller.signal);
        assert.equal(JSON.parse(String(init.body)).measuredAt, request.measuredAt);
        assert.ok(JSON.stringify(init.headers).includes('X-Thalassa-Pi-Relay-Id'));
        return new Response('{"schema":1}');
    });
    assert.deepEqual(await fetcher(request, authority, controller.signal), { schema: 1 });
    for (const response of [
        new Response('x'.repeat(131073)),
        new Response(
            new ReadableStream<Uint8Array>({
                start(c) {
                    c.enqueue(new Uint8Array());
                },
            }),
        ),
        new Response('{}', { status: 503 }),
    ]) {
        await assert.rejects(internetAisFetcher(endpoint, async () => response)(request, authority, controller.signal));
    }
    let cancelled = false;
    const never = internetAisFetcher(
        endpoint,
        async () =>
            new Response(
                new ReadableStream<Uint8Array>({
                    pull: () => new Promise(() => undefined),
                    cancel: () => {
                        cancelled = true;
                        return new Promise(() => undefined);
                    },
                }),
            ),
    );
    const reading = never(request, authority, controller.signal);
    controller.abort();
    await assert.rejects(reading);
    assert.equal(cancelled, true);
});

test('fixed HTTPS source endpoint refuses URL/path/credential variants and the runtime has no default activation', () => {
    assert.equal(
        internetAisEndpoint('https://synthetic.supabase.co'),
        'https://synthetic.supabase.co/functions/v1/pi-internet-ais',
    );
    for (const url of [
        'http://synthetic.supabase.co',
        'https://user:secret@synthetic.supabase.co',
        'https://synthetic.supabase.co/path',
    ])
        assert.throws(() => internetAisEndpoint(url));
    assert.equal(
        startInternetAisRuntime({
            enabled: false,
            reviewed: true,
            port: 10112,
            blockedPorts: [],
            supabaseOrigin: 'https://synthetic.supabase.co',
            authority: () => null,
            fix: async () => null,
        }),
        null,
    );
    assert.equal(
        startInternetAisRuntime({
            enabled: true,
            reviewed: false,
            port: 10112,
            blockedPorts: [],
            supabaseOrigin: 'https://synthetic.supabase.co',
            authority: () => null,
            fix: async () => null,
        }),
        null,
    );
});
test('actual loopback TCP carries only admitted tagged JSON, refuses client commands and retires sockets on authority loss', async (t) => {
    let admitted = true;
    const tcp = createInternetAisTcp({ beforeClient: () => admitted });
    tcp.server.listen(0, '127.0.0.1');
    await once(tcp.server, 'listening');
    const address = tcp.server.address();
    assert.ok(address && typeof address !== 'string');
    const client = createConnection({ host: '127.0.0.1', port: address.port });
    client.on('error', () => undefined);
    t.after(() => {
        client.destroy();
        tcp.close();
    });
    await once(client, 'connect');
    await new Promise<void>((resolve) => setImmediate(resolve));
    const received = once(client, 'data');
    tcp.emit('{"updates":[{"$source":"thalassa-internet-ais.aisstream"}]}\n', () => true);
    assert.match(String((await received)[0]), /thalassa-internet-ais/);
    const closed = once(client, 'close');
    client.write('stand down');
    await closed;
    const active = createConnection({ host: '127.0.0.1', port: address.port });
    active.on('error', () => undefined);
    await once(active, 'connect');
    await new Promise<void>((resolve) => setImmediate(resolve));
    const retired = once(active, 'close');
    tcp.retire();
    await retired;
    admitted = false;
    const refused = createConnection({ host: '127.0.0.1', port: address.port });
    refused.on('error', () => undefined);
    await once(refused, 'close');
    assert.equal(tcp.clients(), 0);
});
test('an actual occupied optional port holds this listener without closing the unrelated running service', async (t) => {
    const existing = createServer();
    existing.listen(0, '127.0.0.1');
    await once(existing, 'listening');
    t.after(() => existing.close());
    const address = existing.address();
    assert.ok(address && typeof address !== 'string');
    const optional = startInternetAisRuntime({
        enabled: true,
        reviewed: true,
        port: address.port,
        blockedPorts: [],
        supabaseOrigin: 'https://synthetic.supabase.co',
        authority: () => null,
        fix: async () => null,
    });
    assert.ok(optional);
    const error = await once(optional.server, 'error');
    assert.equal((error[0] as NodeJS.ErrnoException).code, 'EADDRINUSE');
    assert.equal(existing.listening, true);
    assert.equal(optional.server.listening, false);
    optional.close();
});
