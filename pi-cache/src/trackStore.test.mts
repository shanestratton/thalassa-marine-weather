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

test('polar RPM/TWA columns migrate as nullable and the append cursor survives duplicate GPS time', () => {
    const { store, dir } = tmpStore();
    try {
        store.append([pt(), pt({ engineRpm: 0, twaDeg: 90 })]);
        const rows = store.polarPointsAfter(0);
        assert.equal(rows.length, 2);
        assert.equal(rows[0].engine_rpm, null);
        assert.equal(rows[0].twa_deg, null);
        assert.equal(rows[1].engine_rpm, 0);
        assert.equal(rows[1].twa_deg, 90);
        assert.deepEqual(
            store.polarPointsAfter(Number(rows[0].sample_id)).map((row) => row.sample_id),
            [rows[1].sample_id],
        );
        store.writePolarState(JSON.stringify({ cursor: rows[1].sample_id, samples: 1 }));
        assert.equal(store.polarLastRowId(), rows[1].sample_id);
        assert.deepEqual(JSON.parse(store.readPolarState()!), { cursor: rows[1].sample_id, samples: 1 });
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

test('derived-instrument source clocks migrate nullable and round-trip without borrowing row time', () => {
    const { store, dir } = tmpStore();
    try {
        store.append([
            pt(),
            pt({
                gpsTimeMs: T0 + 5000,
                sogAtMs: T0 - 1000,
                cogTrueAtMs: T0 - 2000,
                stwAtMs: T0 - 3000,
                headingTrueDeg: 0,
                headingTrueAtMs: T0 - 4000,
                engineRpm: 0,
                engineRpmAtMs: T0 - 5000,
                leewayDeg: -2,
                leewayAtMs: T0 - 6000,
                leewaySource: 'explicit sensor',
            }),
        ]);
        const rows = store.points({ fromMs: T0, toMs: T0 + 10000 });
        for (const key of [
            'sog_at_ms',
            'cog_true_at_ms',
            'stw_at_ms',
            'heading_true_deg',
            'heading_true_at_ms',
            'engine_rpm_at_ms',
            'leeway_deg',
            'leeway_at_ms',
            'leeway_source',
        ])
            assert.equal(rows[0][key], null);
        assert.equal(rows[1].heading_true_deg, 0);
        assert.equal(rows[1].heading_true_at_ms, T0 - 4000);
        assert.equal(rows[1].engine_rpm_at_ms, T0 - 5000);
        assert.equal(rows[1].leeway_source, 'explicit sensor');
        store.close();
        const reopened = new TrackStore(dir);
        assert.equal(reopened.points({ fromMs: T0, toMs: T0 + 10000 })[1].stw_at_ms, T0 - 3000);
        reopened.close();
    } finally {
        try {
            store.close();
        } catch {}
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
