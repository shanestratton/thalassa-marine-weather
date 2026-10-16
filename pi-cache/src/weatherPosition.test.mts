import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import {
    readWeatherPositionSource,
    weatherPositionProof,
    appendWeatherPosition,
    readWeatherPositionRequest,
} from './weatherPosition.js';
import { TelemetryPublisher } from './telemetryPublisher.js';
import { createWeatherPositionRoutes } from './routes/weatherPosition.js';
import type { BoatLanView, ChartDevicePublic } from './encDevices.js';
const now = Date.parse('2026-10-17T07:00:00Z'),
    relay = 'fictional_relay_0001',
    revision = '30000000-0000-4000-8000-000000000001';
const doc = () => ({
    uuid: 'urn:mrn:imo:mmsi:000000001',
    navigation: {
        datetime: { value: new Date(now).toISOString() },
        position: {
            $source: 'fictional.gps.1',
            timestamp: new Date(now - 1000).toISOString(),
            value: { latitude: 0, longitude: 0 },
        },
    },
});
const request = () => {
    const s = readWeatherPositionSource(doc(), relay, now)!;
    return { schema: 1 as const, revision, selfKey: s.selfKey, sourceKey: s.sourceKey, expiresAt: now + 600000 };
};
test('fixed cache leaf retains original clock and global coordinates; parent/report clocks never qualify', () => {
    const s = readWeatherPositionSource(doc(), relay, now)!;
    assert.deepEqual(s.position, { lat: 0, lon: 0, at: now - 1000 });
    assert.match(s.selfKey, /^[a-f\d]{64}$/);
    assert.match(s.sourceKey, /^[a-f\d]{64}$/);
    const text = JSON.stringify(s);
    assert.equal(text.includes('mmsi'), false);
    assert.equal(text.includes('fictional.gps'), false);
    for (const at of [undefined, new Date(now - 14000).toISOString(), new Date(now + 1).toISOString(), 'invalid']) {
        const d = doc();
        (d as { timestamp?: string }).timestamp = new Date(now).toISOString();
        (d.navigation.position as { timestamp?: string }).timestamp = at;
        assert.equal(readWeatherPositionSource(d, relay, now), null);
    }
    const d = doc();
    d.navigation.position.$source = '';
    assert.equal(readWeatherPositionSource(d, relay, now), null);
    d.navigation.position.$source = 'fictional.gps.2';
    assert.notEqual(readWeatherPositionSource(d, relay, now)?.sourceKey, s.sourceKey);
});
test('proof requires current explicit source consent; changed self/source and expiry cannot adopt it', () => {
    assert.equal(weatherPositionProof(doc(), relay, null, now), null);
    const q = request();
    assert.equal(weatherPositionProof(doc(), relay, q, now)?.revision, revision);
    for (const change of [{ expiresAt: now }, { sourceKey: 'a'.repeat(64) }, { selfKey: 'b'.repeat(64) }])
        assert.equal(weatherPositionProof(doc(), relay, { ...q, ...change }, now), null);
    const d = doc();
    d.uuid = 'urn:mrn:imo:mmsi:000000002';
    assert.equal(weatherPositionProof(d, relay, q, now), null);
});
test('optional proof never raises 16KiB envelope or trims unchanged telemetry keys', () => {
    const proof = weatherPositionProof(doc(), relay, request(), now)!;
    const body = {
        extra: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`key${i}`, i])),
        pad: 'x'.repeat(15800),
    };
    assert.ok(Buffer.byteLength(JSON.stringify(body), 'utf8') <= 16384);
    assert.ok(Buffer.byteLength(JSON.stringify({ ...body, weather_position_v1: proof }), 'utf8') > 16384);
    assert.equal(appendWeatherPosition(body, proof), JSON.stringify(body));
    assert.equal(appendWeatherPosition({ pad: 'x'.repeat(16385) }, proof), null);
    const small = { extra: body.extra };
    const decoded = JSON.parse(appendWeatherPosition(small, proof)!);
    assert.deepEqual(decoded.extra, small.extra);
    assert.equal(Object.keys(decoded.extra).length, 40);
    assert.deepEqual(decoded.weather_position_v1, proof);
});
test('bounded response reader refuses oversized/unknown/expired requests without changing legacy success', async () => {
    assert.deepEqual(
        await readWeatherPositionRequest(new Response(JSON.stringify({ weather_position_request: request() })), now),
        request(),
    );
    assert.equal(await readWeatherPositionRequest(new Response('x'.repeat(2049)), now), null);
    assert.equal(
        await readWeatherPositionRequest(
            new Response(
                JSON.stringify({ weather_position_request: { ...request(), arbitraryUrl: 'https://invalid' } }),
            ),
            now,
        ),
        null,
    );
    assert.equal(await readWeatherPositionRequest({}, now), null);
});
function publisherFixture() {
    const data = {
        document: doc(),
        credential: { relayId: relay, token: 'a'.repeat(64) },
        allowed: true,
        posts: [] as Record<string, unknown>[],
    };
    const publisher = new TelemetryPublisher({
        fetchImpl: async (_url, init) => {
            data.posts.push(JSON.parse(String(init?.body)));
            return new Response(JSON.stringify({ ok: true, weather_position_request: request() }));
        },
        signalkOrigin: 'http://unused.invalid',
        selfDocument: async () => data.document,
        endpoint: 'https://synthetic.invalid/functions/v1/telemetry-relay',
        anonKey: () => 'synthetic-public',
        credentials: () => data.credential,
        internetAllowed: () => data.allowed,
        deviceLabel: 'Fictional',
        now: () => now,
    });
    return { data, publisher };
}
test('existing policy-controlled telemetry learns consent then publishes independently dated proof without a second request', async () => {
    const { data, publisher } = publisherFixture();
    assert.equal(await publisher.publishOnce(), 'sent');
    assert.equal(data.posts[0].weather_position_v1, undefined);
    assert.equal(await publisher.publishOnce(), 'sent');
    assert.deepEqual(data.posts[1].weather_position_v1, weatherPositionProof(doc(), relay, request(), now));
    assert.equal(
        data.posts[1].lat,
        null,
        'legacy Null Island handling remains isolated from the dedicated measured proof',
    );
    data.allowed = false;
    assert.equal(await publisher.publishOnce(), 'internet-off');
    assert.equal(data.posts.length, 2);
    data.allowed = true;
    await publisher.publishOnce();
    assert.equal(data.posts[2].weather_position_v1, undefined, 'policy retirement requires renewed consent response');
});
test('changed sources and relay credentials never reuse previous consent', async () => {
    const { data, publisher } = publisherFixture();
    await publisher.publishOnce();
    data.document.navigation.position.$source = 'fictional.gps.2';
    await publisher.publishOnce();
    assert.equal(data.posts[1].weather_position_v1, undefined);
    data.document = doc();
    data.credential = { ...data.credential, token: 'b'.repeat(64) };
    await publisher.publishOnce();
    assert.equal(data.posts[2].weather_position_v1, undefined);
    publisher.stop();
    await publisher.publishOnce();
    assert.equal(data.posts[3].weather_position_v1, undefined);
});
test('a credential/stop change while cache read waits prevents the old request being sent', async () => {
    let finish!: (v: unknown) => void,
        posts = 0;
    const p = new TelemetryPublisher({
        fetchImpl: async () => {
            posts++;
            return new Response('{}');
        },
        selfDocument: () => new Promise((r) => (finish = r)),
        signalkOrigin: 'http://unused.invalid',
        endpoint: 'https://synthetic.invalid',
        anonKey: () => 'synthetic',
        credentials: () => ({ relayId: relay, token: 'a'.repeat(64) }),
        internetAllowed: () => true,
        deviceLabel: 'Fictional',
        now: () => now,
    });
    const pending = p.publishOnce();
    p.stop();
    finish(doc());
    assert.equal(await pending, 'not-paired');
    assert.equal(posts, 0);
});
test('actual mounted fixed source read requires app gate + current enrollment + physical boat LAN', async (t) => {
    const state = { peer: '192.168.1.22', enrolled: true, reads: 0 };
    const device: ChartDevicePublic = {
        id: revision,
        label: 'Fictional',
        enrolledAt: new Date(now - 1000).toISOString(),
        lastSeenAt: new Date(now).toISOString(),
    };
    const lan: BoatLanView = {
        interfaces: {
            eth0: [
                {
                    address: '192.168.1.180',
                    netmask: '255.255.255.0',
                    family: 'IPv4',
                    internal: false,
                    mac: '',
                    cidr: '192.168.1.180/24',
                },
            ],
        },
        gateways: ['192.168.1.1'],
    };
    const app = express();
    app.use(
        '/api/weather-watch',
        (req, res, next) => (req.headers['x-test-app'] === 'yes' ? next() : res.status(403).end()),
        createWeatherPositionRoutes({
            devices: {
                verify: async (token) =>
                    state.enrolled && token === 'synthetic-device'
                        ? { state: 'enrolled', device }
                        : { state: 'unknown' },
            },
            selfDocument: () => {
                state.reads++;
                return doc();
            },
            relayId: () => relay,
            now: () => now,
            peerOf: () => state.peer,
            lanView: () => lan,
        }),
    );
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', r));
    t.after(() => new Promise<void>((r) => server.close(() => r())));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/weather-watch/position-source`,
        headers = { 'x-test-app': 'yes', 'x-thalassa-chart-device': 'synthetic-device' };
    assert.equal((await fetch(url)).status, 403);
    assert.equal(state.reads, 0);
    state.peer = '100.76.1.20';
    assert.equal((await fetch(url, { headers })).status, 403);
    assert.equal(state.reads, 0);
    state.peer = '192.168.1.22';
    state.enrolled = false;
    assert.equal((await fetch(url, { headers })).status, 401);
    assert.equal(state.reads, 0);
    state.enrolled = true;
    assert.equal((await fetch(url + '?path=navigation.position', { headers })).status, 400);
    const result = await fetch(url, { headers });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.deepEqual((await result.json()).position, { lat: 0, lon: 0, at: now - 1000 });
    assert.equal(state.reads, 1);
});
