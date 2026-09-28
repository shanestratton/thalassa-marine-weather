import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import {
    chartBlobPath,
    publishChartDelivery,
    readChartIndex,
    redactChartSourceUrl,
    removeChartCell,
    sameChartContentIgnoringSencBuildDate,
    type StagedChartCell,
} from './encChartStore.js';

async function fixture(t: TestContext) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'enc-store-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const storeDir = path.join(root, 'store');
    let sequence = 0;
    const cell = async (
        cellId: string,
        edition = 1,
        updateNumber = 0,
        marker = 'original',
    ): Promise<StagedChartCell> => {
        const filename = path.join(root, `${sequence++}.json`);
        const data = JSON.stringify({ cells: [{ cellId, edition, updateNumber, marker }] });
        await fs.writeFile(filename, data);
        return {
            filename,
            meta: {
                cellId,
                edition,
                updateNumber,
                sourceHO: cellId.slice(0, 2),
                issued: '2026-09-01',
                bbox: [165, -23, 167, -21],
                featureCount: 1,
                sizeBytes: Buffer.byteLength(data),
                installedAt: '2026-09-27T00:00:00.000Z',
                source: 'pi-decrypt',
                contentSha256: createHash('sha256').update(data).digest('hex'),
            },
        };
    };
    return { root, storeDir, cell };
}

async function rewriteCandidate(candidate: StagedChartCell, body: Record<string, unknown>): Promise<void> {
    const text = JSON.stringify(body);
    await fs.writeFile(candidate.filename, text);
    candidate.meta.sizeBytes = Buffer.byteLength(text);
    candidate.meta.contentSha256 = createHash('sha256').update(text).digest('hex');
}

function chartWire(sencCreateDate = '20260921') {
    return {
        cells: [
            {
                cellId: 'FR466870',
                sourceCellId: 'FR466870',
                sourceHO: 'FR',
                edition: 2,
                updateNumber: 2,
                issued: '2026-09-01',
                sencCreateDate,
                layers: {
                    SOUNDG: { features: [{ properties: { VALSOU: 12 }, geometry: { coordinates: [165, -22, 12] } }] },
                },
                stats: { emittedFeatures: 1 },
            },
        ],
    };
}

test('publishes a complete delivery atomically and retains unrelated regions and old reader snapshots', async (t) => {
    const f = await fixture(t);
    await publishChartDelivery(f.storeDir, [await f.cell('FR466870'), await f.cell('AU530150')]);
    const old = await readChartIndex(f.storeDir);
    const oldBytes = await fs.readFile(chartBlobPath(f.storeDir, old.cells[0]), 'utf8');
    const candidate = await f.cell('FR466870', 2);
    const result = await publishChartDelivery(f.storeDir, [candidate, await f.cell('GB501494')], {
        beforeCommit: async () => {
            assert.deepEqual(await readChartIndex(f.storeDir), old);
            assert.equal(await fs.readFile(chartBlobPath(f.storeDir, old.cells[0]), 'utf8'), oldBytes);
        },
    });
    assert.deepEqual(result.packageSummary, { new: 1, updated: 1, unchanged: 0, total: 2 });
    const current = await readChartIndex(f.storeDir);
    assert.equal(current.cells.length, 3);
    assert.equal(current.cells.find((c) => c.cellId === 'FR466870')?.edition, 2);
    assert.equal(current.cells.find((c) => c.cellId === 'AU530150')?.edition, 1);
    assert.equal(await fs.readFile(chartBlobPath(f.storeDir, old.cells[0]), 'utf8'), oldBytes);
});

test('a publication failure preserves exact previous index and chart bytes', async (t) => {
    const f = await fixture(t);
    await publishChartDelivery(f.storeDir, [await f.cell('FR466870')]);
    const indexBefore = await fs.readFile(path.join(f.storeDir, 'index.json'), 'utf8');
    const old = (await readChartIndex(f.storeDir)).cells[0];
    const blobBefore = await fs.readFile(chartBlobPath(f.storeDir, old), 'utf8');
    await assert.rejects(
        publishChartDelivery(f.storeDir, [await f.cell('FR466870', 2), await f.cell('GB501494')], {
            beforeCommit: async () => {
                throw new Error('simulated disk failure');
            },
        }),
        /simulated disk failure/,
    );
    assert.equal(await fs.readFile(path.join(f.storeDir, 'index.json'), 'utf8'), indexBefore);
    assert.equal(await fs.readFile(chartBlobPath(f.storeDir, old), 'utf8'), blobBefore);
    await assert.rejects(fs.stat(path.join(f.storeDir, '.index.lock')), { code: 'ENOENT' });
});

