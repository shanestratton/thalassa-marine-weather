import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
    ChartInstallError,
    chartBlobPath,
    publishChartDelivery,
    readChartIndex,
    type InstalledCellMeta,
    type PackageSummary,
    type StagedChartCell,
} from './encChartStore.js';

const EXTRACTOR_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_CONVERTED_CELL_BYTES = 256 * 1024 * 1024;
const S57_CELL_NAME = /^[A-Z]{2}\d[A-Z0-9]{2,5}$/;

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
        const timeout = setTimeout(() => {
            if (!child.pid) return;
            try {
                if (process.platform === 'win32') child.kill('SIGKILL');
                else process.kill(-child.pid, 'SIGKILL');
            } catch {
                // The group may have completed just before the timeout.
            }
        }, EXTRACTOR_TIMEOUT_MS);
        child.once('error', () => {
            clearTimeout(timeout);
            reject(
                new ChartInstallError(
                    'ocharts-extractor-unavailable',
                    'The o-charts converter could not start. Existing charts were preserved.',
                ),
            );
        });
        child.once('close', (code, signal) => {
            clearTimeout(timeout);
            if (code === 0 && !signal) resolve();
            else
                reject(
                    new ChartInstallError(
                        signal ? 'ocharts-conversion-timeout' : 'ocharts-conversion-failed',
                        signal
                            ? 'Chart conversion did not finish in time. Existing charts were preserved.'
                            : 'The licensed o-charts converter could not process the complete set. Check that the registered dongle is connected and the download belongs to this boat. Existing charts were preserved.',
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
    const sets = await inspectOChartsSets(options.extractedDir);
    if (sets.length === 0)
        throw new ChartInstallError('ocharts-no-cells', 'No o-charts cells were found in this archive.');
    const total = sets.reduce((sum, set) => sum + set.cellIds.length, 0);
    const candidates: StagedChartCell[] = [];
    let featureCount = 0;
    let completed = 0;
    for (let setIndex = 0; setIndex < sets.length; setIndex++) {
        const chartSet = sets[setIndex];
        const storeDir = path.join(options.workDir, 'converted-ocharts', String(setIndex));
        const reportPath = path.join(options.workDir, `ocharts-report-${setIndex}.json`);
        options.onProgress?.(`Converting o-charts set ${setIndex + 1} of ${sets.length}`, completed, total);
        await (options.runExtractor ?? runOChartsExtractor)({
            chartSet,
            storeDir,
            reportPath,
            extractorDir: options.extractorDir,
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
            candidates.push({
                filename,
                meta: {
                    ...meta,
                    contentSha256: hash,
                    source: 'pi-decrypt',
                    sourceUrl: undefined,
                    packageId: options.archiveHash,
                },
            });
        }
        completed += chartSet.cellIds.length;
        options.onProgress?.('Verifying converted charts', completed, total);
    }
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
