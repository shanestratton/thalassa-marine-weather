/**
 * The boat for a phone on the LAN — Shane 2026-09-07: "no more signal k or
 * ydwg-02 on the actual phone unless there is no pi available." The AIS
 * reader below is fed a Signal K `vessels` collection shaped like the real
 * one (envelopes, timestamps, the boat herself under her own URN).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    AIS_HEADING_UNAVAILABLE,
    AIS_TARGET_CAP,
    readAisTargets,
    readLanTelemetry,
    readSelfUrn,
} from './lanTelemetry.js';

const NOW = Date.parse('2026-09-07T03:00:00Z');
const now = () => NOW;
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString();

const target = (agoMs: number, extra: Record<string, unknown> = {}) => ({
    navigation: {
        position: { value: { latitude: -27.19, longitude: 153.12 }, timestamp: iso(agoMs), $source: 'ydwg-tcp.YD' },
        courseOverGroundTrue: { value: Math.PI / 2 },
        speedOverGround: { value: 5.144 }, // 10 kt
        headingTrue: { value: Math.PI },
        state: { value: 'sailing' },
        destination: { commonName: { value: 'Mooloolaba' } },
    },
    communication: { callsignVhf: { value: 'VJN1234' } },
    design: { aisShipType: { value: { id: 36, name: 'Sailing' } } },
    name: 'Wandering Star',
    ...extra,
});

const VESSELS = {
    'urn:mrn:imo:mmsi:503101240': {
        name: 'Serene Summer',
        navigation: { position: { value: { latitude: -27.2, longitude: 153.1 }, timestamp: iso(2_000) } },
    },
    'urn:mrn:imo:mmsi:503000111': target(20_000),
    'urn:mrn:imo:mmsi:503000222': target(4_000, {
        navigation: { position: { value: { latitude: -27.3, longitude: 153.2 }, timestamp: iso(4_000) } },
    }),
    'urn:mrn:imo:mmsi:503000333': target(15 * 60_000), // stale
    'urn:mrn:imo:mmsi:503000444': { name: 'No position', navigation: { speedOverGround: { value: 1 } } },
    'urn:mrn:signalk:uuid:abc': {
        mmsi: '244123456',
        navigation: { position: { value: { latitude: -27.1, longitude: 153.0 }, timestamp: iso(1_000) } },
    },
};

test('self URN comes off Signal K’s /self answer with the vessels. prefix dropped', () => {
    assert.equal(readSelfUrn('vessels.urn:mrn:imo:mmsi:503101240'), 'urn:mrn:imo:mmsi:503101240');
    assert.equal(readSelfUrn('urn:mrn:imo:mmsi:503101240'), 'urn:mrn:imo:mmsi:503101240');
    assert.equal(readSelfUrn(''), null);
    assert.equal(readSelfUrn({ not: 'a string' }), null);
});

test('AIS targets: the boat herself is excluded, stale and positionless targets dropped, freshest first', () => {
    const targets = readAisTargets(VESSELS, 'urn:mrn:imo:mmsi:503101240', now);
    assert.deepEqual(
        targets.map((t) => t.mmsi),
        [244123456, 503000222, 503000111],
    );
});

test('AIS fields land in the phone’s units: degrees, knots, ITU codes, 511 for no heading', () => {
    const [, , star] = readAisTargets(VESSELS, 'urn:mrn:imo:mmsi:503101240', now);
    assert.equal(star.name, 'Wandering Star');
    assert.equal(Math.round(star.cog), 90);
    assert.equal(Math.round(star.sog * 10) / 10, 10);
    assert.equal(Math.round(star.heading), 180);
    assert.equal(star.navStatus, 8); // sailing
    assert.equal(star.shipType, 36);
    assert.equal(star.callSign, 'VJN1234');
    assert.equal(star.destination, 'Mooloolaba');
    assert.equal(star.lastUpdated, NOW - 20_000);

    const [bare] = readAisTargets(VESSELS, 'urn:mrn:imo:mmsi:503101240', now);
    assert.equal(bare.mmsi, 244123456);
    assert.equal(bare.heading, AIS_HEADING_UNAVAILABLE);
    assert.equal(bare.navStatus, 15);
    assert.equal(bare.shipType, 0);
    assert.equal(bare.name, '');
});

test('a busy port is capped, and rubbish input is an empty list, not a throw', () => {
    const crowd: Record<string, unknown> = {};
    for (let i = 0; i < AIS_TARGET_CAP + 50; i += 1) crowd[`urn:mrn:imo:mmsi:${503100000 + i}`] = target(i * 10);
    assert.equal(readAisTargets(crowd, null, now).length, AIS_TARGET_CAP);
    assert.deepEqual(readAisTargets(null, null, now), []);
    assert.deepEqual(readAisTargets('nope', null, now), []);
});

test('readLanTelemetry: the publisher’s wire shape plus the traffic; a quiet bus is available:false, not an error', async () => {
    const self = {
        navigation: {
            position: { value: { latitude: -27.2, longitude: 153.1 }, timestamp: iso(1_000) },
            datetime: { value: iso(1_000) },
            speedOverGround: { value: 3.0 },
        },
        environment: { depth: { belowTransducer: { value: 4.2 } } },
    };
    const fetchImpl = (async (url: string) => {
        const path = String(url);
        const ok = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;
        if (path.endsWith('/signalk'))
            return ok({ endpoints: { v1: { 'signalk-http': 'http://sk/signalk/v1/api/' } } });
        if (path.endsWith('/vessels/self')) return ok(self);
        if (path.endsWith('/vessels')) return ok(VESSELS);
        if (path.endsWith('/self')) return ok('vessels.urn:mrn:imo:mmsi:503101240');
        return { ok: false, json: async () => null } as unknown as Response;
    }) as unknown as typeof fetch;

    const payload = await readLanTelemetry({ fetchImpl, signalkOrigin: 'http://sk', deviceLabel: 'calypso', now });
    assert.equal(payload.available, true);
    assert.equal(payload.telemetry?.source, 'pi');
    assert.equal(payload.telemetry?.device_label, 'calypso');
    assert.equal(payload.telemetry?.depth_m, 4.2);
    assert.equal(payload.telemetry?.lat, -27.2);
    assert.equal(payload.ais.length, 3);
    assert.equal(payload.served_at, new Date(NOW).toISOString());

    const quiet = (async (url: string) => {
        const path = String(url);
        if (path.endsWith('/signalk'))
            return {
                ok: true,
                json: async () => ({ endpoints: { v1: { 'signalk-http': 'http://sk/signalk/v1/api/' } } }),
            } as unknown as Response;
        return { ok: false, json: async () => null } as unknown as Response; // 404: nothing on the bus yet
    }) as unknown as typeof fetch;
    const ashore = await readLanTelemetry({
        fetchImpl: quiet,
        signalkOrigin: 'http://sk',
        deviceLabel: 'calypso',
        now,
    });
    assert.equal(ashore.available, false);
    assert.equal(ashore.telemetry, null);
    assert.deepEqual(ashore.ais, []);
    assert.equal(ashore.reason, 'Signal K has no vessel document');
});
