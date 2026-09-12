import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    WindHistory,
    RollingWindHistory,
    readWindHistorySample,
    WIND_HISTORY_MS,
    WIND_HISTORY_SAMPLE_CAP,
} from './windHistory.js';
import { readTelemetrySnapshot } from './trackSignalk.js';
import { buildTelemetryBody } from './telemetryPublisher.js';
import type { BroadcastDeps } from './anchorBroadcaster.js';

const NOW = Date.parse('2026-09-10T00:00:00Z');
const SOURCE = 'ydwg-tcp.YD';
const doc = (at = NOW, kts = 10, source = SOURCE) => ({
    environment: {
        wind: { speedTrue: { value: kts / 1.94384, timestamp: new Date(at).toISOString(), $source: source } },
    },
});
const observation = (at: number, kts: number, source = SOURCE) => ({ at, kts, source });
const fakeSignalK =
    (read: () => unknown): BroadcastDeps['fetchImpl'] =>
    async (url, init) => {
        assert.ok(init?.signal, 'every request has a bounded abort signal');
        assert.ok(String(url).startsWith('http://127.0.0.1:3000/'), 'local Signal K only');
        if (String(url).endsWith('/signalk'))
            return new Response(
                JSON.stringify({
                    endpoints: { v1: { 'signalk-http': 'http://127.0.0.1:3000/signalk/v1/api/' } },
                }),
            );
        return new Response(JSON.stringify(read()));
    };

test('source-owned timestamps and knots are required; calm zero remains real data', () => {
    assert.deepEqual(readWindHistorySample(doc(NOW, 0), NOW), observation(NOW, 0));
    assert.ok(Math.abs(readWindHistorySample(doc(NOW, 23), NOW)!.kts - 23) < 1e-10);
    for (const value of [
        doc(NOW - 20_001),
        doc(NOW + 1),
        doc(NOW, -1),
        doc(NOW, 151),
        doc(NOW, 10, ''),
        doc(NOW, 10, 'x'.repeat(121)),
    ])
        assert.equal(readWindHistorySample(value, NOW), null);
    const parentOnly = doc();
    delete (parentOnly.environment.wind.speedTrue as { timestamp?: string }).timestamp;
    assert.equal(readWindHistorySample({ ...parentOnly, timestamp: new Date(NOW).toISOString() }, NOW), null);
    const missingSource = doc();
    delete (missingSource.environment.wind.speedTrue as { $source?: string }).$source;
    assert.equal(readWindHistorySample(missingSource, NOW), null);
    for (const bad of [NaN, Infinity, '10', null]) {
        const input = doc();
        (input.environment.wind.speedTrue as { value: unknown }).value = bad;
        assert.equal(readWindHistorySample(input, NOW), null);
    }
});

test('peaks expire on read without new data; hourly maximum and ten-minute peak are separate', () => {
    const history = new RollingWindHistory();
    history.ingest(observation(NOW, 28), NOW);
    history.ingest(observation(NOW + 15 * 60_000, 14), NOW + 15 * 60_000);
    history.ingest(observation(NOW + 20 * 60_000, 0), NOW + 20 * 60_000);
    const state = history.extra(NOW + 20 * 60_000);
    assert.equal(state.wind_max_1h_kts, 28);
    assert.equal(state.wind_gust_10m_kts, 14);
    assert.equal(state.wind_history_since_ms, NOW);
    assert.equal(state.wind_history_samples_1h, 3);
    assert.equal(history.extra(NOW + 31 * 60_000).wind_gust_10m_kts, undefined);
    assert.equal(history.extra(NOW + WIND_HISTORY_MS + 1).wind_max_1h_kts, 14);
    assert.deepEqual(history.extra(NOW + 81 * 60_000), {});
});

test('cached/out-of-order timestamps are not samples, source change starts a separate record', () => {
    const history = new RollingWindHistory();
    assert.equal(history.ingest(observation(NOW, 27), NOW), true);
    assert.equal(history.ingest(observation(NOW, 40), NOW + 5_000), false);
    assert.equal(history.ingest(observation(NOW - 1, 41), NOW + 5_000), false);
    assert.equal(history.extra(NOW + 5_000).wind_history_samples_1h, 1);
    history.ingest(observation(NOW + 5_000, 6, 'second-sensor'), NOW + 5_000);
    assert.equal(history.extra(NOW + 5_000).wind_max_1h_kts, 6);
    assert.equal(history.extra(NOW + 5_000).wind_history_source, 'second-sensor');
    assert.equal(history.extra(NOW + 5_000).wind_history_since_ms, NOW + 5_000);
});

