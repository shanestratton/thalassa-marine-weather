/**
 * The vault's index comes from the delivered, still-encrypted sets (127-C-d
 * decision 6): the newest edition wins, a malformed set is skipped with its
 * reason, removals hold across restarts until a new delivery brings the cell
 * back, a restart re-opens only what changed, and a new parser schema
 * re-opens everything once. No index work runs during a watch (decision 11).
 *
 * Synthetic sets only (fakeOexserverd.mjs): a fictional "ZZ" producer,
 * fictional OC-99-ZZ files and native ids such as ZZ5KESTR.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { openFixture, buildSenc, writeFixtureCatalogue, writeFixtureSet, type FixtureCell } from './fakeOexserverd.mjs';
import { DecoderDownError } from './decoder.js';
import { VaultService, type VaultServiceOptions } from './vaultService.js';
import { VAULT_INDEX_ENTRY_KEYS } from './vaultIndex.js';
import { EXTRACTOR_SCHEMA } from '../sencEngine/s57Classes.js';

const box = { s: 50.7, w: -1.4, n: 50.8, e: -1.2 };

function cell(file: string, sourceCellId: string, edition = 1, update = 0): FixtureCell {
    return {
        file,
        sourceCellId,
        edition,
        update,
        issued: '20260920',
        extent: box,
        objnam: `Kestrel ${file}`,
        depth: 12.5,
    };
}

async function world(t: TestContext) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-index-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const charts = path.join(root, 'Charts');
    const store = path.join(root, 'enc-charts');
    const sources = path.join(store, 'sources');
    const stateDir = path.join(store, 'vault');
    const reference = writeFixtureCatalogue(path.join(root, 'reference'));
    let decrypts = 0;
    const services: VaultService[] = [];
    const open = (
        options: { schema?: number; watching?: boolean | null; extra?: Partial<VaultServiceOptions> } = {},
    ) => {
        const service = new VaultService({
            stateDir,
            roots: [charts, sources],
            referenceDir: reference,
            lruBytes: 4 * 1024 * 1024,
            initialWatching: options.watching === undefined ? false : options.watching,
            ...(options.schema !== undefined ? { schema: options.schema } : {}),
            decrypt: async (file, key) => {
                decrypts++;
                const spec = openFixture(await fs.readFile(file), key);
                return spec ? buildSenc(spec) : Buffer.alloc(0);
            },
            ...options.extra,
        });
        services.push(service);
        return service;
    };
    t.after(async () => {
        for (const s of services) await s.stop();
    });
    const delivered = (name: string) => path.join(sources, `${'a'.repeat(64)}-${randomUUID()}`, name);
    return { root, charts, sources, stateDir, open, delivered, decrypts: () => decrypts };
}

test('two sets holding one cell: the newer edition wins', async (t) => {
    const w = await world(t);
    writeFixtureSet(path.join(w.charts, 'oeuSENC-ZZ-base'), { cells: [cell('OC-99-ZZ0001', 'ZZ5KESTR', 1)] });
    writeFixtureSet(w.delivered('oeuSENC-ZZ-2026-1-1'), { cells: [cell('OC-99-ZZ0001', 'ZZ5KESTR', 2)] });
    const vault = w.open();
    await vault.start();
    await vault.whenReady();
    const cells = vault.index();
    assert.equal(cells.length, 1);
    assert.equal(cells[0].cellId, 'OC-99-ZZ0001');
    assert.equal(cells[0].edition, 2);
    assert.equal(cells[0].sourceCellId, 'ZZ5KESTR');
    assert.equal(cells[0].sourceHO, 'ZZ');
    assert.equal(cells[0].licence, 'protected');
    assert.equal(cells[0].source, 'pi-decrypt');
    const served = await vault.cell('OC-99-ZZ0001');
    assert.equal(JSON.parse(served.bytes.toString('utf8')).cells[0].edition, 2);
    assert.equal(served.sha256, cells[0].contentSha256);
});

test('a set with two key XMLs, an unkeyed .oesu or an over-long path is skipped with its reason', async (t) => {
    const w = await world(t);
    writeFixtureSet(path.join(w.charts, 'two-keys'), { cells: [cell('OC-99-ZZ0002', 'ZZ5KESTB')], keyFiles: 2 });
    writeFixtureSet(path.join(w.charts, 'unkeyed'), {
        cells: [cell('OC-99-ZZ0003', 'ZZ5KESTC')],
        unkeyed: ['OC-99-ZZ0099'],
    });
    writeFixtureSet(path.join(w.charts, 'good'), { cells: [cell('OC-99-ZZ0004', 'ZZ5KESTD')] });
    // oexserverd takes a chart path of at most 255 bytes: a longer one is never sent cut short.
    writeFixtureSet(path.join(w.charts, `long-${'x'.repeat(240)}`), { cells: [cell('OC-99-ZZ0008', 'ZZ5KESTH')] });
    const vault = w.open();
    await vault.start();
    await vault.whenReady();
    assert.deepEqual(
        vault.index().map((c) => c.cellId),
        ['OC-99-ZZ0004'],
    );
    const reasons = Object.fromEntries(vault.status().skippedSets.map((s) => [path.basename(s.set), s.reason]));
    assert.equal(reasons['two-keys'], 'key-file-count');
    assert.equal(reasons.unkeyed, 'unkeyed-cell');
    assert.equal(reasons[`long-${'x'.repeat(240)}`], 'path-too-long');
});

test('removed.json holds ids only and is honoured across a restart', async (t) => {
    const w = await world(t);
    writeFixtureSet(path.join(w.charts, 'set'), {
        cells: [cell('OC-99-ZZ0001', 'ZZ5KESTR'), cell('OC-99-ZZ0005', 'ZZ5KESTE')],
    });
    const first = w.open();
    await first.start();
    await first.whenReady();
    assert.equal(await first.remove('OC-99-ZZ0001'), true);
    assert.deepEqual(
        first.index().map((c) => c.cellId),
        ['OC-99-ZZ0005'],
    );
    await assert.rejects(first.cell('OC-99-ZZ0001'), { code: 'cell-not-found' });
    const removed = JSON.parse(await fs.readFile(path.join(w.stateDir, 'removed.json'), 'utf8'));
    assert.deepEqual(removed, { version: 1, cellIds: ['OC-99-ZZ0001'] });
    await first.stop();

    const second = w.open();
    await second.start();
    await second.whenReady();
    assert.deepEqual(
        second.index().map((c) => c.cellId),
        ['OC-99-ZZ0005'],
        'a restart never brings a removed cell back',
    );
});

test('a new delivery that contains a removed cell brings it back', async (t) => {
    const w = await world(t);
    writeFixtureSet(path.join(w.charts, 'set'), { cells: [cell('OC-99-ZZ0001', 'ZZ5KESTR', 1)] });
    const vault = w.open();
    await vault.start();
    await vault.whenReady();
    await vault.remove('OC-99-ZZ0001');
    assert.equal(vault.index().length, 0);
    writeFixtureSet(w.delivered('oeuSENC-ZZ-2026-1-2'), { cells: [cell('OC-99-ZZ0001', 'ZZ5KESTR', 2)] });
    const result = await vault.rescan(['OC-99-ZZ0001']);
    assert.equal(result.queued, false);
    assert.deepEqual(result.summary, { new: 1, updated: 0, unchanged: 0, total: 1 });
    assert.equal(vault.index()[0]?.edition, 2);
});

test('a restart reuses the index and re-opens only files whose encrypted hash changed', async (t) => {
    const w = await world(t);
    const setDir = path.join(w.charts, 'set');
    const cells = [
        cell('OC-99-ZZ0001', 'ZZ5KESTR'),
        cell('OC-99-ZZ0005', 'ZZ5KESTE'),
        cell('OC-99-ZZ0006', 'ZZ5KESTF'),
    ];
    writeFixtureSet(setDir, { cells });
    const first = w.open();
    await first.start();
    await first.whenReady();
    assert.equal(w.decrypts(), 3);
    await first.stop();

    const second = w.open();
    await second.start();
    await second.whenReady();
    assert.equal(w.decrypts(), 3, 'nothing changed: nothing re-opened');
    assert.equal(second.index().length, 3);
    await second.stop();

    writeFixtureSet(setDir, { cells: [cells[0], cells[1], cell('OC-99-ZZ0006', 'ZZ5KESTF', 1, 1)] });
    const third = w.open();
    await third.start();
    await third.whenReady();
    assert.equal(w.decrypts(), 4, 'only the re-issued file was opened again');
    assert.equal(third.index().find((c) => c.cellId === 'OC-99-ZZ0006')?.updateNumber, 1);
});

test('a parser-schema change re-indexes everything once, in RAM', async (t) => {
    const w = await world(t);
    writeFixtureSet(path.join(w.charts, 'set'), {
        cells: [cell('OC-99-ZZ0001', 'ZZ5KESTR'), cell('OC-99-ZZ0005', 'ZZ5KESTE')],
    });
    const first = w.open();
    await first.start();
    await first.whenReady();
    await first.stop();
    assert.equal(w.decrypts(), 2);
    const second = w.open({ schema: EXTRACTOR_SCHEMA + 1 });
    await second.start();
    await second.whenReady();
    assert.equal(w.decrypts(), 4);
    await second.stop();
    const third = w.open({ schema: EXTRACTOR_SCHEMA + 1 });
    await third.start();
    await third.whenReady();
    assert.equal(w.decrypts(), 4, 'once');
});

test('vault-index.json carries exactly the catalogue allowlist', async (t) => {
    const w = await world(t);
    writeFixtureSet(path.join(w.charts, 'set'), { cells: [cell('OC-99-ZZ0001', 'ZZ5KESTR')] });
    const vault = w.open();
    await vault.start();
    await vault.whenReady();
    const saved = JSON.parse(await fs.readFile(path.join(w.stateDir, 'vault-index.json'), 'utf8'));
    assert.deepEqual(Object.keys(saved).sort(), ['files', 'schema', 'version']);
    for (const entry of saved.files) {
        assert.deepEqual(Object.keys(entry).sort(), [...VAULT_INDEX_ENTRY_KEYS].sort());
        assert.equal(entry.licence, 'protected');
    }
    assert.deepEqual([...VAULT_INDEX_ENTRY_KEYS].sort(), [
        'bbox',
        'cellId',
        'contentSha256',
        'edition',
        'encSha256',
        'extractorSchema',
        'featureCount',
        'fileName',
        'issued',
        'licence',
        'setDir',
        'sizeBytes',
        'sourceCellId',
        'sourceHO',
        'updateNumber',
    ]);
    const text = JSON.stringify(saved);
    assert.doesNotMatch(text, /Kestrel|OBJNAM|depths|coordinates|layers|RInstallKey|0A1B2C3D/);
    const stat = await fs.stat(path.join(w.stateDir, 'vault-index.json'));
    assert.equal(stat.mode & 0o777, 0o600);
});

test('no index work runs during a watch: the pass and a rescan wait for it to end', async (t) => {
    const w = await world(t);
    writeFixtureSet(path.join(w.charts, 'set'), { cells: [cell('OC-99-ZZ0001', 'ZZ5KESTR')] });
    const vault = w.open({ watching: null });
    await vault.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(w.decrypts(), 0, 'unknown counts as a watch');
    assert.equal(vault.status().state, 'starting');
    vault.hint({ watching: false });
    await vault.whenReady();
    assert.equal(w.decrypts(), 1);

    vault.hint({ watching: true });
    writeFixtureSet(w.delivered('oeuSENC-ZZ-2026-1-3'), { cells: [cell('OC-99-ZZ0007', 'ZZ5KESTG')] });
    const during = await vault.rescan(['OC-99-ZZ0007']);
    assert.deepEqual({ queued: during.queued, reason: during.reason }, { queued: true, reason: 'watch' });
    assert.equal(w.decrypts(), 1);
    assert.equal(vault.status().rescanPending, true);
    // A phone's own cell is still served during the watch.
    assert.equal((await vault.cell('OC-99-ZZ0001')).bytes.length > 0, true);
    vault.hint({ watching: false });
    await vault.whenIdle();
    assert.equal(w.decrypts(), 3, 'the queued rescan ran after the watch (one cell served, one opened)');
    assert.ok(vault.index().some((c) => c.cellId === 'OC-99-ZZ0007'));
});

const until = async (predicate: () => boolean, ms = 5_000) => {
    const end = Date.now() + ms;
    while (!predicate()) {
        if (Date.now() > end) throw new Error('timed out');
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
};

/** A decrypt that fails like a pulled dongle while `down()`, else opens the fixture; and a counting hash. */
function dongleAndHash(down: () => boolean) {
    const tries: number[] = [];
    let hashes = 0;
    return {
        tries,
        hashes: () => hashes,
        extra: {
            hashFile: async (file: string) => {
                hashes++;
                return createHash('sha256')
                    .update(await fs.readFile(file))
                    .digest('hex');
            },
            decrypt: async (file: string, key: string) => {
                tries.push(Date.now());
                if (down()) throw new DecoderDownError();
                const spec = openFixture(await fs.readFile(file), key);
                return spec ? buildSenc(spec) : Buffer.alloc(0);
            },
        } satisfies Partial<VaultServiceOptions>,
    };
}

