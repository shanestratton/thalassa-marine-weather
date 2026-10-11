import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, type Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
    ChartInstallError,
    chartBlobPath,
    publishChartDelivery,
    readChartIndex,
    writeChartFileAtomic,
    type InstalledCellMeta,
    type PackageSummary,
    type StagedChartCell,
} from './encChartStore.js';
// Namespace import on purpose: CHART_REFRESH_SUPPORTED is read at run time, so
// an older encChartStore.js without it fails the re-conversion closed instead
// of failing this module (and the whole server) at link time.
import * as chartStore from './encChartStore.js';
import { chartBlobExtractorSchema } from './encLayerContract.js';

const EXTRACTOR_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_CONVERTED_CELL_BYTES = 256 * 1024 * 1024;
const S57_CELL_NAME = /^[A-Z]{2}\d[A-Z0-9]{2,5}$/;

function throwIfConversionStopped(signal: AbortSignal | undefined): void {
    if (signal?.aborted)
        throw new ChartInstallError(
            'ocharts-conversion-stopped',
            'Chart conversion was stopped. Existing charts were preserved.',
        );
}

export interface OChartsSet {
    directory: string;
    keyFile: string;
    cellIds: string[];
    sourceCellIds: Record<string, string>;
}

export interface OChartsExtractorRequest {
    chartSet: OChartsSet;
    storeDir: string;
    reportPath: string;
    extractorDir: string;
    /** Stops the converter (its whole process group); the run fails with ocharts-conversion-stopped. */
    signal?: AbortSignal;
    /**
     * Scheduling niceness (absolute, os.setPriority) for the converter. The
     * service runs at Nice=-5, above Signal K and the anchor watch; background
     * work asks for less. Raising niceness needs no privilege.
     */
    niceness?: number;
}

interface ExtractorReport {
    version: 1;
    expectedCellIds: string[];
    processedCellIds: string[];
    skippedCellIds: string[];
    failedCells: { cellId: string; error: string }[];
    staleCellIds?: string[];
}

/** Hash by streaming: archive size is already bounded by the download policy. */
export async function archiveSha256(filename: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filename)) hash.update(chunk);
    return hash.digest('hex');
}

export async function verifyArchiveSha256(filename: string, expected?: string): Promise<string> {
    const hash = await archiveSha256(filename);
    if (expected !== undefined && hash !== expected.toLowerCase()) {
        throw new ChartInstallError(
            'archive-checksum-mismatch',
            'The downloaded archive does not match the expected SHA-256. No charts were changed.',
        );
    }
    return hash;
}

/** Find every complete set, never silently install just the first directory. */
export async function inspectOChartsSets(root: string): Promise<OChartsSet[]> {
    const sets: OChartsSet[] = [];
    const allCellIds = new Set<string>();
    const walk = async (directory: string): Promise<void> => {
        const entries = await fs.readdir(directory, { withFileTypes: true });
        const cells = entries.filter((entry) => entry.isFile() && /\.oesu$/i.test(entry.name));
        if (cells.length > 0) {
            const keyFiles = entries.filter(
                (entry) => entry.isFile() && /^oeuSENC-.*-sgl[0-9a-f]+\.xml$/i.test(entry.name),
            );
            if (keyFiles.length !== 1) {
                throw new ChartInstallError(
                    'ocharts-key-file',
                    'Each o-charts set must include exactly one matching key XML. Request a complete download for this boat’s registered system.',
                );
            }
            const keyFile = path.join(directory, keyFiles[0].name);
            const xml = await fs.readFile(keyFile, 'utf8');
            const keyedCells = new Set<string>();
            const sourceCellIds: Record<string, string> = {};
            for (const match of xml.matchAll(/<Chart>([\s\S]*?)<\/Chart>/g)) {
                const id = /<FileName>\s*([^<\s]+)\s*<\/FileName>/.exec(match[1]);
                const key = /<RInstallKey>\s*([0-9A-Fa-f]+)\s*<\/RInstallKey>/.exec(match[1]);
                if (id && key) {
                    if (keyedCells.has(id[1]))
                        throw new ChartInstallError(
                            'ocharts-key-file',
                            'The key XML contains an ambiguous chart mapping.',
                        );
                    keyedCells.add(id[1]);
                    const nativeIds = [...match[1].matchAll(/<ID>\s*([^<]*?)\s*<\/ID>/g)];
                    if (nativeIds.length > 1)
                        throw new ChartInstallError(
                            'ocharts-key-file',
                            'The key XML contains an ambiguous native chart identity.',
                        );
                    if (nativeIds.length === 1) {
                        const nativeId = nativeIds[0][1].trim().toUpperCase();
                        if (!/^[A-Z0-9]{2}[1-6][A-Z0-9]{5}$/.test(nativeId))
                            throw new ChartInstallError(
                                'ocharts-key-file',
                                'The key XML contains an invalid native chart identity.',
                            );
                        sourceCellIds[id[1]] = nativeId;
                    }
                }
            }
            const cellIds = cells.map((entry) => path.basename(entry.name, path.extname(entry.name))).sort();
            for (const id of cellIds) {
                if (!/^[A-Z0-9][A-Z0-9_-]{1,127}$/.test(id)) {
                    throw new ChartInstallError(
                        'invalid-chart-cell',
                        'The o-charts archive contains an unsupported cell filename.',
                    );
                }
                if (allCellIds.has(id))
                    throw new ChartInstallError(
                        'duplicate-chart-cell',
                        `The archive contains ${id} in more than one set. No charts were changed.`,
                    );
                if (!keyedCells.has(id))
                    throw new ChartInstallError(
                        'ocharts-missing-key',
                        `The download has no installation key for ${id}. Request a complete download for this boat’s registered system.`,
                    );
                allCellIds.add(id);
            }
            sets.push({ directory, keyFile, cellIds, sourceCellIds });
        }
        for (const entry of entries) {
            if (entry.isSymbolicLink())
                throw new ChartInstallError('invalid-chart-archive', 'Chart archives cannot contain symbolic links.');
            if (entry.isDirectory()) await walk(path.join(directory, entry.name));
        }
    };
    await walk(root);
    return sets.sort((a, b) => a.directory.localeCompare(b.directory));
}

