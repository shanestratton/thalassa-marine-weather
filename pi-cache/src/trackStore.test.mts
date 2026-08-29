/**
 * The track store round-trips what the recorder hands it, and answers the
 * questions the log exists to answer.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TrackStore } from './trackStore.js';
import type { TrackPoint } from './trackRecorder.js';

const T0 = 1_756_500_000_000;

function tmpStore(): { store: TrackStore; dir: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thalassa-track-'));
    return { store: new TrackStore(dir), dir };
}

const pt = (over: Partial<TrackPoint> = {}): TrackPoint => ({
    lat: -27.195,
    lon: 153.105,
    gpsTimeMs: T0,
    reason: 'first',
    sogKts: 5,
    cogDeg: 90,
    depthM: 8.2,
    twsKts: 12,
    twdDeg: 130,
    stwKts: 4.6,
    hdgDeg: 84,
    waterTempC: 21.4,
    pressureHpa: null,
    heelDeg: -6.5,
    ...over,
});

test('a point survives the round trip with every instrument intact', () => {
    const { store, dir } = tmpStore();
    try {
        assert.equal(store.append([pt()]), 1);
        const rows = store.points({ fromMs: T0 - 1, toMs: T0 + 1 });
        assert.equal(rows.length, 1);
        const r = rows[0];
        assert.equal(r.lat, -27.195);
        assert.equal(r.depth_m, 8.2);
        assert.equal(r.tws_kts, 12);
        assert.equal(r.stw_kts, 4.6);
        assert.equal(r.hdg_deg, 84);
        assert.equal(r.water_temp_c, 21.4);
        assert.equal(r.heel_deg, -6.5);
        // A boat that does not report pressure stores a null, not a zero — a
        // zero here would read as a hurricane.
        assert.equal(r.pressure_hpa, null);
    } finally {
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('points come back oldest first, which is the order a track is drawn in', () => {
    const { store, dir } = tmpStore();
    try {
        store.append([
            pt({ gpsTimeMs: T0 + 2000, reason: 'heartbeat' }),
            pt({ gpsTimeMs: T0, reason: 'first' }),
            pt({ gpsTimeMs: T0 + 1000, reason: 'distance' }),
        ]);
        const rows = store.points({ fromMs: 0, toMs: T0 + 10_000 });
        assert.deepEqual(
            rows.map((r) => r.at_ms),
            [T0, T0 + 1000, T0 + 2000],
        );
    } finally {
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('the window is respected, so a year of track does not come back at once', () => {
    const { store, dir } = tmpStore();
    try {
        store.append([pt({ gpsTimeMs: T0 }), pt({ gpsTimeMs: T0 + 900_000 })]);
        assert.equal(store.points({ fromMs: T0 - 1, toMs: T0 + 1 }).length, 1);
    } finally {
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('the summary answers what the settings screen has to show honestly', () => {
    const { store, dir } = tmpStore();
    try {
        assert.deepEqual(store.summary().points, 0);
        store.append([pt({ gpsTimeMs: T0 }), pt({ gpsTimeMs: T0 + 60_000 })]);
        const s = store.summary();
        assert.equal(s.points, 2);
        assert.equal(s.firstMs, T0);
        assert.equal(s.lastMs, T0 + 60_000);
        assert.ok(s.bytes > 0);
    } finally {
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('an empty batch is a no-op, not an empty transaction', () => {
    const { store, dir } = tmpStore();
    try {
        assert.equal(store.append([]), 0);
        assert.equal(store.summary().points, 0);
    } finally {
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('reopening the same directory keeps the track', () => {
    // The Pi reboots. The log is the point.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thalassa-track-'));
    try {
        const first = new TrackStore(dir);
        first.append([pt()]);
        first.checkpoint();
        first.close();

        const second = new TrackStore(dir);
        assert.equal(second.summary().points, 1);
        second.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
