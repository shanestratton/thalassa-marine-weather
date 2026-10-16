import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PiUnderwayWatch, validUnderwayConfiguration } from './underwayWatch.js';
import { UNDERWAY_DEFAULTS } from './lookaheadShared/services/underway/underwayRule.js';

const initial = Date.UTC(2026, 9, 16);
const config = () => ({
    key: 'test-route',
    route: [
        { lat: 30, lon: -150 },
        { lat: 30, lon: -149 },
    ],
    draftM: 2,
    ukcM: 0.5,
    prefs: UNDERWAY_DEFAULTS,
});
function harness(file?: string) {
    let now = initial,
        lat = 30,
        anchor = false,
        stale = false;
    let answer = { coverage: 'charted' as 'charted' | 'partial' | 'unavailable', danger: false };
    const watch = new PiUnderwayWatch({
        file,
        now: () => now,
        atAnchor: () => anchor,
        self: async () => {
            const stamp = new Date(now - (stale ? 31000 : 0)).toISOString();
            return {
                navigation: {
                    position: { value: { latitude: lat, longitude: -149.8 }, timestamp: stamp },
                    datetime: { value: stamp },
                    speedOverGround: { value: 6 / 1.94384, timestamp: stamp },
                    courseOverGroundTrue: { value: Math.PI / 2, timestamp: stamp },
                },
            };
        },
        vault: { lookahead: async () => ({ ...answer }) },
    });
    return {
        watch,
        step: async (dt = 5000, nextLat = lat) => {
            now += dt;
            lat = nextLat;
            await watch.pass();
        },
        danger: (value: boolean, coverage = answer.coverage) => {
            answer = { danger: value, coverage };
        },
        anchor: (value: boolean) => (anchor = value),
        stale: (value: boolean) => (stale = value),
    };
}
test('Pi XTE arms on the line, confirms two fresh off-line fixes, and ignores cached fixes', async (t) => {
    const h = harness();
    t.after(() => h.watch.close());
    assert.equal(h.watch.configure(config()), true);
    await h.step();
    assert.equal(h.watch.describe().xte, 'watching');
    await h.step(5000, 30.03);
    assert.equal(h.watch.describe().alarms.length, 0);
    await h.step(10000);
    assert.equal(h.watch.describe().alarms[0]?.kind, 'off-route');
    const alarm = h.watch.describe().alarms[0];
    h.stale(true);
    await h.step();
    assert.deepEqual(h.watch.describe().alarms, [alarm]);
    assert.equal(h.watch.describe().xte, 'no-fix');
    h.stale(false);
    h.anchor(true);
    await h.step();
    assert.equal(h.watch.describe().alarms.length, 0);
});
test('a partial or failed chart scan cannot clear a danger; positive complete evidence can', async (t) => {
    const h = harness();
    t.after(() => h.watch.close());
    h.watch.configure(config());
    h.danger(true);
    await h.step();
    assert.equal(h.watch.describe().alarms[0]?.kind, 'chart-ahead');
    h.danger(false, 'partial');
    await h.step();
    assert.equal(h.watch.describe().alarms.length, 1);
    h.danger(false, 'unavailable');
    await h.step();
    assert.equal(h.watch.describe().alarms.length, 1);
    h.danger(false, 'charted');
    await h.step();
    assert.equal(h.watch.describe().alarms.length, 0);
});
test('acknowledgements are encounter-specific; the next danger re-arms', async (t) => {
    const h = harness();
    t.after(() => h.watch.close());
    h.watch.configure(config());
    h.danger(true);
    await h.step();
    const key = h.watch.describe().alarms[0].key;
    assert.equal(h.watch.acknowledge(key), true);
    assert.notEqual(h.watch.describe().alarms[0].ackedAt, null);
    assert.equal(h.watch.acknowledge('chart-ahead::1'), false);
    h.danger(false);
    await h.step();
    h.danger(true);
    await h.step();
    assert.notEqual(h.watch.describe().alarms[0].key, key);
    assert.equal(h.watch.describe().alarms[0].ackedAt, null);
});
test('restart retains an armed route, but requires fresh fixes to raise an off-route alarm', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thalassa-underway-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'watch.json');
    const first = harness(file);
    first.watch.configure(config());
    await first.step();
    first.watch.close();
    const second = harness(file);
    t.after(() => second.watch.close());
    second.watch.restore();
    await second.step(5000, 30.03);
    assert.equal(second.watch.describe().alarms.length, 0);
    await second.step(10000);
    assert.equal(second.watch.describe().alarms[0]?.kind, 'off-route');
    assert.equal(second.watch.standDown(), true);
    assert.equal(second.watch.describe().armed, false);
});
test('route change or stand-down invalidates a delayed vault response', async (t) => {
    let resolve!: (value: { coverage: 'charted'; danger: boolean }) => void;
    const base = harness();
    base.watch.close();
    const now = initial;
    const watch = new PiUnderwayWatch({
        now: () => now,
        atAnchor: () => false,
        self: async () => ({
            navigation: {
                position: { value: { latitude: 30, longitude: -149.8 }, timestamp: new Date(now).toISOString() },
                datetime: { value: new Date(now).toISOString() },
                speedOverGround: { value: 3, timestamp: new Date(now).toISOString() },
                courseOverGroundTrue: { value: 1, timestamp: new Date(now).toISOString() },
            },
        }),
        vault: {
            lookahead: () =>
                new Promise((r) => {
                    resolve = r;
                }),
        },
    });
    t.after(() => watch.close());
    watch.configure(config());
    const pending = watch.pass();
    await new Promise((r) => setImmediate(r));
    watch.standDown();
    resolve({ coverage: 'charted', danger: true });
    await pending;
    assert.deepEqual(watch.describe().alarms, []);
    assert.equal(watch.describe().armed, false);
});
for (const interruption of ['anchor', 'stale-fix'] as const) {
    test(`a delayed vault result cannot raise a new danger after ${interruption}`, async (t) => {
        let now = initial;
        let anchored = false;
        let resolve!: (value: { coverage: 'charted'; danger: boolean }) => void;
        const watch = new PiUnderwayWatch({
            now: () => now,
            atAnchor: () => anchored,
            self: async () => ({
                navigation: {
                    position: {
                        value: { latitude: 30, longitude: -149.8 },
                        timestamp: new Date(initial).toISOString(),
                    },
                    speedOverGround: { value: 3, timestamp: new Date(initial).toISOString() },
                    courseOverGroundTrue: { value: 1, timestamp: new Date(initial).toISOString() },
                },
            }),
            vault: {
                lookahead: () =>
                    new Promise((r) => {
                        resolve = r;
                    }),
            },
        });
        t.after(() => watch.close());
        watch.configure(config());
        const pending = watch.pass();
        await new Promise((r) => setImmediate(r));
        if (interruption === 'anchor') anchored = true;
        else now += 31_000;
        resolve({ coverage: 'charted', danger: true });
        await pending;
        assert.deepEqual(watch.describe().alarms, []);
        assert.equal(watch.describe().coverage, interruption === 'anchor' ? 'at-anchor' : 'unavailable');
    });
}
test('configuration refuses degenerate/oversized lines and invalid keel rules', () => {
    for (const value of [
        { ...config(), route: [] },
        { ...config(), route: Array(1001).fill({ lat: 30, lon: 0 }) },
        {
            ...config(),
            route: [
                { lat: 90, lon: 0 },
                { lat: 90, lon: 1 },
            ],
        },
        { ...config(), ukcM: 0.49 },
        { ...config(), draftM: NaN },
        {
            ...config(),
            route: [
                { lat: 30, lon: 0 },
                { lat: 30, lon: 0 },
            ],
        },
    ])
        assert.equal(validUnderwayConfiguration(value), null);
});
