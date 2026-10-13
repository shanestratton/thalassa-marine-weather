/**
 * The ~/Charts watcher after Pi update 3 (127-C-d decision 11): o-charts sets
 * open in the chart vault's memory, so the watcher decrypts nothing and spawns
 * nothing, even switched on (calypso has ENC_WATCHER_ENABLED=false; nothing in
 * this update reads it to start anything new). It still recognises o-charts
 * inputs, and still settles its startup reconcile at once.
 */
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { test, mock } from 'node:test';
import chokidar from 'chokidar';

test('switched on, the watcher watches nothing and spawns nothing: the vault opens o-charts sets', async (t) => {
    process.env.ENC_WATCHER_ENABLED = 'true';
    const watched: unknown[] = [];
    mock.method(chokidar, 'watch', (p: unknown) => {
        watched.push(p);
        throw new Error('the watcher must not start chokidar');
    });
    const spawned: unknown[] = [];
    mock.method(childProcess, 'spawn', (command: unknown) => {
        spawned.push(command);
        throw new Error('the watcher must not spawn');
    });
    syncBuiltinESMExports();
    t.after(() => {
        mock.restoreAll();
        syncBuiltinESMExports();
    });
    const watcher = await import('./encWatcher.js');
    watcher.startEncWatcher();
    await watcher.whenInitialReconcileSettled();
    assert.deepEqual(watched, []);
    assert.deepEqual(spawned, []);
    const status = watcher.getWatcherStatus();
    assert.equal(status.watching, false);
    assert.equal(status.currentDecrypt, null);
    assert.equal(status.mode, 'vault');
    await watcher.stopEncWatcher();
});

test('o-charts inputs are still recognised (cells, key XML, provenance), nothing else', async () => {
    const { isOChartsInput } = await import('./encWatcher.js');
    for (const yes of [
        'set/OC-99-ZZ0001.oesu',
        'set/oeuSENC-ZZ-2026-1-0-sgl00ABCD.XML',
        'set/thalassa-chart-source.json',
    ])
        assert.equal(isOChartsInput(yes), true, yes);
    for (const no of ['set/ZZ5KESTR.000', 'set/readme.txt', 'set/oeuSENC-ZZ.XML.bak'])
        assert.equal(isOChartsInput(no), false, no);
});
