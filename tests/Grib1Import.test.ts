import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
    decodeGrib1File,
    decodeGrib1Wind,
    gribEdition,
    GribImportError,
    GRIB1_LIMITS,
    type GribImportCode,
} from '../services/weather/decodeGrib1Wind';
import { decodeGribImportRequest, type GribImportReply } from '../services/weather/gribImportProtocol';
import { decodeGribInWorker, type GribDecodeWorker } from '../services/weather/gribImportWorkerHost';
import { concatenate, message, pair, type FixtureOptions } from './fixtures/grib1Fixtures';

function rejects(buffer: ArrayBuffer, code: GribImportCode) {
    assert.throws(
        () => decodeGrib1Wind(buffer),
        (error: unknown) => error instanceof GribImportError && error.code === code,
    );
}
function mutate(at: number, value: number, options: FixtureOptions = {}): ArrayBuffer {
    const m = message(options);
    m[at] = value;
    return concatenate(m, message({ ...options, parameter: 34 }));
}

test('recognises editions by magic and edition byte, without guessing extensions', () => {
    assert.equal(gribEdition(pair()), 1);
    const header = new Uint8Array([71, 82, 73, 66, 0, 0, 0, 2]);
    assert.equal(gribEdition(header.buffer), 2);
    assert.throws(() => gribEdition(new Uint8Array([80, 75, 3, 4, 0, 0, 0, 1]).buffer), { code: 'NOT_GRIB' });
    rejects(mutate(7, 2), 'UNSUPPORTED_EDITION');
    rejects(concatenate(message(), header), 'MALFORMED');
});
test('pairs U/V by real parameter/time, ignores pressure, and sorts nonuniform forecast hours', () => {
    const input = concatenate(
        message({ parameter: 34, p1: 12, values: [4, 4, 4, 4, 4, 4] }),
        message({ parameter: 2, level: 102, height: 0 }),
        message({ parameter: 33, p1: 0 }),
        message({ parameter: 33, p1: 12, values: [3, 3, 3, 3, 3, 3] }),
        message({ parameter: 34, p1: 0 }),
    );
    const wind = decodeGrib1Wind(input);
    assert.deepEqual(wind.stepHours, [0, 12]);
    assert.equal(wind.refTime, '2026-01-01T00:00:00.000Z');
    assert.equal(wind.validUntil, '2026-01-01T12:00:00.000Z');
    assert.equal(wind.totalHours, 2);
    assert.equal(wind.ignoredMessages, 1);
    assert.deepEqual([...wind.speed[1]], [5, 5, 5, 5, 5, 5]);
});
for (const scan of [0, 32, 64, 96, 128, 160, 192, 224])
    test(`normalises scan ${scan} to east/north increasing rows`, () => {
        const grid = decodeGrib1Wind(pair({ scan }));
        assert.deepEqual([...grid.u[0]], [1, 2, 3, 4, 5, 6]);
        assert.deepEqual(grid.lats, [-2, -1]);
        assert.deepEqual(grid.lons, [-30, -29, -28]);
    });
