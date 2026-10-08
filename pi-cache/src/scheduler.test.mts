/**
 * The pre-fetch scheduler fetches no Bureau of Meteorology chart.
 *
 * Until Pi update 1 (build 125, 125-10) a southern-hemisphere Pi pre-fetched
 * BOM's MSLP analysis (IDY00030) and its black-and-white chart (IDX0894)
 * every cycle. BOM's copyright terms do not allow commercial use, so the Pi
 * fetches neither. The northern hemisphere's NOAA OPC charts are untouched.
 * Every position here is a fictional boat.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as scheduler from './scheduler.js';

const SOUTHERN = [
    { name: 'off Cape Town', lat: -34.05, lon: 18.35 },
    { name: 'Valparaíso', lat: -33.03, lon: -71.63 },
    { name: 'the Hauraki Gulf', lat: -36.8, lon: 174.9 },
    { name: 'Moreton Bay', lat: -27.3, lon: 153.2 },
    { name: 'just south of the equator, Indian Ocean', lat: -0.5, lon: 73.2 },
];

type Plan = (lat: number, lon: number) => Array<{ key: string; url: string; contentType: string }>;
const plan = (): Plan => {
    const fn = (scheduler as Record<string, unknown>).synopticChartsFor;
    assert.equal(typeof fn, 'function', 'scheduler exports synopticChartsFor, the synoptic job’s chart list');
    return fn as Plan;
};

test('no southern-hemisphere boat pre-fetches a BOM chart, or any synoptic chart', () => {
    for (const boat of SOUTHERN) {
        const charts = plan()(boat.lat, boat.lon);
        assert.deepEqual(charts, [], boat.name);
    }
});

test('the northern hemisphere keeps exactly the NOAA OPC charts it had', () => {
    const atlantic = [
        { key: 'synoptic:noaa:overview', url: 'https://ocean.weather.gov/UA/entire_UA.gif', contentType: 'image/gif' },
        { key: 'synoptic:noaa:atlantic', url: 'https://ocean.weather.gov/UA/OPC_ATL.gif', contentType: 'image/gif' },
    ];
    const pacific = [
        atlantic[0],
        { key: 'synoptic:noaa:pacific', url: 'https://ocean.weather.gov/UA/OPC_PAC.gif', contentType: 'image/gif' },
    ];
    assert.deepEqual(plan()(50.77, -1.3), atlantic, 'the Solent');
    assert.deepEqual(plan()(37.74, -25.67), atlantic, 'the Azores');
    assert.deepEqual(plan()(47.6, -122.4), pacific, 'Puget Sound');
    assert.deepEqual(plan()(35.4, 139.8), pacific, 'Tokyo Bay');
});

test('no chart anywhere comes from bom.gov.au', () => {
    for (let lat = -80; lat <= 80; lat += 10) {
        for (let lon = -180; lon <= 180; lon += 30) {
            for (const chart of plan()(lat, lon)) assert.doesNotMatch(chart.url, /bom\.gov\.au/i, `${lat},${lon}`);
        }
    }
    // Nor anywhere else in the scheduler: no URL on the Bureau's host at all.
    const source = readFileSync(new URL('./scheduler.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /bom\.gov\.au/i);
});
