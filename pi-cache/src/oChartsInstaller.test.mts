import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { chartBlobPath, publishChartDelivery, readChartIndex } from './encChartStore.js';
import {
    inspectOChartsSets,
    installOChartsDelivery,
    verifyArchiveSha256,
    type OChartsExtractorRequest,
} from './oChartsInstaller.js';

async function fixture(t: TestContext) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ocharts-install-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const extractedDir = path.join(root, 'unpacked');
    const chartStoreDir = path.join(root, 'store');
    const workDir = path.join(root, 'work');
    await fs.mkdir(extractedDir);
    await fs.mkdir(workDir);
    const source = async (name: string, ids: string[], missingKey = false, nativeIds: Record<string, string> = {}) => {
        const directory = path.join(extractedDir, name);
        await fs.mkdir(directory, { recursive: true });
        for (const id of ids) await fs.writeFile(path.join(directory, `${id}.oesu`), 'encrypted test data');
        const keyed = missingKey ? ids.slice(1) : ids;
        await fs.writeFile(
            path.join(directory, 'oeuSENC-test-sgl1234.XML'),
            `<keyList>${keyed.map((id) => `<Chart><FileName>${id}</FileName>${nativeIds[id] ? `<ID>${nativeIds[id]}</ID>` : ''}<RInstallKey>AABB</RInstallKey></Chart>`).join('')}</keyList>`,
        );
        return directory;
    };
    const runExtractor = async (request: OChartsExtractorRequest) => {
        await fs.mkdir(request.storeDir, { recursive: true });
        const staged = [];
        for (const id of request.chartSet.cellIds) {
            const cell = {
                cellId: id,
                sourceHO: (request.chartSet.sourceCellIds[id] ?? id).slice(0, 2),
                sourceCellId: request.chartSet.sourceCellIds[id],
                edition: 2,
                updateNumber: 1,
                issued: '2026-09-01',
                bbox: [165, -23, 167, -21] as [number, number, number, number],
                layers: {
                    LIGHTS: {
                        type: 'FeatureCollection',
                        features: [
                            { type: 'Feature', geometry: { type: 'Point', coordinates: [166, -22] }, properties: {} },
                        ],
                    },
                },
            };
            const filename = path.join(workDir, `${id}.json`);
            const bytes = JSON.stringify({ cells: [cell] });
            await fs.writeFile(filename, bytes);
            staged.push({
                filename,
                meta: {
                    cellId: id,
                    sourceHO: cell.sourceHO,
                    sourceCellId: cell.sourceCellId,
                    edition: 2,
                    updateNumber: 1,
                    issued: cell.issued,
                    bbox: cell.bbox,
                    featureCount: 1,
                    sizeBytes: Buffer.byteLength(bytes),
                    installedAt: '2026-09-27T00:00:00.000Z',
                    source: 'pi-decrypt' as const,
                },
            });
        }
        await publishChartDelivery(request.storeDir, staged);
        await fs.writeFile(
            request.reportPath,
            JSON.stringify({
                version: 1,
                expectedCellIds: request.chartSet.cellIds,
                processedCellIds: request.chartSet.cellIds,
                skippedCellIds: [],
                failedCells: [],
            }),
        );
    };
    const options = {
        extractedDir,
        chartStoreDir,
        workDir,
        extractorDir: path.join(root, 'fake-extractor'),
        archiveHash: 'a'.repeat(64),
        runExtractor,
    };
    return { ...options, options, source, root };
}

test('multi-set delivery converts in isolation and becomes ready only after every set validates', async (t) => {
    const f = await fixture(t);
    await f.source('one', ['FR466870']);
    await f.source('nested/two', ['GB501494']);
    let conversions = 0;
    const result = await installOChartsDelivery({
        ...f.options,
        runExtractor: async (request) => {
            assert.equal((await readChartIndex(f.chartStoreDir)).cells.length, 0);
            await f.runExtractor(request);
            conversions++;
        },
    });
    assert.equal(conversions, 2);
    assert.deepEqual(result.persistedCellIds.sort(), ['FR466870', 'GB501494']);
    assert.deepEqual(result.packageSummary, { new: 2, updated: 0, unchanged: 0, total: 2 });
    const installed = await readChartIndex(f.chartStoreDir);
    for (const cell of installed.cells) {
        assert.equal(cell.packageId, 'a'.repeat(64));
        assert.equal(
            createHash('sha256')
                .update(await fs.readFile(chartBlobPath(f.chartStoreDir, cell)))
                .digest('hex'),
            cell.contentSha256,
        );
    }
    assert.ok((await fs.readdir(path.join(f.chartStoreDir, 'sources'))).includes(result.sourceArchiveId));
});

test('failed second set keeps every previous installed cell and index byte intact', async (t) => {
    const f = await fixture(t);
    await f.source('one', ['FR466870']);
    await installOChartsDelivery(f.options);
    const indexBefore = await fs.readFile(path.join(f.chartStoreDir, 'index.json'), 'utf8');
    const previous = (await readChartIndex(f.chartStoreDir)).cells[0];
    const blobBefore = await fs.readFile(chartBlobPath(f.chartStoreDir, previous), 'utf8');
    await f.source('two', ['GB501494']);
    let conversions = 0;
    await assert.rejects(
        installOChartsDelivery({
            ...f.options,
            workDir: await fs.mkdtemp(path.join(f.root, 'retry-')),
            runExtractor: async (request) => {
                if (++conversions === 2) throw new Error('licensed decrypt failed');
                await f.runExtractor(request);
            },
        }),
        /licensed decrypt failed/,
    );
    assert.equal(await fs.readFile(path.join(f.chartStoreDir, 'index.json'), 'utf8'), indexBefore);
    assert.equal(await fs.readFile(chartBlobPath(f.chartStoreDir, previous), 'utf8'), blobBefore);
});