export async function runOChartsExtractor(request: OChartsExtractorRequest): Promise<void> {
    const entrypoint = path.join(request.extractorDir, 'src', 'decryptBatch.ts');
    try {
        await fs.access(entrypoint);
    } catch {
        throw new ChartInstallError(
            'ocharts-extractor-unavailable',
            'The o-charts converter is not installed on this Pi. Existing charts were preserved.',
        );
    }
    throwIfConversionStopped(request.signal);
    await new Promise<void>((resolve, reject) => {
        // No download URLs or installation keys ever enter argv or captured logs.
        // Load tsx in this Node process, so the timeout owns the actual worker
        // rather than just killing an npm launcher and leaving it running.
        const child = spawn(
            process.execPath,
            [
                '--import',
                'tsx',
                entrypoint,
                '--charts',
                request.chartSet.directory,
                '--key-file',
                request.chartSet.keyFile,
                '--pi-cache-store',
                request.storeDir,
                '--report',
                request.reportPath,
            ],
            {
                cwd: request.extractorDir,
                env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' },
                stdio: ['ignore', 'ignore', 'ignore'],
                detached: process.platform !== 'win32',
            },
        );
        if (request.niceness !== undefined && child.pid) {
            // Set before the converter starts its own children (oexserverd),
            // which inherit it. Best effort: never a reason to fail a conversion.
            try {
                os.setPriority(child.pid, request.niceness);
            } catch {
                // Already lower priority than asked (EACCES), or already gone.
            }
        }
        const killGroup = (signal: NodeJS.Signals) => {
            if (!child.pid) return;
            try {
                if (process.platform === 'win32') child.kill(signal);
                else process.kill(-child.pid, signal);
            } catch {
                // The group may have completed just before.
            }
        };
        let timedOut = false;
        let stopped = false;
        let forceKill: NodeJS.Timeout | undefined;
        const timeout = setTimeout(() => {
            timedOut = true;
            killGroup('SIGKILL');
        }, EXTRACTOR_TIMEOUT_MS);
        const onAbort = () => {
            stopped = true;
            killGroup('SIGTERM');
            forceKill = setTimeout(() => killGroup('SIGKILL'), 5_000);
        };
        request.signal?.addEventListener('abort', onAbort, { once: true });
        const settled = () => {
            clearTimeout(timeout);
            clearTimeout(forceKill);
            request.signal?.removeEventListener('abort', onAbort);
        };
        child.once('error', () => {
            settled();
            reject(
                new ChartInstallError(
                    'ocharts-extractor-unavailable',
                    'The o-charts converter could not start. Existing charts were preserved.',
                ),
            );
        });
        child.once('close', (code, signal) => {
            settled();
            if (code === 0 && !signal) resolve();
            else if (stopped)
                reject(
                    new ChartInstallError(
                        'ocharts-conversion-stopped',
                        'Chart conversion was stopped. Existing charts were preserved.',
                    ),
                );
            else if (timedOut)
                reject(
                    new ChartInstallError(
                        'ocharts-conversion-timeout',
                        'Chart conversion did not finish in time. Existing charts were preserved.',
                    ),
                );
            else if (signal)
                // Killed from outside (a service stop signals the whole unit, the
                // kernel's OOM killer): not a verdict on the charts or the dongle.
                reject(
                    new ChartInstallError(
                        'ocharts-conversion-interrupted',
                        'Chart conversion was interrupted before it finished. Existing charts were preserved.',
                    ),
                );
            else
                reject(
                    new ChartInstallError(
                        'ocharts-conversion-failed',
                        'The licensed o-charts converter could not process the complete set. Check that the registered dongle is connected and the download belongs to this boat. Existing charts were preserved.',
                    ),
                );
        });
    });
}

