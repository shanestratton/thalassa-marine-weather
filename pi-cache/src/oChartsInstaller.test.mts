/**
 * o-charts installs keep the set encrypted (127-C-d decision 11). The installer
 * checks the delivery's shape, keeps the encrypted set in enc-charts/sources/,
 * and asks the chart vault to rescan; the vault opens the cells in memory.
 * Nothing spawns decryptBatch and nothing is converted to disk, whatever the
 * ENC switches say. Fictional sets only.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { inspectOChartsSets, installOChartsDelivery, verifyArchiveSha256 } from './oChartsInstaller.js';
import type { VaultRescanWire } from './vault/protocol.js';

const require = createRequire(import.meta.url);

/** Count every child process this process starts. */
function spySpawns(t: TestContext): string[] {
    const cp = require('node:child_process') as Record<string, unknown>;
    const started: string[] = [];
    for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
        const original = cp[name] as (...args: unknown[]) => unknown;
        cp[name] = (...args: unknown[]) => {
            started.push(`${name} ${String(args[0])}`);
            return original(...args);
        };
        t.after(() => {
            cp[name] = original;
            syncBuiltinESMExports();
        });
    }
    syncBuiltinESMExports();
    return started;
}

async function fixture(t: TestContext) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ocharts-install-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const extractedDir = path.join(root, 'work', 'unzipped');
    const chartStoreDir = path.join(root, 'store');
    await fs.mkdir(extractedDir, { recursive: true });
    const source = async (name: string, ids: string[], missingKey = false) => {
        const directory = path.join(extractedDir, name);
        await fs.mkdir(directory, { recursive: true });
        for (const id of ids) await fs.writeFile(path.join(directory, `${id}.oesu`), `encrypted fixture ${id}`);
        const keyed = missingKey ? ids.slice(1) : ids;
        await fs.writeFile(
            path.join(directory, 'oeuSENC-ZZ-2026-1-0-sgl00ABCD.XML'),
            `<keyList>${keyed.map((id) => `<Chart><FileName>${id}</FileName><RInstallKey>AABB</RInstallKey></Chart>`).join('')}</keyList>`,
        );
        return directory;
    };
    const rescans: (string[] | undefined)[] = [];
    let answer: VaultRescanWire = { queued: false, summary: { new: 2, updated: 0, unchanged: 0, total: 2 } };
    const rescan = async (cellIds?: string[]) => {
        rescans.push(cellIds);
        return answer;
    };
    const options = { extractedDir, chartStoreDir, archiveHash: 'a'.repeat(64), rescan };
    return {
        root,
        extractedDir,
        chartStoreDir,
        options,
        source,
        rescans,
        answer: (next: VaultRescanWire) => {
            answer = next;
        },
    };
}

async function allPaths(dir: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
    return entries.map((e) => path.join(e.parentPath ?? (e as unknown as { path: string }).path, e.name));
}

test('an .oesu delivery is kept encrypted: no decryptBatch, nothing converted, the set retained and rescanned', async (t) => {
    const f = await fixture(t);
    await f.source('one', ['OC-99-ZZ0001']);
    await f.source('two', ['OC-99-ZZ0002']);
    const spawned = spySpawns(t);
    const result = await installOChartsDelivery(f.options);
    assert.deepEqual(spawned, [], 'pi-cache never spawns decryptBatch (or anything) for o-charts');
    assert.deepEqual(result.persistedCellIds, ['OC-99-ZZ0001', 'OC-99-ZZ0002']);
    assert.deepEqual(result.packageSummary, { new: 2, updated: 0, unchanged: 0, total: 2 });
    assert.equal(result.queued, undefined);
    assert.deepEqual(f.rescans, [['OC-99-ZZ0001', 'OC-99-ZZ0002']]);
    const everything = await allPaths(f.root);
    assert.deepEqual(
        everything.filter((p) => /converted-ocharts|ocharts-report/.test(p)),
        [],
        'nothing is ever converted under the work dir',
    );
    // The store holds the encrypted delivery and nothing else.
    assert.deepEqual(await fs.readdir(f.chartStoreDir), ['sources']);
    const [retained] = await fs.readdir(path.join(f.chartStoreDir, 'sources'));
    assert.match(retained, /^a{64}-[0-9a-f-]{36}$/);
    const kept = path.join(f.chartStoreDir, 'sources', retained);
    assert.equal((await fs.stat(kept)).mode & 0o777, 0o700);
    for (const [set, id] of [
        ['one', 'OC-99-ZZ0001'],
        ['two', 'OC-99-ZZ0002'],
    ]) {
        const original = await fs.readFile(path.join(f.extractedDir, set, `${id}.oesu`));
        assert.deepEqual(await fs.readFile(path.join(kept, set, `${id}.oesu`)), original, 'byte-identical, encrypted');
    }
});