test('an older or equal-time different sensor cannot replace a newer source record', () => {
    const history = new RollingWindHistory();
    history.ingest(observation(NOW, 27, 'current-sensor'), NOW);
    assert.equal(history.ingest(observation(NOW - 1, 60, 'delayed-sensor'), NOW + 5_000), false);
    assert.equal(history.ingest(observation(NOW, 70, 'delayed-sensor'), NOW + 5_000), false);
    assert.equal(history.extra(NOW + 5_000).wind_history_source, 'current-sensor');
    assert.equal(history.extra(NOW + 5_000).wind_max_1h_kts, 27);
    assert.equal(history.ingest(observation(NOW + 1_000, 7, 'replacement-sensor'), NOW + 5_000), true);
    assert.equal(history.extra(NOW + 5_000).wind_history_source, 'replacement-sensor');
    assert.equal(history.extra(NOW + 5_000).wind_max_1h_kts, 7);
});

test('rolling windows exclude their exact old boundary, matching the app parser', () => {
    const history = new RollingWindHistory();
    history.ingest(observation(NOW, 18), NOW);
    assert.equal(history.extra(NOW + 600_000 - 1).wind_gust_10m_kts, 18);
    assert.equal(history.extra(NOW + 600_000).wind_gust_10m_kts, undefined);
    assert.equal(history.extra(NOW + WIND_HISTORY_MS - 1).wind_max_1h_kts, 18);
    assert.deepEqual(history.extra(NOW + WIND_HISTORY_MS), {});
    assert.notEqual(readWindHistorySample(doc(NOW), NOW + 20_000), null, 'live budget remains inclusive');
});

test('hard cap drops the oldest coverage instead of advertising a fabricated full hour', () => {
    const history = new RollingWindHistory();
    for (let i = 0; i <= WIND_HISTORY_SAMPLE_CAP; i++) history.ingest(observation(NOW + i, i === 0 ? 100 : 3), NOW + i);
    const state = history.extra(NOW + WIND_HISTORY_SAMPLE_CAP);
    assert.equal(state.wind_history_samples_1h, WIND_HISTORY_SAMPLE_CAP);
    assert.equal(state.wind_history_since_ms, NOW + 1);
    assert.equal(state.wind_max_1h_kts, 3);
});

test('restore validates identity, ordering, bounds, and actual ages; never restores old/future data', () => {
    const input = JSON.stringify({
        version: 1,
        identity: 'pi-a',
        source: SOURCE,
        samples: [
            { at: NOW - WIND_HISTORY_MS - 1, kts: 100 },
            { at: NOW - 5_000, kts: 16 },
            { at: NOW - 5_000, kts: 90 },
            { at: NOW - 6_000, kts: 99 },
            { at: NOW, kts: 0 },
            { at: NOW + 1, kts: 110 },
            { at: NOW, kts: 900 },
        ],
    });
    const history = new RollingWindHistory();
    history.restore(input, NOW, 'pi-a');
    assert.equal(history.extra(NOW).wind_history_samples_1h, 2);
    assert.equal(history.extra(NOW).wind_max_1h_kts, 16);
    const copied = new RollingWindHistory();
    copied.restore(input, NOW, 'pi-b');
    assert.deepEqual(copied.extra(NOW), {});
    for (const raw of [
        'not json',
        '{"version":2}',
        'x'.repeat(160_001),
        JSON.stringify({ version: 1, source: SOURCE, samples: Array(2001).fill({ at: NOW, kts: 9 }) }),
    ]) {
        const invalid = new RollingWindHistory();
        invalid.restore(raw, NOW);
        assert.deepEqual(invalid.extra(NOW), {});
    }
});

