import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignalKReadSession, type SignalKReadSessionOptions } from './signalKReadSession.js';
import { SharedSignalkReader } from './lanTelemetry.js';
import { readTelemetrySnapshot } from './trackSignalk.js';
import { SignalKReadState, type SignalKNotice } from './signalkProtocol.js';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo, Socket } from 'node:net';

const self = 'urn:mrn:imo:mmsi:000000001';
const initial = Date.parse('2026-10-16T00:00:00Z');
const leaf = (value: unknown, at = initial - 4_000) => ({
    value,
    timestamp: new Date(at).toISOString(),
    $source: 'test.1',
});
const own = () => ({
    uuid: self,
    navigation: { speedOverGround: leaf(3), position: leaf({ latitude: -27, longitude: 153 }) },
    electrical: { batteries: { house: { voltage: leaf(12.7) } } },
    vendorExistingSystems: { untouched: leaf(17) },
});
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture(extra: Partial<SignalKReadSessionOptions> = {}) {
    let now = initial;
    let scheduled: (() => void) | undefined;
    let ownReads = 0,
        vesselsReads = 0,
        stops = 0;
    const streams: Parameters<NonNullable<SignalKReadSessionOptions['stream']>>[0][] = [];
    const session = new SignalKReadSession({
        origin: 'http://127.0.0.1:3000',
        now: () => now,
        client: {
            async getSelf() {
                ownReads++;
                return { status: 200, body: own() };
            },
            async getVessels() {
                vesselsReads++;
                return { status: 200, body: { 'urn:mrn:imo:mmsi:000000002': { name: 'fixture target' } } };
            },
        },
        stream(options) {
            streams.push(options);
            options.onState?.('reading');
            return {
                stop() {
                    stops++;
                    options.onState?.('stopped');
                },
            };
        },
        schedule(callback) {
            assert.equal(scheduled, undefined, 'at most one timer');
            scheduled = callback;
            return {
                cancel() {
                    if (scheduled === callback) scheduled = undefined;
                },
            };
        },
        ...extra,
    });
    return {
        session,
        streams,
        stats: () => ({ ownReads, vesselsReads, stops }),
        async tick(ms = 5000) {
            now += ms;
            const callback = scheduled;
            scheduled = undefined;
            callback?.();
            await flush();
        },
        pending: () => !!scheduled,
    };
}
test('one session feeds existing instrument/AIS consumers without request-triggered WAN or clock replacement', async () => {
    const f = fixture();
    await f.session.start();
    await f.session.start();
    try {
        const docs = await f.session.readDocuments();
        const snapshot = readTelemetrySnapshot(docs.selfDoc, () => initial);
        assert.ok(Math.abs((snapshot?.sogKts ?? 0) - 5.83) < 0.005);
        assert.equal(snapshot?.extra?.bus_at_ms, initial - 4000);
        assert.equal(snapshot?.voltageV, 12.7);
        assert.deepEqual((docs.selfDoc as ReturnType<typeof own>).vendorExistingSystems, own().vendorExistingSystems);
        assert.equal(docs.selfAnswer, `vessels.${self}`);
        assert.equal(Object.keys(docs.vesselsDoc as object).length, 1);
        for (let i = 0; i < 20; i++) await f.session.readDocuments();
        assert.deepEqual(f.stats(), { ownReads: 1, vesselsReads: 1, stops: 0 });
        assert.equal(f.streams.length, 1);
    } finally {
        f.session.stop();
    }
});
test('new source-dated delta overlays and null clears survive delayed older REST refresh; readers cannot mutate cache', async () => {
    const f = fixture();
    await f.session.start();
    try {
        f.streams[0].onDocument({ uuid: self, navigation: { speedOverGround: leaf(null, initial) } });
        const read = await f.session.readDocuments();
        (read.selfDoc as ReturnType<typeof own>).navigation.speedOverGround.value = 999;
        await f.tick(30_000);
        const later = await f.session.readDocuments();
        assert.deepEqual((later.selfDoc as ReturnType<typeof own>).navigation.speedOverGround, leaf(null, initial));
        assert.equal(f.stats().ownReads, 2);
        assert.equal(f.stats().vesselsReads, 2);
    } finally {
        f.session.stop();
    }
});
test('disconnect immediately retires self/AIS/notices and fences delayed documents; reconnect gets a new session', async () => {
    const f = fixture();
    await f.session.start();
    const before = f.session.notificationSnapshot().session;
    const old = f.streams[0];
    old.onState?.('disconnected');
    old.onDocument(own());
    assert.equal((await f.session.readDocuments()).selfDoc, null);
    assert.equal((await f.session.readDocuments()).vesselsDoc, null);
    assert.equal(f.session.notificationSnapshot().session, null);
    await f.tick();
    assert.notEqual(f.session.notificationSnapshot().session, before);
    assert.equal(f.streams.length, 2);
    old.onState?.('disconnected');
    assert.equal(f.session.notificationSnapshot().state, 'reading');
    f.session.stop();
    assert.equal(f.pending(), false);
});
test('identity change during periodic REST check retires instead of mixing vessels, then reboots verified identity', async () => {
    let change = false;
    const other = 'urn:mrn:imo:mmsi:000000003';
    const f = fixture({
        client: {
            async getSelf() {
                return { status: 200, body: { ...own(), uuid: change ? other : self } };
            },
            async getVessels() {
                return { status: 200, body: {} };
            },
        },
    });
    await f.session.start();
    change = true;
    await f.tick(30_000);
    assert.equal((await f.session.readDocuments()).selfDoc, null);
    assert.equal(f.session.notificationSnapshot().state, 'unavailable');
    await f.tick();
    assert.equal(f.streams.at(-1)?.selfUrn, other);
    f.session.stop();
});
test('stop/start fences an earlier delayed bootstrap without creating a duplicate loop or wrong-vessel socket', async () => {
    let resolve!: (value: { status: number; body: unknown }) => void;
    let calls = 0;
    const f = fixture({
        client: {
            async getSelf() {
                return ++calls === 1
                    ? new Promise((r) => {
                          resolve = r;
                      })
                    : { status: 200, body: own() };
            },
            async getVessels() {
                return { status: 200, body: {} };
            },
        },
    });
    const first = f.session.start();
    f.session.stop();
    await f.session.start();
    resolve({ status: 200, body: { ...own(), uuid: 'urn:other:boat' } });
    await first;
    assert.equal(f.streams.length, 1);
    assert.equal(f.streams[0].selfUrn, self);
    assert.equal(f.pending(), true);
    f.session.stop();
});
test('failed identity bootstrap is unavailable, retries are paced and caller reads never fetch', async () => {
    let calls = 0;
    const f = fixture({
        client: {
            async getSelf() {
                calls++;
                return { status: 401, body: null };
            },
            async getVessels() {
                return { status: 200, body: {} };
            },
        },
    });
    await f.session.start();
    assert.equal(f.session.notificationSnapshot().state, 'unavailable');
    assert.equal(f.streams.length, 0);
    await f.session.readDocuments();
    assert.equal(calls, 1);
    await f.tick(1000);
    assert.equal(calls, 1);
    await f.tick(1000);
    assert.equal(calls, 2);
    f.session.stop();
});
test('invalid self UUID and synchronous stream construction failure fail closed with a scheduled recovery', async () => {
    for (const invalid of [true, false]) {
        const f = fixture({
            client: {
                async getSelf() {
                    return { status: 200, body: { ...own(), uuid: invalid ? '__proto__' : self } };
                },
                async getVessels() {
                    return { status: 200, body: {} };
                },
            },
            stream() {
                throw new Error('synthetic failure');
            },
        });
        await f.session.start();
        assert.equal((await f.session.readDocuments()).selfDoc, null);
        assert.equal(f.session.notificationSnapshot().state, 'unavailable');
        assert.equal(f.pending(), true);
        f.session.stop();
    }
});
test('notification payload is cache-only, under 16KiB, explicit about truncation and excludes private source configuration', async () => {
    const f = fixture();
    await f.session.start();
    const notices: SignalKNotice[] = Array.from({ length: 64 }, (_, i) => ({
        path: `notifications.${'a'.repeat(30)}.${i}`,
        source: 's'.repeat(120),
        at: initial,
        receivedAt: initial,
        message: '🌊'.repeat(80),
        state: 'alarm',
        soundRequested: true,
    }));
    f.streams[0].onNotifications?.(notices, []);
    const snapshot = f.session.notificationSnapshot();
    assert.equal(snapshot.truncated, true);
    assert.ok(snapshot.notices.length > 0 && snapshot.notices.length < notices.length);
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot), 'utf8') <= 16_384);
    assert.equal(JSON.stringify(snapshot).includes(self), false);
    assert.equal(JSON.stringify(snapshot).includes('127.0.0.1'), false);
    snapshot.notices[0].message = 'mutated';
    assert.notEqual(f.session.notificationSnapshot().notices[0].message, 'mutated');
    f.session.stop();
    assert.deepEqual(f.session.notificationSnapshot().notices, []);
});
test('shared reader callback uses the stream cache exclusively while legacy constructor contract remains additive', async () => {
    let calls = 0;
    let now = initial;
    const reader = new SharedSignalkReader(
        {
            now: () => now,
            signalkOrigin: 'http://127.0.0.1:3000',
            fetchImpl: async () => {
                throw new Error('must not fetch');
            },
        },
        1500,
        async () => {
            calls++;
            return { selfDoc: own(), vesselsDoc: {}, selfAnswer: self, readAt: now };
        },
    );
    await Promise.all([reader.read(), reader.read()]);
    assert.equal(calls, 1);
    await reader.read();
    assert.equal(calls, 2, 'stream cache is read again even inside the old REST TTL, so retirement is visible');
    now += 1500;
    await reader.read();
    assert.equal(calls, 3);
});
test('original-clock GNSS, battery and magnetic-course deltas remain compatible with existing Pi leaf readers', () => {
    const state = new SignalKReadState(self, initial - 1);
    const values = [
        { path: 'navigation.datetime', value: new Date(initial - 1000).toISOString() },
        { path: 'navigation.courseOverGroundMagnetic', value: 1.2 },
        { path: 'navigation.gnss.satellites', value: 12 },
        { path: 'navigation.gnss.horizontalDilution', value: 0.9 },
        { path: 'navigation.gnss.methodQuality', value: 'GNSS Fix' },
        { path: 'electrical.batteries.house.voltage', value: 12.7 },
    ];
    state.ingestDelta(
        {
            context: `vessels.${self}`,
            updates: [{ $source: 'gps', timestamp: new Date(initial).toISOString(), values }],
        },
        initial,
    );
    const doc = state.document();
    assert.deepEqual((doc.electrical as { batteries: object }).batteries, {
        house: { voltage: { ...leaf(12.7, initial), $source: 'gps' } },
    });
    assert.equal((doc.navigation as { gnss: { satellites: { value: number } } }).gnss.satellites.value, 12);
    const count = Object.keys((doc.navigation as { gnss: object }).gnss).length;
    state.ingestDelta(
        {
            context: `vessels.${self}`,
            updates: [
                {
                    $source: 'gps',
                    timestamp: new Date(initial + 1).toISOString(),
                    values: [
                        { path: 'navigation.gnss.satellites', value: 1.5 },
                        { path: 'navigation.gnss.methodQuality', value: 'fabricated' },
                    ],
                },
            ],
        },
        initial + 1,
    );
    assert.equal(Object.keys((state.document().navigation as { gnss: object }).gnss).length, count);
    assert.equal(
        (state.document().navigation as { gnss: { satellites: { value: number } } }).gnss.satellites.value,
        12,
    );
});