function validateConvertedCell(value: unknown, expected: InstalledCellMeta): number {
    const cell = value as Record<string, unknown> | undefined;
    const integer = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 9999;
    if (
        !cell ||
        cell.cellId !== expected.cellId ||
        !integer(cell.edition) ||
        cell.edition !== expected.edition ||
        (cell.updateNumber !== undefined && !integer(cell.updateNumber)) ||
        cell.updateNumber !== expected.updateNumber ||
        typeof cell.sourceHO !== 'string' ||
        !/^[A-Z]{2}$/.test(cell.sourceHO) ||
        cell.sourceHO !== expected.sourceHO ||
        (S57_CELL_NAME.test(expected.cellId) && cell.sourceHO !== expected.cellId.slice(0, 2)) ||
        cell.sourceCellId !== expected.sourceCellId ||
        (cell.sourceCellId !== undefined &&
            (typeof cell.sourceCellId !== 'string' ||
                !/^[A-Z0-9]{2}[1-6][A-Z0-9]{5}$/.test(cell.sourceCellId) ||
                cell.sourceCellId.slice(0, 2) !== cell.sourceHO ||
                (S57_CELL_NAME.test(expected.cellId) && cell.sourceCellId !== expected.cellId))) ||
        typeof cell.issued !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(cell.issued) ||
        cell.issued !== expected.issued
    ) {
        throw new ChartInstallError(
            'invalid-converted-chart',
            `The converted metadata for ${expected.cellId} could not be verified.`,
        );
    }
    const bbox = cell.bbox;
    if (
        !Array.isArray(bbox) ||
        bbox.length !== 4 ||
        bbox.some((v) => typeof v !== 'number' || !Number.isFinite(v)) ||
        bbox[0] < -180 ||
        bbox[2] > 180 ||
        bbox[1] < -90 ||
        bbox[3] > 90 ||
        bbox[0] >= bbox[2] ||
        bbox[1] >= bbox[3] ||
        JSON.stringify(bbox) !== JSON.stringify(expected.bbox)
    ) {
        throw new ChartInstallError(
            'invalid-converted-chart',
            `The coverage for ${expected.cellId} could not be verified.`,
        );
    }
    const layers = cell.layers;
    if (!layers || typeof layers !== 'object' || Array.isArray(layers))
        throw new ChartInstallError('invalid-converted-chart', `${expected.cellId} contains no chart layers.`);
    let features = 0;
    for (const layer of Object.values(layers)) {
        const fc = layer as { type?: unknown; features?: unknown[] };
        if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features))
            throw new ChartInstallError(
                'invalid-converted-chart',
                `${expected.cellId} contains an invalid chart layer.`,
            );
        for (const raw of fc.features) {
            const feature = raw as { type?: unknown; geometry?: { type?: string; coordinates?: unknown } };
            if (
                !feature ||
                feature.type !== 'Feature' ||
                !feature.geometry ||
                !['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'].includes(
                    feature.geometry.type ?? '',
                )
            ) {
                throw new ChartInstallError(
                    'invalid-converted-chart',
                    `${expected.cellId} contains invalid chart geometry.`,
                );
            }
            const inspectCoordinates = (coordinates: unknown, depth = 0): void => {
                if (!Array.isArray(coordinates) || coordinates.length === 0 || depth > 4)
                    throw new ChartInstallError(
                        'invalid-converted-chart',
                        `${expected.cellId} contains invalid chart coordinates.`,
                    );
                if (typeof coordinates[0] === 'number') {
                    if (
                        coordinates.length < 2 ||
                        coordinates.some((n) => typeof n !== 'number' || !Number.isFinite(n)) ||
                        Math.abs(coordinates[0]) > 180 ||
                        Math.abs(coordinates[1]) > 90
                    ) {
                        throw new ChartInstallError(
                            'invalid-converted-chart',
                            `${expected.cellId} contains invalid chart coordinates.`,
                        );
                    }
                } else {
                    for (const entry of coordinates) inspectCoordinates(entry, depth + 1);
                }
            };
            inspectCoordinates(feature.geometry.coordinates);
        }
        features += fc.features.length;
    }
    if (features === 0 || features !== expected.featureCount)
        throw new ChartInstallError('invalid-converted-chart', `${expected.cellId} has no verified chart features.`);
    return features;
}

export interface ConvertedOChartsDelivery {
    /** Verified, staged cells (in the work dir), stamped with the package identity. */
    candidates: StagedChartCell[];
    /** Converter schema of each staged cell (encLayerContract.chartBlobExtractorSchema). */
    extractorSchemas: Record<string, number | null>;
    featureCount: number;
    total: number;
}

/**
 * Convert every o-charts set under `extractedDir` into isolated work stores
 * and verify each result: the converter's completion report, the cell list
 * against the licensed key XML, native identity, file size, checksum and the
 * converted content itself (validateConvertedCell). Nothing touches the live
 * chart store here. Shared by a fresh install (installOChartsDelivery) and a
 * re-conversion of a retained source (reconvertRetainedOChartsSource), so both
 * apply exactly the same checks.
 */