/**
 * The vault's pass-retry timer is unref'd: on the Pi the service's sockets keep the event loop alive.
 * A bare test process has nothing else, so while these tests wait on a retry Node 22's runner cancels
 * them ("Promise resolution is still pending but the event loop has already resolved", release run
 * 38361371829; Node 24 waits). A ref'd interval stands in for the sockets, as in piAlarmRelay.test.mts.
 */
const keepLoopAlive = (t: { after: (fn: () => void) => void }) => {
    const keepAlive = setInterval(() => undefined, 1_000);
    t.after(() => clearInterval(keepAlive));
};

const three = () => [
    cell('OC-99-ZZ0001', 'ZZ5KESTR'),
    cell('OC-99-ZZ0002', 'ZZ5KESTS'),
    cell('OC-99-ZZ0003', 'ZZ5KESTT'),
];

test('decoder down: each retry resumes the pass without re-hashing the sets, and the retries back off', async (t) => {
    keepLoopAlive(t);
    const w = await world(t);
    writeFixtureSet(path.join(w.charts, 'set'), { cells: three() });
    let down = true;
    const d = dongleAndHash(() => down);
    const vault = w.open({ extra: { ...d.extra, passRetryMs: 20, passRetryMaxMs: 160 } });
    await vault.start();
    await until(() => d.tries.length >= 5);
    assert.equal(vault.status().state, 'decoder-down');
    assert.equal(d.hashes(), 3, 'hashed once, by the first pass: the four retries resumed its plan');
    const gaps = d.tries.slice(1, 5).map((at, i) => at - d.tries[i]);
    // 20, 40, 80, then 160 (the cap): a timer never fires early, however loaded the machine.
    [20, 40, 80, 160].forEach((at, i) =>
        assert.ok(gaps[i] >= at - 5, `the retry backs off (gaps ${gaps.join(', ')} ms)`),
    );
    down = false;
    await vault.whenReady();
    assert.equal(vault.index().length, 3);
    assert.equal(d.hashes(), 3, 'still no second hashing of the delivered set');
});