test('U and V may use different supported scans without reversing their physical signs', () => {
    const g = decodeGrib1Wind(
        concatenate(
            message({ scan: 224, west: -1.111, dx: 0.333 }),
            message({ parameter: 34, scan: 0, west: -1.111, dx: 0.333 }),
        ),
    );
    assert.deepEqual([...g.u[0]], [...g.v[0]]);
    assert.ok(g.u[0][0] > 0);
});
test('preserves a short antimeridian interval as continuous longitudes', () => {
    const g = decodeGrib1Wind(pair({ west: 179 }));
    assert.deepEqual(g.lons, [179, 180, 181]);
    assert.equal(g.east - g.west, 2);
});
test('wraps 0–360 coordinates without inventing a half-world column shift', () => {
    const g = decodeGrib1Wind(pair({ west: 359 }));
    assert.deepEqual(g.lons, [-1, 0, 1]);
    assert.deepEqual([...g.u[0]], [1, 2, 3, 4, 5, 6]);
});
test('decodes known IBM hexadecimal reference bytes, constant fields, and signed scales', () => {
    const constant = message({ reference: -10, bits: 0 });
    assert.deepEqual([...constant.slice(74, 78)], [0xc1, 0xa0, 0, 0]);
    const g = decodeGrib1Wind(concatenate(constant, message({ parameter: 34, reference: 16.25, bits: 0 })));
    assert.deepEqual([...g.u[0]], Array(6).fill(-10));
    assert.deepEqual([...g.v[0]], Array(6).fill(16.25));
    const scaled = decodeGrib1Wind(pair({ reference: -10, binaryScale: -1, decimalScale: -1 }));
    assert.deepEqual([...scaled.u[0]], [-95, -90, -85, -80, -75, -70]);
});
test('unpacks cross-byte 17-bit values and full unsigned 32-bit values without sign overflow', () => {
    const wide = decodeGrib1Wind(pair({ values: [0, 1, 65535, 65536, 100000, 131071], bits: 17, binaryScale: -10 }));
    assert.equal(wide.u[0][3], 64);
    assert.equal(wide.u[0][5], 127.9990234375);
    const full = decodeGrib1Wind(
        pair({ values: [0, 1, 2147483648, 4294967295, 100, 200], bits: 32, binaryScale: -26 }),
    );
    assert.equal(full.u[0][2], 32);
    assert.equal(full.u[0][3], 64);
});
test('bitmap holes are NaN and magnitude needs both known components', () => {
    const u = message({ bitmap: [true, false, true, true, true, true] });
    const v = message({ parameter: 34, bitmap: [true, true, false, true, true, true] });
    const g = decodeGrib1Wind(concatenate(u, v));
    assert.ok(Number.isNaN(g.u[0][1]));
    assert.ok(Number.isNaN(g.v[0][2]));
    assert.ok(Number.isNaN(g.speed[0][1]));
    assert.ok(Number.isNaN(g.speed[0][2]));
    assert.equal(g.u[0][0], 1);
    assert.equal(g.v[0][0], 1);
    rejects(pair({ bitmap: Array(6).fill(false) }), 'INCOMPLETE_WIND');
});
for (const options of [
    { unit: 0, p1: 30, expected: 0.5 },
    { unit: 2, p1: 1, expected: 24 },
    { unit: 10, p1: 2, expected: 6 },
    { unit: 11, p1: 2, expected: 12 },
    { unit: 12, p1: 2, expected: 24 },
    { timeRange: 10, p1: 1, p2: 2, expected: 258 },
    { timeRange: 1, expected: 0 },
])
    test(`decodes forecast clock ${JSON.stringify(options)}`, () => {
        assert.equal(decodeGrib1Wind(pair(options)).stepHours[0], options.expected);
    });
