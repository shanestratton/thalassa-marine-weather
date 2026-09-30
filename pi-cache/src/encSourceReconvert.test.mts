import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ChartInstallError, chartBlobPath, publishChartDelivery, readChartIndex } from './encChartStore.js';
import { chartBlobExtractorSchema } from './encLayerContract.js';
import {
    assessRetainedOChartsSource,
    installOChartsDelivery,
    listRetainedOChartsSources,
    readExtractorSchema,
    reconvertRetainedOChartsSources,
    trailingExtractorSchema,
    type OChartsExtractorRequest,
} from './oChartsInstaller.js';
import { acquireIdleConversionLease, getSourceReconvertStatus, startSourceReconvert } from './encSourceReconvert.js';
import { PiWorkloadGovernor } from './workloadGovernor.js';

const AU = 'a'.repeat(64); // the app-installed AU 1-34 set
const NC = 'b'.repeat(64); // the app-installed New Caledonia set

/**
 * A store in the state measured on the boat on 2026-10-01: two sets installed
 * through the app at converter schema 1, then the ~/Charts base set converted
 * again at schema 2 by the watcher (no packageId), which took over the AU
 * set's cells at the same revision; the AU set's newer editions and every NC
 * cell stayed schema 1 with their package.
 */
async function boat(t: TestContext) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'enc-reconvert-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const chartStoreDir = path.join(root, 'store');
    const extractorDir = path.join(root, 'extractor');
    const workRoot = path.join(root, 'reconvert-work');
    await fs.mkdir(path.join(extractorDir, 'src'), { recursive: true });
    const declare = (schema: number) =>
        fs.writeFile(
            path.join(extractorDir, 'src', 's57Classes.ts'),
            `/** docs */\nexport const EXTRACTOR_SCHEMA = ${schema};\n`,
        );
    await declare(2);
    // Chart revisions in each licensed download.
    const editions: Record<string, number> = {
        AU530150: 2, // same revision as the base set: now the watcher's cell
        AU530151: 3, // newer than the base set: still the AU package's
        AU530152: 4, // superseded later by another package's edition 5
        FR466870: 2,
        FR466871: 2,
    };
    let schema: number | undefined; // what the fake converter emits (undefined = schema 1)
    let conversions: string[] = [];
    let fail: ((request: OChartsExtractorRequest) => boolean) | null = null;
    const runExtractor = async (request: OChartsExtractorRequest) => {
        conversions.push(path.basename(request.chartSet.directory));
        if (fail?.(request))
            throw new ChartInstallError('ocharts-conversion-failed', 'The licensed converter could not finish.');
        await fs.mkdir(request.storeDir, { recursive: true });
        const staged = [];
        for (const id of request.chartSet.cellIds) {
            const cell: Record<string, unknown> = {
                cellId: id,
                sourceHO: id.slice(0, 2),
                edition: editions[id],
                updateNumber: 0,
                issued: '2026-09-01',
                bbox: [165, -23, 167, -21],
                layers: {
                    LIGHTS: {
                        type: 'FeatureCollection',
                        features: [
                            { type: 'Feature', geometry: { type: 'Point', coordinates: [166, -22] }, properties: {} },
                        ],
                    },
                    ...(schema !== undefined ? { BRIDGE: { type: 'FeatureCollection', features: [] } } : {}),
                },
                // A different package build of the same revision (SENC build, package).
                package:
                    request.chartSet.directory.includes(AU) || request.chartSet.directory.includes(NC) ? 'app' : 'x',
            };
            if (schema !== undefined) cell.extractorSchema = schema;
            const filename = path.join(request.storeDir, `${id}.staged.json`);
            const bytes = JSON.stringify({ cells: [cell] });
            await fs.writeFile(filename, bytes);
            staged.push({
                filename,
                meta: {
                    cellId: id,
                    sourceHO: id.slice(0, 2),
                    edition: editions[id],
                    updateNumber: 0,
                    issued: '2026-09-01',
                    bbox: [165, -23, 167, -21] as [number, number, number, number],
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
    const download = async (name: string, sets: Record<string, string[]>) => {
        const directory = path.join(root, 'downloads', name);
        for (const [set, ids] of Object.entries(sets)) {
            const dir = path.join(directory, set);
            await fs.mkdir(dir, { recursive: true });
            for (const id of ids) await fs.writeFile(path.join(dir, `${id}.oesu`), 'encrypted test data');
            await fs.writeFile(
                path.join(dir, `oeuSENC-${set}-sgl1234.XML`),
                `<keyList>${ids.map((id) => `<Chart><FileName>${id}</FileName><RInstallKey>AABB</RInstallKey></Chart>`).join('')}</keyList>`,
            );
        }
        return directory;
    };
    const install = async (archiveHash: string, extractedDir: string) => {
        const workDir = await fs.mkdtemp(path.join(root, 'install-'));
        return installOChartsDelivery({
            extractedDir,
            workDir,
            chartStoreDir,
            extractorDir,
            archiveHash,
            runExtractor,
        });
    };
    /** Stand-in for the watcher / another package: publish one converted cell. */
    const supply = async (cellId: string, edition: number, cellSchema: number, packageId?: string) => {
        const filename = path.join(root, `supply-${cellId}-${edition}.json`);
        const cell = {
            cellId,
            sourceHO: cellId.slice(0, 2),
            edition,
            updateNumber: 0,
            issued: '2026-09-01',
            bbox: [165, -23, 167, -21],
            layers: { LIGHTS: { type: 'FeatureCollection', features: [] } },
            package: 'base-set',
            extractorSchema: cellSchema,
        };
        const bytes = JSON.stringify({ cells: [cell] });
        await fs.writeFile(filename, bytes);
        await publishChartDelivery(chartStoreDir, [
            {
                filename,
                meta: {
                    cellId,
                    sourceHO: cellId.slice(0, 2),
                    edition,
                    updateNumber: 0,
                    issued: '2026-09-01',
                    bbox: [165, -23, 167, -21],
                    featureCount: 1,
                    sizeBytes: Buffer.byteLength(bytes),
                    installedAt: '2026-10-01T00:00:00.000Z',
                    source: 'pi-decrypt',
                    ...(packageId ? { packageId } : {}),
                },
            },
        ]);
    };
    const schemaOf = async (cellId: string) => {
        const meta = (await readChartIndex(chartStoreDir)).cells.find((c) => c.cellId === cellId)!;
        return chartBlobExtractorSchema(await fs.readFile(chartBlobPath(chartStoreDir, meta)));
    };
    const indexBytes = () => fs.readFile(path.join(chartStoreDir, 'index.json'), 'utf8');
    const warnings: string[] = [];
    const logger = { log: () => {}, warn: (message: string) => warnings.push(message) };
    const reconvert = () =>
        reconvertRetainedOChartsSources({ chartStoreDir, extractorDir, workRoot, runExtractor, logger });

    // Build the boat's state.
    schema = undefined;
    await install(AU, await download('au', { 'oeuSENC-AU-1-34': ['AU530150', 'AU530151', 'AU530152'] }));
    await install(NC, await download('nc', { 'oeuSENC-FRnc-a': ['FR466870'], 'oeuSENC-FRnc-b': ['FR466871'] }));
    await supply('AU530150', 2, 2); // the watcher's schema-2 base set, same revision
    await supply('AU530152', 5, 2, 'e'.repeat(64)); // a newer edition from another package
    schema = 2;
    conversions = [];
    return {
        chartStoreDir,
        extractorDir,
        workRoot,
        runExtractor,
        declare,
        schemaOf,
        indexBytes,
        warnings,
        logger,
        reconvert,
        setSchema: (value: number | undefined) => {
            schema = value;
        },
        setFail: (predicate: typeof fail) => {
            fail = predicate;
        },
        conversions: () => conversions,
    };
}

test('detects the sources whose installed cells predate the extractor schema, and only their own cells', async (t) => {
    const b = await boat(t);
    const sources = await listRetainedOChartsSources(b.chartStoreDir);
    assert.deepEqual(
        sources.map((s) => s.packageId),
        [AU, NC],
    );
    const au = await assessRetainedOChartsSource(b.chartStoreDir, sources[0], 2);
    assert.deepEqual(au.ownedCellIds, ['AU530151'], 'AU530150 is the watcher’s now, AU530152 another package’s');
    assert.deepEqual(au.staleCellIds, ['AU530151']);
    const nc = await assessRetainedOChartsSource(b.chartStoreDir, sources[1], 2);
    assert.deepEqual(nc.staleCellIds.sort(), ['FR466870', 'FR466871']);
    assert.deepEqual((await assessRetainedOChartsSource(b.chartStoreDir, sources[1], 1)).staleCellIds, []);
    assert.equal(await readExtractorSchema(b.extractorDir), 2);
});

test('re-converts each stale source through the installer checks, keeps its package, and leaves other cells as installed', async (t) => {
    const b = await boat(t);
    const before = await readChartIndex(b.chartStoreDir);
    const byId = (cells: typeof before.cells, id: string) => cells.find((c) => c.cellId === id)!;
    const result = await b.reconvert();
    assert.equal(result.targetSchema, 2);
    assert.deepEqual(
        result.outcomes.map((o) => [o.source, o.outcome, o.updated, o.retained]),
        [
            [AU.slice(0, 12), 'reconverted', 1, 2],
            [NC.slice(0, 12), 'reconverted', 2, 0],
        ],
    );
    assert.deepEqual(b.warnings, []);
    const after = await readChartIndex(b.chartStoreDir);
    for (const id of ['AU530151', 'FR466870', 'FR466871']) {
        assert.equal(await b.schemaOf(id), 2, `${id} carries the new layers`);
        assert.equal(byId(after.cells, id).packageId, byId(before.cells, id).packageId, `${id} keeps its package`);
        assert.equal(byId(after.cells, id).source, 'pi-decrypt');
        assert.equal(byId(after.cells, id).edition, byId(before.cells, id).edition);
    }
    // Same revision, same schema, different package build: kept, no conflict.
    assert.deepEqual(byId(after.cells, 'AU530150'), byId(before.cells, 'AU530150'));
    // Another package's newer edition: never downgraded.
    assert.deepEqual(byId(after.cells, 'AU530152'), byId(before.cells, 'AU530152'));
    assert.equal(after.cells.length, before.cells.length);
    // No second retained copy, and the work dirs are gone.
    assert.equal((await listRetainedOChartsSources(b.chartStoreDir)).length, 2);
    assert.deepEqual(await fs.readdir(b.workRoot), []);
});

test('a second run finds everything current and converts nothing', async (t) => {
    const b = await boat(t);
    await b.reconvert();
    const index = await b.indexBytes();
    const converted = b.conversions().length;
    const again = await b.reconvert();
    assert.deepEqual(
        again.outcomes.map((o) => o.outcome),
        ['current', 'current'],
    );
    assert.equal(b.conversions().length, converted, 'the converter was not started again');
    assert.equal(await b.indexBytes(), index);
});

test('a failing set leaves every chart of that source as installed; other sources still convert', async (t) => {
    const b = await boat(t);
    const auBefore = (await readChartIndex(b.chartStoreDir)).cells.filter((c) => c.packageId === AU);
    // The NC download has two sets; the second fails.
    b.setFail((request) => request.chartSet.directory.endsWith('oeuSENC-FRnc-b'));
    const ncBefore = (await readChartIndex(b.chartStoreDir)).cells.filter((c) => c.packageId === NC);
    const result = await b.reconvert();
    assert.deepEqual(
        result.outcomes.map((o) => [o.outcome, o.code]),
        [
            ['reconverted', undefined],
            ['failed', 'ocharts-conversion-failed'],
        ],
    );
    const after = await readChartIndex(b.chartStoreDir);
    assert.deepEqual(
        after.cells.filter((c) => c.packageId === NC),
        ncBefore,
        'the set that converted is not published either',
    );
    assert.notDeepEqual(
        after.cells.filter((c) => c.packageId === AU),
        auBefore,
    );
    assert.equal(b.warnings.length, 1);
    assert.match(b.warnings[0], /^\[encReconvert\] reconvert-failed bbbbbbbbbbbb: ocharts-conversion-failed/);
    assert.deepEqual(await fs.readdir(b.workRoot), []);
    // Fixed (the dongle is back): the next start converts it.
    b.setFail(null);
    const retry = await b.reconvert();
    assert.deepEqual(
        retry.outcomes.map((o) => o.outcome),
        ['current', 'reconverted'],
    );
});

test('a converter that does not produce the schema it declares changes nothing and says so', async (t) => {
    const b = await boat(t);
    await b.declare(3);
    const index = await b.indexBytes();
    const result = await b.reconvert();
    assert.deepEqual(
        result.outcomes.map((o) => o.code),
        ['reconvert-schema-mismatch', 'reconvert-schema-mismatch'],
    );
    assert.equal(await b.indexBytes(), index);
    assert.equal(b.warnings.length, 2);
});

test('no readable schema declaration: nothing is converted', async (t) => {
    const b = await boat(t);
    await fs.writeFile(
        path.join(b.extractorDir, 'src', 's57Classes.ts'),
        'export const EXTRACTOR_SCHEMA = 2;\nexport const EXTRACTOR_SCHEMA = 3;\n',
    );
    assert.equal(await readExtractorSchema(b.extractorDir), null);
    assert.equal(await readExtractorSchema(path.join(b.extractorDir, 'missing')), null);
    const index = await b.indexBytes();
    const result = await b.reconvert();
    assert.deepEqual(result.outcomes, []);
    assert.equal(b.conversions().length, 0);
    assert.match(b.warnings[0], /reconvert-schema-unknown/);
    assert.equal(await b.indexBytes(), index);
});

test('the cheap trailing schema read agrees with the store’s own reading', () => {
    const blob = (cell: Record<string, unknown>) => Buffer.from(JSON.stringify({ cells: [cell] }));
    const layers = {
        LIGHTS: {
            type: 'FeatureCollection',
            features: [{ type: 'Feature', properties: { INFORM: ',"extractorSchema":9}' } }],
        },
    };
    const current = blob({ cellId: 'AU530150', layers, sencCreateDate: '20260901', extractorSchema: 2, stats: {} });
    assert.equal(trailingExtractorSchema(current), 2);
    assert.equal(chartBlobExtractorSchema(current), 2);
    const legacy = blob({ cellId: 'AU530150', layers, stats: {} });
    assert.equal(trailingExtractorSchema(legacy), null, 'a key inside a string is never read');
    assert.equal(chartBlobExtractorSchema(legacy), 1);
    const last = blob({ cellId: 'AU530150', layers, extractorSchema: 3 });
    assert.equal(trailingExtractorSchema(last), 3);
    assert.equal(trailingExtractorSchema(Buffer.from('{"cells":[{"extractorSchema":"2"}]}')), null);
});

test('the idle-only lease never takes a queue slot from an install', async () => {
    const governor = new PiWorkloadGovernor();
    const install = await governor.admit('conversion').lease;
    let acquired = false;
    const pending = acquireIdleConversionLease(governor, 5).then((lease) => {
        acquired = true;
        return lease;
    });
    await delay(20);
    assert.equal(acquired, false);
    assert.equal(governor.snapshot('conversion').queued, 0);
    install.release();
    const lease = await pending;
    assert.equal(governor.snapshot('conversion').active, 1);
    lease.release();
});

test('the startup pass waits for the watcher’s reconcile, holds a lease per source and reports its outcome', async (t) => {
    const b = await boat(t);
    let settle!: () => void;
    const reconcile = new Promise<void>((resolve) => {
        settle = resolve;
    });
    let leases = 0;
    let held = 0;
    const run = startSourceReconvert({
        chartStoreDir: b.chartStoreDir,
        extractorDir: b.extractorDir,
        workRoot: b.workRoot,
        runExtractor: async (request) => {
            assert.equal(held, 1, 'conversion runs under the lease');
            await b.runExtractor(request);
        },
        waitForReconcile: () => reconcile,
        acquireLease: async () => {
            leases++;
            held++;
            return { release: () => void held-- };
        },
        logger: b.logger,
    });
    await delay(20);
    assert.equal(getSourceReconvertStatus().state, 'waiting');
    assert.equal(b.conversions().length, 0);
    settle();
    await run;
    const status = getSourceReconvertStatus();
    assert.equal(status.state, 'done');
    assert.equal(status.targetSchema, 2);
    assert.deepEqual(
        status.outcomes.map((o) => o.outcome),
        ['reconverted', 'reconverted'],
    );
    assert.equal(leases, 2);
    assert.equal(held, 0);
    assert.equal(startSourceReconvert(), run, 'once per start');
});