test('repeat delivery is unchanged and does not rewrite installation time or manifest', async (t) => {
    const f = await fixture(t);
    const cell = await f.cell('FR466870');
    await publishChartDelivery(f.storeDir, [cell]);
    const before = await fs.readFile(path.join(f.storeDir, 'index.json'), 'utf8');
    cell.meta.installedAt = '2026-10-01T00:00:00.000Z';
    const result = await publishChartDelivery(f.storeDir, [cell]);
    assert.deepEqual(result.packageSummary, { new: 0, updated: 0, unchanged: 1, total: 1 });
    assert.equal(await fs.readFile(path.join(f.storeDir, 'index.json'), 'utf8'), before);
});

test('older editions and updates reject the whole delivery without adding other cells', async (t) => {
    const f = await fixture(t);
    await publishChartDelivery(f.storeDir, [await f.cell('FR466870', 2, 3)]);
    const before = await fs.readFile(path.join(f.storeDir, 'index.json'), 'utf8');
    for (const [edition, update] of [
        [1, 9],
        [2, 2],
    ]) {
        await assert.rejects(
            publishChartDelivery(f.storeDir, [await f.cell('GB501494'), await f.cell('FR466870', edition, update)]),
            { code: 'chart-downgrade' },
        );
        assert.equal(await fs.readFile(path.join(f.storeDir, 'index.json'), 'utf8'), before);
    }
});

test('same revision conflicting bytes and altered staged hashes fail closed', async (t) => {
    const f = await fixture(t);
    await publishChartDelivery(f.storeDir, [await f.cell('FR466870')]);
    await assert.rejects(publishChartDelivery(f.storeDir, [await f.cell('FR466870', 1, 0, 'changed')]), {
        code: 'chart-revision-conflict',
    });
    const candidate = await f.cell('FR466870', 2);
    await fs.appendFile(candidate.filename, ' ');
    await assert.rejects(publishChartDelivery(f.storeDir, [candidate]), { code: 'chart-checksum-mismatch' });
    assert.equal((await readChartIndex(f.storeDir)).cells[0].edition, 1);
});

test('SENC build-date-only rebuild retains selected bytes, hash, provenance, time and exact index', async (t) => {
    const f = await fixture(t);
    const current = await f.cell('FR466870', 2, 2);
    current.meta.sourceCellId = 'FR466870';
    current.meta.packageId = 'newer-package';
    await rewriteCandidate(current, chartWire());
    const {
        cells: [selected],
    } = await publishChartDelivery(f.storeDir, [current]);
    const indexBefore = await fs.readFile(path.join(f.storeDir, 'index.json'), 'utf8');
    const bytesBefore = await fs.readFile(chartBlobPath(f.storeDir, selected), 'utf8');
    const incoming = await f.cell('FR466870', 2, 2);
    incoming.meta.sourceCellId = 'FR466870';
    incoming.meta.packageId = 'older-package';
    incoming.meta.installedAt = '2026-10-01T00:00:00.000Z';
    const oldWire = chartWire('20260824');
    await rewriteCandidate(incoming, { cells: [Object.fromEntries(Object.entries(oldWire.cells[0]).reverse())] });
    assert.notEqual(incoming.meta.contentSha256, selected.contentSha256);
    const result = await publishChartDelivery(f.storeDir, [incoming]);
    assert.deepEqual(result.packageSummary, { new: 0, updated: 0, unchanged: 1, total: 1 });
    assert.deepEqual(result.cells, [selected]);
    assert.equal(await fs.readFile(path.join(f.storeDir, 'index.json'), 'utf8'), indexBefore);
    assert.equal(await fs.readFile(chartBlobPath(f.storeDir, selected), 'utf8'), bytesBefore);
    assert.equal((await fs.readdir(path.join(f.storeDir, 'cells'))).length, 1);
});

