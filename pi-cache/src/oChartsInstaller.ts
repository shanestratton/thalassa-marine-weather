/**
 * o-charts deliveries, kept encrypted (127-C-d decision 11).
 *
 * Until Pi update 3 every o-charts install ran the extractor (decryptBatch)
 * into a work dir and published the decrypted cells as files: the plaintext
 * store o-charts forbids ("Storing unencrypted data on any medium ... is
 * strictly prohibited"). Now an install checks the delivery's shape (every
 * set: exactly one key XML, every .oesu keyed, no cell twice), keeps the
 * ENCRYPTED delivery in enc-charts/sources/<archive sha256>-<uuid> (0700) as
 * before, and asks the chart vault to rescan; the vault opens the cells in its
 * own memory. Nothing here spawns anything or writes a decrypted byte. During
 * a watch the vault queues the rescan, and the set's charts open after it.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ChartInstallError, type PackageSummary } from './encChartStore.js';
import type { VaultRescanWire } from './vault/protocol.js';

export interface OChartsSet {
    directory: string;
    keyFile: string;
    cellIds: string[];
    sourceCellIds: Record<string, string>;
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

export interface OChartsInstallResult {
    persistedCellIds: string[];
    packageSummary: PackageSummary;
    /** Not counted: the vault keeps no feature count per delivery. */
    featureCount: number;
    sourceArchiveId: string;
    /** The rescan waits: for the end of a watch, or for a vault that is down. */
    queued?: 'watch' | 'vault-down';
}

/** An earlier install of the same archive, kept in sources/, if any. */
async function retainedCopyOf(sourceRoot: string, archiveHash: string): Promise<string | null> {
    const entries = await fs.readdir(sourceRoot, { withFileTypes: true }).catch(() => []);
    const kept = entries.find((e) => e.isDirectory() && e.name.startsWith(`${archiveHash}-`));
    return kept ? path.join(sourceRoot, kept.name) : null;
}

export async function installOChartsDelivery(options: {
    extractedDir: string;
    chartStoreDir: string;
    archiveHash: string;
    /** The chart vault's /v1/rescan (vaultClient.rescan). */
    rescan: (cellIds: string[]) => Promise<VaultRescanWire>;
    onProgress?: (step: string, completed: number, total: number) => void;
}): Promise<OChartsInstallResult> {
    if (!/^[0-9a-f]{64}$/.test(options.archiveHash))
        throw new ChartInstallError('invalid-chart-archive', 'The delivery has no verified archive identity.');
    const sets = await inspectOChartsSets(options.extractedDir);
    if (sets.length === 0)
        throw new ChartInstallError('ocharts-no-cells', 'No o-charts cells were found in this archive.');
    const cellIds = sets.flatMap((set) => set.cellIds).sort();
    // Keep a private copy of the encrypted delivery outside ENC_WATCH_DIR, once
    // per archive. It is what the vault reads, and the licensed delivery.
    const sourceRoot = path.join(options.chartStoreDir, 'sources');
    await fs.mkdir(sourceRoot, { recursive: true, mode: 0o700 });
    let retained = await retainedCopyOf(sourceRoot, options.archiveHash);
    if (!retained) {
        retained = path.join(sourceRoot, `${options.archiveHash}-${randomUUID()}`);
        try {
            await fs.cp(options.extractedDir, retained, { recursive: true, errorOnExist: true, force: false });
            await fs.chmod(retained, 0o700);
        } catch (error) {
            await fs.rm(retained, { recursive: true, force: true }).catch(() => {});
            throw error;
        }
    }
    options.onProgress?.('Opening the new charts in the Pi’s memory', 0, cellIds.length);
    let result: VaultRescanWire;
    try {
        result = await options.rescan(cellIds);
    } catch {
        // The set is kept, encrypted; the vault opens it when it is back.
        result = { queued: true, reason: 'vault-down' };
    }
    const none: PackageSummary = { new: 0, updated: 0, unchanged: 0, total: cellIds.length };
    return {
        persistedCellIds: cellIds,
        packageSummary: result.summary ?? none,
        featureCount: 0,
        sourceArchiveId: path.basename(retained),
        ...(result.queued ? { queued: result.reason ?? 'watch' } : {}),
    };
}