export async function convertAndVerifyOChartsSets(options: {
    extractedDir: string;
    workDir: string;
    extractorDir: string;
    archiveHash: string;
    runExtractor?: (request: OChartsExtractorRequest) => Promise<void>;
    onProgress?: (step: string, completed: number, total: number) => void;
    /** Re-conversion only (installs pass neither): see OChartsExtractorRequest. */
    signal?: AbortSignal;
    niceness?: number;
}): Promise<ConvertedOChartsDelivery> {
    const sets = await inspectOChartsSets(options.extractedDir);
    if (sets.length === 0)
        throw new ChartInstallError('ocharts-no-cells', 'No o-charts cells were found in this archive.');
    const total = sets.reduce((sum, set) => sum + set.cellIds.length, 0);
    const candidates: StagedChartCell[] = [];
    const extractorSchemas: Record<string, number | null> = {};
    let featureCount = 0;
    let completed = 0;
    for (let setIndex = 0; setIndex < sets.length; setIndex++) {
        const chartSet = sets[setIndex];
        const storeDir = path.join(options.workDir, 'converted-ocharts', String(setIndex));
        const reportPath = path.join(options.workDir, `ocharts-report-${setIndex}.json`);
        options.onProgress?.(`Converting o-charts set ${setIndex + 1} of ${sets.length}`, completed, total);
        throwIfConversionStopped(options.signal);
        await (options.runExtractor ?? runOChartsExtractor)({
            chartSet,
            storeDir,
            reportPath,
            extractorDir: options.extractorDir,
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.niceness !== undefined ? { niceness: options.niceness } : {}),
        });
        let report: ExtractorReport;
        try {
            report = JSON.parse(await fs.readFile(reportPath, 'utf8')) as ExtractorReport;
        } catch {
            throw new ChartInstallError(
                'ocharts-conversion-report',
                'The converter did not produce a verifiable completion report. Update the Pi converter and try again.',
            );
        }
        const sameIds = (actual: unknown, expected: string[]): boolean =>
            Array.isArray(actual) &&
            actual.length === expected.length &&
            actual.every((id) => typeof id === 'string') &&
            [...actual].sort().join('\n') === [...expected].sort().join('\n');
        if (
            report.version !== 1 ||
            !sameIds(report.expectedCellIds, chartSet.cellIds) ||
            !sameIds(report.processedCellIds, chartSet.cellIds) ||
            !Array.isArray(report.failedCells) ||
            report.failedCells.length !== 0 ||
            !Array.isArray(report.skippedCellIds) ||
            report.skippedCellIds.length !== 0 ||
            (report.staleCellIds && report.staleCellIds.length !== 0)
        ) {
            throw new ChartInstallError(
                'ocharts-incomplete-conversion',
                'Some charts could not be converted. Existing charts were preserved; retry with the complete licensed download.',
            );
        }
        const index = await readChartIndex(storeDir);
        if (
            !sameIds(
                index.cells.map((cell) => cell.cellId),
                chartSet.cellIds,
            )
        )
            throw new ChartInstallError(
                'ocharts-incomplete-conversion',
                'The converted chart list does not match the downloaded set.',
            );
        for (const meta of index.cells) {
            // Verifying a large set takes a while (~45 s for the 934-cell AU set
            // on the boat); a service stop should not have to wait for it.
            throwIfConversionStopped(options.signal);
            if (meta.sourceCellId !== chartSet.sourceCellIds[meta.cellId]) {
                throw new ChartInstallError(
                    'invalid-converted-chart',
                    `The native identity for ${meta.cellId} does not match its licensed key XML.`,
                );
            }
            const filename = chartBlobPath(storeDir, meta);
            const stat = await fs.stat(filename);
            if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_CONVERTED_CELL_BYTES)
                throw new ChartInstallError(
                    'invalid-converted-chart',
                    `${meta.cellId} has an invalid converted file size.`,
                );
            const bytes = await fs.readFile(filename);
            const hash = createHash('sha256').update(bytes).digest('hex');
            if (meta.contentSha256 && meta.contentSha256 !== hash)
                throw new ChartInstallError(
                    'chart-checksum-mismatch',
                    `${meta.cellId} failed its conversion integrity check.`,
                );
            const blob = JSON.parse(bytes.toString('utf8')) as { cells?: unknown[] };
            if (!Array.isArray(blob.cells) || blob.cells.length !== 1)
                throw new ChartInstallError(
                    'invalid-converted-chart',
                    `${meta.cellId} contains an invalid converted result.`,
                );
            featureCount += validateConvertedCell(blob.cells[0], meta);
            extractorSchemas[meta.cellId] = chartBlobExtractorSchema(bytes);
            candidates.push({
                filename,
                meta: {
                    ...meta,
                    contentSha256: hash,
                    source: 'pi-decrypt',
                    licence: 'protected',
                    sourceUrl: undefined,
                    packageId: options.archiveHash,
                },
            });
        }
        completed += chartSet.cellIds.length;
        options.onProgress?.('Verifying converted charts', completed, total);
    }
    return { candidates, extractorSchemas, featureCount, total };
}

export async function installOChartsDelivery(options: {
    extractedDir: string;
    workDir: string;
    chartStoreDir: string;
    extractorDir: string;
    archiveHash: string;
    runExtractor?: (request: OChartsExtractorRequest) => Promise<void>;
    onProgress?: (step: string, completed: number, total: number) => void;
}): Promise<{
    persistedCellIds: string[];
    packageSummary: PackageSummary;
    featureCount: number;
    sourceArchiveId: string;
}> {
    const { candidates, featureCount, total } = await convertAndVerifyOChartsSets(options);
    // Retain a private immutable source copy outside ENC_WATCH_DIR. It cannot
    // trigger a second watcher conversion and is not exposed by installed APIs.
    const sourceRoot = path.join(options.chartStoreDir, 'sources');
    await fs.mkdir(sourceRoot, { recursive: true, mode: 0o700 });
    const retainedSource = path.join(sourceRoot, `${options.archiveHash}-${randomUUID()}`);
    let committed = false;
    try {
        await fs.cp(options.extractedDir, retainedSource, { recursive: true, errorOnExist: true, force: false });
        await fs.chmod(retainedSource, 0o700);
        options.onProgress?.('Publishing verified charts', total, total);
        const published = await publishChartDelivery(options.chartStoreDir, candidates);
        committed = true;
        return {
            persistedCellIds: published.cells.map((cell) => cell.cellId),
            packageSummary: published.packageSummary,
            featureCount,
            sourceArchiveId: path.basename(retainedSource),
        };
    } finally {
        if (!committed) await fs.rm(retainedSource, { recursive: true, force: true }).catch(() => {});
    }
}

