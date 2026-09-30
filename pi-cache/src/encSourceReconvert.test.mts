import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ChartInstallError, chartBlobPath, publishChartDelivery, readChartIndex } from './encChartStore.js';
import { chartBlobExtractorSchema } from './encLayerContract.js';
import {
    assessRetainedOChartsSource,
    chartStoreSupportsRefresh,
    convertAndVerifyOChartsSets,
    installOChartsDelivery,
    listRetainedOChartsSources,
    readExtractorSchema,
    reconvertFailuresPath,
    reconvertRetainedOChartsSources,
    runOChartsExtractor,
    trailingExtractorSchema,
    RECONVERT_MAX_ATTEMPTS,
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
    const reconvert = (extra: Partial<Parameters<typeof reconvertRetainedOChartsSources>[0]> = {}) =>
        reconvertRetainedOChartsSources({ chartStoreDir, extractorDir, workRoot, runExtractor, logger, ...extra });

    // Build the boat's state.
    schema = undefined;
    await install(AU, await download('au', { 'oeuSENC-AU-1-34': ['AU530150', 'AU530151', 'AU530152'] }));
    await install(NC, await download('nc', { 'oeuSENC-FRnc-a': ['FR466870'], 'oeuSENC-FRnc-b': ['FR466871'] }));
    await supply('AU530150', 2, 2); // the watcher's schema-2 base set, same revision
    await supply('AU530152', 5, 2, 'e'.repeat(64)); // a newer edition from another package
    schema = 2;
    conversions = [];
    return {
        root,
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

// The lease polls on an unref'd timer (a waiting pass must never hold the
// service open). In a test that timer can be the only thing left in the event
// loop, and node:test then cancels the test ('Promise resolution is still
// pending but the event loop has already resolved'): 3 of 3 combined runs on
// the Pi, 2026-10-01. The tests poll on a ref'd timer instead.
const refWait = (ms: number, signal?: AbortSignal) => delay(ms, undefined, { signal });

test('the idle-only lease never takes a queue slot from an install', async () => {
    const governor = new PiWorkloadGovernor();
    const install = await governor.admit('conversion').lease;
    let acquired = false;
    const pending = acquireIdleConversionLease({ governor, pollMs: 5, wait: refWait }).then((lease) => {
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

test('waiting for the idle lease ends when the service stops', async () => {
    const governor = new PiWorkloadGovernor();
    const install = await governor.admit('conversion').lease;
    const controller = new AbortController();
    const pending = acquireIdleConversionLease({ governor, pollMs: 5, wait: refWait, signal: controller.signal });
    await delay(20);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(governor.snapshot('conversion').active, 1, 'only the install holds the lane');
    install.release();
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

test('an older chart store module without refresh support fails the pass closed before any conversion', async (t) => {
    const b = await boat(t);
    assert.equal(chartStoreSupportsRefresh(), true);
    // A namespace import of an encChartStore.js from before refreshes: the
    // marker is simply undefined (a named import would fail module linking).
    const older = path.join(b.root, 'older-encChartStore.mjs');
    await fs.writeFile(older, 'export async function publishChartDelivery() { return { cells: [] }; }\n');
    const namespace = (await import(pathToFileURL(older).href)) as object;
    assert.equal(chartStoreSupportsRefresh(namespace), false);
    const index = await b.indexBytes();
    const result = await b.reconvert({ supportsRefresh: () => chartStoreSupportsRefresh(namespace) });
    assert.equal(result.code, 'reconvert-store-unsupported');
    assert.deepEqual(result.outcomes, []);
    assert.equal(b.conversions().length, 0, 'no converter time spent');
    assert.equal(b.warnings.length, 1);
    assert.match(b.warnings[0], /^\[encReconvert\] reconvert-store-unsupported/);
    assert.equal(await b.indexBytes(), index);
});

test('a stop during the conversion publishes nothing, counts nothing and ends the pass', async (t) => {
    const b = await boat(t);
    const index = await b.indexBytes();
    const controller = new AbortController();
    const requests: OChartsExtractorRequest[] = [];
    const result = await b.reconvert({
        signal: controller.signal,
        niceness: 10,
        runExtractor: async (request) => {
            requests.push(request);
            controller.abort(); // the service is stopping; the converter is killed
            throw new ChartInstallError('ocharts-conversion-stopped', 'Chart conversion was stopped.');
        },
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].signal, controller.signal, 'the converter is handed the stop signal');
    assert.equal(requests[0].niceness, 10, 'and the lower priority');
    assert.deepEqual(
        result.outcomes.map((o) => [o.source, o.outcome]),
        [[AU.slice(0, 12), 'stopped']],
        'the next source is not started',
    );
    assert.equal(await b.indexBytes(), index);
    await assert.rejects(fs.access(reconvertFailuresPath(b.chartStoreDir)), 'a stop is not a failure');
    await assert.rejects(fs.access(path.join(b.chartStoreDir, '.index.lock')));
    assert.deepEqual(await fs.readdir(b.workRoot), []);
    assert.deepEqual(b.warnings, []);
});

test('a stop that arrives after the conversion still publishes nothing', async (t) => {
    const b = await boat(t);
    const index = await b.indexBytes();
    const controller = new AbortController();
    const result = await b.reconvert({
        signal: controller.signal,
        runExtractor: async (request) => {
            await b.runExtractor(request);
            controller.abort();
        },
    });
    assert.deepEqual(
        result.outcomes.map((o) => o.outcome),
        ['stopped'],
    );
    assert.equal(await b.indexBytes(), index);
    await assert.rejects(fs.access(reconvertFailuresPath(b.chartStoreDir)));
});

test('a stop while the converted charts are being verified ends the verification at once', async (t) => {
    const b = await boat(t);
    const [au] = await listRetainedOChartsSources(b.chartStoreDir);
    const controller = new AbortController();
    const workDir = await fs.mkdtemp(path.join(b.root, 'verify-'));
    await assert.rejects(
        convertAndVerifyOChartsSets({
            extractedDir: au.directory,
            workDir,
            extractorDir: b.extractorDir,
            archiveHash: au.packageId,
            signal: controller.signal,
            runExtractor: async (request) => {
                await b.runExtractor(request);
                controller.abort(); // the converter finished; verification is next
            },
        }),
        { code: 'ocharts-conversion-stopped' },
    );
});

test('a publication already under way is never cut off; the pass stops after it', async (t) => {
    const b = await boat(t);
    const controller = new AbortController();
    const result = await b.reconvert({
        signal: controller.signal,
        onProgress: (progress) => {
            if (progress.step === 'Publishing re-converted charts') controller.abort();
        },
    });
    assert.deepEqual(
        result.outcomes.map((o) => [o.source, o.outcome]),
        [
            [AU.slice(0, 12), 'reconverted'],
            [NC.slice(0, 12), 'stopped'],
        ],
    );
    assert.equal(await b.schemaOf('AU530151'), 2);
    assert.equal(await b.schemaOf('FR466870'), 1);
    await assert.rejects(fs.access(path.join(b.chartStoreDir, '.index.lock')), 'the index lock was released');
});

test(`a source failing the same way on ${RECONVERT_MAX_ATTEMPTS} starts is held until the schema moves or its record is removed`, async (t) => {
    const b = await boat(t);
    b.setFail((request) => request.chartSet.directory.endsWith('oeuSENC-FRnc-b'));
    const first = await b.reconvert();
    assert.deepEqual(
        first.outcomes.map((o) => [o.outcome, o.attempts]),
        [
            ['reconverted', undefined],
            ['failed', 1],
        ],
    );
    assert.match(b.warnings.at(-1)!, /the next start tries again\.$/);
    const second = await b.reconvert();
    assert.deepEqual(
        second.outcomes.map((o) => [o.outcome, o.attempts]),
        [
            ['current', undefined],
            ['failed', 2],
        ],
    );
    assert.match(b.warnings.at(-1)!, /held from now on \(2 starts in a row\)/);
    const record = JSON.parse(await fs.readFile(reconvertFailuresPath(b.chartStoreDir), 'utf8')) as {
        sources: Record<string, { targetSchema: number; code: string; attempts: number }>;
    };
    assert.deepEqual(
        Object.entries(record.sources).map(([name, r]) => [name.slice(0, 64), r.targetSchema, r.code, r.attempts]),
        [[NC, 2, 'ocharts-conversion-failed', 2]],
    );
    // Third start: no converter time for it, one warning that says how to retry.
    const converted = b.conversions().length;
    b.warnings.length = 0;
    const third = await b.reconvert();
    assert.deepEqual(
        third.outcomes.map((o) => [o.outcome, o.code]),
        [
            ['current', undefined],
            ['held', 'ocharts-conversion-failed'],
        ],
    );
    assert.equal(b.conversions().length, converted, 'the converter was not started');
    assert.equal(b.warnings.length, 1);
    assert.match(
        b.warnings[0],
        /^\[encReconvert\] reconvert-held bbbbbbbbbbbb: .*rm \S+\.reconvert-failures\.json and restart\.$/,
    );
    // Manual retry: remove the record. Still failing, so counted from one again.
    await fs.rm(reconvertFailuresPath(b.chartStoreDir));
    assert.deepEqual(
        (await b.reconvert()).outcomes.map((o) => [o.outcome, o.attempts]),
        [
            ['current', undefined],
            ['failed', 1],
        ],
    );
    // A new converter schema retries whatever was held; success clears the record.
    b.setFail(null);
    await b.declare(3);
    b.setSchema(3);
    assert.deepEqual(
        (await b.reconvert()).outcomes.map((o) => o.outcome),
        ['reconverted', 'reconverted'],
    );
    await assert.rejects(fs.access(reconvertFailuresPath(b.chartStoreDir)), 'nothing left to record');
});

test('a conversion killed from outside is reported but never counted towards holding a source', async (t) => {
    const b = await boat(t);
    const interrupted = async () => {
        throw new ChartInstallError('ocharts-conversion-interrupted', 'Chart conversion was interrupted.');
    };
    for (let start = 0; start <= RECONVERT_MAX_ATTEMPTS; start++) {
        const result = await b.reconvert({ runExtractor: interrupted });
        assert.deepEqual(
            result.outcomes.map((o) => [o.outcome, o.code, o.attempts]),
            [
                ['failed', 'ocharts-conversion-interrupted', undefined],
                ['failed', 'ocharts-conversion-interrupted', undefined],
            ],
        );
    }
    await assert.rejects(fs.access(reconvertFailuresPath(b.chartStoreDir)));
});

test('an unexpected error reaches the journal in full but the health status only as codes', async (t) => {
    const b = await boat(t);
    const where = path.join(b.chartStoreDir, 'sources', `${AU}-00000000-0000-0000-0000-000000000000`, 'x.oesu');
    const result = await b.reconvert({
        runExtractor: async () => {
            throw Object.assign(new Error(`ENOENT: no such file or directory, open '${where}'`), { code: 'ENOENT' });
        },
    });
    assert.equal(result.outcomes.length, 2);
    for (const outcome of result.outcomes) {
        assert.equal(outcome.code, 'reconvert-unexpected');
        assert.equal(outcome.errno, 'ENOENT');
        assert.equal(outcome.message, undefined);
    }
    assert.ok(!JSON.stringify(result.outcomes).includes(b.root), 'no path in the status');
    assert.ok(b.warnings[0].includes(where), 'the journal keeps the whole error');
});

/**
 * A stand-in converter run through the real runOChartsExtractor: a real child
 * process in its own process group, entry point src/decryptBatch.ts loaded
 * with `--import tsx` from the extractor directory (a no-op `tsx` here; the
 * entry point is plain JavaScript that Node runs as TypeScript).
 */
async function fakeConverter(t: TestContext) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'enc-fake-converter-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    await fs.mkdir(path.join(dir, 'node_modules', 'tsx'), { recursive: true });
    await fs.writeFile(
        path.join(dir, 'node_modules', 'tsx', 'package.json'),
        JSON.stringify({ name: 'tsx', type: 'module', exports: './noop.mjs' }),
    );
    await fs.writeFile(path.join(dir, 'node_modules', 'tsx', 'noop.mjs'), '');
    await fs.mkdir(path.join(dir, 'src'));
    await fs.writeFile(
        path.join(dir, 'src', 'decryptBatch.ts'),
        [
            "const { spawn } = require('node:child_process');",
            "const fs = require('node:fs');",
            "const os = require('node:os');",
            "const path = require('node:path');",
            'const arg = (name) => process.argv[process.argv.indexOf(name) + 1];',
            "const mode = path.basename(arg('--charts'));",
            "const report = arg('--report');",
            "if (mode === 'nice') fs.writeFileSync(report + '.nice', String(os.getPriority()));",
            "if (mode === 'self-kill') process.kill(process.pid, 'SIGTERM');",
            "if (mode === 'hang') {",
            "    const helper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });",
            "    fs.writeFileSync(report + '.pid', String(helper.pid));",
            '    setTimeout(() => {}, 60000);',
            '}',
            '',
        ].join('\n'),
    );
    const request = (mode: string, extra: Partial<OChartsExtractorRequest> = {}): OChartsExtractorRequest => ({
        chartSet: {
            directory: path.join(dir, mode),
            keyFile: path.join(dir, 'key.xml'),
            cellIds: [],
            sourceCellIds: {},
        },
        storeDir: path.join(dir, 'store'),
        reportPath: path.join(dir, `${mode}-report.json`),
        extractorDir: dir,
        ...extra,
    });
    return { dir, request };
}

const typeStripping = Boolean((process.features as { typescript?: unknown }).typescript);

test(
    'the converter runs at the niceness it is given',
    { skip: !typeStripping && 'needs Node type stripping' },
    async (t) => {
        const converter = await fakeConverter(t);
        const request = converter.request('nice', { niceness: 10 });
        await runOChartsExtractor(request);
        const nice = Number(await fs.readFile(`${request.reportPath}.nice`, 'utf8'));
        // Raising niceness needs no privilege; lowering it does (so never below ours).
        assert.equal(nice, Math.max(10, os.getPriority()));
    },
);

test(
    'stopping the converter ends its whole process group, and says it was stopped',
    { skip: !typeStripping && 'needs Node type stripping' },
    async (t) => {
        const converter = await fakeConverter(t);
        const controller = new AbortController();
        const request = converter.request('hang', { signal: controller.signal });
        const running = runOChartsExtractor(request);
        let helper = 0;
        for (let i = 0; i < 200 && !helper; i++) {
            await delay(25);
            helper = Number(await fs.readFile(`${request.reportPath}.pid`, 'utf8').catch(() => '0'));
        }
        assert.ok(helper > 0, 'the converter started its helper');
        const stoppedAt = Date.now();
        controller.abort();
        await assert.rejects(running, { code: 'ocharts-conversion-stopped' });
        assert.ok(Date.now() - stoppedAt < 5_000, 'stopped promptly');
        let alive = true;
        for (let i = 0; i < 80 && alive; i++) {
            try {
                process.kill(helper, 0);
                await delay(25);
            } catch {
                alive = false;
            }
        }
        assert.equal(alive, false, 'the converter’s own child (oexserverd in real life) went with it');
        // Already stopped: nothing is started at all.
        await assert.rejects(runOChartsExtractor(converter.request('nice', { signal: controller.signal })), {
            code: 'ocharts-conversion-stopped',
        });
        await assert.rejects(fs.access(`${converter.request('nice').reportPath}.nice`));
    },
);

test(
    'a converter killed from outside is "interrupted", not a timeout or a verdict on the charts',
    { skip: !typeStripping && 'needs Node type stripping' },
    async (t) => {
        const converter = await fakeConverter(t);
        await assert.rejects(runOChartsExtractor(converter.request('self-kill')), {
            code: 'ocharts-conversion-interrupted',
        });
    },
);
