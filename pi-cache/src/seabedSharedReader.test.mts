import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignalkSelfReader, type SeabedDocumentPath } from './seabed/seabedReader.js';
import { SeabedRunner } from './seabed/seabedRunner.js';
import type { SeabedStore } from './seabed/seabedStore.js';
import type { SeabedRow } from './seabed/seabedCore.js';

const at = Date.parse('2026-10-16T00:00:00Z');
const original = {
    uuid: 'urn:mrn:imo:mmsi:000000001',
    environment: {
        depth: { belowKeel: { value: 2.5, timestamp: new Date(at - 4000).toISOString(), $source: 'fixture.depth' } },
    },
};
test('seabed reader uses only the fixed authenticated cache documents and preserves original envelopes', async () => {
    let fetches = 0;
    const paths: SeabedDocumentPath[] = [];
    const reader = new SignalkSelfReader(
        async () => {
            fetches++;
            throw new Error('No source requests');
        },
        'http://127.0.0.1:3000',
        () => at,
        async (path) => {
            paths.push(path);
            return path === 'vessels/self' ? original : null;
        },
    );
    assert.deepEqual(await reader.read(), original);
    assert.equal(await reader.read('sources'), null);
    assert.equal(await reader.read('https://unexpected.example' as SeabedDocumentPath), null);
    assert.deepEqual(paths, ['vessels/self', 'sources']);
    assert.equal(fetches, 0);
});
test('null or failed shared cache never falls back to discovery for either document', async () => {
    let fetches = 0;
    for (const failure of ['null', 'throw']) {
        const reader = new SignalkSelfReader(
            async () => {
                fetches++;
                throw new Error('Unexpected network');
            },
            'http://127.0.0.1:3000',
            () => at,
            async () => {
                if (failure === 'throw') throw new Error('Synthetic retired cache');
                return null;
            },
        );
        assert.equal(await reader.read(), null);
        assert.equal(await reader.read('sources'), null);
    }
    assert.equal(fetches, 0);
});
test('unchanged two/three-argument constructors retain legacy fixed-document discovery behavior', async () => {
    for (const clock of [undefined, () => at]) {
        const paths: string[] = [];
        const reader = new SignalkSelfReader(
            async (url) => {
                paths.push(url);
                return {
                    ok: true,
                    json: async () =>
                        url.endsWith('/signalk')
                            ? { endpoints: { v1: { 'signalk-http': 'http://127.0.0.1:3000/signalk/v1/api/' } } }
                            : original,
                };
            },
            'http://127.0.0.1:3000',
            clock,
        );
        assert.deepEqual(await reader.read(), original);
        assert.deepEqual(await reader.read('sources'), original);
        assert.deepEqual(paths, [
            'http://127.0.0.1:3000/signalk',
            'http://127.0.0.1:3000/signalk/v1/api/vessels/self',
            'http://127.0.0.1:3000/signalk/v1/api/sources',
        ]);
    }
});

test('missing cached product metadata does not disable an existing opted-in sounding capture', async () => {
    let now = at,
        tick = 0,
        fetches = 0,
        metadataReads = 0;
    const rows: SeabedRow[] = [];
    const store = {
        getConfig: () => ({ enabled: true, zones: [], ownerId: 'fictional-owner' }),
        isFull: () => false,
        appendOpenRows: (next: SeabedRow[]) => rows.push(...next),
        checkpoint: () => undefined,
    } as unknown as SeabedStore;
    const reader = new SignalkSelfReader(
        async () => {
            fetches++;
            throw new Error('No source HTTP');
        },
        'http://127.0.0.1:3000',
        () => now,
        async (path) => {
            if (path === 'sources') {
                metadataReads++;
                return null;
            }
            const leaf = (value: unknown, source: string) => ({
                value,
                timestamp: new Date(now).toISOString(),
                $source: source,
            });
            return {
                navigation: {
                    position: leaf({ latitude: -30, longitude: 160 + tick * 0.00031 }, 'fictional-gps'),
                    datetime: leaf(new Date(now).toISOString(), 'fictional-gps'),
                    speedOverGround: leaf(3, 'fictional-gps'),
                },
                environment: { depth: { belowTransducer: leaf(20, 'fictional-depth') } },
            };
        },
    );
    const runner = new SeabedRunner({
        read: () => reader.read(),
        readSources: () => reader.read('sources'),
        store,
        gzip: async () => Buffer.alloc(0),
        now: () => now,
        log: () => undefined,
    });
    try {
        for (tick = 0; tick < 50; tick++) {
            now = at + tick * 10_000;
            await runner.tick();
        }
        assert.equal(runner.describe().lastOutcome, 'logging');
        assert.ok(rows.length > 0, 'soundings past the existing start/end privacy trim are captured');
        assert.equal(metadataReads, 1);
        assert.equal(fetches, 0);
    } finally {
        runner.halt();
    }
});