test('build-date comparison still rejects changed navigation data without publishing any delivery cell', async (t) => {
    const f = await fixture(t);
    const current = await f.cell('FR466870', 2, 2);
    await rewriteCandidate(current, chartWire());
    await publishChartDelivery(f.storeDir, [current]);
    const indexBefore = await fs.readFile(path.join(f.storeDir, 'index.json'), 'utf8');
    const incoming = await f.cell('FR466870', 2, 2);
    const changed = chartWire('20260824');
    changed.cells[0].layers.SOUNDG.features[0].properties.VALSOU = 3;
    await rewriteCandidate(incoming, changed);
    await assert.rejects(publishChartDelivery(f.storeDir, [await f.cell('GB501494'), incoming]), {
        code: 'chart-revision-conflict',
    });
    assert.equal(await fs.readFile(path.join(f.storeDir, 'index.json'), 'utf8'), indexBefore);
    assert.equal((await fs.readdir(path.join(f.storeDir, 'cells'))).length, 1);
});

test('semantic equality cannot hide corrupted or missing installed wire bytes', async (t) => {
    const f = await fixture(t);
    const current = await f.cell('FR466870', 2, 2);
    await rewriteCandidate(current, chartWire());
    const {
        cells: [selected],
    } = await publishChartDelivery(f.storeDir, [current]);
    const indexBefore = await fs.readFile(path.join(f.storeDir, 'index.json'), 'utf8');
    const incoming = await f.cell('FR466870', 2, 2);
    await rewriteCandidate(incoming, chartWire('20260824'));
    const installedPath = chartBlobPath(f.storeDir, selected);
    // Corrupt only the ignored field, making stored bytes equal to the incoming
    // package while still disagreeing with the trusted installed fingerprint.
    await fs.copyFile(incoming.filename, installedPath);
    await assert.rejects(publishChartDelivery(f.storeDir, [incoming]), { code: 'chart-checksum-mismatch' });
    assert.equal(await fs.readFile(path.join(f.storeDir, 'index.json'), 'utf8'), indexBefore);
    await fs.unlink(installedPath);
    await assert.rejects(publishChartDelivery(f.storeDir, [incoming]), { code: 'ENOENT' });
});

test('comparison ignores only a valid direct-cell build date, not nested dates, metadata or array order', () => {
    const wire = chartWire();
    const original = JSON.stringify(wire);
    assert.equal(sameChartContentIgnoringSencBuildDate(original, JSON.stringify(chartWire('20260824'))), true);
    for (const change of [
        { sourceHO: 'AU' },
        { sourceCellId: 'FR466871' },
        { edition: 3 },
        { updateNumber: 3 },
        { issued: '2026-09-02' },
        { stats: { emittedFeatures: 2 } },
        { extra: { sencCreateDate: '20260824' } },
        { sencCreateDate: { untrusted: true } },
        { sencCreateDate: 'not-a-date' },
        {
            layers: {
                SOUNDG: { features: [{ properties: { VALSOU: 12 }, geometry: { coordinates: [-22, 165, 12] } }] },
            },
        },
    ]) {
        assert.equal(
            sameChartContentIgnoringSencBuildDate(
                original,
                JSON.stringify({ cells: [{ ...wire.cells[0], ...change }] }),
            ),
            false,
        );
    }
    const nested = { cells: [{ ...wire.cells[0], extra: { sencCreateDate: '20260921' } }] };
    const nestedChanged = { cells: [{ ...wire.cells[0], extra: { sencCreateDate: '20260824' } }] };
    assert.equal(sameChartContentIgnoringSencBuildDate(JSON.stringify(nested), JSON.stringify(nestedChanged)), false);
    assert.equal(sameChartContentIgnoringSencBuildDate(original, JSON.stringify({ ...wire, extra: true })), false);
    for (const invalid of [
        'malformed',
        '{}',
        '{"cells":[]}',
        '{"cells":[null]}',
        '{"cells":[{"extra":1e400}]}',
        JSON.stringify({ cells: [wire.cells[0], wire.cells[0]] }),
    ]) {
        assert.equal(sameChartContentIgnoringSencBuildDate(invalid, invalid), false);
    }
    let nestedTooDeep: unknown = { value: 1 };
    for (let i = 0; i < 130; i++) nestedTooDeep = { child: nestedTooDeep };
    const excessiveDepth = JSON.stringify({ cells: [nestedTooDeep] });
    assert.equal(sameChartContentIgnoringSencBuildDate(excessiveDepth, excessiveDepth), false);
});

