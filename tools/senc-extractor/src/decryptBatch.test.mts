import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm, utimes, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { resolveChartProducer } from './chartProvenance.js';
import { runDecryptBatch, type Args, type DecryptClient } from './decryptBatch.js';
import { cellStoreRecord, loadPiCacheIndex, publishPiCacheCells } from './piCacheStore.js';
import { emitCell } from './geojsonEmitter.js';
import { loadKeyFile } from './keyFile.js';

function record(type: number, payload: Buffer): Buffer {
    const head = Buffer.alloc(6);
    head.writeUInt16LE(type, 0);
    head.writeUInt32LE(payload.length + 6, 2);
    return Buffer.concat([head, payload]);
}
function senc(update = 1, edition = 2, createDate?: string): Buffer {
    const u16 = (value: number) => {
        const b = Buffer.alloc(2);
        b.writeUInt16LE(value);
        return b;
    };
    const extent = Buffer.alloc(64);
    [-28, 153, -27, 153, -27, 154, -28, 154].forEach((value, i) => extent.writeDoubleLE(value, i * 8));
    return Buffer.concat([
        record(1, u16(201)),
        record(3, Buffer.from('20260920\0')),
        record(4, u16(edition)),
        record(6, u16(update)),
        ...(createDate ? [record(8, Buffer.from(createDate + '\0'))] : []),
        record(100, extent),
    ]);
}

