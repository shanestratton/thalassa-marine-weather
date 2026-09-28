import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSenc } from './featureParser.js';

function record(type: number, payload: Buffer): Buffer {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(type, 0);
    header.writeUInt32LE(payload.length + 6, 2);
    return Buffer.concat([header, payload]);
}

function chartPrefix(): Buffer {
    const version = Buffer.alloc(2);
    version.writeUInt16LE(201);
    const extent = Buffer.alloc(64);
    [-28, 153, -27, 153, -27, 154, -28, 154].forEach((value, i) => extent.writeDoubleLE(value, i * 8));
    const feature = Buffer.alloc(5);
    feature.writeUInt16LE(74, 0);
    feature.writeUInt16LE(1, 2);
    feature.writeUInt8(1, 4);
    const point = Buffer.alloc(16);
    point.writeDoubleLE(-27.5, 0);
    point.writeDoubleLE(153.5, 8);
    return Buffer.concat([record(1, version), record(100, extent), record(64, feature), record(80, point)]);
}

const edgeTable = () => record(96, Buffer.alloc(4));
const nodeTable = () => record(97, Buffer.alloc(4));
const completeChart = () => Buffer.concat([chartPrefix(), edgeTable(), nodeTable()]);

test('complete SENC records preserve identical features with zero, six or seven terminal zero bytes', () => {
    const baseline = parseSenc(completeChart());
    assert.equal(baseline.features.length, 1);
    for (const padding of [0, 1, 2, 3, 4, 5, 6, 7]) {
        const parsed = parseSenc(Buffer.concat([completeChart(), Buffer.alloc(padding)]));
        assert.deepEqual(parsed.features, baseline.features);
        assert.deepEqual(parsed.header, baseline.header);
        assert.equal(parsed.stats.totalRecords, baseline.stats.totalRecords);
        assert.equal(parsed.stats.trailingPaddingBytes ?? 0, padding);
    }
});

test('terminal padding is permitted after complete extended vector tables too', () => {
    const payload = Buffer.alloc(12);
    payload.writeDoubleLE(1, 0);
    const parsed = parseSenc(Buffer.concat([chartPrefix(), record(85, payload), record(86, payload), Buffer.alloc(7)]));
    assert.equal(parsed.features.length, 1);
    assert.equal(parsed.stats.trailingPaddingBytes, 7);
});

test('nonzero, oversized and midstream tails remain errors', () => {
    assert.throws(() => parseSenc(Buffer.concat([completeChart(), Buffer.alloc(8)])), /Invalid SENC record length/);
    assert.throws(() => parseSenc(Buffer.concat([completeChart(), Buffer.from([1])])), /Truncated SENC record header/);
    assert.throws(
        () => parseSenc(Buffer.concat([completeChart(), Buffer.from([0, 0, 0, 0, 0, 0, 1])])),
        /Invalid SENC record length/,
    );
    assert.throws(
        () => parseSenc(Buffer.concat([completeChart(), Buffer.alloc(6), record(2, Buffer.from('later'))])),
        /Invalid SENC record length/,
    );
    assert.throws(
        () => parseSenc(Buffer.concat([chartPrefix(), edgeTable(), Buffer.alloc(6), nodeTable()])),
        /Invalid SENC record length/,
    );
    assert.throws(() => parseSenc(Buffer.concat([chartPrefix(), Buffer.alloc(6)])), /Invalid SENC record length/);
});

test('padding cannot disguise incomplete vector tables or truncated records', () => {
    const missingEntries = Buffer.alloc(4);
    missingEntries.writeUInt32LE(1);
    assert.throws(
        () => parseSenc(Buffer.concat([chartPrefix(), edgeTable(), record(97, missingEntries), Buffer.alloc(6)])),
        /Invalid SENC record length/,
    );
    assert.throws(
        () => parseSenc(Buffer.concat([chartPrefix(), record(96, missingEntries), nodeTable(), Buffer.alloc(6)])),
        /Invalid SENC record length/,
    );
    const truncated = record(97, Buffer.alloc(16)).subarray(0, 12);
    assert.throws(() => parseSenc(Buffer.concat([chartPrefix(), edgeTable(), truncated])), /Truncated SENC record/);
});
