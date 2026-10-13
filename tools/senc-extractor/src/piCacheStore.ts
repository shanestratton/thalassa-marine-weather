import { mkdir, readFile, rmdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { CellOutput } from './geojsonEmitter.js';
import { writeFileAtomic } from './atomicWrite.js';
import { sameChartContentIgnoringSencBuildDate } from './chartContent.js';

/**
 * Writers for pi-cache's chart store:
 *   <store>/cells/<cellId>-<sha256>.json   immutable `{cells: [cell]}`
 *   <store>/index.json            InstalledIndex consumed by /api/enc/installed
 *
 * Mirrors what pi-cache/src/routes/enc.ts (`saveInstalledCell`) writes, so
 * cells dropped here are immediately visible to the iOS app's `syncEncFromPi`
 * flow. Every writer uses the same .index.lock and atomic publication point.
 */

export interface InstalledCellMeta {
    cellId: string;
    sourceCellId?: string;
    sourceHO: string;
    edition: number;
    updateNumber?: number;
    issued: string;
    bbox: [number, number, number, number];
    featureCount: number;
    sizeBytes: number;
    installedAt: string;
    source: 'phone-upload' | 'url' | 'pi-decrypt';
    sourceUrl?: string;
    contentSha256?: string;
    blobPath?: string;
    /** 127-C-b: every decrypted cell is 'protected' (pi-cache/src/chartLicence.ts). */
    licence?: 'protected' | 'open';
}

export interface InstalledIndex {
    version: 1;
    cells: InstalledCellMeta[];
}

export async function loadPiCacheIndex(storeDir: string): Promise<InstalledIndex> {
    let raw: string;
    try {
        raw = await readFile(join(storeDir, 'index.json'), 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, cells: [] };
        throw error;
    }
    const parsed = JSON.parse(raw) as InstalledIndex;
    if (parsed.version !== 1 || !Array.isArray(parsed.cells))
        throw new Error('Invalid pi-cache index; refusing to replace it');
    const seen = new Set<string>();
    for (const cell of parsed.cells) {
        if (
            !cell ||
            !/^[A-Za-z0-9_-]+$/.test(cell.cellId) ||
            seen.has(cell.cellId) ||
            typeof cell.sourceHO !== 'string' ||
            !Number.isSafeInteger(cell.edition) ||
            cell.edition < 0 ||
            (cell.updateNumber !== undefined && (!Number.isSafeInteger(cell.updateNumber) || cell.updateNumber < 0)) ||
            typeof cell.issued !== 'string' ||
            (cell.sourceCellId !== undefined && !/^[A-Z0-9]{2}[1-6][A-Z0-9]{5}$/.test(cell.sourceCellId)) ||
            (cell.contentSha256 !== undefined && !/^[a-f0-9]{64}$/.test(cell.contentSha256)) ||
            (cell.blobPath !== undefined && !/^cells\/[A-Za-z0-9_-]+\.json$/.test(cell.blobPath))
        ) {
            throw new Error('Invalid pi-cache cell metadata; refusing to replace the index');
        }
        seen.add(cell.cellId);
    }
    return parsed;
}

/** All pi-cache writers acquire this lock before rereading and replacing the index. */
export async function withPiCacheIndexLock<T>(storeDir: string, action: () => Promise<T>): Promise<T> {
    await mkdir(storeDir, { recursive: true });
    const lockPath = join(storeDir, '.index.lock');
    const deadline = Date.now() + 30_000;
    for (;;) {
        try {
            await mkdir(lockPath);
            break;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            if (Date.now() >= deadline) throw new Error(`Chart index is locked: ${lockPath}; check for another writer`);
            await delay(100);
        }
    }
    try {
        return await action();
    } finally {
        await rmdir(lockPath);
    }
}

export function compareCellRevision(a: InstalledCellMeta, b: InstalledCellMeta): number {
    const date = (value: string) => (/^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '');
    return (
        a.edition - b.edition ||
        (a.updateNumber ?? 0) - (b.updateNumber ?? 0) ||
        date(a.issued).localeCompare(date(b.issued))
    );
}

/** Serialize one cell in the store's wire shape and build its index entry. */
export function cellStoreRecord(cell: CellOutput): { json: string; meta: InstalledCellMeta } {
    if (!/^[A-Za-z0-9_-]+$/.test(cell.cellId)) throw new Error(`Invalid cell id: ${cell.cellId}`);
    const json = JSON.stringify({ cells: [cell] });
    const contentSha256 = createHash('sha256').update(json, 'utf8').digest('hex');
    return {
        json,
        meta: {
            cellId: cell.cellId,
            ...(cell.sourceCellId ? { sourceCellId: cell.sourceCellId } : {}),
            sourceHO: cell.sourceHO,
            edition: cell.edition,
            updateNumber: cell.updateNumber,
            issued: cell.issued,
            bbox: cell.bbox,
            featureCount: cell.stats?.emittedFeatures ?? 0,
            sizeBytes: Buffer.byteLength(json, 'utf8'),
            installedAt: new Date().toISOString(),
            source: 'pi-decrypt',
            licence: 'protected',
            contentSha256,
            blobPath: `cells/${cell.cellId}-${contentSha256}.json`,
        },
    };
}

/**
 * The extractor schema a store blob `{cells: [cell]}` was produced by: the
 * cell's `extractorSchema`, 1 when absent (every extraction before the field
 * existed); null when the blob is not a single-cell batch or the field is
 * malformed — then no schema rule applies and a content difference stays a
 * conflict.
 */
export function cellExtractorSchema(raw: string | Buffer): number | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw.toString());
    } catch {
        return null;
    }
    const cells = (parsed as { cells?: unknown } | null)?.cells;
    if (!Array.isArray(cells) || cells.length !== 1 || !cells[0] || typeof cells[0] !== 'object') return null;
    const schema = (cells[0] as { extractorSchema?: unknown }).extractorSchema;
    if (schema === undefined) return 1;
    return Number.isSafeInteger(schema) && (schema as number) >= 1 ? (schema as number) : null;
}

