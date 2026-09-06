/**
 * The Pi publishes the boat — Shane 2026-09-06: "all of the data to supabase
 * needs to come from the pi, not from my phone", and the whole bus, not just
 * GPS.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readTelemetrySnapshot } from './trackSignalk.js';
import { MAX_BACKOFF_MS, PUBLISH_INTERVAL_MS, TelemetryPublisher, buildTelemetryBody } from './telemetryPublisher.js';

const RAD = Math.PI / 180;
const SELF = {
    navigation: {
        position: { value: { latitude: -27.2, longitude: 153.11 }, timestamp: 't' },
        datetime: { value: '2026-09-06T06:00:00.000Z' },
        speedOverGround: { value: 3.0 }, // m/s
        courseOverGroundTrue: { value: 45 * RAD },
        headingTrue: { value: 40 * RAD },
        speedThroughWater: { value: 2.8 },
        attitude: { value: { roll: -8 * RAD, pitch: 1 * RAD } },
    },
    environment: {
        wind: {
            speedTrue: { value: 7.0 },
            angleTrueWater: { value: -48 * RAD },
            directionTrue: { value: 350 * RAD },
            speedApparent: { value: 8.5 },
            angleApparent: { value: -33 * RAD },
        },
        depth: { belowTransducer: { value: 12.4 } },
        water: { temperature: { value: 295.65 } },
        outside: { pressure: { value: 101_320 } },
    },
    steering: { rudderAngle: { value: 2 * RAD } },
    propulsion: { port: { revolutions: { value: 30 } } }, // Hz
    electrical: { batteries: { house: { voltage: { value: 13.1 } } } },
};

test('reads the whole bus in the panel’s units: knots, signed degrees, metres, Celsius, hPa, rpm', () => {
    const s = readTelemetrySnapshot(SELF)!;
    assert.equal(s.reportedAt, '2026-09-06T06:00:00.000Z');
    assert.equal(s.lat, -27.2);
    assert.ok(Math.abs(s.sogKts! - 5.83) < 0.01);
    assert.ok(Math.abs(s.cogDeg! - 45) < 1e-9);
    assert.ok(Math.abs(s.twaDeg! - -48) < 1e-9, 'twa stays signed');
    assert.ok(Math.abs(s.awaDeg! - -33) < 1e-9);
    assert.ok(Math.abs(s.twdDeg! - 350) < 1e-9);
    assert.ok(Math.abs(s.heelDeg! - -8) < 1e-9);
    assert.equal(s.depthM, 12.4);
    assert.ok(Math.abs(s.waterTempC! - 22.5) < 1e-9);
    assert.ok(Math.abs(s.pressureHpa! - 1013.2) < 1e-9);
    assert.equal(s.rpm, 1800);
    assert.equal(s.voltageV, 13.1);
});

test('no document, or a document with nothing on it, is no snapshot; Null Island is not a position', () => {
    assert.equal(
        readTelemetrySnapshot({ navigation: {} }, () => 0),
        null,
    );
    const s = readTelemetrySnapshot({
        navigation: { position: { value: { latitude: 0, longitude: 0 } }, speedOverGround: { value: 1 } },
    })!;
    assert.equal(s.lat, null);
    assert.equal(s.lon, null);
});

test('the body is the Edge Function’s snake_case shape, marked as the Pi', () => {
    const body = buildTelemetryBody(readTelemetrySnapshot(SELF)!, 'calypso');
    assert.equal(body.source, 'pi');
    assert.equal(body.device_label, 'calypso');
    assert.equal(body.twa_deg, -48 + 0 || body.twa_deg);
    assert.ok('voltage_v' in body && 'depth_m' in body && 'rudder_deg' in body);
});

function fakeSignalK(selfDoc: unknown) {
    return async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith('/signalk')) {
            return new Response(
                JSON.stringify({ endpoints: { v1: { 'signalk-http': 'http://sk/signalk/v1/api/' } } }),
                { status: 200 },
            );
        }
        if (u.startsWith('http://sk/')) return new Response(JSON.stringify(selfDoc), { status: 200 });
        return new Response('unexpected', { status: 500 });
    };
}

test('publishes with the pairing credential and the anon key, and reports sent', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const sk = fakeSignalK(SELF);
    const publisher = new TelemetryPublisher({
        fetchImpl: async (url, init) => {
            if (String(url).includes('telemetry-relay')) {
                calls.push({ url: String(url), init });
                return new Response('{"ok":true}', { status: 200 });
            }
            return sk(url, init);
        },
        signalkOrigin: 'http://sk',
        endpoint: 'https://x.supabase.co/functions/v1/telemetry-relay',
        anonKey: () => 'anon',
        credentials: () => ({ relayId: 'relay-1234567890abcdef', token: 'a'.repeat(64) }),
        internetAllowed: () => true,
        deviceLabel: 'calypso',
    });
    assert.equal(await publisher.publishOnce(), 'sent');
    assert.equal(calls.length, 1);
    const headers = calls[0].init?.headers as Record<string, string>;
    assert.equal(headers['X-Thalassa-Pi-Relay-Id'], 'relay-1234567890abcdef');
    assert.equal(headers.apikey, 'anon');
    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
    assert.equal(body.source, 'pi');
    assert.equal(body.lat, -27.2);
    assert.equal(publisher.status().consecutiveFailures, 0);
});

test('stands down when the skipper’s policy forbids internet, or the Pi is unpaired, and never posts', async () => {
    let posted = 0;
    const base = {
        fetchImpl: async (url: string | URL, init?: RequestInit) => {
            if (String(url).includes('telemetry-relay')) posted += 1;
            return fakeSignalK(SELF)(url, init);
        },
        signalkOrigin: 'http://sk',
        endpoint: 'https://x.supabase.co/functions/v1/telemetry-relay',
        anonKey: () => 'anon',
        deviceLabel: 'calypso',
    };
    const off = new TelemetryPublisher({
        ...base,
        credentials: () => ({ relayId: 'r'.repeat(20), token: 'b'.repeat(64) }),
        internetAllowed: () => false,
    });
    assert.equal(await off.publishOnce(), 'internet-off');
    const unpaired = new TelemetryPublisher({ ...base, credentials: () => null, internetAllowed: () => true });
    assert.equal(await unpaired.publishOnce(), 'not-paired');
    assert.equal(posted, 0);
});

test('a refusing cloud backs the Pi off, doubling to a five-minute cap, and a success resets it', async () => {
    let status = 500;
    const publisher = new TelemetryPublisher({
        fetchImpl: async (url, init) =>
            String(url).includes('telemetry-relay') ? new Response('no', { status }) : fakeSignalK(SELF)(url, init),
        signalkOrigin: 'http://sk',
        endpoint: 'https://x.supabase.co/functions/v1/telemetry-relay',
        anonKey: () => 'anon',
        credentials: () => ({ relayId: 'r'.repeat(20), token: 'c'.repeat(64) }),
        internetAllowed: () => true,
        deviceLabel: 'calypso',
    });
    assert.equal(publisher.nextDelayMs(), PUBLISH_INTERVAL_MS);
    for (let i = 0; i < 3; i++) assert.equal(await publisher.publishOnce(), 'rejected');
    assert.equal(publisher.nextDelayMs(), PUBLISH_INTERVAL_MS * 8);
    for (let i = 0; i < 10; i++) await publisher.publishOnce();
    assert.equal(publisher.nextDelayMs(), MAX_BACKOFF_MS);
    status = 200;
    assert.equal(await publisher.publishOnce(), 'sent');
    assert.equal(publisher.nextDelayMs(), PUBLISH_INTERVAL_MS);
});
