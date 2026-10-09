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
    AIS_REPORT_SKEW_MS,
    AIS_TARGET_CAP,
    readAisTargets,
    readLanTelemetry,
    readSelfUrn,
} from './lanTelemetry.js';

const NOW = Date.parse('2026-09-07T03:00:00Z');
const now = () => NOW;
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString();

// Signal K stamps every leaf; a report's course, speed, heading and status
// carry its position's time.
const target = (agoMs: number, extra: Record<string, unknown> = {}) => ({
    navigation: {
        position: { value: { latitude: -27.19, longitude: 153.12 }, timestamp: iso(agoMs), $source: 'ydwg-tcp.YD' },
        courseOverGroundTrue: { value: Math.PI / 2, timestamp: iso(agoMs) },
        speedOverGround: { value: 5.144, timestamp: iso(agoMs) }, // 10 kt
        headingTrue: { value: Math.PI, timestamp: iso(agoMs) },
        state: { value: 'sailing', timestamp: iso(agoMs) },
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
    assert.equal(Math.round(star.cog!), 90);
    assert.equal(Math.round(star.sog! * 10) / 10, 10);
    assert.equal(Math.round(star.heading), 180);
    assert.equal(star.navStatus, 8); // sailing
    assert.equal(star.shipType, 36);
    assert.equal(star.callSign, 'VJN1234');
    assert.equal(star.destination, 'Mooloolaba');
    assert.equal(star.lastUpdated, NOW - 20_000);

    const [bare] = readAisTargets(VESSELS, 'urn:mrn:imo:mmsi:503101240', now);
    assert.equal(bare.mmsi, 244123456);
    assert.equal(bare.heading, AIS_HEADING_UNAVAILABLE);
    // No navigation.state is no status at all (125-10b), not 15 'undefined':
    // on a 97x MMSI the phone reads 15 as a beacon's TEST.
    assert.equal(bare.navStatus, null);
    assert.equal(bare.cog, null);
    assert.equal(bare.sog, null);
    assert.equal(bare.shipType, 0);
    assert.equal(bare.name, '');
});

test('a zero-padded URN that names no real MMSI is no target, as a document field with that number is not', () => {
    // A misconfigured transponder off Kiel: Signal K files it under the URN it sent.
    const vessels = {
        'urn:mrn:imo:mmsi:000012345': target(3_000),
        'urn:mrn:signalk:uuid:def': { ...target(3_000), mmsi: '000012345' },
        'urn:mrn:imo:mmsi:211000001': target(2_000),
    };
    assert.deepEqual(
        readAisTargets(vessels, null, now).map((t) => t.mmsi),
        [211000001],
    );
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

// ── AIS truth over the Pi lane (build 125, package 125-10b) ─────────────────
//
// Shaped like Signal K 2.32.0's own documents, read off the boat's Pi
// (read-only) on 2026-10-09: @signalk/nmea0183-signalk 3.20.1 hooks/VDM.js
// files message 1-3 targets, 97x beacons included, under `vessels.`; it never
// writes a speed of 102.3 kn, a course of 360° or a position of 91/181 (those
// leaves are simply absent), maps nav status through its own string table
// (15 is 'default'), and drops message 14's text. @signalk/n2k-signalk 4.7.0
// files PGN 129802's text under communication.ais.safetyRelatedBroadcast.
// Fictional MMSIs (970/972/974 and MID 123) and positions worldwide.

const leaf = (value: unknown, agoMs: number) => ({ value, $source: 'ydwg-tcp.AI', timestamp: iso(agoMs) });

/** A Class A report as VDM.js files it: no leaf for anything 'not available'. */
const classA = (
    mmsi: string,
    agoMs: number,
    fields: {
        position?: { latitude: number; longitude: number };
        cogRad?: number;
        sogMs?: number;
        state?: string;
        text?: { value: string; agoMs: number };
    },
) => ({
    mmsi,
    navigation: {
        ...(fields.position ? { position: leaf(fields.position, agoMs) } : {}),
        ...(fields.cogRad !== undefined ? { courseOverGroundTrue: leaf(fields.cogRad, agoMs) } : {}),
        ...(fields.sogMs !== undefined ? { speedOverGround: leaf(fields.sogMs, agoMs) } : {}),
        ...(fields.state !== undefined ? { state: leaf(fields.state, agoMs) } : {}),
    },
    sensors: { ais: { class: leaf('A', agoMs) } },
    ...(fields.text
        ? { communication: { ais: { safetyRelatedBroadcast: leaf(fields.text.value, fields.text.agoMs) } } }
        : {}),
});

const one = (key: string, doc: unknown) => readAisTargets({ [key]: doc }, null, now);

test('a course or speed Signal K does not have stays null, never 0 (due north and stopped)', () => {
    const [blind] = one(
        'urn:mrn:imo:mmsi:123456001',
        classA('123456001', 5_000, { position: { latitude: 50.77, longitude: -1.3 }, state: 'motoring' }),
    );
    assert.equal(blind.cog, null);
    assert.equal(blind.sog, null);
    assert.equal(blind.heading, AIS_HEADING_UNAVAILABLE);

    const [moving] = one(
        'urn:mrn:imo:mmsi:123456002',
        classA('123456002', 5_000, {
            position: { latitude: 37.0, longitude: -76.1 },
            cogRad: 0,
            sogMs: 0,
            state: 'anchored',
        }),
    );
    // A real 0 is a measurement and stays one.
    assert.equal(moving.cog, 0);
    assert.equal(moving.sog, 0);
    assert.equal(moving.navStatus, 1);
});

test('a distress beacon heard before its GNSS fix is sent with no position; other positionless targets are not', () => {
    const vessels = {
        // An AIS-SART bursting status 14 with lat 91 / lon 181: VDM.js leaves no position leaf.
        'urn:mrn:imo:mmsi:970123001': classA('970123001', 30_000, { state: 'ais-sart' }),
        // A man overboard beacon in test mode before its fix: status 15, 'default'.
        'urn:mrn:imo:mmsi:972123002': classA('972123002', 40_000, { state: 'default' }),
        // Any MMSI reporting status 14 counts as a beacon.
        'urn:mrn:imo:mmsi:123456003': classA('123456003', 50_000, { state: 'ais-sart' }),
        // A ship whose GPS has failed is not drawable and not a beacon.
        'urn:mrn:imo:mmsi:123456004': classA('123456004', 10_000, { state: 'motoring' }),
        // A beacon not heard for 11 minutes is history, as any target is.
        'urn:mrn:imo:mmsi:974123003': classA('974123003', 11 * 60_000, { state: 'ais-sart' }),
        // A message 14 alone leaves only the MMSI, with no time to age it by.
        'urn:mrn:imo:mmsi:970123009': { mmsi: '970123009' },
    };
    const targets = readAisTargets(vessels, null, now);
    assert.deepEqual(
        targets.map((t) => t.mmsi),
        [970123001, 972123002, 123456003],
    );
    const [sart, mob] = targets;
    assert.equal(sart.lat, null);
    assert.equal(sart.lon, null);
    assert.equal(sart.navStatus, 14);
    assert.equal(sart.lastUpdated, NOW - 30_000);
    assert.equal(sart.cog, null);
    assert.equal(sart.sog, null);
    assert.equal(mob.navStatus, 15);
    assert.equal(mob.lat, null);
});

test('the cap never cuts a beacon: beacons go first, then the freshest traffic', () => {
    const crowd: Record<string, unknown> = {};
    // A busy port: more fresh ships than the cap, all heard after the beacons.
    for (let i = 0; i < AIS_TARGET_CAP + 20; i += 1) {
        crowd[`urn:mrn:imo:mmsi:${123400000 + i}`] = classA(String(123400000 + i), 1_000 + i, {
            position: { latitude: 1.26, longitude: 103.8 }, // Singapore Strait
            state: 'motoring',
        });
    }
    crowd['urn:mrn:imo:mmsi:970123001'] = classA('970123001', 9 * 60_000, { state: 'ais-sart' });
    crowd['urn:mrn:imo:mmsi:972123002'] = classA('972123002', 8 * 60_000, {
        position: { latitude: 1.27, longitude: 103.81 },
        state: 'default',
    });
    const targets = readAisTargets(crowd, null, now);
    assert.equal(targets.length, AIS_TARGET_CAP);
    assert.deepEqual(
        targets.slice(0, 2).map((t) => t.mmsi),
        [972123002, 970123001],
    );
    assert.equal(targets[2].mmsi, 123400000); // then the freshest ship
});

test('a beacon with a fix is sent as any target is, its position and status together', () => {
    const [sart] = one(
        'urn:mrn:imo:mmsi:970123001',
        classA('970123001', 8_000, {
            position: { latitude: -34.05, longitude: 18.35 }, // off Cape Town
            cogRad: Math.PI,
            sogMs: 0.3,
            state: 'ais-sart',
        }),
    );
    assert.equal(sart.lat, -34.05);
    assert.equal(sart.lon, 18.35);
    assert.equal(sart.navStatus, 14);
    assert.equal(sart.lastUpdated, NOW - 8_000);
});

test('navigation.state strings map to the ITU codes exactly; a missing or unknown state is null', () => {
    // Every string VDM.js (3.20.1) and n2k-signalk's 129038 (4.7.0) write.
    const table: Array<[string, number]> = [
        ['motoring', 0],
        ['anchored', 1],
        ['not under command', 2],
        ['restricted manouverability', 3],
        ['constrained by draft', 4],
        ['moored', 5],
        ['aground', 6],
        ['fishing', 7],
        ['sailing', 8],
        ['hazardous material high speed', 9],
        ['hazardous material wing in ground', 10],
        ['ais-sart', 14],
        ['default', 15],
    ];
    for (const [state, code] of table) {
        const [t] = one(
            'urn:mrn:imo:mmsi:123456010',
            classA('123456010', 1_000, { position: { latitude: -17.0, longitude: 179.9 }, state }),
        );
        assert.equal(t.navStatus, code, state);
    }
    const stateOf = (state: unknown) =>
        one('urn:mrn:imo:mmsi:123456011', {
            mmsi: '123456011',
            navigation: {
                position: leaf({ latitude: -17.0, longitude: 179.9 }, 1_000),
                ...(state === undefined ? {} : { state: leaf(state, 1_000) }),
            },
        })[0].navStatus;
    assert.equal(stateOf('Sailing'), 8); // case aside
    assert.equal(stateOf(undefined), null); // Class B: VDM.js writes no state at all
    assert.equal(stateOf('towing < 200m'), null); // a Signal K state with no ITU code
    assert.equal(stateOf(15), null);
    assert.equal(stateOf('constructor'), null); // not a key of any object's prototype
    assert.equal(stateOf(''), null);
});

test('a message 14 text Signal K carries (PGN 129802) travels with the time it was heard', () => {
    const vessels = {
        // A SART with a fix, its text heard after its last position report.
        'urn:mrn:imo:mmsi:970123001': classA('970123001', 20_000, {
            position: { latitude: 57.19, longitude: -2.03 },
            state: 'ais-sart',
            text: { value: ' SART ACTIVE ', agoMs: 5_000 },
        }),
        // A beacon heard only by its text, before any position or status.
        'urn:mrn:imo:mmsi:974123003': {
            mmsi: '974123003',
            communication: { ais: { safetyRelatedBroadcast: leaf('EPIRB TEST', 15_000) } },
        },
        // A coast station's broadcast: no position, a text: the phone keeps the
        // text against its MMSI and decides what it means.
        'urn:mrn:imo:mmsi:001231000': {
            mmsi: '001231000',
            communication: { ais: { safetyRelatedBroadcast: leaf('NAVAREA WARNING IN FORCE', 25_000) } },
        },
        // A stale text is history.
        'urn:mrn:imo:mmsi:972123002': {
            mmsi: '972123002',
            communication: { ais: { safetyRelatedBroadcast: leaf('MOB ACTIVE', 11 * 60_000) } },
        },
    };
    const byMmsi = new Map(readAisTargets(vessels, null, now).map((t) => [t.mmsi, t]));
    assert.deepEqual([...byMmsi.keys()].sort(), [1231000, 970123001, 974123003]);

    const sart = byMmsi.get(970123001)!;
    assert.equal(sart.safetyText, 'SART ACTIVE');
    assert.equal(sart.safetyTextAt, NOW - 5_000);
    assert.equal(sart.lat, 57.19);
    assert.equal(sart.lastUpdated, NOW - 20_000); // the position's time, not the text's

    const epirb = byMmsi.get(974123003)!;
    assert.equal(epirb.safetyText, 'EPIRB TEST');
    assert.equal(epirb.safetyTextAt, NOW - 15_000);
    assert.equal(epirb.lat, null);
    assert.equal(epirb.navStatus, null);
    assert.equal(epirb.lastUpdated, NOW - 15_000);

    assert.equal(byMmsi.get(1231000)!.safetyText, 'NAVAREA WARNING IN FORCE');

    // No text, no key: an ordinary target's wire is unchanged in size.
    const [plain] = one(
        'urn:mrn:imo:mmsi:123456001',
        classA('123456001', 5_000, { position: { latitude: 50.77, longitude: -1.3 } }),
    );
    assert.equal('safetyText' in plain, false);
    assert.equal('safetyTextAt' in plain, false);
});

// ── Values Signal K kept from an earlier report (125-10b review) ─────────────
//
// Neither reader writes a leaf for 'not available', and Signal K keeps the
// value it held before. So a ship whose newest report says "speed not
// available" still has the 0 she reported at her mooring 40 minutes ago, and
// on an N2K-fed Pi a SART switched from ACTIVE to TEST (status 15, which
// n2k-signalk 4.7.0 has no string for) still says 'ais-sart'. Only the leaf's
// own time tells them apart: a report writes its position, course, speed,
// heading and status together.

test('a course, speed or heading left from an earlier report is unknown, not current', () => {
    const MIN = 60_000;
    const [ship] = one('urn:mrn:imo:mmsi:123456020', {
        mmsi: '123456020',
        navigation: {
            position: leaf({ latitude: 35.44, longitude: 139.65 }, 2_000), // Tokyo Bay
            // From her mooring, 40 minutes ago: her newest report said "not available".
            speedOverGround: leaf(0, 40 * MIN),
            courseOverGroundTrue: leaf(0, 40 * MIN),
            headingTrue: leaf(Math.PI, 40 * MIN),
            state: leaf('moored', 40 * MIN),
        },
    });
    assert.equal(ship.sog, null);
    assert.equal(ship.cog, null);
    assert.equal(ship.heading, AIS_HEADING_UNAVAILABLE);
    assert.equal(ship.navStatus, null);
    assert.equal(ship.lastUpdated, NOW - 2_000);

    // Leaves from the same report (or a newer one) are current; a leaf with no
    // time of its own cannot be dated, so it is not sent as current either.
    const [same] = one('urn:mrn:imo:mmsi:123456021', {
        mmsi: '123456021',
        navigation: {
            position: leaf({ latitude: 35.44, longitude: 139.65 }, 2_000),
            speedOverGround: leaf(2.572, 2_000 + AIS_REPORT_SKEW_MS), // 5 kt
            courseOverGroundTrue: leaf(Math.PI / 2, 1_000),
            headingTrue: { value: Math.PI },
            state: leaf('motoring', 2_000),
        },
    });
    assert.equal(Math.round(same.sog!), 5);
    assert.equal(Math.round(same.cog!), 90);
    assert.equal(same.heading, AIS_HEADING_UNAVAILABLE);
    assert.equal(same.navStatus, 0);
});

test('a status left from an earlier report is null: an N2K SART switched to TEST is not still ACTIVE', () => {
    // n2k-signalk writes no state for status 15, so 'ais-sart' from her
    // activation half an hour ago is still there under every new position.
    const [sart] = one('urn:mrn:imo:mmsi:970123001', {
        mmsi: '970123001',
        navigation: {
            position: leaf({ latitude: 60.39, longitude: 5.32 }, 3_000), // off Bergen
            state: leaf('ais-sart', 30 * 60_000),
        },
    });
    assert.equal(sart.navStatus, null);
    assert.equal(sart.lat, 60.39);
    assert.equal(sart.lastUpdated, NOW - 3_000);
});

test('a beacon with no position: its status only when recent, dated by its own time', () => {
    // A SART tested before its fix: 'ais-sart' left from an activation two
    // hours ago, and a fresh 'SART TEST' text.
    const [tested] = one('urn:mrn:imo:mmsi:970123001', {
        mmsi: '970123001',
        navigation: { state: leaf('ais-sart', 2 * 3_600_000) },
        communication: { ais: { safetyRelatedBroadcast: leaf('SART TEST', 5_000) } },
    });
    assert.equal(tested.navStatus, null);
    assert.equal(tested.lat, null);
    assert.equal(tested.safetyText, 'SART TEST');
    assert.equal(tested.lastUpdated, NOW - 5_000);

    // A recent status goes out with its own time, not its newer text's: the
    // text carries its own (safetyTextAt), and the phone weighs the two.
    const [active] = one('urn:mrn:imo:mmsi:972123002', {
        mmsi: '972123002',
        navigation: { state: leaf('ais-sart', 60_000) },
        communication: { ais: { safetyRelatedBroadcast: leaf('MOB TEST', 20_000) } },
    });
    assert.equal(active.navStatus, 14);
    assert.equal(active.lastUpdated, NOW - 60_000);
    assert.equal(active.safetyTextAt, NOW - 20_000);

    // A ship with no position, a status and only a two-hour-old text is not news.
    assert.deepEqual(
        one('urn:mrn:imo:mmsi:123456022', {
            mmsi: '123456022',
            navigation: { state: leaf('motoring', 1_000) },
            communication: { ais: { safetyRelatedBroadcast: leaf('NAVAREA WARNING IN FORCE', 2 * 3_600_000) } },
        }),
        [],
    );
});