test('during a watch the set is kept and its charts open in memory after the watch', async (t) => {
    const f = await fixture(t);
    await f.source('one', ['OC-99-ZZ0001']);
    f.answer({ queued: true, reason: 'watch' });
    const result = await installOChartsDelivery(f.options);
    assert.equal(result.queued, 'watch');
    assert.deepEqual(result.packageSummary, { new: 0, updated: 0, unchanged: 0, total: 1 });
    assert.equal((await fs.readdir(path.join(f.chartStoreDir, 'sources'))).length, 1);
});

test('the same archive twice is kept once, and rescanned each time', async (t) => {
    const f = await fixture(t);
    await f.source('one', ['OC-99-ZZ0001']);
    await installOChartsDelivery(f.options);
    await installOChartsDelivery(f.options);
    assert.equal((await fs.readdir(path.join(f.chartStoreDir, 'sources'))).length, 1);
    assert.equal(f.rescans.length, 2);
});

test('duplicate cells, missing keys and ambiguous key files fail before anything is kept', async (t) => {
    const f = await fixture(t);
    await f.source('one', ['OC-99-ZZ0001']);
    const two = await f.source('two', ['OC-99-ZZ0001']);
    await assert.rejects(inspectOChartsSets(f.extractedDir), { code: 'duplicate-chart-cell' });
    await assert.rejects(installOChartsDelivery(f.options), { code: 'duplicate-chart-cell' });
    await fs.rm(two, { recursive: true });
    const three = await f.source('three', ['OC-99-ZZ0003'], true);
    await assert.rejects(inspectOChartsSets(f.extractedDir), { code: 'ocharts-missing-key' });
    await fs.writeFile(path.join(three, 'oeuSENC-ZZ-other-sglFFFF.XML'), '<keyList/>');
    await assert.rejects(installOChartsDelivery(f.options), { code: 'ocharts-key-file' });
    assert.deepEqual(f.rescans, []);
    await assert.rejects(fs.readdir(f.chartStoreDir), { code: 'ENOENT' });
});

test('archive SHA-256 is checked without exposing the filename or source URL', async (t) => {
    const f = await fixture(t);
    const filename = path.join(f.root, 'private-token.zip');
    await fs.writeFile(filename, 'actual archive');
    const expected = createHash('sha256').update('actual archive').digest('hex');
    assert.equal(await verifyArchiveSha256(filename, expected.toUpperCase()), expected);
    await assert.rejects(verifyArchiveSha256(filename, '0'.repeat(64)), (error: unknown) => {
        assert.equal((error as { code: string }).code, 'archive-checksum-mismatch');
        assert.doesNotMatch((error as Error).message, /private-token/);
        return true;
    });
});

test('encWatcher and startSourceReconvert spawn nothing for o-charts sets, with the switches false or true', async (t) => {
    const f = await fixture(t);
    const charts = path.join(f.root, 'Charts');
    await fs.mkdir(path.join(charts, 'oeuSENC-ZZ-base'), { recursive: true });
    await fs.writeFile(path.join(charts, 'oeuSENC-ZZ-base', 'OC-99-ZZ0001.oesu'), 'encrypted fixture');
    await fs.writeFile(path.join(charts, 'oeuSENC-ZZ-base', 'oeuSENC-ZZ-sgl00ABCD.XML'), '<keyList/>');
    process.env.ENC_WATCH_DIR = charts;
    process.env.ENC_CHART_DIR = f.chartStoreDir;
    process.env.ENC_WATCHER_DEBOUNCE_MS = '1';
    const spawned = spySpawns(t);
    const watcher = await import('./encWatcher.js');
    const reconvert = await import('./encSourceReconvert.js');
    for (const value of ['false', 'true']) {
        process.env.ENC_WATCHER_ENABLED = value;
        process.env.ENC_SOURCE_RECONVERT_ENABLED = value;
        watcher.startEncWatcher();
        await watcher.whenInitialReconcileSettled();
        await reconvert.startSourceReconvert();
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(watcher.getWatcherStatus().watching, false, `watcher ${value}`);
        assert.equal(reconvert.getSourceReconvertStatus().state, 'disabled', `reconvert ${value}`);
        await watcher.stopEncWatcher();
    }
    assert.deepEqual(spawned, []);
    await assert.rejects(fs.readdir(f.chartStoreDir), { code: 'ENOENT' }, 'nothing written to the store');
});