test('actual authenticated REST bootstrap and WebSocket delta feed the shared Pi reader without polling per caller', async () => {
    const at = Date.now() - 4000;
    const sockets = new Set<Socket>();
    const received: { path: string | undefined; auth: string | undefined }[] = [];
    const server = createServer((req, res) => {
        received.push({ path: req.url, auth: req.headers.authorization });
        res.setHeader('content-type', 'application/json');
        if (req.url === '/signalk/v1/api/vessels/self') {
            res.end(JSON.stringify({ ...own(), navigation: { speedOverGround: leaf(1, at - 1000) } }));
        } else if (req.url === '/signalk/v1/api/vessels') res.end('{}');
        else res.writeHead(404).end();
    });
    server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => undefined);
    });
    server.on('upgrade', (req, socket) => {
        received.push({ path: req.url, auth: req.headers.authorization });
        const accept = createHash('sha1')
            .update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
            .digest('base64');
        socket.write(
            `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        socket.once('data', () => {
            const payload = Buffer.from(
                JSON.stringify({
                    context: `vessels.${self}`,
                    updates: [
                        {
                            $source: 'receiver',
                            timestamp: new Date(at).toISOString(),
                            values: [{ path: 'navigation.speedOverGround', value: 4 }],
                        },
                    ],
                }),
            );
            const head = Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
            socket.write(Buffer.concat([head, payload]));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const session = new SignalKReadSession({ origin, accessToken: 'synthetic-read-token' });
    try {
        await session.start();
        const reader = new SharedSignalkReader({ signalkOrigin: origin, fetchImpl: fetch }, 1500, () =>
            session.readDocuments(),
        );
        const deadline = Date.now() + 3000;
        let doc: unknown = null;
        while (Date.now() < deadline) {
            doc = (await reader.read()).selfDoc;
            if ((doc as ReturnType<typeof own> | null)?.navigation.speedOverGround.value === 4) break;
            await new Promise((r) => setTimeout(r, 20));
        }
        assert.deepEqual((doc as ReturnType<typeof own>).navigation.speedOverGround, {
            value: 4,
            timestamp: new Date(at).toISOString(),
            $source: 'receiver',
        });
        assert.equal((doc as ReturnType<typeof own>).electrical.batteries.house.voltage.value, 12.7);
        assert.deepEqual(
            received.map((r) => r.path).sort(),
            ['/signalk/v1/api/vessels', '/signalk/v1/api/vessels/self', '/signalk/v1/stream?subscribe=none'].sort(),
        );
        assert.equal(
            received.every((r) => r.auth === 'Bearer synthetic-read-token'),
            true,
        );
        assert.equal(
            received.some((r) => r.path?.includes('synthetic-read-token')),
            false,
        );
        session.stop();
        assert.equal((await reader.read()).selfDoc, null);
    } finally {
        session.stop();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});