test('decoder down, then a set arrives: the retry sees the change and plans again', async (t) => {
    keepLoopAlive(t);
    const w = await world(t);
    writeFixtureSet(path.join(w.charts, 'set'), { cells: three() });
    let down = true;
    const d = dongleAndHash(() => down);
    const vault = w.open({ extra: { ...d.extra, passRetryMs: 20, passRetryMaxMs: 40 } });
    await vault.start();
    await until(() => d.tries.length >= 2);
    writeFixtureSet(w.delivered('oeuSENC-ZZ-2026-1-4'), { cells: [cell('OC-99-ZZ0008', 'ZZ5KESTH')] });
    down = false;
    await vault.whenReady();
    assert.deepEqual(
        vault.index().map((c) => c.cellId),
        ['OC-99-ZZ0001', 'OC-99-ZZ0002', 'OC-99-ZZ0003', 'OC-99-ZZ0008'],
    );
    assert.equal(d.hashes(), 3 + 4, 'the changed sets were hashed again, once');
});

test('the decoder answers a phone again: the waiting pass runs at once, not after its backoff', async (t) => {
    keepLoopAlive(t);
    const w = await world(t);
    writeFixtureSet(path.join(w.charts, 'set'), { cells: three() });
    let down = false;
    const d = dongleAndHash(() => down);
    const vault = w.open({ extra: { ...d.extra, passRetryMs: 60_000 } });
    await vault.start();
    await vault.whenReady();
    down = true;
    writeFixtureSet(w.delivered('oeuSENC-ZZ-2026-1-5'), { cells: [cell('OC-99-ZZ0009', 'ZZ5KESTJ')] });
    await vault.rescan();
    assert.equal(vault.status().state, 'decoder-down');
    down = false;
    // A phone opens a chart near the boat: the decoder is back.
    assert.ok((await vault.cell('OC-99-ZZ0002')).bytes.length > 0);
    await until(() => vault.index().some((c) => c.cellId === 'OC-99-ZZ0009'), 2_000);
    await vault.whenIdle();
    assert.equal(vault.status().state, 'ready');
});
