import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PiPolarLearner } from './polarLearner.js';
import {
    polarPeriodAt,
    polarPeriodForAltitude,
    polarSailingGate,
    type PolarObservation,
    type PolarTable,
} from './polarLearningRule.js';

const baseline: PolarTable = {
    windSpeeds: [4, 30],
    angles: [40, 180],
    matrix: [
        [6, 6],
        [6, 6],
    ],
};
const t0 = Date.parse('2026-03-20T10:00:00Z');
const sample = (over: Partial<PolarObservation> = {}): PolarObservation => ({
    at: t0,
    lat: 0,
    lon: 1,
    tws: 12,
    twa: 90,
    stw: 5,
    sog: 5.2,
    heading: 90,
    rpm: null,
    ...over,
});
function harness() {
    let saved: string | null = null;
    let fail = false;
    const rows: Record<string, number | null>[] = [];
    const store = {
        readPolarState: () => saved,
        writePolarState: (value: string) => {
            if (fail) throw new Error('disk unavailable');
            saved = value;
        },
        isEnabled: () => true,
        polarLastRowId: () => rows.length,
        polarPointsAfter: (id: number, limit: number) => rows.filter((row) => row.sample_id! > id).slice(0, limit),
    };
    const add = (count: number, over: Partial<PolarObservation> = {}) => {
        const initial = rows.length;
        for (let i = 0; i < count; i++) {
            const s = sample({ at: t0 + (initial + i) * 60000, rpm: 0, ...over });
            rows.push({
                sample_id: rows.length + 1,
                at_ms: s.at,
                lat: s.lat,
                lon: s.lon,
                tws_kts: s.tws,
                twa_deg: s.twa,
                stw_kts: s.stw,
                sog_kts: s.sog,
                hdg_deg: s.heading,
                engine_rpm: s.rpm,
            });
        }
    };
    return {
        store,
        add,
        rows,
        setFailure: (v: boolean) => {
            fail = v;
        },
        reopen: () => new PiPolarLearner(store),
    };
}
test('RPM gates exclude motoring; missing RPM uses a conservative polar and wind/speed step heuristic', () => {
    const previous = sample({ at: t0 - 60000 });
    assert.equal(polarSailingGate(sample({ rpm: 900 }), previous, baseline), false);
    assert.equal(polarSailingGate(sample({ rpm: 0 }), previous, null), true);
    assert.equal(polarSailingGate(sample(), previous, baseline), true);
    assert.equal(polarSailingGate(sample(), previous, null), false);
    assert.equal(polarSailingGate(sample({ stw: 8 }), previous, baseline), false);
    assert.equal(polarSailingGate(sample({ sog: 7 }), previous, baseline), false);
    assert.equal(polarSailingGate(sample({ sog: 0.2 }), previous, baseline), false);
    assert.equal(polarSailingGate(sample({ heading: 120 }), previous, baseline), false);
});
test('civil twilight uses -6 degrees, including polar day and night', () => {
    assert.deepEqual([-6.001, -6, -5.999].map(polarPeriodForAltitude), ['night', 'day', 'day']);
    assert.equal(polarPeriodAt(Date.parse('2026-03-20T12:00Z'), 0, 0), 'day');
    assert.equal(polarPeriodAt(Date.parse('2026-03-20T00:00Z'), 0, 0), 'night');
    assert.equal(polarPeriodAt(Date.parse('2026-06-21T00:00Z'), 89, 0), 'day');
    assert.equal(polarPeriodAt(Date.parse('2026-12-21T12:00Z'), 89, 0), 'night');
});
test('30–45 degree rows learn on the Pi, with 29.9 refused and old history retained', () => {
    const previous = sample({ at: t0 - 60000, twa: 30, rpm: 0 });
    assert.equal(polarSailingGate(sample({ twa: 30, rpm: 0 }), previous, baseline), true);
    assert.equal(polarSailingGate(sample({ twa: 29.9, rpm: 0 }), previous, baseline), false);
    const h = harness();
    const learner = h.reopen();
    learner.configure({ enabled: true, baseline });
    for (const twa of [30, 35, 40, 45]) {
        h.add(20, { twa });
        learner.processBatch();
    }
    const p = learner.snapshot().extendedPolars.all!;
    assert.deepEqual(p.angles, [30, 35, 40, 45, 60, 90, 120, 150, 180]);
    assert.deepEqual(learner.snapshot().polars.all?.angles, [45, 60, 90, 120, 150, 180]);
    for (const twa of [30, 35, 40, 45]) assert.ok(p.matrix[p.angles.indexOf(twa)][3] > 0);
    assert.equal(h.reopen().snapshot().samples.all, learner.snapshot().samples.all);
});
test('an engine known to be running stays excluded when its RPM signal disappears', () => {
    const h = harness();
    const learner = h.reopen();
    learner.configure({ enabled: true, baseline });
    h.add(5, { rpm: 1200 });
    learner.processBatch();
    h.add(20, { rpm: null });
    learner.processBatch();
    assert.equal(learner.snapshot().samples.all, 0);
    h.add(20, { rpm: 0 });
    learner.processBatch();
    assert.ok(learner.snapshot().samples.all > 0);
});
test('a boat without RPM still learns conservative steady sailing from its polar', () => {
    const h = harness();
    const learner = h.reopen();
    learner.configure({ enabled: true, baseline });
    h.add(20, { rpm: null });
    learner.processBatch();
    assert.equal(learner.snapshot().samples.all, 19);
});
test('bounded history batches and reboot keep each row counted once', () => {
    const h = harness();
    h.add(620);
    const learner = h.reopen();
    learner.configure({ enabled: true, baseline });
    assert.equal(learner.processBatch(), 500);
    assert.equal(learner.snapshot().processedRowId, 500);
    const reboot = h.reopen();
    assert.equal(reboot.processBatch(), 120);
    assert.equal(reboot.snapshot().samples.all, 619);
    assert.equal(reboot.processBatch(), 0);
    assert.equal(h.reopen().snapshot().samples.all, 619);
});
test('a failed checkpoint advances neither the aggregate nor cursor; retry counts once', () => {
    const h = harness();
    const learner = h.reopen();
    learner.configure({ enabled: true, baseline });
    h.add(20);
    h.setFailure(true);
    assert.throws(() => learner.processBatch());
    assert.equal(learner.snapshot().processedRowId, 0);
    assert.equal(learner.snapshot().samples.all, 0);
    h.setFailure(false);
    learner.processBatch();
    assert.equal(learner.snapshot().samples.all, 19);
    assert.equal(h.reopen().processBatch(), 0);
});
test('phone asleep does not stop day/night learning, while disabled and motoring history teaches nothing', () => {
    const h = harness();
    const learner = h.reopen();
    learner.configure({ enabled: true, baseline });
    h.add(20, { rpm: 1800 });
    learner.processBatch();
    assert.equal(learner.snapshot().samples.all, 0);
    h.add(20, { rpm: 0 });
    learner.processBatch();
    assert.ok(learner.snapshot().samples.day >= 19);
    learner.configure({ enabled: false });
    h.add(20);
    learner.processBatch();
    const paused = learner.snapshot().samples.all;
    learner.configure({ enabled: true });
    h.add(20, { at: Date.parse('2026-03-21T00:00Z') });
    // Distinct GPS instants are mandatory: repeated or backward time cannot teach the table.
    learner.processBatch();
    assert.equal(learner.snapshot().samples.all, paused);
    h.add(20, { at: Date.parse('2026-03-21T01:00Z') });
    h.rows.slice(-20).forEach((row, i) => {
        row.at_ms = Date.parse('2026-03-21T01:00Z') + i * 60000;
    });
    learner.processBatch();
    const result = learner.snapshot();
    assert.ok(result.samples.night >= 19);
    assert.ok(result.polars.day?.matrix.flat().some((v) => v === 5));
    assert.ok(result.polars.night?.matrix.flat().some((v) => v === 5));
});
