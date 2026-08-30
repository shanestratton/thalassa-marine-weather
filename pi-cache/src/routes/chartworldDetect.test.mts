import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { detectChartworldArchive } from './enc.js';

function tree(files: string[]): string {
    const root = mkdtempSync(join(tmpdir(), 'cw-detect-'));
    for (const f of files) {
        const full = join(root, f);
        mkdirSync(join(full, '..'), { recursive: true });
        writeFileSync(full, 'x');
    }
    return root;
}

test('an S-63 exchange set is recognised by SERIAL.ENC', async () => {
    const root = tree(['SERIAL.ENC', 'IHO.CRT', 'IHO.PUB', 'ENC_ROOT/CATALOG.031', 'ENC_ROOT/README.TXT']);
    assert.equal(await detectChartworldArchive(root), 'exchange');
});

test('a permit bundle is recognised by PERMIT.TXT', async () => {
    const root = tree(['PERMIT.TXT', 'licence.dat', '49.LIC', 'UP_A4ED9E615188420F427E1CDD3147']);
    assert.equal(await detectChartworldArchive(root), 'permit');
});

test('a plain S-57 exchange set is NOT mistaken for S-63', async () => {
    // This is the case that matters. An unencrypted S-57 set carries ENC_ROOT
    // and CATALOG.031 exactly like the S-63 one does, so neither can be used to
    // tell them apart. Only SERIAL.ENC separates them. Getting this wrong sends
    // readable cells to the permit installer, or encrypted ones to ogr2ogr,
    // which fails with a parser error that never mentions permits.
    const root = tree(['ENC_ROOT/CATALOG.031', 'ENC_ROOT/AU/AU5PTL01.000', 'README.TXT']);
    assert.equal(await detectChartworldArchive(root), null);
});

test('an o-charts set is left to the .oesu path', async () => {
    const root = tree(['OC-61-001012.oesu', 'OC-61-001022.oesu', 'oeuSENC-AU.XML']);
    assert.equal(await detectChartworldArchive(root), null);
});

test('the markers are found even when the zip has a wrapper directory', async () => {
    // Downloads routinely unpack into a single top-level folder.
    const root = tree(['DC40966ACES_ORDER_26_31_00/SERIAL.ENC', 'DC40966ACES_ORDER_26_31_00/ENC_ROOT/CATALOG.031']);
    assert.equal(await detectChartworldArchive(root), 'exchange');
});

test('a permit bundle wins over an exchange set if somehow both appear', async () => {
    // Order matters only for a malformed archive, but it should be deterministic
    // rather than depending on readdir order.
    const root = tree(['PERMIT.TXT', 'SERIAL.ENC']);
    assert.equal(await detectChartworldArchive(root), 'permit');
});

test('an empty or missing directory is not a ChartWorld archive', async () => {
    assert.equal(await detectChartworldArchive(tree([])), null);
    assert.equal(await detectChartworldArchive('/nonexistent-path-for-test'), null);
});