// ── Re-converting retained sources when the converter schema moves ────────
//
// An install keeps a private copy of its o-charts source under
// <chart store>/sources/<archive sha256>-<uuid>/ and publishes its cells with
// packageId = that archive hash. The ~/Charts watcher re-extracts its own sets
// when the extractor's schema moves (the schema salts decryptBatch's skip
// fingerprint); nothing re-read these retained sources, so charts installed
// through the app kept the old conversion (no bridge / overhead-clearance
// layers) for good. This does for them what the watcher does for ~/Charts,
// through the installer's own conversion and checks.

const RETAINED_SOURCE_NAME = /^([0-9a-f]{64})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface RetainedOChartsSource {
    /** Directory name under <chart store>/sources. */
    name: string;
    directory: string;
    /** The installing archive's SHA-256: the packageId its cells were published with. */
    packageId: string;
}

/**
 * The converter schema the Pi's extractor will actually produce: its own
 * declaration, `export const EXTRACTOR_SCHEMA = N` in src/s57Classes.ts.
 *
 * Read from the extractor on disk rather than compiled into pi-cache
 * (encLayerContract.ENC_CONVERSION_SCHEMA) because the two deploy separately
 * (the extractor is a git checkout, pi-cache is copied into /opt): a target
 * the converter cannot reach would re-convert every source on every start,
 * forever, and one it has already passed would never re-convert anything.
 * A missing or ambiguous declaration yields null and nothing is converted.
 */
export async function readExtractorSchema(extractorDir: string): Promise<number | null> {
    let source: string;
    try {
        source = await fs.readFile(path.join(extractorDir, 'src', 's57Classes.ts'), 'utf8');
    } catch {
        return null;
    }
    const declarations = [...source.matchAll(/^export const EXTRACTOR_SCHEMA\s*=\s*(\d+)\s*;/gm)];
    if (declarations.length !== 1) return null;
    const schema = Number(declarations[0][1]);
    return Number.isSafeInteger(schema) && schema >= 1 ? schema : null;
}

const SCHEMA_KEY = Buffer.from(',"extractorSchema":');

/**
 * Cheap reading of a blob's `extractorSchema`: the extractor writes it on the
 * cell after the layers (geojsonEmitter.emitCell), so it is the last
 * occurrence of the key. Inside a JSON string that quote would be escaped, so
 * a match is structural. null when absent or unreadable — never "schema 1".
 */
export function trailingExtractorSchema(bytes: Buffer): number | null {
    const at = bytes.lastIndexOf(SCHEMA_KEY);
    if (at < 0) return null;
    const match = /^,"extractorSchema":([1-9]\d{0,8})[,}]/.exec(bytes.subarray(at, at + 32).toString('latin1'));
    return match ? Number(match[1]) : null;
}

/**
 * An installed blob's converter schema as the store's same-revision rule
 * reads it (chartBlobExtractorSchema). Only an at-least-current answer comes
 * from the cheap trailing read; anything that would start a conversion is
 * confirmed by the full parse. Keeps a second start cheap: ~1 s of reading
 * for the 187 installed cells measured on the boat, not ~7 s of parsing.
 */
async function installedBlobSchema(filename: string, targetSchema: number): Promise<number | null> {
    const bytes = await fs.readFile(filename);
    const trailing = trailingExtractorSchema(bytes);
    if (trailing !== null && trailing >= targetSchema) return trailing;
    return chartBlobExtractorSchema(bytes);
}