/** Immutable blobs are written first; the index rename publishes the complete selection. */
export async function publishPiCacheCells(
    storeDir: string,
    records: Array<ReturnType<typeof cellStoreRecord>>,
): Promise<{ installed: string[]; unchanged: string[]; stale: string[] }> {
    return withPiCacheIndexLock(storeDir, async () => {
        const index = await loadPiCacheIndex(storeDir);
        const result = { installed: [] as string[], unchanged: [] as string[], stale: [] as string[] };
        const accepted: typeof records = [];
        for (const record of records) {
            const { meta } = record;
            const existingIdx = index.cells.findIndex((c) => c.cellId === meta.cellId);
            const existing = index.cells[existingIdx];
            if (existing) {
                const revision = compareCellRevision(meta, existing);
                if (revision < 0) {
                    result.stale.push(meta.cellId);
                    continue;
                }
                if (revision === 0 && existing.contentSha256 === meta.contentSha256) {
                    const path = join(storeDir, existing.blobPath ?? `cells/${existing.cellId}.json`);
                    const data = await readFile(path).catch((error: NodeJS.ErrnoException) => {
                        if (error.code === 'ENOENT') return null;
                        throw error;
                    });
                    if (data && createHash('sha256').update(data).digest('hex') === meta.contentSha256) {
                        result.unchanged.push(meta.cellId);
                        continue;
                    }
                } else if (revision === 0 && existing.contentSha256) {
                    const data = await readFile(join(storeDir, existing.blobPath ?? `cells/${existing.cellId}.json`));
                    if (createHash('sha256').update(data).digest('hex') !== existing.contentSha256) {
                        throw new Error(`Installed blob integrity mismatch for ${meta.cellId}`);
                    }
                    if (sameChartContentIgnoringSencBuildDate(data, record.json)) {
                        // Keep the published bytes/hash/build date. An older package
                        // rebuild must not replace the currently selected package.
                        result.unchanged.push(meta.cellId);
                        continue;
                    }
                    // The same chart revision from a DIFFERENT extractor schema
                    // (s57Classes EXTRACTOR_SCHEMA): a newer extractor's output
                    // replaces the older one (how installed cells gain new
                    // layers); an older extractor never replaces a newer one.
                    const incoming = cellExtractorSchema(record.json);
                    const installedSchema = cellExtractorSchema(data);
                    if (incoming !== null && installedSchema !== null && incoming < installedSchema) {
                        result.unchanged.push(meta.cellId);
                        continue;
                    }
                    if (incoming === null || installedSchema === null || incoming === installedSchema) {
                        throw new Error(
                            `Conflicting content for ${meta.cellId} at edition ${meta.edition}, update ${meta.updateNumber ?? 0}`,
                        );
                    }
                }
                if (existing.sourceCellId && existing.sourceCellId !== meta.sourceCellId)
                    throw new Error(`Native ENC identity conflict for ${meta.cellId}`);
                const nativeId = meta.sourceCellId ?? meta.cellId;
                const verifiedLegacyCorrection =
                    !existing.contentSha256 &&
                    /^[A-Z0-9]{2}[1-6][A-Z0-9]{5}$/.test(nativeId) &&
                    meta.sourceHO === nativeId.slice(0, 2);
                if (existing.sourceHO !== meta.sourceHO && !verifiedLegacyCorrection)
                    throw new Error(`Producer conflict for ${meta.cellId}`);
                index.cells[existingIdx] = meta;
            } else index.cells.push(meta);
            accepted.push(record);
            result.installed.push(meta.cellId);
        }
        await mkdir(join(storeDir, 'cells'), { recursive: true });
        for (const record of accepted) await writeFileAtomic(join(storeDir, record.meta.blobPath!), record.json);
        if (accepted.length > 0) await writeFileAtomic(join(storeDir, 'index.json'), JSON.stringify(index, null, 2));
        return result;
    });
}
