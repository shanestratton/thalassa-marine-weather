/**
 * The loop that keeps the boat's track.
 *
 * The rules that matter are about NOT recording: a tick that cannot reach
 * Signal K, or gets a position with no GPS clock behind it, must write
 * nothing, say so, and leave the timer running. Failure is the normal case on
 * a boat — Signal K restarts, the gateway drops its slot, someone turns the
 * panel off — and none of it is an error.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TrackRecorderRunner, type TrackRunnerDeps } from './trackRunner.js';
import type { TrackPoint } from './trackRecorder.js';
import type { TrackStore } from './trackStore.js';

const T0 = Date.parse('2026-08-29T19:48:49.820Z');

function selfDoc(over: { lat?: number; lon?: number; iso?: string | null; sog?: number } = {}) {
    const nav: Record<string, unknown> = {
        position: { value: { latitude: over.lat ?? -27.195, longitude: over.lon ?? 153.105 } },
        speedOverGround: { value: over.sog ?? 3 },
        courseOverGroundTrue: { value: Math.PI / 2 },
    };
    if (over.iso !== null) nav.datetime = { value: over.iso ?? '2026-08-29T19:48:49.820Z' };
    return { navigation: nav };
}

/** Signal K's discovery handshake, then the self document. */
function fetchReturning(doc: unknown | 'throw' | 'down') {
    return async (url: string) => {
        if (doc === 'throw') throw new Error('socket hung up');
        if (doc === 'down') return { ok: false, json: async () => ({}) } as unknown as Response;
        if (url.endsWith('/signalk')) {
            return {
                ok: true,
                json: async () => ({ endpoints: { v1: { 'signalk-http': 'http://127.0.0.1:3000/signalk/v1/api/' } } }),
            } as unknown as Response;
        }
        return { ok: true, json: async () => doc } as unknown as Response;
    };
}

function fakeStore() {
    const written: TrackPoint[] = [];
    let checkpoints = 0;
    const store = {
        append: (points: TrackPoint[]) => {
            written.push(...points);
            return points.length;
        },
        checkpoint: () => {
            checkpoints += 1;
        },
        summary: () => ({ points: written.length, firstMs: null, lastMs: null, bytes: 0 }),
    } as unknown as TrackStore;
    return { store, written, checkpoints: () => checkpoints };
}

function deps(doc: unknown | 'throw' | 'down', store: TrackStore): TrackRunnerDeps {
    return { fetchImpl: fetchReturning(doc) as never, signalkOrigin: 'http://127.0.0.1:3000', store };
}

test('a good fix is logged', async () => {
    const { store, written } = fakeStore();
    const runner = new TrackRecorderRunner(deps(selfDoc(), store));
    assert.equal(await runner.tick(), 'logged');
    assert.equal(written.length, 1);
    assert.equal(written[0].reason, 'first');
    assert.equal(written[0].gpsTimeMs, T0);
});

test('a fix that has not moved is HELD, not written again', async () => {
    const { store, written } = fakeStore();
    const runner = new TrackRecorderRunner(deps(selfDoc(), store));
    assert.equal(await runner.tick(), 'logged');
    assert.equal(await runner.tick(), 'held');
    assert.equal(written.length, 1);
});

test('a position with no GPS clock behind it is refused and named', async () => {
    // The whole reason: a Pi has no RTC battery, so its own clock cannot be
    // trusted to stamp a track that will be read years later.
    const { store, written } = fakeStore();
    const runner = new TrackRecorderRunner(deps(selfDoc({ iso: null }), store));
    assert.equal(await runner.tick(), 'no-gps-time');
    assert.equal(written.length, 0);
});

test('Signal K being down is not an error', async () => {
    const { store, written } = fakeStore();
    const runner = new TrackRecorderRunner(deps('down', store));
    assert.equal(await runner.tick(), 'unreachable');
    assert.equal(written.length, 0);
});

test('a thrown socket is not an error either', async () => {
    const { store, written } = fakeStore();
    const runner = new TrackRecorderRunner(deps('throw', store));
    assert.equal(await runner.tick(), 'unreachable');
    assert.equal(written.length, 0);
});

test('a document with no position records nothing', async () => {
    const { store, written } = fakeStore();
    const runner = new TrackRecorderRunner(deps({ navigation: {} }, store));
    assert.equal(await runner.tick(), 'no-fix');
    assert.equal(written.length, 0);
});

test('an unreachable tick does not lose the track state', async () => {
    // The gap in the log is the honest record of a gap in the data; the next
    // good fix must simply continue, not start a new track.
    const { store, written } = fakeStore();
    let doc: unknown | 'throw' = selfDoc();
    const runner = new TrackRecorderRunner({
        fetchImpl: ((url: string) => fetchReturning(doc as never)(url)) as never,
        signalkOrigin: 'http://127.0.0.1:3000',
        store,
    });
    assert.equal(await runner.tick(), 'logged');
    doc = 'throw';
    assert.equal(await runner.tick(), 'unreachable');
    doc = selfDoc();
    // Still the same track: an unmoved fix is held, not re-logged as 'first'.
    assert.equal(await runner.tick(), 'held');
    assert.equal(written.length, 1);
});

test('it is OFF until asked, and stopping checkpoints the log', () => {
    const { store, checkpoints } = fakeStore();
    const runner = new TrackRecorderRunner(deps(selfDoc(), store));
    assert.equal(runner.isRunning(), false);
    runner.stop();
    // Stopping is the one moment we know the track is complete.
    assert.equal(checkpoints(), 1);
});

test('status names no position and no credential', async () => {
    const { store } = fakeStore();
    const runner = new TrackRecorderRunner(deps(selfDoc(), store));
    await runner.tick();
    const d = runner.describe();
    assert.equal(d.running, false);
    assert.equal(d.lastOutcome, 'logged');
    assert.equal(d.writtenThisSession, 1);
    assert.equal(JSON.stringify(d).includes('153.105'), false);
});