async function fixture(t: { after(fn: () => Promise<void>): void }, cells = ['AU530150']) {
    const dir = await mkdtemp(join(tmpdir(), 'senc-batch-test-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const chartDir = join(dir, 'charts');
    const store = join(dir, 'store');
    await mkdir(chartDir);
    const keyPath = join(chartDir, 'oeuSENC-test-sglABC.XML');
    await writeFile(
        keyPath,
        `<keyList>${cells.map((id) => `<Chart><FileName>${id}</FileName><RInstallKey>AABB</RInstallKey></Chart>`).join('')}</keyList>`,
    );
    for (const cell of cells) await writeFile(join(chartDir, `${cell}.oesu`), 'encrypted-v1');
    const args: Args = {
        chartDir,
        outDir: join(store, 'cells'),
        piCacheStore: store,
        skipExisting: true,
        fileExt: '.json',
        sourceHO: '',
        reportPath: join(dir, 'report.json'),
    };
    let decryptCount = 0;
    let update = 1;
    let createDate: string | undefined;
    const client: DecryptClient = {
        start: async () => {},
        stop: async () => {},
        decryptChart: async () => {
            decryptCount++;
            return senc(update, 2, createDate);
        },
    };
    return {
        dir,
        chartDir,
        store,
        keyPath,
        args,
        client,
        count: () => decryptCount,
        setUpdate: (value: number) => {
            update = value;
        },
        setCreateDate: (value: string) => {
            createDate = value;
        },
    };
}

test('standard ENC producers derive independently; synthetic ids require verified metadata', () => {
    assert.equal(resolveChartProducer('AU530150'), 'AU');
    assert.equal(resolveChartProducer('NZ505321'), 'NZ');
    assert.equal(resolveChartProducer('FR466870'), 'FR');
    assert.throws(() => resolveChartProducer('OC-61-041834'), /Unknown producer/);
    assert.throws(() => resolveChartProducer('FR466870', 'AU'), /Conflicting/);
    assert.equal(
        resolveChartProducer('OC-61-041834', undefined, { version: 1, cells: { 'OC-61-041834': { sourceHO: 'FR' } } }),
        'FR',
    );
});

test('licensed native IDs map mixed synthetic packages per cell and survive publication', async (t) => {
    const ids = {
        'OC-33-086174': 'FR471680',
        'OC-61-041834': 'AU438140',
        'OC-61-000001': 'PG500001',
        'OC-61-000002': 'SB400002',
    };
    const f = await fixture(t, Object.keys(ids));
    await writeFile(
        f.keyPath,
        `<keyList>${Object.entries(ids)
            .map(
                ([file, id]) =>
                    `<Chart><FileName>${file}</FileName><ID>${id}</ID><RInstallKey>AABB</RInstallKey></Chart>`,
            )
            .join('')}</keyList>`,
    );
    assert.equal(
        (await loadKeyFile(f.keyPath)).get('OC-33-086174'),
        'AABB',
        'legacy helper still exposes filename-to-key map',
    );
    const result = await runDecryptBatch(f.args, f.client);
    assert.deepEqual(result.failedCells, []);
    assert.equal(result.processedCellIds.length, 4);
    for (const meta of (await loadPiCacheIndex(f.store)).cells) {
        const nativeId = ids[meta.cellId as keyof typeof ids];
        assert.equal(meta.sourceCellId, nativeId);
        assert.equal(meta.sourceHO, nativeId.slice(0, 2));
        const cell = JSON.parse(await readFile(join(f.store, meta.blobPath!), 'utf8')).cells[0];
        assert.equal(cell.cellId, meta.cellId);
        assert.equal(cell.sourceCellId, nativeId);
    }
});

test('output preserves update number and hashes exact UTF-8 bytes', () => {
    const cell = emitCell({ cellEdition: 3, update: 7, cellName: 'Nouméa' }, [], {
        cellId: 'FR466870',
        sourceHO: 'FR',
    });
    const result = cellStoreRecord(cell);
    assert.equal(result.meta.updateNumber, 7);
    assert.equal(JSON.parse(result.json).cells[0].updateNumber, 7);
    assert.equal(result.meta.sizeBytes, Buffer.byteLength(result.json));
    assert.equal(result.meta.contentSha256, createHash('sha256').update(result.json).digest('hex'));
    assert.ok(result.meta.blobPath?.endsWith(`${result.meta.contentSha256}.json`));
});

test('key-only and same-mtime chart changes reconcile, unchanged inputs skip decryption', async (t) => {
    const f = await fixture(t);
    assert.deepEqual((await runDecryptBatch(f.args, f.client)).processedCellIds, ['AU530150']);
    const first = (await loadPiCacheIndex(f.store)).cells[0];
    assert.deepEqual((await runDecryptBatch(f.args, f.client)).skippedCellIds, ['AU530150']);
    assert.equal(f.count(), 1);
    await writeFile(f.keyPath, (await readFile(f.keyPath, 'utf8')).replace('AABB', 'CCDD'));
    assert.equal((await runDecryptBatch(f.args, f.client)).failedCells.length, 0);
    assert.equal(f.count(), 2, 'key-only change must reach decryptor');
    const chart = join(f.chartDir, 'AU530150.oesu');
    const originalStat = await stat(chart);
    await writeFile(chart, 'encrypted-v2');
    await utimes(chart, originalStat.atime, originalStat.mtime);
    f.setUpdate(2);
    assert.deepEqual((await runDecryptBatch(f.args, f.client)).processedCellIds, ['AU530150']);
    const next = (await loadPiCacheIndex(f.store)).cells[0];
    assert.equal(next.edition, 2);
    assert.equal(next.updateNumber, 2);
    assert.notEqual(next.contentSha256, first.contentSha256);
    assert.ok(await readFile(join(f.store, first.blobPath!)), 'previous immutable blob remains readable');
});

test('partial decrypt and missing keys fail visibly without replacing the installed index', async (t) => {
    const f = await fixture(t);
    await runDecryptBatch(f.args, f.client);
    const prior = await readFile(join(f.store, 'index.json'), 'utf8');
    await writeFile(join(f.chartDir, 'NZ505321.oesu'), 'missing-key');
    const report = await runDecryptBatch(f.args, f.client);
    assert.equal(report.failedCells[0].cellId, 'NZ505321');
    assert.match(report.failedCells[0].error, /matching chart key/);
    assert.equal(await readFile(join(f.store, 'index.json'), 'utf8'), prior);
    assert.deepEqual(JSON.parse(await readFile(f.args.reportPath!, 'utf8')), report);
});

test('corrupt index and truncated decrypted SENC produce failed reports', async (t) => {
    const f = await fixture(t);
    const report = await runDecryptBatch(f.args, { ...f.client, decryptChart: async () => Buffer.from('not-a-chart') });
    assert.match(report.failedCells[0].error, /missing valid|Truncated/);
    const incompleteRecord = record(64, Buffer.from([1, 2, 3])).subarray(0, 7);
    const partial = await runDecryptBatch(f.args, {
        ...f.client,
        decryptChart: async () => Buffer.concat([senc(), incompleteRecord]),
    });
    assert.match(partial.failedCells[0].error, /Truncated SENC record/);
    await writeFile(join(f.store, 'index.json'), '{corrupt');
    const corrupt = await runDecryptBatch(f.args, f.client);
    assert.equal(corrupt.failedCells[0].cellId, '__batch__');
    assert.equal(await readFile(join(f.store, 'index.json'), 'utf8'), '{corrupt');
});

test('CLI returns nonzero with a machine-readable report for an incomplete package', async (t) => {
    const f = await fixture(t);
    await writeFile(f.keyPath, '<keyList/>');
    const cli = fileURLToPath(new URL('../../../pi-cache/node_modules/tsx/dist/cli.mjs', import.meta.url));
    const batch = fileURLToPath(new URL('./decryptBatch.ts', import.meta.url));
    await assert.rejects(
        promisify(execFile)(process.execPath, [
            cli,
            batch,
            '--charts',
            f.chartDir,
            '--pi-cache-store',
            f.store,
            '--report',
            f.args.reportPath!,
        ]),
        (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 1,
    );
    const report = JSON.parse(await readFile(f.args.reportPath!, 'utf8'));
    assert.equal(report.failedCells.length, 1);
    assert.deepEqual(report.expectedCellIds, ['AU530150']);
});

test('blob publication failure reports failure and preserves the prior published index', async (t) => {
    const f = await fixture(t);
    await runDecryptBatch(f.args, f.client);
    const prior = await readFile(join(f.store, 'index.json'), 'utf8');
    await writeFile(join(f.chartDir, 'AU530150.oesu'), 'encrypted-update');
    const badClient: DecryptClient = {
        ...f.client,
        decryptChart: async () => {
            const parsed = emitCell(
                {
                    sencVersion: 201,
                    cellEdition: 2,
                    publishDate: '20260920',
                    update: 2,
                    cellExtent: { sLat: -28, nLat: -27, wLon: 153, eLon: 154 },
                },
                [],
                { cellId: 'AU530150', sourceHO: 'AU' },
            );
            await mkdir(join(f.store, cellStoreRecord(parsed).meta.blobPath!));
            return senc(2);
        },
    };
    const report = await runDecryptBatch(f.args, badClient);
    assert.equal(report.failedCells[0].cellId, '__batch__');
    assert.equal(await readFile(join(f.store, 'index.json'), 'utf8'), prior);
});

test('index rename failure is reported and never acknowledges a new installed revision', async (t) => {
    const f = await fixture(t);
    await runDecryptBatch(f.args, f.client);
    const prior = await readFile(join(f.store, 'index.json'), 'utf8');
    await writeFile(join(f.chartDir, 'AU530150.oesu'), 'updated');
    f.setUpdate(2);
    const originalRename = fsPromises.rename;
    const mockedRename = t.mock.method(fsPromises, 'rename', async (...args: Parameters<typeof originalRename>) => {
        if (String(args[1]) === join(f.store, 'index.json')) throw new Error('simulated index publication failure');
        return originalRename(...args);
    });
    syncBuiltinESMExports();
    t.after(() => {
        mockedRename.mock.restore();
        syncBuiltinESMExports();
    });
    const report = await runDecryptBatch(f.args, f.client);
    assert.match(report.failedCells[0].error, /index publication failure/);
    assert.equal(await readFile(join(f.store, 'index.json'), 'utf8'), prior);
});

test('legacy wrong default producer can migrate only using a genuine ENC prefix', async (t) => {
    const f = await fixture(t);
    const good = cellStoreRecord(emitCell({ cellEdition: 1, update: 0 }, [], { cellId: 'FR466870', sourceHO: 'FR' }));
    await mkdir(f.store);
    await writeFile(
        join(f.store, 'index.json'),
        JSON.stringify({
            version: 1,
            cells: [{ ...good.meta, sourceHO: 'AU', contentSha256: undefined, blobPath: undefined }],
        }),
    );
    assert.deepEqual((await publishPiCacheCells(f.store, [good])).installed, ['FR466870']);
    assert.equal((await loadPiCacheIndex(f.store)).cells[0].sourceHO, 'FR');
    const synthetic = cellStoreRecord(
        emitCell({ cellEdition: 1, update: 0 }, [], { cellId: 'OC-1-123456', sourceHO: 'FR' }),
    );
    await writeFile(
        join(f.store, 'index.json'),
        JSON.stringify({
            version: 1,
            cells: [{ ...synthetic.meta, sourceHO: 'AU', contentSha256: undefined, blobPath: undefined }],
        }),
    );
    await assert.rejects(publishPiCacheCells(f.store, [synthetic]), /Producer conflict/);
    const verifiedSynthetic = cellStoreRecord(
        emitCell({ cellEdition: 1, update: 0 }, [], {
            cellId: 'OC-1-123456',
            sourceCellId: 'FR471680',
            sourceHO: 'FR',
        }),
    );
    assert.deepEqual((await publishPiCacheCells(f.store, [verifiedSynthetic])).installed, ['OC-1-123456']);
});

test('immutable publisher preserves newer revisions and rejects equal-revision conflicts', async (t) => {
    const f = await fixture(t);
    const make = (update: number, cellName = 'first') =>
        cellStoreRecord(emitCell({ cellEdition: 2, update, cellName }, [], { cellId: 'AU530150', sourceHO: 'AU' }));
    await publishPiCacheCells(f.store, [make(5)]);
    const prior = await readFile(join(f.store, 'index.json'), 'utf8');
    assert.deepEqual((await publishPiCacheCells(f.store, [make(4)])).stale, ['AU530150']);
    assert.equal(await readFile(join(f.store, 'index.json'), 'utf8'), prior);
    await assert.rejects(publishPiCacheCells(f.store, [make(5, 'changed')]), /Conflicting content/);
    assert.equal(await readFile(join(f.store, 'index.json'), 'utf8'), prior);
});

test('old-package build-date-only changes retain the selected blob and become cached no-ops', async (t) => {
    const f = await fixture(t);
    f.setCreateDate('20260921');
    await runDecryptBatch(f.args, f.client);
    const priorIndex = await readFile(join(f.store, 'index.json'), 'utf8');
    const installed = (await loadPiCacheIndex(f.store)).cells[0];
    const priorBlob = await readFile(join(f.store, installed.blobPath!), 'utf8');
    await writeFile(join(f.chartDir, 'AU530150.oesu'), 'older-package-encrypted-bytes');
    f.setCreateDate('20260824');
    const reconciled = await runDecryptBatch(f.args, f.client);
    assert.deepEqual(reconciled.failedCells, []);
    assert.deepEqual(reconciled.processedCellIds, []);
    assert.deepEqual(reconciled.skippedCellIds, ['AU530150']);
    assert.equal(await readFile(join(f.store, 'index.json'), 'utf8'), priorIndex);
    assert.equal(await readFile(join(f.store, installed.blobPath!), 'utf8'), priorBlob);
    assert.equal(f.count(), 2);
    assert.deepEqual((await runDecryptBatch(f.args, f.client)).skippedCellIds, ['AU530150']);
    assert.equal(f.count(), 2, 'the old source now points at the preserved selected blob');
});

test('semantic comparison never bypasses installed-blob integrity checks', async (t) => {
    const f = await fixture(t);
    f.setCreateDate('20260921');
    await runDecryptBatch(f.args, f.client);
    const meta = (await loadPiCacheIndex(f.store)).cells[0];
    const blob = JSON.parse(await readFile(join(f.store, meta.blobPath!), 'utf8'));
    blob.cells[0].sencCreateDate = '20260824';
    await writeFile(join(f.store, meta.blobPath!), JSON.stringify(blob));
    await writeFile(join(f.chartDir, 'AU530150.oesu'), 'force-reconcile');
    f.setCreateDate('20260824');
    const result = await runDecryptBatch(f.args, f.client);
    assert.match(result.failedCells[0].error, /Installed blob integrity mismatch/);
});

test('concurrent publishers merge independently produced cells under the shared lock', async (t) => {
    const f = await fixture(t);
    const make = (cellId: string) =>
        cellStoreRecord(emitCell({ cellEdition: 1, update: 0 }, [], { cellId, sourceHO: cellId.slice(0, 2) }));
    await Promise.all([
        publishPiCacheCells(f.store, [make('AU530150')]),
        publishPiCacheCells(f.store, [make('NZ505321')]),
    ]);
    assert.deepEqual((await loadPiCacheIndex(f.store)).cells.map((cell) => cell.cellId).sort(), [
        'AU530150',
        'NZ505321',
    ]);
});

// Part B (2026-09-30): a newer extractor adds the structure layers (BRIDGE,
// PONTON, CBLOHD, PIPOHD) to cells whose CHART revision has not changed. The
// Pi's startup reconcile (--skip-existing) must re-extract them, and the
// publisher must let the newer extractor's output replace the old one at the
// same revision — or no installed cell ever gains the layers, and the phone
// never reads a bridge.
test('a newer extractor schema re-extracts unchanged charts and republishes them at the same revision', async (t) => {
    const f = await fixture(t);
    // What the previous extractor left: its fingerprint (salt v2) and a blob
    // with no schema and no structure layers, at the chart's own revision.
    const legacyCell = emitCell(
        {
            sencVersion: 201,
            cellEdition: 2,
            update: 1,
            publishDate: '20260920',
            cellExtent: { sLat: -28, nLat: -27, wLon: 153, eLon: 154 },
        },
        [],
        { cellId: 'AU530150', sourceHO: 'AU' },
    ) as unknown as Record<string, unknown>;
    delete legacyCell.extractorSchema;
    legacyCell.layers = {};
    const legacy = cellStoreRecord(legacyCell as unknown as Parameters<typeof cellStoreRecord>[0]);
    await publishPiCacheCells(f.store, [legacy]);
    const chartPath = join(f.chartDir, 'AU530150.oesu');
    const keyDigest = createHash('sha256')
        .update(await readFile(f.keyPath))
        .digest('hex');
    const legacyFingerprint = createHash('sha256')
        .update(`senc-extractor-v2\0${keyDigest}\0AU\0`)
        .update(await readFile(chartPath))
        .digest('hex');
    await writeFile(
        join(f.store, 'processed-files.json'),
        JSON.stringify({
            version: 2,
            files: {
                [chartPath]: {
                    inputSha256: legacyFingerprint,
                    cellId: 'AU530150',
                    outputPath: join(f.store, legacy.meta.blobPath!),
                    contentSha256: legacy.meta.contentSha256,
                },
            },
        }),
    );

    const report = await runDecryptBatch(f.args, f.client);
    assert.deepEqual(report.failedCells, []);
    assert.deepEqual(report.processedCellIds, ['AU530150']);
    assert.equal(f.count(), 1, 'the unchanged chart was decrypted again');
    const meta = (await loadPiCacheIndex(f.store)).cells[0];
    assert.notEqual(meta.contentSha256, legacy.meta.contentSha256);
    const blob = JSON.parse(await readFile(join(f.store, meta.blobPath!), 'utf8'));
    for (const layer of ['BRIDGE', 'PONTON', 'CBLOHD', 'PIPOHD', 'CONVYR'])
        assert.deepEqual(blob.cells[0].layers[layer], { type: 'FeatureCollection', features: [] }, layer);
    // …and the next reconcile is a no-op again.
    assert.deepEqual((await runDecryptBatch(f.args, f.client)).skippedCellIds, ['AU530150']);
    assert.equal(f.count(), 1);
});

test('an OLDER extractor schema never replaces a newer one at the same revision; equal schemas still conflict', async (t) => {
    const f = await fixture(t);
    const make = (schema: number | undefined, cellName = 'first') => {
        const cell = emitCell({ cellEdition: 2, update: 5, cellName }, [], {
            cellId: 'AU530150',
            sourceHO: 'AU',
        }) as unknown as Record<string, unknown>;
        if (schema === undefined) delete cell.extractorSchema;
        else cell.extractorSchema = schema;
        return cellStoreRecord(cell as unknown as Parameters<typeof cellStoreRecord>[0]);
    };
    await publishPiCacheCells(f.store, [make(3)]);
    const prior = await readFile(join(f.store, 'index.json'), 'utf8');
    assert.deepEqual((await publishPiCacheCells(f.store, [make(2, 'older-extractor')])).unchanged, ['AU530150']);
    assert.deepEqual((await publishPiCacheCells(f.store, [make(undefined, 'legacy')])).unchanged, ['AU530150']);
    assert.equal(await readFile(join(f.store, 'index.json'), 'utf8'), prior);
    await assert.rejects(publishPiCacheCells(f.store, [make(3, 'changed')]), /Conflicting content/);
    assert.deepEqual((await publishPiCacheCells(f.store, [make(4, 'newer-extractor')])).installed, ['AU530150']);
});