test('matching metadata never reports a corrupt or missing installed file as ready', async (t) => {
    const f = await fixture(t);
    const candidate = await f.cell('FR466870');
    const result = await publishChartDelivery(f.storeDir, [candidate]);
    const filename = chartBlobPath(f.storeDir, result.cells[0]);
    await fs.appendFile(filename, 'corrupt');
    await assert.rejects(publishChartDelivery(f.storeDir, [candidate]), { code: 'chart-checksum-mismatch' });
    await fs.unlink(filename);
    await assert.rejects(publishChartDelivery(f.storeDir, [candidate]), { code: 'ENOENT' });
});

test('concurrent writers merge under the shared filesystem lock', async (t) => {
    const f = await fixture(t);
    const cells = await Promise.all(['FR466870', 'GB501494', 'AU530150'].map((id) => f.cell(id)));
    await Promise.all(cells.map((cell) => publishChartDelivery(f.storeDir, [cell])));
    assert.deepEqual((await readChartIndex(f.storeDir)).cells.map((c) => c.cellId).sort(), [
        'AU530150',
        'FR466870',
        'GB501494',
    ]);
});

test('legacy blobs remain readable and removal does not invalidate existing snapshots', async (t) => {
    const f = await fixture(t);
    const candidate = await f.cell('FR466870');
    delete candidate.meta.contentSha256;
    await fs.mkdir(path.join(f.storeDir, 'cells'), { recursive: true });
    await fs.copyFile(candidate.filename, path.join(f.storeDir, 'cells', 'FR466870.json'));
    await fs.writeFile(path.join(f.storeDir, 'index.json'), JSON.stringify({ version: 1, cells: [candidate.meta] }));
    assert.equal((await publishChartDelivery(f.storeDir, [candidate])).packageSummary.unchanged, 1);
    const old = (await readChartIndex(f.storeDir)).cells[0];
    assert.equal(await removeChartCell(f.storeDir, old.cellId), true);
    assert.equal((await readChartIndex(f.storeDir)).cells.length, 0);
    assert.ok(await fs.readFile(chartBlobPath(f.storeDir, old), 'utf8'));
});

test('corrupt indexes and unsafe version paths cannot replace the store', async (t) => {
    const f = await fixture(t);
    await fs.mkdir(f.storeDir);
    await fs.writeFile(path.join(f.storeDir, 'index.json'), 'corrupt');
    await assert.rejects(publishChartDelivery(f.storeDir, [await f.cell('FR466870')]));
    assert.equal(await fs.readFile(path.join(f.storeDir, 'index.json'), 'utf8'), 'corrupt');
    assert.throws(() => chartBlobPath(f.storeDir, { cellId: 'FR466870', blobPath: 'cells/../../private.json' }), {
        code: 'invalid-chart-index',
    });
    assert.equal(
        redactChartSourceUrl('https://charts.example/private-token/charts.zip?signature=secret'),
        'https://charts.example',
    );
});

test('a legacy synthetic producer is corrected only with matching native ENC identity', async (t) => {
    const f = await fixture(t);
    const old = await f.cell('OC-61-001001');
    old.meta.sourceHO = 'AU';
    delete old.meta.contentSha256;
    await fs.mkdir(path.join(f.storeDir, 'cells'), { recursive: true });
    await fs.copyFile(old.filename, path.join(f.storeDir, 'cells', 'OC-61-001001.json'));
    await fs.writeFile(path.join(f.storeDir, 'index.json'), JSON.stringify({ version: 1, cells: [old.meta] }));
    const updated = await f.cell('OC-61-001001', 2);
    updated.meta.sourceHO = 'PG';
    await assert.rejects(publishChartDelivery(f.storeDir, [updated]), { code: 'chart-producer-conflict' });
    updated.meta.sourceCellId = 'AU530150';
    await assert.rejects(publishChartDelivery(f.storeDir, [updated]), { code: 'chart-producer-conflict' });
    updated.meta.sourceCellId = 'PG300001';
    assert.equal((await publishChartDelivery(f.storeDir, [updated])).packageSummary.updated, 1);
    const current = (await readChartIndex(f.storeDir)).cells[0];
    assert.equal(current.sourceHO, 'PG');
    assert.equal(current.sourceCellId, 'PG300001');
});