test('local collector persists and restores with no page, cloud permission, or pairing dependency', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'thalassa-wind-history-'));
    let now = NOW;
    let current: unknown = doc();
    const deps = {
        cacheDir,
        vesselIdentity: 'pi-a',
        signalkOrigin: 'http://127.0.0.1:3000',
        now: () => now,
        fetchImpl: fakeSignalK(() => current),
    };
    const history = new WindHistory(deps);
    const restored = new WindHistory(deps);
    try {
        await history.start();
        assert.equal(history.extra().wind_history_identity, 'pi-a');
        assert.equal(history.extra().wind_history_samples_1h, 1);
        now += 5_000;
        await history.sampleOnce(); // unchanged source envelope
        assert.equal(history.extra().wind_history_samples_1h, 1);
        current = doc(now, 0);
        await history.sampleOnce();
        assert.equal(
            JSON.parse(await readFile(join(cacheDir, 'wind-history.json'), 'utf8')).samples.length,
            1,
            'five-second collection does not rewrite the whole file every time',
        );
        now = NOW + 30_000;
        current = doc(now, 5);
        await history.sampleOnce();
        history.stop();
        const persisted = JSON.parse(await readFile(join(cacheDir, 'wind-history.json'), 'utf8'));
        assert.equal(persisted.samples.length, 3);
        assert.deepEqual(await readdir(cacheDir), ['wind-history.json']);
        current = null;
        await restored.start();
        assert.equal(restored.extra().wind_history_samples_1h, 3);
        now += WIND_HISTORY_MS + 1;
        assert.deepEqual(restored.extra(), {});
    } finally {
        history.stop();
        restored.stop();
        await rm(cacheDir, { recursive: true, force: true });
    }
});

test('stop rejects a late HTTP result and never writes its sample', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'thalassa-wind-stop-'));
    let release!: () => void;
    let reached!: () => void;
    const waiting = new Promise<void>((resolve) => {
        release = resolve;
    });
    const started = new Promise<void>((resolve) => {
        reached = resolve;
    });
    const base = fakeSignalK(() => doc());
    const history = new WindHistory({
        cacheDir,
        now: () => NOW,
        signalkOrigin: 'http://127.0.0.1:3000',
        fetchImpl: async (url, init) => {
            if (!String(url).endsWith('/signalk')) {
                reached();
                await waiting;
            }
            return base(url, init);
        },
    });
    try {
        const pending = history.start();
        await started;
        history.stop();
        release();
        await pending;
        assert.deepEqual(history.extra(), {});
        assert.deepEqual(await readdir(cacheDir), []);
    } finally {
        history.stop();
        release?.();
        await rm(cacheDir, { recursive: true, force: true });
    }
});

for (const failure of ['cached', 'absent', 'failed'] as const) {
    test(`pending observed peaks flush on schedule after the wind source becomes ${failure}`, async () => {
        const cacheDir = await mkdtemp(join(tmpdir(), 'thalassa-wind-dirty-'));
        let now = NOW;
        let current: unknown = doc();
        let fail = false;
        const deps = {
            cacheDir,
            vesselIdentity: 'pi-dirty',
            now: () => now,
            signalkOrigin: 'http://127.0.0.1:3000',
            fetchImpl: fakeSignalK(() => {
                if (fail) throw new Error('Signal K unavailable');
                return current;
            }),
        };
        const history = new WindHistory(deps);
        const restored = new WindHistory(deps);
        try {
            await history.start();
            now += 5_000;
            current = doc(now, 44);
            await history.sampleOnce();
            assert.equal(JSON.parse(await readFile(join(cacheDir, 'wind-history.json'), 'utf8')).samples.length, 1);
            now = NOW + 30_000;
            if (failure === 'absent') current = null;
            if (failure === 'failed') fail = true;
            await history.sampleOnce();
            const persisted = JSON.parse(await readFile(join(cacheDir, 'wind-history.json'), 'utf8'));
            assert.equal(persisted.samples.length, 2);
            assert.equal(persisted.samples[1].kts, 44);
            history.stop();
            current = null;
            fail = false;
            await restored.start();
            assert.equal(restored.extra().wind_max_1h_kts, 44);
            assert.equal(restored.extra().wind_history_samples_1h, 2);
        } finally {
            history.stop();
            restored.stop();
            await rm(cacheDir, { recursive: true, force: true });
        }
    });
}

