import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createServer, type Socket } from 'node:net';
import { RadarRawReader } from './radar/rawReader.js';
import { createRadarRoutes } from './routes/radar.js';
import express from 'express';
const T = Date.UTC(2026, 0, 2, 12);
const frame = (body: string) =>
    `$${body}*${[...body]
        .reduce((v, c) => v ^ c.charCodeAt(0), 0)
        .toString(16)
        .padStart(2, '0')}\r\n`;
const echo = frame('RATLL,1,5030.000,N,00115.000,W,Generated,120000,T,');
const wait = async (fn: () => boolean) => {
    for (let i = 0; i < 200; i++) {
        if (fn()) return;
        await new Promise((r) => setTimeout(r, 5));
    }
    assert.fail('bounded socket wait timed out');
};
test('radar reader is explicit and loopback-only; HTTP cannot activate an unconfigured input', () => {
    assert.throws(() => new RadarRawReader({ host: '192.0.2.1' as '127.0.0.1', port: 10110 }));
    for (const port of [-1, 0, 1.5, 65536]) assert.throws(() => new RadarRawReader({ port }));
    const reader = new RadarRawReader({ now: () => T });
    reader.start('generated-context');
    assert.deepEqual(reader.snapshot(), {
        schema: 1,
        source: 'radar',
        configured: false,
        connected: false,
        overloaded: false,
        feedId: null,
        servedAt: T,
        lastFrameAt: null,
        lastTargetAt: null,
        ownship: null,
        observations: [],
    });
    reader.stop();
});
test('actual local TCP input preserves original times, bounded framing, and independent replacement sessions', async (t) => {
    const clients: Socket[] = [];
    const server = createServer((socket) => {
        clients.push(socket);
        socket.on('error', () => {});
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    let now = T;
    const reader = new RadarRawReader({ port: (server.address() as { port: number }).port, now: () => now });
    t.after(async () => {
        reader.stop();
        clients.forEach((s) => s.destroy());
        await new Promise<void>((r) => server.close(() => r()));
    });
    reader.start('pair-a:vessel-a');
    await wait(() => reader.snapshot().connected);
    clients[0].write('x'.repeat(4096) + '\r\n' + echo.slice(0, 20));
    clients[0].write(echo.slice(20));
    await wait(() => reader.snapshot().observations.length === 1);
    const first = reader.snapshot();
    assert.equal(first.observations[0].receivedAt, T);
    assert.match(first.feedId!, /^pi:[a-f0-9]{32}$/);
    now += 16000;
    const aged = reader.snapshot();
    assert.equal(aged.servedAt, T + 16000);
    assert.equal(aged.observations[0].receivedAt, T);
    reader.start('pair-b:vessel-a');
    await wait(() => clients.length === 2 && reader.snapshot().connected);
    assert.notEqual(reader.snapshot().feedId, first.feedId);
    assert.equal(reader.snapshot().observations.length, 0);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(reader.snapshot().connected, true, 'old socket close must not retire its successor');
    reader.stop();
    assert.equal(reader.snapshot().feedId, null);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(reader.snapshot().connected, false);
});
test('excessive raw input retires only the active feed instead of retaining unbounded bytes', async (t) => {
    const clients: Socket[] = [];
    const server = createServer((s) => {
        clients.push(s);
        s.on('error', () => {});
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const reader = new RadarRawReader({ port: (server.address() as { port: number }).port, now: () => T });
    t.after(async () => {
        reader.stop();
        clients.forEach((s) => s.destroy());
        await new Promise<void>((r) => server.close(() => r()));
    });
    reader.start('generated');
    await wait(() => reader.snapshot().connected);
    clients[0].write(Buffer.alloc(1_100_000, 65));
    await wait(() => reader.snapshot().overloaded);
    assert.equal(reader.snapshot().connected, false);
    assert.equal(reader.snapshot().feedId, null);
    assert.equal(reader.snapshot().observations.length, 0);
});
test('paired mount module is cache-only, no-store, query-free and response bounded', async (t) => {
    const reader = new RadarRawReader({ now: () => T });
    let calls = 0;
    const app = express();
    app.use(
        '/api/radar',
        createRadarRoutes({
            snapshot: () => {
                calls++;
                return reader.snapshot();
            },
        }),
    );
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', r));
    t.after(() => new Promise<void>((r) => server.close(() => r())));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const result = await fetch(base + '/api/radar/targets');
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal((await result.json()).connected, false);
    assert.equal(calls, 1);
    assert.equal((await fetch(base + '/api/radar/targets?host=other')).status, 400);
    assert.equal(calls, 1);
    const huge = express();
    huge.use(
        '/api/radar',
        createRadarRoutes({ snapshot: () => ({ ...reader.snapshot(), extra: 'x'.repeat(524288) }) }),
    );
    const hs = huge.listen(0, '127.0.0.1');
    await new Promise<void>((r) => hs.once('listening', r));
    t.after(() => new Promise<void>((r) => hs.close(() => r())));
    assert.equal(
        (await fetch(`http://127.0.0.1:${(hs.address() as { port: number }).port}/api/radar/targets`)).status,
        503,
    );
});
