import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TrackStore } from './trackStore.js';
import type { TrackPoint } from './trackRecorder.js';

const T = 1_760_000_000_000;
function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thalassa-track-page-'));
    const store = new TrackStore(dir);
    const point = (gpsTimeMs = T): TrackPoint => ({
        gpsTimeMs,
        lat: 0,
        lon: 179.9,
        reason: 'first',
        sogKts: 0,
        cogDeg: null,
        stwKts: null,
        hdgDeg: null,
        depthM: null,
        twsKts: null,
        twdDeg: null,
        waterTempC: null,
        pressureHpa: null,
        heelDeg: null,
    });
    return {
        store,
        point,
        close() {
            store.close();
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}
function cursor(value: string) {
    const [atMs, rowId, snapshot] = value.split(':').map(Number);
    return { atMs, rowId, snapshot };
}
test('composite pages retain every duplicate timestamp, with no false final truncation', () => {
    const h = fixture();
    try {
        h.store.append([h.point(), h.point(), h.point(), h.point(T + 1)]);
        const first = h.store.pointsPage({ fromMs: T, toMs: T + 1, limit: 2 });
        assert.equal(first.truncated, true);
        assert.deepEqual(
            first.points.map((row) => row.sample_id),
            [1, 2],
        );
        const second = h.store.pointsPage({ fromMs: T, toMs: T + 1, limit: 2, cursor: cursor(first.nextCursor!) });
        assert.deepEqual(
            second.points.map((row) => row.sample_id),
            [3, 4],
        );
        assert.equal(second.truncated, false);
        assert.equal(second.nextCursor, null);
        assert.equal(second.points[0].sog_kts, 0);
        assert.equal(second.points[0].pressure_hpa, null);
    } finally {
        h.close();
    }
});
test('the first-page append snapshot excludes concurrent inserts, including backdated fixes', () => {
    const h = fixture();
    try {
        h.store.append([h.point(), h.point(T + 1), h.point(T + 2)]);
        const first = h.store.pointsPage({ fromMs: T, toMs: T + 10, limit: 1 });
        h.store.append([h.point(), h.point(T + 1), h.point(T + 5)]);
        const second = h.store.pointsPage({ fromMs: T, toMs: T + 10, limit: 10, cursor: cursor(first.nextCursor!) });
        assert.deepEqual(
            second.points.map((row) => row.sample_id),
            [2, 3],
        );
        assert.equal(second.snapshot, 3);
        assert.equal(second.truncated, false);
        assert.equal(h.store.pointsPage({ fromMs: T, toMs: T + 10 }).points.length, 6);
    } finally {
        h.close();
    }
});
test('GPS time ordering uses row ID only as its tie-breaker', () => {
    const h = fixture();
    try {
        h.store.append([h.point(T + 2), h.point(), h.point(T + 1), h.point()]);
        const all = h.store.pointsPage({ fromMs: T, toMs: T + 2 });
        assert.deepEqual(
            all.points.map((row) => row.sample_id),
            [2, 4, 3, 1],
        );
        assert.equal(all.truncated, false);
    } finally {
        h.close();
    }
});
test('empty windows are complete and impossible future snapshots are refused', () => {
    const h = fixture();
    try {
        assert.deepEqual(h.store.pointsPage({ fromMs: T, toMs: T }), {
            points: [],
            snapshot: 0,
            truncated: false,
            nextCursor: null,
        });
        assert.throws(
            () => h.store.pointsPage({ fromMs: T, toMs: T, cursor: { atMs: T, rowId: 1, snapshot: 2 } }),
            RangeError,
        );
    } finally {
        h.close();
    }
});
