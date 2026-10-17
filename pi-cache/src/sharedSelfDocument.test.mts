import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fetchSelfDocument, currentReading, type BroadcastDeps } from './anchorBroadcaster.js';
import { TelemetryPublisher } from './telemetryPublisher.js';
import { WindHistory } from './windHistory.js';
import { TrackRecorderRunner } from './trackRunner.js';
import type { TrackStore } from './trackStore.js';
import type { TrackPoint } from './trackRecorder.js';

const now = Date.parse('2026-10-16T00:00:00Z');
const leaf = (value: unknown, at = now - 4000) => ({
    value,
    timestamp: new Date(at).toISOString(),
    $source: 'fixture.1',
});
const doc = () => ({
    uuid: 'urn:mrn:imo:mmsi:000000001',
    navigation: {
        position: leaf({ latitude: -27, longitude: 153 }),
        datetime: leaf(new Date(now - 4000).toISOString()),
        speedOverGround: leaf(3),
        courseOverGroundTrue: leaf(1),
    },
    environment: { wind: { speedTrue: leaf(5) } },
});
const noNetwork: BroadcastDeps['fetchImpl'] = async () => {
    throw new Error('Unexpected source fetch');
};

test('cache-only self source preserves original leaf clocks for anchor readers without discovery or REST', async () => {
    let calls = 0;
    const deps: BroadcastDeps = {
        fetchImpl: noNetwork,
        signalkOrigin: 'http://127.0.0.1:3000',
        now: () => now,
        selfDocument: async () => {
            calls++;
            return doc();
        },
    };
    assert.deepEqual(await fetchSelfDocument(deps), doc());
    const reading = await currentReading(deps);
    assert.deepEqual(reading.document, doc());
    assert.equal(reading.fix?.timestamp, now - 4000);
    assert.equal(calls, 2);
});
test('unknown or failed authenticated cache never downgrades to unauthenticated discovery', async () => {
    let fetches = 0;
    for (const source of [
        async () => null,
        async () => {
            throw new Error('synthetic cache failure');
        },
    ]) {
        assert.equal(
            await fetchSelfDocument({
                fetchImpl: async () => {
                    fetches++;
                    throw new Error('must not fetch');
                },
                signalkOrigin: 'http://127.0.0.1:3000',
                selfDocument: source,
            }),
            null,
        );
    }
    assert.equal(fetches, 0);
});
test('pre-aborted/current fences skip the cache; a cancellation or identity change during a cache read discards it', async () => {
    let reads = 0;
    const controller = new AbortController();
    controller.abort();
    assert.equal(
        await fetchSelfDocument({
            fetchImpl: noNetwork,
            signalkOrigin: 'http://127.0.0.1:3000',
            signal: controller.signal,
            selfDocument: async () => {
                reads++;
                return doc();
            },
        }),
        null,
    );
    assert.equal(reads, 0);
    for (const kind of ['abort', 'identity']) {
        const pending = new AbortController();
        let current = true;
        let resolve!: (value: unknown) => void;
        const reading = fetchSelfDocument({
            fetchImpl: noNetwork,
            signalkOrigin: 'http://127.0.0.1:3000',
            signal: pending.signal,
            isCurrent: () => current,
            selfDocument: () =>
                new Promise((r) => {
                    resolve = r;
                }),
        });
        if (kind === 'abort') pending.abort();
        else current = false;
        resolve(doc());
        assert.equal(await reading, null);
    }
});
test('real publisher uses the shared source and policy; source retirement retains legacy dated bus semantics without fetching Signal K', async () => {
    const posts: Record<string, unknown>[] = [];
    let current: unknown = doc(),
        reads = 0;
    const publisher = new TelemetryPublisher({
        fetchImpl: async (url, init) => {
            assert.equal(String(url), 'https://example.test/telemetry-relay');
            posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
            return Response.json({ ok: true });
        },
        signalkOrigin: 'http://127.0.0.1:3000',
        selfDocument: async () => {
            reads++;
            return current;
        },
        endpoint: 'https://example.test/telemetry-relay',
        anonKey: () => 'synthetic-public',
        credentials: () => ({ relayId: 'synthetic-relay', token: 'synthetic-token' }),
        internetAllowed: () => true,
        deviceLabel: 'Fictional Pi',
        now: () => now,
    });
    assert.equal(await publisher.publishOnce(), 'sent');
    assert.equal(posts[0].reported_at, new Date(now - 4000).toISOString());
    assert.equal((posts[0].extra as Record<string, unknown>).bus_at_ms, now - 4000);
    current = null;
    assert.equal(await publisher.publishOnce(), 'sent');
    assert.equal(posts[1].reported_at, posts[0].reported_at);
    assert.equal((posts[1].extra as Record<string, unknown>).bus_at_ms, now - 4000);
    assert.equal(reads, 2);
});
test('track runner and wind collector consume the same original-clock cache without hidden source HTTP', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'thalassa-shared-source-'));
    const written: TrackPoint[] = [];
    const store = {
        append: (points: TrackPoint[]) => {
            written.push(...points);
            return points.length;
        },
        checkpoint: () => undefined,
        summary: () => ({ points: written.length, firstMs: null, lastMs: null, bytes: 0 }),
    } as unknown as TrackStore;
    const deps = {
        fetchImpl: noNetwork,
        signalkOrigin: 'http://127.0.0.1:3000',
        selfDocument: async () => doc(),
        now: () => now,
    };
    const recorder = new TrackRecorderRunner({ ...deps, store });
    const history = new WindHistory({ ...deps, cacheDir: dir, vesselIdentity: 'fictional-pi' });
    try {
        assert.equal(await recorder.tick(), 'logged');
        assert.equal(written[0].gpsTimeMs, now - 4000);
        await history.start();
        assert.equal(history.extra().wind_history_samples_1h, 1);
        assert.equal(history.extra().wind_history_since_ms, now - 4000);
        await history.sampleOnce();
        assert.equal(history.extra().wind_history_samples_1h, 1, 'same cached reading is not a second observation');
    } finally {
        recorder.stop();
        history.stop();
        await rm(dir, { recursive: true, force: true });
    }
});
