import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// DOWNLOAD_DIR is resolved from the environment at module load, so this has to
// be set before the import below.
const dir = mkdtempSync(join(tmpdir(), 'chartworld-drop-'));
process.env.ENC_CHARTWORLD_DIR = dir;
const { listLocal } = await import('./chartworldSync.js');

test('files dropped in by hand are installable, exactly like FTP-fetched ones', async () => {
    // ChartWorld's licence FTP went with the Teledyne migration, so the ePORTAL
    // download is now the arrival route. Anything dropped here must be picked up
    // with no host, no credentials and no network.
    writeFileSync(join(dir, 'DC40966ACES_ORDER_26_31_00.S63.ZIP'), 'x'.repeat(1451344));
    writeFileSync(join(dir, 'Serene_Summer_DC40966_20260807.prm.zip'), 'y'.repeat(935));

    const found = await listLocal();
    const byName = new Map(found.map((f) => [f.name, f.sizeBytes]));

    assert.equal(byName.get('DC40966ACES_ORDER_26_31_00.S63.ZIP'), 1451344);
    assert.equal(byName.get('Serene_Summer_DC40966_20260807.prm.zip'), 935);
    assert.equal(found.length, 2);
});

test('only exchange sets and permit bundles are picked up', async () => {
    // The directory is a human drop point now, so it will collect stray things:
    // a browser's part-file, a note, an unpacked directory from a previous run.
    // Handing any of those to the S-63 installer is a failure, not a chart.
    writeFileSync(join(dir, 'notes.txt'), 'not a chart');
    writeFileSync(join(dir, 'DC40966ACES_ORDER_26_31_01.S63.ZIP.crdownload'), 'partial');
    writeFileSync(join(dir, '.sync-state.json'), '{}');
    mkdirSync(join(dir, 'DC40966ACES_ORDER_26_31_00.S63.unpacked'), { recursive: true });

    const names = (await listLocal()).map((f) => f.name).sort();
    assert.deepEqual(names, ['DC40966ACES_ORDER_26_31_00.S63.ZIP', 'Serene_Summer_DC40966_20260807.prm.zip']);
});

test('a directory named like an archive is not mistaken for one', async () => {
    // .unpacked directories sit right next to the zips; stat() must gate on
    // isFile() or an install would be handed a directory.
    mkdirSync(join(dir, 'BOGUS_ORDER.S63.ZIP'), { recursive: true });
    const names = (await listLocal()).map((f) => f.name);
    assert.ok(!names.includes('BOGUS_ORDER.S63.ZIP'));
});
