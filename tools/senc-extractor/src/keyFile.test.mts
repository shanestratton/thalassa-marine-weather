import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseKeyFile } from './keyFile.js';
import { resolveChartProducer } from './chartProvenance.js';

// Mirrors licensed package structure; AABB is a dummy key, never a licence secret.
const chart = (fileName: string, id?: string) => `<Chart><FileName>${fileName}</FileName>${id ? `<ID>${id}</ID>` : ''}<RInstallKey>AABB</RInstallKey></Chart>`;

test('licensed key XML native IDs identify synthetic charts from different offices', () => {
    const xml = `<keyList>${chart('OC-33-086174', 'FR471680')}${chart('OC-33-A58965', 'FR56985A')}${chart('OC-61-041834', 'AU438140')}${chart('OC-61-000001', 'PG500001')}${chart('OC-61-000002', 'SB400002')}</keyList>`;
    const entries = parseKeyFile(xml);
    assert.equal(entries.size, 5);
    assert.equal(entries.get('OC-33-086174')?.sourceCellId, 'FR471680');
    assert.equal(entries.get('OC-33-A58965')?.sourceCellId, 'FR56985A');
    assert.deepEqual([...entries].map(([file, entry]) => resolveChartProducer(file, undefined, undefined, entry.sourceCellId)), ['FR', 'FR', 'AU', 'PG', 'SB']);
    assert.throws(() => resolveChartProducer('OC-61-000001', 'AU', undefined, 'PG500001'), /Conflicting producer/);
});

test('key XML rejects collisions, ambiguous IDs and malformed identity metadata', () => {
    assert.throws(() => parseKeyFile(`<keyList>${chart('OC-1', 'FR471680')}${chart('oc-1', 'FR56985A')}</keyList>`), /Duplicate chart key mapping/);
    assert.throws(() => parseKeyFile(`<keyList>${chart('OC-1', 'FR471680')}${chart('OC-2', 'FR471680')}</keyList>`), /maps to multiple/);
    assert.throws(() => parseKeyFile(chart('OC-1', 'not-an-ENC')), /Invalid native ENC ID/);
    assert.throws(() => parseKeyFile(chart('AU530150', 'NZ505321')), /conflicts with chart filename/);
    assert.throws(() => parseKeyFile(chart('OC-1', 'FR471680').replace('</ID>', '</ID><ID>FR56985A</ID>')), /Ambiguous or missing ID/);
    assert.throws(() => parseKeyFile('<keyList><Chart><FileName>OC-1</FileName></keyList>'), /Malformed/);
});

test('a legacy key file without native ID retains its keys without inventing provenance', () => {
    const entries = parseKeyFile(chart('AU530150'));
    assert.equal(entries.get('AU530150')?.installKey, 'AABB');
    assert.equal(entries.get('AU530150')?.sourceCellId, undefined);
    assert.equal(resolveChartProducer('AU530150', undefined, undefined, entries.get('AU530150')?.sourceCellId), 'AU');
    assert.throws(() => resolveChartProducer('OC-1', undefined, undefined, parseKeyFile(chart('OC-1')).get('OC-1')?.sourceCellId), /Unknown producer/);
});
