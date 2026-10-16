import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseNdbcLatest, parseNdbcHistory, parseAwcMetars } from '../services/weather/observations/parsers.js';
import {
    MAX_FEED_BYTES,
    currentObservation,
    HOUR_MS,
    type Observation,
    type Station,
} from '../services/weather/observations/model.js';
import {
    selectNearbyObservations,
    observationUiRows,
    observationEmptyMessage,
    ObservationHistory,
} from '../services/weather/observations/nearby.js';
import { metarRequest, ndbcHistoryRequest, ndbcLatestRequest } from '../services/weather/observations/requests.js';
import { NOW, latestHeader, ndbcLatest, metar } from './observationFixtures.js';
const station: Station = {
    id: 'ZZ001',
    name: 'Synthetic buoy',
    lat: 30,
    lon: -150,
    owner: 'Synthetic institute',
    exposure: 'buoy',
};
const ndbc = (wind = '10.0', gust = '12.0') =>
    ndbcLatest([`ZZ001 30 -150 2026 10 16 11 40 360 ${wind} ${gust} 1001.5 0.0`]);
const sample = (): Observation => parseAwcMetars(JSON.stringify([metar()]), NOW).rows[0];

test('NDBC metric wind converts to knots, pressure stays sea level and 0°C remains a measurement', () => {
    const row = parseNdbcLatest(ndbc(), NOW, new Map([[station.id, station]])).rows[0];
    assert.ok(Math.abs(row.windSpeedKts! - 19.4384449) < 0.0001);
    assert.ok(Math.abs(row.gustKts! - 23.3261339) < 0.0001);
    assert.equal(row.fromDeg, 0);
    assert.equal(row.airTempC, 0);
    assert.equal(row.seaLevelPressureHpa, 1001.5);
    assert.equal(row.altimeterHpa, null);
    assert.equal(row.observedAtMs, Date.parse('2026-10-16T11:40:00Z'));
    assert.match(row.attribution, /Synthetic institute/);
});
test('NDBC unknown/relocated stations do not inherit a buoy exposure or owner', () => {
    assert.equal(parseNdbcLatest(ndbc(), NOW).rows[0].exposure, 'unknown');
    const moved = new Map([[station.id, { ...station, lon: -149 }]]);
    const row = parseNdbcLatest(ndbc(), NOW, moved).rows[0];
    assert.equal(row.exposure, 'unknown');
    assert.equal(row.owner, null);
});
test('NDBC missing values remain null, while genuinely reported calm remains zero', () => {
    const rows = parseNdbcLatest(
        ndbcLatest([
            'ZZ001 30 -150 2026 10 16 11 40 MM MM MM MM MM',
            'ZZ002 30 -150 2026 10 16 11 40 999 0.0 MM 1000 0.0',
            'ZZ003 30 -150 2026 10 16 11 40 999 999.0 999.0 9999 999.0',
        ]),
        NOW,
    ).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].windSpeedKts, 0);
    assert.equal(rows[0].gustKts, null);
    assert.equal(rows[0].fromDeg, null);
});
test('NDBC uses named columns rather than column positions or station-page imperial defaults', () => {
    const row = parseNdbcLatest(
        '#STN PRES MM WSPD DD YYYY LAT LON ATMP hh GST mm WDIR\nZZ001 1001 10 10 16 2026 30 -150 -5 11 12 40 90',
        NOW,
    ).rows[0];
    assert.ok(row.windSpeedKts! > 19);
    assert.equal(row.airTempC, -5);
    assert.equal(row.fromDeg, 90);
});
test('NDBC rejects impossible UTC dates and missing/default coordinates; receipt time never repairs them', () => {
    for (const fields of ['2026 02 30 11 40', '2026 13 16 11 40', '2026 10 16 24 40', '26 10 16 11 40'])
        assert.equal(parseNdbcLatest(ndbcLatest([`ZZ001 30 -150 ${fields} 90 5 6 1000 20`]), NOW).rows.length, 0);
    assert.equal(parseNdbcLatest(ndbc().replace('30 -150', '0 0'), NOW).rows.length, 0);
});
test('old data is history, not current; future timestamps cannot become fresh observations', () => {
    const stale = parseAwcMetars(JSON.stringify([metar({ obsTime: NOW / 1000 - 4 * 3600 })]), NOW).rows[0];
    assert.equal(currentObservation(stale, NOW), false);
    assert.equal(parseAwcMetars(JSON.stringify([metar({ obsTime: NOW / 1000 + 301 })]), NOW).rows.length, 0);
    assert.equal(parseAwcMetars(JSON.stringify([metar({ obsTime: NOW / 1000 - 73 * 3600 })]), NOW).rows.length, 0);
});
test('NDBC station history uses its station location and actual sample UTC times', () => {
    const result = parseNdbcHistory(
        '#YY MM DD hh mm WDIR WSPD GST PRES ATMP\n2026 10 16 11 00 120 5 8 1002 19\n2026 10 13 11 00 120 5 8 1002 19',
        station,
        NOW,
    );
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].lat, station.lat);
    assert.equal(result.rows[0].observedAtMs, NOW - HOUR_MS);
});
test('AWC v4 units keep knots unchanged and separate QNH/altimeter from sea-level pressure', () => {
    const row = sample();
    assert.equal(row.windSpeedKts, 10);
    assert.equal(row.gustKts, 15);
    assert.equal(row.seaLevelPressureHpa, 1007.4);
    assert.equal(row.altimeterHpa, 1010.2);
    assert.equal(row.observedAtMs, NOW - 20 * 60000);
    assert.equal(row.retrievedAtMs, NOW);
    assert.equal(row.receivedAtMs, NOW - 19 * 60000);
    const ui = observationUiRows({
        marine: null,
        airport: {
            observation: row,
            distanceNm: 1,
            ageMinutes: 20,
            exposureLabel: 'Airport on land',
        },
    })[0];
    assert.match(ui.measurements, /Sea-level pressure 1007.4 hPa/);
    assert.match(ui.measurements, /Altimeter\/QNH 1010.2 hPa/);
});
test('AWC variable wind and true calm have different meanings; a missing direction is neither', () => {
    const rows = parseAwcMetars(
        JSON.stringify([
            metar({ wdir: 'VRB' }),
            metar({ icaoId: 'ZZ02', wspd: 0, wdir: 0, wgst: null }),
            metar({ icaoId: 'ZZ03', wdir: null }),
        ]),
        NOW,
    ).rows;
    assert.equal(rows[0].variableWind, true);
    assert.equal(rows[0].fromDeg, null);
    assert.equal(rows[1].windSpeedKts, 0);
    assert.equal(rows[1].variableWind, false);
    assert.equal(rows[1].fromDeg, null);
    assert.equal(rows[2].fromDeg, null);
    assert.equal(rows[2].variableWind, false);
});
test('AWC rejects missing/ms clocks, booleans, malformed numbers and unrelated report types', () => {
    for (const changes of [
        { obsTime: null },
        { obsTime: NOW },
        { obsTime: true },
        { metarType: 'BUOY' },
        { metarType: 'SYNOP' },
    ])
        assert.equal(parseAwcMetars(JSON.stringify([metar(changes)]), NOW).rows.length, 0);
    const row = parseAwcMetars(
        JSON.stringify([metar({ wspd: true, wgst: '12oops', temp: null, slp: null, altim: null })]),
        NOW,
    );
    assert.equal(row.rows.length, 0);
});
test('bounds fail closed and a full AWC response declares potential truncation', () => {
    assert.match(parseNdbcLatest('x'.repeat(MAX_FEED_BYTES + 1), NOW).error!, /exceeds/);
    assert.match(parseNdbcLatest(`${latestHeader}\n${'x\n'.repeat(8003)}`, NOW).error!, /limit/);
    assert.match(parseAwcMetars('[' + ' '.repeat(MAX_FEED_BYTES) + ']', NOW).error!, /exceeds/);
    assert.notEqual(parseAwcMetars('{}', NOW).error, null);
    assert.equal(parseAwcMetars(JSON.stringify(Array.from({ length: 400 }, () => metar())), NOW).partial, true);
    assert.notEqual(parseAwcMetars(JSON.stringify(Array.from({ length: 401 }, () => metar())), NOW).error, null);
});
test('nearest airport remains a separate land observation rather than replacing a marine station', () => {
    const rows = [
        ...parseNdbcLatest(ndbc(), NOW).rows,
        ...parseAwcMetars(JSON.stringify([metar({ lat: 30.0001 })]), NOW).rows,
    ];
    const nearby = selectNearbyObservations(rows, { lat: 30, lon: -150 }, NOW);
    assert.equal(nearby.marine?.observation.provider, 'ndbc');
    assert.equal(nearby.airport?.observation.provider, 'awc-metar');
    assert.match(nearby.airport!.exposureLabel, /METAR.*exposure.*unknown/);
    assert.match(nearby.marine!.exposureLabel, /unknown/);
    assert.equal(observationUiRows(nearby).length, 2);
});
test('distance selection wraps the dateline, rechecks age, and never implies full global station coverage', () => {
    const row = { ...sample(), lon: -179.9, lat: 0.1 };
    assert.ok(selectNearbyObservations([row], { lat: 0.1, lon: 179.9 }, NOW).airport!.distanceNm < 13);
    assert.equal(selectNearbyObservations([row], { lat: 0.1, lon: 179.9 }, NOW + 4 * HOUR_MS).airport, null);
    assert.match(observationEmptyMessage('ndbc', 'failed'), /Could not reach/);
    assert.match(observationEmptyMessage('awc-metar', 'native-required'), /does not allow browser access/);
    assert.match(observationEmptyMessage('ndbc', 'available'), /does not establish/);
});
test('corrected AWC observations replace the same timestamp without inventing a new observation time', () => {
    const first = sample(),
        corrected = { ...first, receivedAtMs: NOW - 60000, windSpeedKts: 20 };
    const result = selectNearbyObservations([first, corrected], { lat: 30, lon: -150 }, NOW);
    assert.equal(result.airport!.observation.windSpeedKts, 20);
    assert.equal(result.airport!.ageMinutes, 20);
});
test('history deduplicates corrections, returns copies and expires data without filling gaps', () => {
    const history = new ObservationHistory(),
        first = sample();
    history.put([first, { ...first, receivedAtMs: NOW, windSpeedKts: 20 }], NOW);
    const got = history.get('awc-metar', first.id, NOW, 12);
    assert.equal(got.length, 1);
    assert.equal(got[0].windSpeedKts, 20);
    got[0].windSpeedKts = 100;
    assert.equal(history.get('awc-metar', first.id, NOW)[0].windSpeedKts, 20);
    assert.equal(history.get('awc-metar', first.id, NOW + 73 * HOUR_MS).length, 0);
    assert.deepEqual(history.get('awc-metar', first.id, NOW, 1000), []);
});
test('history limits each station and the global byte/count quota, evicting least recently used stations', () => {
    const history = new ObservationHistory(),
        row = sample();
    history.put(
        Array.from({ length: 700 }, (_, i) => ({
            ...row,
            observedAtMs: NOW - i * 60000,
        })),
        NOW,
    );
    assert.equal(history.get('awc-metar', row.id, NOW).length, 512);
    history.put(
        Array.from({ length: 40 }, (_, i) => ({
            ...row,
            id: `X${i.toString().padStart(3, '0')}`,
        })),
        NOW + 1,
    );
    assert.ok(history.size() <= 32);
    assert.ok(history.bytes() <= 2 * 1024 * 1024);
    assert.equal(history.get('awc-metar', row.id, NOW + 1).length, 0);
});
test('history enforces its byte quota on a generated payload that actually exceeds it', () => {
    const history = new ObservationHistory(),
        row = sample();
    const samples = Array.from({ length: 15 * 512 }, (_, i) => ({
        ...row,
        id: `X${Math.floor(i / 512)
            .toString()
            .padStart(3, '0')}`,
        observedAtMs: NOW - (i % 512) * 5 * 60000,
    }));
    assert.ok(new TextEncoder().encode(JSON.stringify(samples)).length > ObservationHistory.MAX_SERIALIZED_BYTES);
    history.put(samples, NOW);
    assert.ok(history.bytes() <= ObservationHistory.MAX_SERIALIZED_BYTES);
    assert.ok(history.size() < 15);
});
test('a timestamp inside the small clock-skew allowance is labelled ahead, not freshened to now', () => {
    const row = parseAwcMetars(JSON.stringify([metar({ obsTime: NOW / 1000 + 120 })]), NOW).rows[0];
    const nearby = selectNearbyObservations([row], { lat: 30, lon: -150 }, NOW);
    assert.match(observationUiRows(nearby)[0].age, /2 min ahead/);
});
test('request plans use fixed public hosts/station IDs only and reject path/coordinate injection', () => {
    const latest = ndbcLatestRequest();
    assert.equal(new URL(latest.url).hostname, 'www.ndbc.noaa.gov');
    assert.equal(new URL(ndbcHistoryRequest('fpsn7').url).pathname, '/data/realtime2/FPSN7.txt');
    const plan = metarRequest(['ZZ01', 'ZZ02']);
    assert.equal(plan.nativeOnly, true);
    assert.equal(plan.redirect, 'error');
    assert.equal(plan.credentials, 'omit');
    assert.equal(new URL(plan.url).searchParams.get('ids'), 'ZZ01,ZZ02');
    assert.equal(new URL(plan.url).searchParams.has('bbox'), false);
    assert.equal(new URL(metarRequest(['ZZ01'], 72).url).searchParams.get('hours'), '72');
    for (const id of ['../foo', 'ZZ01&bbox=1,2,3,4', 'https://evil.test', '30,-150']) {
        assert.throws(() => ndbcHistoryRequest(id));
        assert.throws(() => metarRequest([id]));
    }
    assert.throws(() => metarRequest(['ZZ01', 'ZZ02'], 72));
    assert.throws(() => metarRequest(['ZZ01'], 73));
});
