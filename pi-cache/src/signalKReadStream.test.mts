import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import type { Socket } from 'node:net';
import { startSignalKReadStream } from './signalKReadStream.js';
const self = 'urn:mrn:imo:mmsi:000000001';
function frame(body: string): Buffer {
    const payload = Buffer.from(body);
    const head =
        payload.length < 126
            ? Buffer.from([0x81, payload.length])
            : payload.length <= 65535
              ? Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255])
              : Buffer.alloc(10);
    if (payload.length > 65535) {
        head[0] = 0x81;
        head[1] = 127;
        head.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    return Buffer.concat([head, payload]);
}
async function fixture(accept: (socket: Socket, request: { url?: string; headers: Record<string, unknown> }) => void) {
    const sockets = new Set<Socket>();
    const server = createServer();
    server.on('upgrade', (req, socket) => {
        const s = socket as Socket;
        sockets.add(s);
        s.on('close', () => sockets.delete(s));
        s.on('error', () => undefined);
        const hash = createHash('sha1')
            .update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
            .digest('base64');
        s.write(
            `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${hash}\r\n\r\n`,
        );
        accept(s, { url: req.url, headers: req.headers });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    return {
        origin: `http://127.0.0.1:${port}`,
        async close() {
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((r) => server.close(() => r()));
        },
    };
}
const deadline = <T,>(p: Promise<T>) =>
    Promise.race([
        p,
        new Promise<never>((_, reject) => {
            const t = setTimeout(() => reject(new Error('test deadline')), 4000);
            t.unref();
        }),
    ]);
test('actual websocket uses fixed path/Bearer header and retains source clock in allowed own-vessel deltas', async () => {
    const at = Date.now() - 4000;
    let request: { url?: string; headers: Record<string, unknown> } | undefined;
    const f = await fixture((socket, req) => {
        request = req;
        socket.once('data', () =>
            socket.write(
                frame(
                    JSON.stringify({
                        context: `vessels.${self}`,
                        updates: [
                            {
                                $source: 'fixture',
                                timestamp: new Date(at).toISOString(),
                                values: [{ path: 'navigation.speedOverGround', value: 3 }],
                            },
                        ],
                    }),
                ),
            ),
        );
    });
    let resolve!: (doc: Record<string, unknown>) => void;
    const promise = new Promise<Record<string, unknown>>((r) => (resolve = r));
    const stream = startSignalKReadStream({
        origin: f.origin,
        accessToken: 'synthetic-token',
        selfUrn: self,
        onDocument: resolve,
    });
    try {
        const doc = await deadline(promise);
        assert.equal(request?.url, '/signalk/v1/stream?subscribe=none');
        assert.equal(request?.headers.authorization, 'Bearer synthetic-token');
        assert.equal(JSON.stringify(request?.url).includes('synthetic-token'), false);
        assert.deepEqual((doc.navigation as Record<string, unknown>).speedOverGround, {
            value: 3,
            timestamp: new Date(at).toISOString(),
            $source: 'fixture',
        });
    } finally {
        stream.stop();
        await f.close();
    }
});
test('actual websocket rejects an oversized message before application JSON/document handling', async () => {
    const f = await fixture((socket) => socket.once('data', () => socket.write(frame(' '.repeat(65535) + '{}'))));
    let resolve!: () => void;
    let docs = 0;
    const promise = new Promise<void>((r) => (resolve = r));
    const stream = startSignalKReadStream({
        origin: f.origin,
        selfUrn: self,
        onDocument: () => docs++,
        onState: (s) => {
            if (s === 'disconnected') resolve();
        },
    });
    try {
        await deadline(promise);
        assert.equal(docs, 0);
    } finally {
        stream.stop();
        await f.close();
    }
});
test('actual websocket redirect cannot forward token to a second host', async () => {
    let targetHits = 0;
    const target = createServer((_req, res) => {
        targetHits++;
        res.end();
    });
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    const redirect = createServer((_req, res) => {
        res.writeHead(302, {
            location: `http://127.0.0.1:${(target.address() as { port: number }).port}/signalk/v1/stream`,
        });
        res.end();
    });
    await new Promise<void>((r) => redirect.listen(0, '127.0.0.1', r));
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    const stream = startSignalKReadStream({
        origin: `http://127.0.0.1:${(redirect.address() as { port: number }).port}`,
        accessToken: 'synthetic-token',
        selfUrn: self,
        onDocument: () => assert.fail(),
        onState: (s) => {
            if (s === 'disconnected') resolve();
        },
    });
    try {
        await deadline(promise);
        assert.equal(targetHits, 0);
    } finally {
        stream.stop();
        await new Promise<void>((r) => redirect.close(() => r()));
        await new Promise<void>((r) => target.close(() => r()));
    }
});
