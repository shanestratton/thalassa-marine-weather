#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { readdir, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, extname, join, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OexserverdClient } from './oexserverd.js';
import { loadKeyFileEntries } from './keyFile.js';
import { parseSenc } from './featureParser.js';
import { emitCell } from './geojsonEmitter.js';
import { EXTRACTOR_SCHEMA } from './s57Classes.js';
import { writeFileAtomic } from './atomicWrite.js';
import { cellStoreRecord, loadPiCacheIndex, publishPiCacheCells } from './piCacheStore.js';
import { loadChartSourceMetadata, resolveChartProducer } from './chartProvenance.js';

export interface Args {
    chartDir: string;
    outDir: string;
    keyFile?: string;
    binaryPath?: string;
    onlyBbox?: { sLat: number; nLat: number; wLon: number; eLon: number };
    limit?: number;
    skipExisting: boolean;
    sourceHO: string;
    fileExt: string;
    piCacheStore?: string;
    reportPath?: string;
}

export interface BatchReport {
    version: 1;
    expectedCellIds: string[];
    processedCellIds: string[];
    skippedCellIds: string[];
    staleCellIds: string[];
    failedCells: Array<{ cellId: string; error: string }>;
}

interface ProcessedFileEntry {
    inputSha256: string;
    cellId: string;
    contentSha256: string;
    outputPath: string;
}
interface ProcessedFilesRecord {
    version: 2;
    files: Record<string, ProcessedFileEntry>;
}

