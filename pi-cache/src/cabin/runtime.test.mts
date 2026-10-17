import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startCabinRuntime } from './runtime.js';
test('display defaults off and invalid optional ports refuse without interrupting the main watch server', () => {
    let reads = 0;
    const base = {
        host: '127.0.0.1',
        port: 3002,
        mainPort: 3001,
        cacheDirectory: '.',
        assets: '.',
        context: () => null,
        read: async () => {
            reads++;
            throw Error('No source should open');
        },
    };
    assert.equal(startCabinRuntime({ ...base, enabled: false }), null);
    for (const port of [0, NaN, 3001, 65536]) assert.equal(startCabinRuntime({ ...base, enabled: true, port }), null);
    assert.equal(reads, 0);
});