test('century/year-of-century handles 2000 and 2001 exactly', () => {
    assert.equal(decodeGrib1Wind(pair({ year: 2000 })).refTime, '2000-01-01T00:00:00.000Z');
    assert.equal(decodeGrib1Wind(pair({ year: 2001 })).refTime, '2001-01-01T00:00:00.000Z');
});
test('refuses averaged products, unsupported calendar units, invalid dates and local tables', () => {
    rejects(pair({ timeRange: 3 }), 'UNSUPPORTED_PRODUCT');
    rejects(pair({ unit: 3 }), 'UNSUPPORTED_PRODUCT');
    rejects(pair({ month: 2, day: 30 }), 'MALFORMED');
    rejects(pair({ table: 128 }), 'UNSUPPORTED_PRODUCT');
    rejects(pair({ timeRange: 1, p1: 1 }), 'UNSUPPORTED_PRODUCT');
    rejects(pair({ p1: 32, unit: 2 }), 'LIMIT');
});
test('never labels upper-air or another parameter as 10m wind', () => {
    rejects(pair({ height: 20 }), 'INCOMPLETE_WIND');
    rejects(pair({ level: 100 }), 'INCOMPLETE_WIND');
    rejects(concatenate(message({ parameter: 2 })), 'INCOMPLETE_WIND');
});
test('rejects missing, duplicate, mismatched source and mismatched forecast pairs', () => {
    rejects(concatenate(message()), 'INCOMPLETE_WIND');
    rejects(concatenate(message(), message(), message({ parameter: 34 })), 'DUPLICATE_WIND');
    rejects(concatenate(message(), message({ parameter: 34, centre: 98 })), 'MIXED_SOURCE');
    rejects(concatenate(message(), message({ parameter: 34, process: 9 })), 'MIXED_SOURCE');
    rejects(concatenate(message(), message({ parameter: 34, hour: 6 })), 'MIXED_SOURCE');
    rejects(concatenate(message(), message({ parameter: 34, west: 10 })), 'MIXED_SOURCE');
    rejects(concatenate(message(), message({ parameter: 34, p1: 3 })), 'INCOMPLETE_WIND');
});
test('rejects projection, reduced/predefined grid, grid-relative winds, scan extensions and inconsistent bounds', () => {
    rejects(mutate(41, 3), 'UNSUPPORTED_GRID');
    rejects(mutate(40, 1), 'UNSUPPORTED_GRID');
    rejects(mutate(52, 0x88), 'UNSUPPORTED_GRID');
    rejects(mutate(63, 0x10), 'UNSUPPORTED_GRID');
    rejects(mutate(61, 0), 'UNSUPPORTED_GRID');
    rejects(mutate(56, 15), 'UNSUPPORTED_GRID');
});
test('rejects complex/spectral packing, predefined bitmap, unknown widths and corrupt padding', () => {
    rejects(mutate(71, 0x40), 'UNSUPPORTED_PACKING');
    rejects(mutate(71, 0x80), 'UNSUPPORTED_PACKING');
    rejects(mutate(71, 0x10), 'UNSUPPORTED_PACKING');
    rejects(mutate(78, 33), 'UNSUPPORTED_PACKING');
    rejects(mutate(73, 1, { bitmap: Array(6).fill(true) }), 'UNSUPPORTED_BITMAP');
    const m = message();
    m[m.length - 5] = 1;
    rejects(concatenate(m, message({ parameter: 34 })), 'MALFORMED');
});
test('bounded checks reject malicious dimensions, oversized outputs/messages, and stopped decoding', () => {
    const m = message();
    new DataView(m.buffer).setUint16(42, 65000);
    new DataView(m.buffer).setUint16(44, 65000);
    rejects(concatenate(m), 'LIMIT');
    rejects(
        concatenate(...Array.from({ length: GRIB1_LIMITS.messages + 1 }, () => message({ parameter: 2 }))),
        'LIMIT',
    );
    rejects(concatenate(...Array.from({ length: GRIB1_LIMITS.frames + 1 }, (_, p1) => message({ p1 }))), 'LIMIT');
    rejects(
        concatenate(
            ...Array.from({ length: 6 }, (_, p1) =>
                message({ width: 1000, rows: 1000, dx: 0.001, dy: 0.001, values: [], reference: 1, bits: 0, p1 }),
            ),
        ),
        'LIMIT',
    );
    assert.throws(() => decodeGrib1Wind(pair(), () => false), { code: 'CANCELLED' });
    const oversized = new ArrayBuffer(GRIB1_LIMITS.fileBytes + 1);
    rejects(oversized, 'LIMIT');
});
test('every truncated prefix fails explicitly without partial output or an unbounded resync', () => {
    const input = new Uint8Array(pair());
    for (let length = 0; length < input.length; length++)
        assert.throws(() => decodeGrib1Wind(input.slice(0, length).buffer), GribImportError);
    rejects(concatenate(message(), new Uint8Array([0, 1, 2]), message({ parameter: 34 })), 'MALFORMED');
    const m = message();
    m[m.length - 1] = 0;
    rejects(concatenate(m), 'MALFORMED');
});
test('protocol errors return bounded generic messages and never a partial field', () => {
    const answer = decodeGribImportRequest({ id: 7, buffer: pair({ timeRange: 4 }) }, () => true);
    assert.equal(answer.type, 'error');
    assert.equal('grid' in answer, false);
    assert.equal(decodeGribImportRequest({ id: NaN, buffer: pair() }, () => true).type, 'error');
});