export function parseArgs(argv: string[]): Args {
    const args: Args = { chartDir: '', outDir: '', skipExisting: false, sourceHO: '', fileExt: '.geojson' };
    for (let i = 0; i < argv.length; i++) {
        const next = (): string => {
            if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing value for ${argv[i]}`);
            return argv[++i];
        };
        switch (argv[i]) {
            case '--charts':
                args.chartDir = resolve(next());
                break;
            case '--out':
                args.outDir = resolve(next());
                break;
            case '--key-file':
                args.keyFile = resolve(next());
                break;
            case '--oexserverd':
                args.binaryPath = resolve(next());
                break;
            case '--limit':
                args.limit = Number(next());
                break;
            case '--skip-existing':
                args.skipExisting = true;
                break;
            case '--source-ho':
                args.sourceHO = next();
                break;
            case '--file-ext':
                args.fileExt = next();
                break;
            case '--pi-cache-store':
                args.piCacheStore = resolve(next());
                break;
            case '--report':
                args.reportPath = next();
                break;
            case '--only-bbox': {
                const parts = next().split(',').map(Number);
                if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n)))
                    throw new Error('--only-bbox must be wLon,sLat,eLon,nLat');
                args.onlyBbox = { wLon: parts[0], sLat: parts[1], eLon: parts[2], nLat: parts[3] };
                break;
            }
            default:
                throw new Error(`Unknown option: ${argv[i]}`);
        }
    }
    if (!args.chartDir || (!args.outDir && !args.piCacheStore)) {
        throw new Error(
            'usage: decrypt-batch --charts <dir> (--out <dir> | --pi-cache-store <dir>) [--report <absolute-path>] [--skip-existing]',
        );
    }
    if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit <= 0))
        throw new Error('--limit must be a positive integer');
    if (args.reportPath && !isAbsolute(args.reportPath)) throw new Error('--report must be an absolute path');
    if (args.piCacheStore && !args.outDir) args.outDir = join(args.piCacheStore, 'cells');
    return args;
}

/**
 * Content hashes catch same-mtime replacements and key-only updates. No raw
 * keys are persisted. The extractor's output schema is folded in (v2 salt up
 * to schema 1), so a newer extractor re-extracts every unchanged chart once
 * on the next --skip-existing reconcile — how installed cells gain new
 * layers (s57Classes EXTRACTOR_SCHEMA).
 */
export async function inputFingerprint(chartPath: string, keyDigest: string, sourceHO: string): Promise<string> {
    const salt = EXTRACTOR_SCHEMA <= 1 ? 'senc-extractor-v2' : `senc-extractor-v2-schema${EXTRACTOR_SCHEMA}`;
    const hash = createHash('sha256').update(`${salt}\0${keyDigest}\0${sourceHO}\0`);
    for await (const chunk of createReadStream(chartPath)) hash.update(chunk);
    return hash.digest('hex');
}

async function digestFile(path: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest('hex');
}

async function loadProcessedFiles(storeDir: string): Promise<ProcessedFilesRecord> {
    try {
        const parsed = JSON.parse(
            await readFile(join(storeDir, 'processed-files.json'), 'utf8'),
        ) as ProcessedFilesRecord;
        if (parsed.version === 2 && parsed.files && typeof parsed.files === 'object') return parsed;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    return { version: 2, files: {} };
}

export interface DecryptClient {
    start(): Promise<void>;
    decryptChart(chartPath: string, key: string): Promise<Buffer>;
    stop(): Promise<void>;
}

/** Isolated dependency makes failure handling testable without chart licences or hardware. */
export async function runDecryptBatch(args: Args, suppliedClient?: DecryptClient): Promise<BatchReport> {
    const report: BatchReport = {
        version: 1,
        expectedCellIds: [],
        processedCellIds: [],
        skippedCellIds: [],
        staleCellIds: [],
        failedCells: [],
    };
    const fail = (cellId: string, error: unknown): void => {
        const message = error instanceof Error ? error.message : String(error);
        report.failedCells.push({ cellId, error: message });
        console.error(`  ${cellId}: FAILED — ${message}`);
    };
    let client: DecryptClient | undefined;
    try {
        const files = await readdir(args.chartDir);
        const oesuFiles = files
            .filter((f) => extname(f).toLowerCase() === '.oesu')
            .sort()
            .slice(0, args.limit);
        report.expectedCellIds = oesuFiles.map((file) => basename(file, extname(file)).toUpperCase());
        if (oesuFiles.length === 0) throw new Error(`No .oesu chart cells found in ${args.chartDir}`);
        const candidates = files.filter((f) => /^oeuSENC-.*-sgl[0-9A-Fa-f]+\.XML$/i.test(f));
        if (!args.keyFile && candidates.length !== 1)
            throw new Error(`Expected one key XML in ${args.chartDir}; found ${candidates.length}`);
        const keyPath = args.keyFile ?? join(args.chartDir, candidates[0]);
        const keys = await loadKeyFileEntries(keyPath);
        const keyDigest = await digestFile(keyPath);
        const provenance = await loadChartSourceMetadata(args.chartDir);
        const processedStoreDir = args.piCacheStore ?? args.outDir;
        const previous = args.skipExisting
            ? await loadProcessedFiles(processedStoreDir)
            : { version: 2 as const, files: {} as Record<string, ProcessedFileEntry> };
        const installed = args.piCacheStore ? await loadPiCacheIndex(args.piCacheStore) : null;
        const records: Array<ReturnType<typeof cellStoreRecord>> = [];
        const pendingEntries: Record<string, ProcessedFileEntry> = {};
        await mkdir(args.outDir, { recursive: true });

        for (const file of oesuFiles) {
            const cellId = basename(file, extname(file)).toUpperCase();
            const chartPath = resolve(args.chartDir, file);
            try {
                const keyEntry = keys.get(basename(file, extname(file))) ?? keys.get(cellId);
                if (!keyEntry) throw new Error('No matching chart key in key XML');
                const { installKey, sourceCellId } = keyEntry;
                const sourceHO = resolveChartProducer(cellId, args.sourceHO, provenance, sourceCellId);
                const inputSha256 = await inputFingerprint(chartPath, keyDigest, sourceHO);
                const recorded = previous.files[chartPath];
                if (args.skipExisting && recorded?.inputSha256 === inputSha256) {
                    const meta = installed?.cells.find((entry) => entry.cellId === cellId);
                    const currentOutput =
                        args.piCacheStore && meta
                            ? join(args.piCacheStore, meta.blobPath ?? `cells/${cellId}.json`)
                            : recorded.outputPath;
                    const currentHash = await digestFile(currentOutput).catch(() => '');
                    if (
                        currentHash === recorded.contentSha256 &&
                        (!installed || meta?.contentSha256 === recorded.contentSha256)
                    ) {
                        report.skippedCellIds.push(cellId);
                        continue;
                    }
                }
                if (!client) {
                    client =
                        suppliedClient ?? new OexserverdClient({ binaryPath: args.binaryPath, readTimeoutMs: 60_000 });
                    await client.start();
                }
                const decrypted = await client.decryptChart(chartPath, installKey);
                const { header, features } = parseSenc(decrypted);
                const extent = header.cellExtent;
                if (
                    !header.sencVersion ||
                    !Number.isSafeInteger(header.cellEdition) ||
                    !extent ||
                    !Object.values(extent).every(Number.isFinite) ||
                    extent.wLon >= extent.eLon ||
                    extent.sLat >= extent.nLat
                ) {
                    throw new Error('Decrypted SENC is missing valid version, edition or chart extent');
                }
                if ((await inputFingerprint(chartPath, await digestFile(keyPath), sourceHO)) !== inputSha256)
                    throw new Error('Chart or keys changed during decryption; retry once download completes');
                const filter = args.onlyBbox;
                if (
                    filter &&
                    (extent.eLon < filter.wLon ||
                        extent.wLon > filter.eLon ||
                        extent.nLat < filter.sLat ||
                        extent.sLat > filter.nLat)
                ) {
                    report.skippedCellIds.push(cellId);
                    continue;
                }
                const cell = emitCell(header, features, { cellId, sourceHO, sourceCellId });
                const record = cellStoreRecord(cell);
                const outputPath = args.piCacheStore
                    ? join(args.piCacheStore, record.meta.blobPath!)
                    : join(args.outDir, `${cellId}${args.fileExt}`);
                const json = args.piCacheStore ? record.json : JSON.stringify(cell);
                if (args.piCacheStore) records.push(record);
                else await writeFileAtomic(outputPath, json);
                pendingEntries[chartPath] = {
                    inputSha256,
                    cellId,
                    outputPath,
                    contentSha256: createHash('sha256').update(json).digest('hex'),
                };
                report.processedCellIds.push(cellId);
                console.log(
                    `  ${file}: ${features.length} features / ${cell.stats?.emittedFeatures ?? 0} emitted; edition=${cell.edition} update=${cell.updateNumber ?? 0}`,
                );
            } catch (error) {
                fail(cellId, error);
            }
        }
        if (client) {
            await client.stop();
            client = undefined;
        }
        // A partial conversion never publishes over the live chart store.
        if (report.failedCells.length === 0) {
            if (args.piCacheStore && records.length > 0) {
                const publication = await publishPiCacheCells(args.piCacheStore, records);
                report.staleCellIds = publication.stale;
                report.skippedCellIds.push(...publication.unchanged, ...publication.stale);
                report.processedCellIds = publication.installed;
                // Cache the selected blob for older/unchanged source sets too. A
                // package rebuild may differ only in SENC creation date and must
                // not force another decryption on every startup.
                const retained = new Set([...publication.stale, ...publication.unchanged]);
                if (retained.size > 0) {
                    const current = await loadPiCacheIndex(args.piCacheStore);
                    for (const entry of Object.values(pendingEntries)) {
                        if (!retained.has(entry.cellId)) continue;
                        const selected = current.cells.find((cell) => cell.cellId === entry.cellId);
                        if (selected?.contentSha256) {
                            entry.contentSha256 = selected.contentSha256;
                            entry.outputPath = join(
                                args.piCacheStore,
                                selected.blobPath ?? `cells/${entry.cellId}.json`,
                            );
                        }
                    }
                }
                console.log(
                    `Wrote pi-cache index (${publication.installed.length} installed, ${publication.stale.length} older revisions preserved)`,
                );
            }
            if (args.skipExisting) {
                Object.assign(previous.files, pendingEntries);
                await writeFileAtomic(
                    join(processedStoreDir, 'processed-files.json'),
                    JSON.stringify(previous, null, 2),
                );
            }
        }
    } catch (error) {
        fail('__batch__', error);
    } finally {
        if (client) {
            try {
                await client.stop();
            } catch (error) {
                fail('__daemon__', error);
            }
        }
    }
    if (args.reportPath) await writeFileAtomic(args.reportPath, JSON.stringify(report, null, 2));
    console.log(
        `Done. processed=${report.processedCellIds.length} skipped=${report.skippedCellIds.length} failed=${report.failedCells.length}`,
    );
    return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try {
        const report = await runDecryptBatch(parseArgs(process.argv.slice(2)));
        if (report.failedCells.length > 0) process.exitCode = 1;
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    }
}