test('local sampling never follows Signal K discovery or redirects onto the internet', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'thalassa-wind-local-'));
    let calls = 0;
    const history = new WindHistory({
        cacheDir,
        now: () => NOW,
        signalkOrigin: 'http://127.0.0.1:3000',
        fetchImpl: async (_url, init) => {
            calls++;
            assert.equal(init?.redirect, 'error');
            return new Response(JSON.stringify({ endpoints: { v1: { 'signalk-http': 'https://example.com/api/' } } }));
        },
    });
    try {
        await history.start();
        assert.equal(calls, 1);
        assert.deepEqual(history.extra(), {});
    } finally {
        history.stop();
        await rm(cacheDir, { recursive: true, force: true });
    }
});

test('disk load is bounded and refuses symlinked history; failed reads leave collection operational', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'thalassa-wind-disk-'));
    const target = join(cacheDir, 'other-record.json');
    const link = join(cacheDir, 'wind-history.json');
    const old = JSON.stringify({ version: 1, source: SOURCE, samples: [{ at: NOW, kts: 99 }] });
    await writeFile(target, old);
    await symlink(target, link);
    const history = new WindHistory({
        cacheDir,
        now: () => NOW,
        signalkOrigin: 'http://127.0.0.1:3000',
        fetchImpl: fakeSignalK(() => doc(NOW, 7)),
    });
    try {
        await history.start();
        assert.equal(history.extra().wind_max_1h_kts, 7);
        assert.equal(await readFile(target, 'utf8'), old, 'atomic replace never follows a symlink target');
    } finally {
        history.stop();
        await rm(cacheDir, { recursive: true, force: true });
    }
});

test('current telemetry adds only the real TWS leaf timestamp and retains current values', () => {
    for (const at of [NOW, NOW - 20_000]) {
        const snapshot = readTelemetrySnapshot(doc(at), () => NOW)!;
        assert.equal(snapshot.extra?.wind_tws_at_ms, at);
        assert.equal(snapshot.extra?.wind_tws_source, SOURCE);
        assert.equal((buildTelemetryBody(snapshot, 'test').extra as Record<string, unknown>).wind_tws_at_ms, at);
    }
    for (const at of [NOW - 20_001, NOW + 1]) {
        const snapshot = readTelemetrySnapshot(doc(at), () => NOW)!;
        assert.equal(snapshot.extra?.wind_tws_at_ms, undefined);
        assert.equal(snapshot.extra?.wind_tws_source, undefined);
        assert.equal(snapshot.twsKts, 10, 'current gauge behavior is untouched');
    }
    const withoutLeafTime = doc();
    delete (withoutLeafTime.environment.wind.speedTrue as { timestamp?: string }).timestamp;
    const snapshot = readTelemetrySnapshot({ ...withoutLeafTime, timestamp: new Date(NOW).toISOString() }, () => NOW)!;
    assert.equal(snapshot.extra?.wind_tws_at_ms, undefined);
    for (const bad of ['', 'x'.repeat(121), 'sensor\nother']) {
        const snapshot = readTelemetrySnapshot(doc(NOW, 10, bad), () => NOW)!;
        assert.equal(snapshot.extra?.wind_tws_source, undefined);
    }
});

test('sensor changes force immediate persistence even inside the write-throttle window', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'thalassa-wind-source-'));
    let now = NOW;
    let current = doc();
    const history = new WindHistory({
        cacheDir,
        now: () => now,
        signalkOrigin: 'http://127.0.0.1:3000',
        fetchImpl: fakeSignalK(() => current),
    });
    try {
        await history.start();
        now += 5_000;
        current = doc(now, 3, 'replacement-sensor');
        await history.sampleOnce();
        const persisted = JSON.parse(await readFile(join(cacheDir, 'wind-history.json'), 'utf8'));
        assert.equal(persisted.source, 'replacement-sensor');
        assert.equal(persisted.samples.length, 1);
        assert.equal(persisted.samples[0].kts, 3);
    } finally {
        history.stop();
        await rm(cacheDir, { recursive: true, force: true });
    }
});