test('rejects nonfinite scale factors, implausible values and wrong packed lengths', () => {
    rejects(pair({ binaryScale: 32767 }), 'MALFORMED');
    rejects(pair({ decimalScale: -32767 }), 'MALFORMED');
    rejects(pair({ reference: 251, bits: 0 }), 'MALFORMED');
    rejects(mutate(71, 0), 'MALFORMED');
});

test('predefined grid omission fails explicitly and cancellation interrupts a large constant field', () => {
    const m = message();
    const noGrid = new Uint8Array(m.length - 32);
    noGrid.set(m.subarray(0, 36));
    noGrid.set(m.subarray(68), 36);
    noGrid[15] = 0;
    noGrid[4] = noGrid.length >>> 16;
    noGrid[5] = noGrid.length >>> 8;
    noGrid[6] = noGrid.length;
    rejects(concatenate(noGrid), 'UNSUPPORTED_GRID');
    let checks = 0;
    assert.throws(
        () =>
            decodeGrib1Wind(
                pair({ width: 1000, rows: 1000, dx: 0.001, dy: 0.001, values: [], reference: 1, bits: 0 }),
                () => ++checks < 10,
            ),
        { code: 'CANCELLED' },
    );
    assert.equal(checks, 10);
});

class FakeWorker implements GribDecodeWorker {
    onmessage: GribDecodeWorker['onmessage'] = null;
    onerror: GribDecodeWorker['onerror'] = null;
    terminated = 0;
    requests: Array<{ id: number; buffer: ArrayBuffer }> = [];
    terminate() {
        this.terminated++;
    }
    postMessage(value: unknown) {
        this.requests.push(value as { id: number; buffer: ArrayBuffer });
    }
    emit(data: GribImportReply) {
        this.onmessage?.({ data } as MessageEvent<GribImportReply>);
    }
}
test('host waits for ready, ignores unmatched replies and terminates once after success', async () => {
    const worker = new FakeWorker(),
        pending = decodeGribInWorker(pair(), { workerFactory: () => worker });
    assert.equal(worker.requests.length, 0);
    worker.emit({ type: 'ready' });
    assert.equal(worker.requests.length, 1);
    const { id, buffer } = worker.requests[0],
        grid = decodeGrib1File(buffer);
    worker.emit({ type: 'decoded', id: id + 1, grid });
    assert.equal(worker.terminated, 0);
    worker.emit({ type: 'decoded', id, grid });
    assert.equal((await pending).wind!.totalHours, 1);
    assert.equal(worker.terminated, 1);
});
test('host cancellation, stale owner and timeout terminate without any synchronous decode fallback', async () => {
    const controller = new AbortController(),
        first = new FakeWorker();
    const stopped = decodeGribInWorker(pair(), { signal: controller.signal, workerFactory: () => first });
    const rejected = assert.rejects(stopped, { code: 'CANCELLED' });
    controller.abort();
    await rejected;
    assert.equal(first.terminated, 1);
    const second = new FakeWorker();
    let current = true;
    const stale = decodeGribInWorker(pair(), { isCurrent: () => current, workerFactory: () => second });
    const staleRejected = assert.rejects(stale, { code: 'CANCELLED' });
    current = false;
    await staleRejected;
    assert.equal(second.terminated, 1);
    const third = new FakeWorker();
    await assert.rejects(decodeGribInWorker(pair(), { timeoutMs: 5, workerFactory: () => third }), {
        code: 'CANCELLED',
    });
    assert.equal(third.requests.length, 0);
    assert.equal(third.terminated, 1);
});