export async function listRetainedOChartsSources(chartStoreDir: string): Promise<RetainedOChartsSource[]> {
    const root = path.join(chartStoreDir, 'sources');
    let entries: Dirent[];
    try {
        entries = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }
    return entries
        .filter((entry) => entry.isDirectory() && RETAINED_SOURCE_NAME.test(entry.name))
        .map((entry) => ({
            name: entry.name,
            directory: path.join(root, entry.name),
            packageId: RETAINED_SOURCE_NAME.exec(entry.name)![1],
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

export interface RetainedSourceAssessment {
    /** Live cells published by this source's package. */
    ownedCellIds: string[];
    /** Owned cells converted by an older schema that this source can re-convert. */
    staleCellIds: string[];
    /** Owned cells whose blob could not be read or carries no valid schema. */
    unreadableCellIds: string[];
    /** Owned, older-schema cells that are not in the retained source (left alone). */
    notInSourceCellIds: string[];
}

/** Does this retained source need converting again? Reads only; changes nothing. */
export async function assessRetainedOChartsSource(
    chartStoreDir: string,
    source: RetainedOChartsSource,
    targetSchema: number,
): Promise<RetainedSourceAssessment> {
    const index = await readChartIndex(chartStoreDir);
    const owned = index.cells.filter((cell) => cell.packageId === source.packageId);
    const older: string[] = [];
    const unreadableCellIds: string[] = [];
    for (const cell of owned) {
        let schema: number | null;
        try {
            schema = await installedBlobSchema(chartBlobPath(chartStoreDir, cell), targetSchema);
        } catch {
            schema = null;
        }
        if (schema === null) unreadableCellIds.push(cell.cellId);
        else if (schema < targetSchema) older.push(cell.cellId);
    }
    let staleCellIds = older;
    let notInSourceCellIds: string[] = [];
    if (older.length > 0) {
        // Only what this source can produce: anything else would stay behind
        // after a successful run and start the same conversion on every start.
        const produced = new Set((await inspectOChartsSets(source.directory)).flatMap((set) => set.cellIds));
        staleCellIds = older.filter((id) => produced.has(id));
        notInSourceCellIds = older.filter((id) => !produced.has(id));
    }
    return {
        ownedCellIds: owned.map((cell) => cell.cellId),
        staleCellIds,
        unreadableCellIds,
        notInSourceCellIds,
    };
}

/**
 * Does the chart store module this process loaded understand a package
 * refresh (encChartStore.CHART_REFRESH_SUPPORTED)? Read from the namespace at
 * run time: Pi files are copied into /opt one by one, and an encChartStore.js
 * from an older build ignores `refreshPackageId`, so a refresh would publish
 * as an ordinary delivery (bringing back removed cells, or failing
 * chart-downgrade for the whole source on every start).
 */
export function chartStoreSupportsRefresh(store: object = chartStore): boolean {
    return (store as Record<string, unknown>).CHART_REFRESH_SUPPORTED === true;
}

/**
 * Convert one retained source again and publish it as a refresh of its own
 * package: the same conversion and verification as an install
 * (convertAndVerifyOChartsSets), then publishChartDelivery with the same
 * packageId and source 'pi-decrypt'. It replaces only cells the package still
 * owns (encChartStore refreshPackageId); cells another package or the watcher
 * now supplies stay exactly as installed. All or nothing: any failure throws
 * before the index changes. No second source copy is retained. `signal` is
 * honoured up to the publication, never inside it: a publication cut off
 * half-way would leave the store's index lock behind.
 */
export async function reconvertRetainedOChartsSource(options: {
    chartStoreDir: string;
    source: RetainedOChartsSource;
    workDir: string;
    extractorDir: string;
    targetSchema: number;
    runExtractor?: (request: OChartsExtractorRequest) => Promise<void>;
    onProgress?: (step: string, completed: number, total: number) => void;
    signal?: AbortSignal;
    niceness?: number;
    supportsRefresh?: () => boolean;
}): Promise<{
    packageSummary: PackageSummary;
    changedCellIds: string[];
    retainedCellIds: string[];
    featureCount: number;
}> {
    if (!(options.supportsRefresh ?? chartStoreSupportsRefresh)())
        throw new ChartInstallError(
            'reconvert-store-unsupported',
            'The chart store on this Pi predates package refreshes. Existing charts were preserved.',
        );
    const converted = await convertAndVerifyOChartsSets({
        extractedDir: options.source.directory,
        workDir: options.workDir,
        extractorDir: options.extractorDir,
        archiveHash: options.source.packageId,
        runExtractor: options.runExtractor,
        onProgress: options.onProgress,
        signal: options.signal,
        niceness: options.niceness,
    });
    // The converter must produce the schema it declares; otherwise the same
    // cells stay behind and this would run again on every start.
    const off = Object.values(converted.extractorSchemas).filter((schema) => schema !== options.targetSchema);
    if (off.length > 0)
        throw new ChartInstallError(
            'reconvert-schema-mismatch',
            `The converter declares schema ${options.targetSchema} but produced another for ${off.length} chart(s). Existing charts were preserved.`,
        );
    if (options.signal?.aborted)
        throw new ChartInstallError('reconvert-stopped', 'Stopped before publishing. Existing charts were preserved.');
    options.onProgress?.('Publishing re-converted charts', converted.total, converted.total);
    const published = await publishChartDelivery(options.chartStoreDir, converted.candidates, {
        refreshPackageId: options.source.packageId,
    });
    return {
        packageSummary: published.packageSummary,
        changedCellIds: published.changedCellIds,
        retainedCellIds: published.retainedCellIds,
        featureCount: converted.featureCount,
    };
}

export interface SourceReconvertOutcome {
    /** First 12 hex of the package id — never a path. */
    source: string;
    /**
     * held: failed RECONVERT_MAX_ATTEMPTS starts in a row with the same code at
     * this converter schema, so it is not tried again (see reconvertFailuresPath).
     * stopped: the service was stopping; nothing changed, the next start tries again.
     */
    outcome: 'current' | 'reconverted' | 'failed' | 'held' | 'stopped' | 'not-installed';
    owned: number;
    stale: number;
    updated?: number;
    retained?: number;
    code?: string;
    /** A ChartInstallError's own sentence only; never a raw error message (those carry paths). */
    message?: string;
    /** For an unexpected error: its errno code (ENOENT, EACCES, ...), if any. */
    errno?: string;
    /** Consecutive failed starts with this code at this converter schema. */
    attempts?: number;
    finishedAt: string;
}

export interface SourceReconvertProgress {
    source: string;
    index: number;
    total: number;
    step: string;
    completed: number;
    cells: number;
}

/**
 * A source that failed this many starts in a row with the same code, at the
 * same converter schema, is held: later starts skip it with one warning
 * instead of spending ~80 s of converter time (and ~1.7 GB) on the same
 * failure every boot. Two, not one, so a one-off (a busy store, a dongle
 * reseated late) gets one more try on its own.
 */
export const RECONVERT_MAX_ATTEMPTS = 2;

/** Stopped by us or killed from outside: says nothing about the charts, never counted. */
const UNCOUNTED_RECONVERT_CODES = new Set([
    'reconvert-stopped',
    'ocharts-conversion-stopped',
    'ocharts-conversion-interrupted',
]);

interface ReconvertFailureRecord {
    targetSchema: number;
    code: string;
    attempts: number;
    lastFailedAt: string;
}

/**
 * Where failed re-conversions are counted, per retained source directory.
 * Removing the file (then restarting) is the manual retry.
 */
export function reconvertFailuresPath(chartStoreDir: string): string {
    return path.join(chartStoreDir, '.reconvert-failures.json');
}

async function readReconvertFailures(
    chartStoreDir: string,
    logger: Pick<Console, 'log' | 'warn'>,
): Promise<Record<string, ReconvertFailureRecord>> {
    let text: string;
    try {
        text = await fs.readFile(reconvertFailuresPath(chartStoreDir), 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
        logger.warn(
            `[encReconvert] reconvert-failures-unreadable: ${(error as NodeJS.ErrnoException).code ?? 'error'}; counting from zero.`,
        );
        return {};
    }
    const records: Record<string, ReconvertFailureRecord> = {};
    try {
        const parsed = JSON.parse(text) as {
            version?: unknown;
            sources?: Record<string, Partial<ReconvertFailureRecord>>;
        };
        if (parsed.version !== 1 || !parsed.sources || typeof parsed.sources !== 'object') throw new Error('shape');
        for (const [name, record] of Object.entries(parsed.sources)) {
            if (
                RETAINED_SOURCE_NAME.test(name) &&
                Number.isSafeInteger(record?.targetSchema) &&
                typeof record?.code === 'string' &&
                Number.isSafeInteger(record?.attempts) &&
                typeof record?.lastFailedAt === 'string'
            )
                records[name] = record as ReconvertFailureRecord;
        }
    } catch {
        logger.warn('[encReconvert] reconvert-failures-unreadable: not a failure record; counting from zero.');
        return {};
    }
    return records;
}

async function writeReconvertFailures(
    chartStoreDir: string,
    records: Record<string, ReconvertFailureRecord>,
    logger: Pick<Console, 'log' | 'warn'>,
): Promise<void> {
    try {
        if (Object.keys(records).length === 0) await fs.rm(reconvertFailuresPath(chartStoreDir), { force: true });
        else
            await writeChartFileAtomic(
                reconvertFailuresPath(chartStoreDir),
                JSON.stringify({ version: 1, sources: records }, null, 2),
            );
    } catch (error) {
        logger.warn(
            `[encReconvert] could not record re-conversion failures (${(error as NodeJS.ErrnoException).code ?? 'error'}); the next start tries again.`,
        );
    }
}

/**
 * Every retained source, one at a time, each under its own lease (so an
 * install the skipper starts can run between two sources). Never throws for a
 * source: a failure is logged as a warning with its code and leaves every
 * installed chart as it was. The next start tries again, up to
 * RECONVERT_MAX_ATTEMPTS starts with the same failure; then the source is held
 * until the converter schema changes or the failure record is removed. A
 * second run after a successful one finds every owned cell current and
 * converts nothing. `signal` stops the pass between sources and before any
 * publication (never inside one).
 */
export async function reconvertRetainedOChartsSources(options: {
    chartStoreDir: string;
    extractorDir: string;
    workRoot: string;
    runExtractor?: (request: OChartsExtractorRequest) => Promise<void>;
    acquireLease?: () => Promise<{ release(): void }>;
    onProgress?: (progress: SourceReconvertProgress) => void;
    logger?: Pick<Console, 'log' | 'warn'>;
    signal?: AbortSignal;
    niceness?: number;
    supportsRefresh?: () => boolean;
}): Promise<{ targetSchema: number | null; outcomes: SourceReconvertOutcome[]; code?: string }> {
    const logger = options.logger ?? console;
    const sources = await listRetainedOChartsSources(options.chartStoreDir);
    if (sources.length === 0) return { targetSchema: null, outcomes: [] };
    const supportsRefresh = options.supportsRefresh ?? chartStoreSupportsRefresh;
    if (!supportsRefresh()) {
        logger.warn(
            `[encReconvert] reconvert-store-unsupported: this Pi's encChartStore.js predates package refreshes (no CHART_REFRESH_SUPPORTED); ${sources.length} installed source(s) left as they are. Deploy it from the same build as oChartsInstaller.js.`,
        );
        return { targetSchema: null, outcomes: [], code: 'reconvert-store-unsupported' };
    }
    const targetSchema = await readExtractorSchema(options.extractorDir);
    if (targetSchema === null) {
        logger.warn(
            `[encReconvert] reconvert-schema-unknown: no single EXTRACTOR_SCHEMA declaration in ${path.join(options.extractorDir, 'src', 's57Classes.ts')}; ${sources.length} installed source(s) left as they are.`,
        );
        return { targetSchema, outcomes: [], code: 'reconvert-schema-unknown' };
    }
    const failures = await readReconvertFailures(options.chartStoreDir, logger);
    const outcomes: SourceReconvertOutcome[] = [];
    const stopped = (id: string, owned: number, stale: number) => {
        logger.log(
            `[encReconvert] ${id}: stopped (the service is stopping); existing charts were preserved, the next start tries again.`,
        );
        outcomes.push({ source: id, outcome: 'stopped', owned, stale, finishedAt: new Date().toISOString() });
    };
    for (let i = 0; i < sources.length; i++) {
        const source = sources[i];
        const id = source.packageId.slice(0, 12);
        if (options.signal?.aborted) {
            stopped(id, 0, 0);
            break;
        }
        let lease: { release(): void } | null = null;
        try {
            lease = options.acquireLease ? await options.acquireLease() : null;
        } catch (error) {
            if (!options.signal?.aborted) throw error;
            stopped(id, 0, 0);
            break;
        }
        const workDir = path.join(options.workRoot, `${id}-${randomUUID()}`);
        const previous = failures[source.name];
        let record: ReconvertFailureRecord | undefined = previous;
        let owned = 0;
        let stale = 0;
        let stop = false;
        try {
            const assessment = await assessRetainedOChartsSource(options.chartStoreDir, source, targetSchema);
            owned = assessment.ownedCellIds.length;
            stale = assessment.staleCellIds.length;
            if (assessment.unreadableCellIds.length > 0)
                logger.warn(
                    `[encReconvert] reconvert-unreadable-schema ${id}: ${assessment.unreadableCellIds.length} installed chart(s) carry no readable converter schema (${assessment.unreadableCellIds.slice(0, 5).join(', ')}); left as they are.`,
                );
            if (assessment.notInSourceCellIds.length > 0)
                logger.warn(
                    `[encReconvert] reconvert-cell-not-in-source ${id}: ${assessment.notInSourceCellIds.length} older chart(s) of this package are not in its retained source (${assessment.notInSourceCellIds.slice(0, 5).join(', ')}); left as they are.`,
                );
            if (owned === 0 || stale === 0) {
                record = undefined;
                outcomes.push({
                    source: id,
                    outcome: owned === 0 ? 'not-installed' : 'current',
                    owned,
                    stale,
                    finishedAt: new Date().toISOString(),
                });
                continue;
            }
            if (previous && previous.targetSchema === targetSchema && previous.attempts >= RECONVERT_MAX_ATTEMPTS) {
                logger.warn(
                    `[encReconvert] reconvert-held ${id}: ${stale} older chart(s) stay as installed; the last ${previous.attempts} starts failed with ${previous.code} at converter schema ${targetSchema}. Not tried again until the converter schema changes. To retry now: rm ${reconvertFailuresPath(options.chartStoreDir)} and restart.`,
                );
                outcomes.push({
                    source: id,
                    outcome: 'held',
                    owned,
                    stale,
                    code: previous.code,
                    attempts: previous.attempts,
                    finishedAt: new Date().toISOString(),
                });
                continue;
            }
            logger.log(
                `[encReconvert] ${id}: ${stale} of ${owned} installed chart(s) predate converter schema ${targetSchema}; re-converting the retained source`,
            );
            await fs.mkdir(workDir, { recursive: true, mode: 0o700 });
            const result = await reconvertRetainedOChartsSource({
                chartStoreDir: options.chartStoreDir,
                source,
                workDir,
                extractorDir: options.extractorDir,
                targetSchema,
                runExtractor: options.runExtractor,
                onProgress: (step, completed, cells) =>
                    options.onProgress?.({ source: id, index: i, total: sources.length, step, completed, cells }),
                signal: options.signal,
                niceness: options.niceness,
                supportsRefresh,
            });
            record = undefined;
            logger.log(
                `[encReconvert] ${id}: replaced ${result.changedCellIds.length} chart(s) with schema ${targetSchema}; left ${result.retainedCellIds.length} as installed (supplied by another package, the ~/Charts watcher, or removed)`,
            );
            outcomes.push({
                source: id,
                outcome: 'reconverted',
                owned,
                stale,
                updated: result.changedCellIds.length,
                retained: result.retainedCellIds.length,
                finishedAt: new Date().toISOString(),
            });
        } catch (error) {
            if (options.signal?.aborted) {
                stopped(id, owned, stale);
                stop = true;
            } else {
                const known = error instanceof ChartInstallError;
                const code = known ? error.code : 'reconvert-unexpected';
                const errno = known ? undefined : (error as NodeJS.ErrnoException | undefined)?.code;
                const counted = !UNCOUNTED_RECONVERT_CODES.has(code);
                if (counted)
                    record = {
                        targetSchema,
                        code,
                        attempts:
                            previous && previous.targetSchema === targetSchema && previous.code === code
                                ? previous.attempts + 1
                                : 1,
                        lastFailedAt: new Date().toISOString(),
                    };
                const next =
                    counted && record && record.attempts >= RECONVERT_MAX_ATTEMPTS
                        ? `held from now on (${record.attempts} starts in a row); to retry: rm ${reconvertFailuresPath(options.chartStoreDir)} and restart.`
                        : 'the next start tries again.';
                // The journal gets the whole error; the health status only codes.
                logger.warn(
                    `[encReconvert] reconvert-failed ${id}: ${code} — ${error instanceof Error ? error.message : String(error)} Existing charts were preserved; ${next}`,
                );
                outcomes.push({
                    source: id,
                    outcome: 'failed',
                    owned,
                    stale,
                    code,
                    ...(known ? { message: error.message } : {}),
                    ...(typeof errno === 'string' ? { errno } : {}),
                    ...(counted && record ? { attempts: record.attempts } : {}),
                    finishedAt: new Date().toISOString(),
                });
            }
        } finally {
            await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
            lease?.release();
            if (record !== previous) {
                if (record) failures[source.name] = record;
                else delete failures[source.name];
                await writeReconvertFailures(options.chartStoreDir, failures, logger);
            }
        }
        if (stop) break;
    }
    return { targetSchema, outcomes };
}