test('zero-exit incomplete converter reports cannot produce a successful install', async (t) => {
    const f = await fixture(t);
    await f.source('one', ['FR466870']);
    await assert.rejects(
        installOChartsDelivery({
            ...f.options,
            runExtractor: async (request) => {
                await f.runExtractor(request);
                await fs.writeFile(
                    request.reportPath,
                    JSON.stringify({
                        version: 1,
                        expectedCellIds: ['FR466870'],
                        processedCellIds: [],
                        skippedCellIds: [],
                        failedCells: [{ cellId: 'FR466870', error: 'no key' }],
                    }),
                );
            },
        }),
        { code: 'ocharts-incomplete-conversion' },
    );
    assert.equal((await readChartIndex(f.chartStoreDir)).cells.length, 0);
});

test('duplicate cells, missing keys and ambiguous key files fail before converter invocation', async (t) => {
    const f = await fixture(t);
    await f.source('one', ['FR466870']);
    const two = await f.source('two', ['FR466870']);
    await assert.rejects(inspectOChartsSets(f.extractedDir), { code: 'duplicate-chart-cell' });
    await fs.rm(two, { recursive: true });
    const three = await f.source('three', ['GB501494'], true);
    await assert.rejects(inspectOChartsSets(f.extractedDir), { code: 'ocharts-missing-key' });
    await fs.writeFile(path.join(three, 'oeuSENC-other-sglFFFF.XML'), '<keyList/>');
    await assert.rejects(inspectOChartsSets(f.extractedDir), { code: 'ocharts-key-file' });
});

test('same archive is idempotent and converted corruption cannot replace working charts', async (t) => {
    const f = await fixture(t);
    await f.source('one', ['FR466870']);
    await installOChartsDelivery(f.options);
    const nextOptions = { ...f.options, workDir: await fs.mkdtemp(path.join(f.root, 'again-')) };
    const result = await installOChartsDelivery(nextOptions);
    assert.deepEqual(result.packageSummary, { new: 0, updated: 0, unchanged: 1, total: 1 });
    const before = await fs.readFile(path.join(f.chartStoreDir, 'index.json'), 'utf8');
    await assert.rejects(
        installOChartsDelivery({
            ...f.options,
            workDir: await fs.mkdtemp(path.join(f.root, 'bad-')),
            runExtractor: async (request) => {
                await f.runExtractor(request);
                const meta = (await readChartIndex(request.storeDir)).cells[0];
                await fs.appendFile(chartBlobPath(request.storeDir, meta), 'tampered');
            },
        }),
        { code: 'chart-checksum-mismatch' },
    );
    assert.equal(await fs.readFile(path.join(f.chartStoreDir, 'index.json'), 'utf8'), before);
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

test('synthetic o-charts filenames retain the real producer identity verified from their licensed XML', async (t) => {
    const f = await fixture(t);
    await f.source('australia', ['OC-61-001001', 'OC-61-001002'], false, {
        'OC-61-001001': 'AU530150',
        'OC-61-001002': 'PG300001',
    });
    await installOChartsDelivery(f.options);
    const installed = (await readChartIndex(f.chartStoreDir)).cells;
    assert.deepEqual(
        installed.map((cell) => [cell.cellId, cell.sourceHO, cell.sourceCellId]),
        [
            ['OC-61-001001', 'AU', 'AU530150'],
            ['OC-61-001002', 'PG', 'PG300001'],
        ],
    );
});

test('converter provenance must agree with the licensed key XML before any publication', async (t) => {
    const f = await fixture(t);
    await f.source('set', ['OC-61-001001'], false, { 'OC-61-001001': 'PG300001' });
    await assert.rejects(
        installOChartsDelivery({
            ...f.options,
            runExtractor: async (request) => {
                await f.runExtractor(request);
                const index = await readChartIndex(request.storeDir);
                index.cells[0].sourceCellId = 'AU530150';
                await fs.writeFile(path.join(request.storeDir, 'index.json'), JSON.stringify(index));
            },
        }),
        { code: 'invalid-converted-chart' },
    );
    assert.equal((await readChartIndex(f.chartStoreDir)).cells.length, 0);
});

test('o-charts installs record every cell as protected in the index, whatever its id looks like (127-C-b)', async (t) => {
    const f = await fixture(t);
    await f.source('set', ['ZZ5TEST1', 'US5XX01M']);
    await installOChartsDelivery(f.options);
    const written = JSON.parse(await fs.readFile(path.join(f.chartStoreDir, 'index.json'), 'utf8')) as {
        cells: Array<{ cellId: string; source: string; licence?: string }>;
    };
    assert.deepEqual(written.cells.map((cell) => [cell.cellId, cell.source, cell.licence]).sort(), [
        ['US5XX01M', 'pi-decrypt', 'protected'],
        ['ZZ5TEST1', 'pi-decrypt', 'protected'],
    ]);
});
