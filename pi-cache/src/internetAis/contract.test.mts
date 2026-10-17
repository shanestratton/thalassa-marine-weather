import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    INTERNET_AIS_SOURCE,
    parseInternetAisRequest,
    parseInternetAisReply,
    internetAisRpcTarget,
    internetAisDelta,
    internetAisDistanceNm,
} from '../internetAisWire.js';
import { readAisTargets } from '../lanTelemetry.js';

const now = Date.parse('2026-10-17T09:00:00Z');
const request = {
    schema: 1 as const,
    lat: -27.2,
    lon: 153.1,
    measuredAt: now - 1000,
    ownMmsi: 503111111,
    radiusNm: 25 as const,
    limit: 100 as const,
};
const row = {
    mmsi: 503222222,
    lat: -27.21,
    lon: 153.11,
    cog: 90,
    sog: 10,
    updated_at: new Date(now - 3000).toISOString(),
    data_source: 'aisstream',
};
const target = () => internetAisRpcTarget(row, request, now)!;
const leaf = (value: unknown, source = `${INTERNET_AIS_SOURCE}.aisstream`, at = now - 3000) => ({
    value,
    $source: source,
    timestamp: new Date(at).toISOString(),
});

test('request is an exact bounded own-fix query, with original time and no URL/owner authority fields', () => {
    assert.deepEqual(parseInternetAisRequest(request, now), request);
    for (const extra of [
        { url: 'https://untrusted.invalid' },
        { ownerId: 'claimed' },
        { limit: 101 },
        { radiusNm: 26 },
        { measuredAt: now - 20001 },
        { measuredAt: now + 5001 },
        { ownMmsi: 0 },
    ])
        assert.equal(parseInternetAisRequest({ ...request, ...extra }, now), null);
    assert.ok(internetAisDistanceNm({ lat: 0, lon: 179.9 }, { lat: 0, lon: -179.9 }) < 13);
});
test('original rows keep clocks and known providers; old, future, far, unknown and own-vessel reports contribute no target', () => {
    assert.equal(target().at, now - 3000);
    for (const extra of [
        { updated_at: new Date(now - 120001).toISOString() },
        { updated_at: new Date(now + 5001).toISOString() },
        { data_source: 'claimed-radio' },
        { mmsi: request.ownMmsi },
        { lat: 0 },
        { lon: Infinity },
    ])
        assert.equal(internetAisRpcTarget({ ...row, ...extra }, request, now), null);
    assert.equal(internetAisRpcTarget({ ...row, cog: 360, sog: 102.3 }, request, now)?.cog, null);
    assert.equal(internetAisRpcTarget({ ...row, cog: 360, sog: 102.3 }, request, now)?.sog, null);
});
test('real delta shape has one distinct source reference, original timestamp and SI units without invented radio/static metadata', () => {
    const delta = internetAisDelta(target(), now)!;
    assert.equal(delta.context, 'vessels.urn:mrn:imo:mmsi:503222222');
    assert.equal(delta.updates[0].$source, 'thalassa-internet-ais.aisstream');
    assert.equal(delta.updates[0].timestamp, row.updated_at);
    assert.equal(delta.updates[0].values[1].value, Math.PI / 2);
    assert.equal(delta.updates[0].values[2].value, (10 * 1852) / 3600);
    assert.ok(!/"source"|NMEA|VDM|class|name|heading|navigation\.state/.test(JSON.stringify(delta)));
    assert.equal(internetAisDelta(target(), now + 120000), null);
});
test('received cohorts reject duplicate/oversized/forged envelopes and never redate an old target', () => {
    const reply = { schema: 1, targets: [target()], coverage: 'limited', truncated: false };
    assert.deepEqual(parseInternetAisReply(reply, request, now)?.targets, [target()]);
    assert.deepEqual(parseInternetAisReply(reply, request, now + 120000)?.targets, []);
    assert.equal(parseInternetAisReply({ ...reply, targets: [target(), target()] }, request, now), null);
    assert.equal(parseInternetAisReply({ ...reply, targets: Array(101).fill(target()) }, request, now), null);
    assert.equal(parseInternetAisReply({ ...reply, coverage: 'held' }, request, now), null);
    assert.equal(parseInternetAisReply({ ...reply, allowInternet: true }, request, now), null);
});
test('internet-selected position cannot become a local radio target or beacon alarm input', () => {
    const doc = {
        navigation: {
            position: leaf({ latitude: row.lat, longitude: row.lon }),
            state: leaf('ais-sart'),
            speedOverGround: leaf(4),
        },
    };
    assert.deepEqual(
        readAisTargets({ 'urn:mrn:imo:mmsi:970222222': doc }, null, () => now),
        [],
    );
    assert.equal(doc.navigation.position.$source, 'thalassa-internet-ais.aisstream');
});
test('an original recent RF alternative wins without internet speed/status contamination or source-object mutation', () => {
    const doc = {
        navigation: {
            position: {
                ...leaf({ latitude: row.lat, longitude: row.lon }),
                values: {
                    'ydwg-tcp.YD': {
                        value: { latitude: -27.3, longitude: 153.2 },
                        timestamp: new Date(now - 5000).toISOString(),
                    },
                },
            },
            speedOverGround: leaf(50),
            state: leaf('ais-sart'),
        },
    };
    const before = JSON.stringify(doc);
    const [radio] = readAisTargets({ 'urn:mrn:imo:mmsi:503222222': doc }, null, () => now);
    assert.equal(radio.lat, -27.3);
    assert.equal(radio.lastUpdated, now - 5000);
    assert.equal(radio.sog, null);
    assert.equal(radio.navStatus, null);
    assert.equal(JSON.stringify(doc), before);
    doc.navigation.position.values['ydwg-tcp.YD'].timestamp = new Date(now - 600001).toISOString();
    assert.deepEqual(
        readAisTargets({ 'urn:mrn:imo:mmsi:503222222': doc }, null, () => now),
        [],
    );
});
