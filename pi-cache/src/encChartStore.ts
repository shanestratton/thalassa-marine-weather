import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { chartBlobExtractorSchema } from './encLayerContract.js';
import { piChartLicence, type ChartLicence } from './chartLicence.js';

export interface InstalledCellMeta {
    cellId: string;
    sourceHO: string;
    /** Native ENC identity attributed to this file by the licensed key XML. */
    sourceCellId?: string;
    edition: number;
    updateNumber?: number;
    issued: string;
    bbox: [number, number, number, number];
    featureCount: number;
    sizeBytes: number;
    installedAt: string;
    /**
     * 's63' is a legacy enum value. The retired S-63 path wrote its cells as
     * 'pi-decrypt', so those cells are removed by 127-C-d's purge, not by source.
     */
    source: 'phone-upload' | 'url' | 'pi-decrypt' | 's63';
    /** Only the origin is retained; vendor download URLs can carry credentials in their path. */
    sourceUrl?: string;
    contentSha256?: string;
    /** Immutable version, relative to the store. Absent on legacy installations. */
    blobPath?: string;
    packageId?: string;
    /** 127-C-b: 'protected' for o-charts, S-63 and anything not NOAA. Filled on
     *  read for older indexes (never written just to add it), stamped on write. */
    licence?: ChartLicence;
}

export interface InstalledIndex {
    version: 1;
    cells: InstalledCellMeta[];
}

export interface PackageSummary {
    new: number;
    updated: number;
    unchanged: number;
    total: number;
}

export class ChartInstallError extends Error {
    constructor(
        public readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = 'ChartInstallError';
    }
}

export function redactChartSourceUrl(value: string | undefined): string | undefined {
    if (!value) return undefined;
    try {
        const parsed = new URL(value);
        return ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin : undefined;
    } catch {
        return undefined;
    }
}

export function chartBlobPath(storeDir: string, meta: Pick<InstalledCellMeta, 'cellId' | 'blobPath'>): string {
    if (meta.blobPath !== undefined) {
        if (!/^cells\/[A-Za-z0-9_-][A-Za-z0-9._-]*\.json$/.test(meta.blobPath)) {
            throw new ChartInstallError('invalid-chart-index', 'The chart index contains an invalid blob path.');
        }
        return path.join(storeDir, meta.blobPath);
    }
    const safe = meta.cellId.replace(/[^A-Za-z0-9_-]/g, '_');
    return path.join(storeDir, 'cells', `${safe}.json`);
}

/** Fail closed on a corrupt existing index; never replace it with an empty one. */
export async function readChartIndex(storeDir: string): Promise<InstalledIndex> {
    let raw: string;
    try {
        raw = await fs.readFile(path.join(storeDir, 'index.json'), 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, cells: [] };
        throw error;
    }
    const index = JSON.parse(raw) as InstalledIndex;
    if (index.version !== 1 || !Array.isArray(index.cells)) {
        throw new ChartInstallError(
            'invalid-chart-index',
            'The installed chart index is invalid; existing charts were preserved.',
        );
    }
    const ids = new Set<string>();
    for (const cell of index.cells) {
        if (
            !cell ||
            typeof cell.cellId !== 'string' ||
            !cell.cellId ||
            ids.has(cell.cellId) ||
            !Number.isInteger(cell.edition) ||
            cell.edition < 0 ||
            (cell.updateNumber !== undefined && (!Number.isInteger(cell.updateNumber) || cell.updateNumber < 0)) ||
            typeof cell.sourceHO !== 'string' ||
            !cell.sourceHO ||
            typeof cell.issued !== 'string'
        ) {
            throw new ChartInstallError(
                'invalid-chart-index',
                'The installed chart index contains invalid or duplicate cells.',
            );
        }
        ids.add(cell.cellId);
        chartBlobPath(storeDir, cell);
        cell.sourceUrl = redactChartSourceUrl(cell.sourceUrl);
        cell.licence = piChartLicence(cell);
    }
    return index;
}

export async function writeChartFileAtomic(filename: string, bytes: string | Buffer): Promise<void> {
    await fs.mkdir(path.dirname(filename), { recursive: true });
    const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${randomUUID()}.tmp`);
    try {
        await fs.writeFile(temporary, bytes, { mode: 0o600 });
        await fs.rename(temporary, filename);
    } catch (error) {
        await fs.unlink(temporary).catch(() => {});
        throw error;
    }
}

/** Same lock protocol as tools/senc-extractor: no automatic stale-lock reclamation. */
export async function withChartIndexLock<T>(storeDir: string, work: () => Promise<T>, timeoutMs = 30_000): Promise<T> {
    await fs.mkdir(storeDir, { recursive: true });
    const lockPath = path.join(storeDir, '.index.lock');
    const deadline = Date.now() + timeoutMs;
    while (true) {
        try {
            await fs.mkdir(lockPath, { mode: 0o700 });
            break;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            if (Date.now() >= deadline) {
                throw new ChartInstallError(
                    'chart-store-busy',
                    'The chart store is busy. Try again after the current installation finishes.',
                );
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }
    try {
        return await work();
    } finally {
        await fs.rmdir(lockPath);
    }
}

export function compareChartRevision(a: InstalledCellMeta, b: InstalledCellMeta): number {
    const edition = a.edition - b.edition;
    if (edition !== 0) return edition;
    const update = (a.updateNumber ?? 0) - (b.updateNumber ?? 0);
    if (update !== 0) return update;
    const date = (value: string): string => (/^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '');
    return date(a.issued).localeCompare(date(b.issued));
}

/**
 * Mirrors senc-extractor/chartContent.ts. A package rebuild can change only
 * the direct cell's SENC build date without changing the ENC revision/data.
 * Keep all other fields (including unknown fields), and preserve array order.
 * This never substitutes for verifying the selected blob's exact wire hash.
 */
export function sameChartContentIgnoringSencBuildDate(a: string | Buffer, b: string | Buffer): boolean {
    const boundedJson = (value: unknown, depth = 0): boolean => {
        if (depth > 128) return false;
        if (typeof value === 'number') return Number.isFinite(value);
        if (value === null || typeof value !== 'object') return true;
        return Object.values(value).every((child) => boundedJson(child, depth + 1));
    };
    const comparable = (raw: string | Buffer): Record<string, unknown> | null => {
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw.toString());
        } catch {
            return null;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !boundedJson(parsed)) return null;
        const batch = parsed as Record<string, unknown>;
        if (!Array.isArray(batch.cells) || batch.cells.length !== 1) return null;
        const cell = batch.cells[0];
        if (!cell || typeof cell !== 'object' || Array.isArray(cell)) return null;
        const { sencCreateDate, ...content } = cell as Record<string, unknown>;
        if (sencCreateDate !== undefined && (typeof sencCreateDate !== 'string' || !/^\d{8}$/.test(sencCreateDate)))
            return null;
        return { ...batch, cells: [content] };
    };
    const left = comparable(a);
    const right = comparable(b);
    return left !== null && right !== null && isDeepStrictEqual(left, right);
}

export interface StagedChartCell {
    meta: InstalledCellMeta;
    filename: string;
}

/**
 * This store understands publishChartDelivery's `refreshPackageId`. A build
 * without it would silently ignore the option and publish a refresh as an
 * ordinary delivery (resurrecting removed cells, or failing chart-downgrade),
 * so oChartsInstaller's re-conversion reads this through a namespace import,
 * where a missing name is `undefined` rather than a module-link failure, and
 * refuses to run without it. Pi files are deployed one by one, so a stale
 * encChartStore.js next to a newer installer is a real possibility.
 */
export const CHART_REFRESH_SUPPORTED = true;

/**
 * Publish a complete validated delivery with one atomic index replacement.
 * Existing blobs are immutable and retained: readers holding the old index
 * continue seeing exactly that edition, even across updates and deletions.
 *
 * `refreshPackageId` makes this a REFRESH of an installed package (the
 * re-conversion of a retained o-charts source when the converter schema
 * moves, oChartsInstaller.reconvertRetainedOChartsSource), not a delivery.
 * A refresh replaces only the cells that package currently owns
 * (`packageId` equal to it). Every other candidate is left exactly as
 * installed and listed in `retainedCellIds`: a cell another package or the
 * ~/Charts watcher now supplies (typically a base set at the same revision,
 * or a newer edition), and a cell the skipper removed (never resurrected).
 * The rules are decided here, under the index lock, so a concurrent
 * install cannot change ownership between the decision and the commit. The
 * owned cells then pass every ordinary rule below unchanged — identity,
 * producer, downgrade, and the same-revision rule (a newer converter schema
 * replaces, an older one never does, equal schemas with different content
 * still fail closed). A normal delivery (no `refreshPackageId`) is untouched.
 */
export async function publishChartDelivery(
    storeDir: string,
    cells: StagedChartCell[],
    options: { beforeCommit?: () => Promise<void>; refreshPackageId?: string } = {},
): Promise<{
    cells: InstalledCellMeta[];
    packageSummary: PackageSummary;
    /** Cells this publication replaced or added. */
    changedCellIds: string[];
    /** Refresh only: candidates left as installed (see refreshPackageId). */
    retainedCellIds: string[];
}> {
    return withChartIndexLock(storeDir, async () => {
        const index = await readChartIndex(storeDir);
        const byId = new Map(index.cells.map((cell) => [cell.cellId, cell]));
        const summary: PackageSummary = { new: 0, updated: 0, unchanged: 0, total: cells.length };
        const prepared: { source: string; meta: InstalledCellMeta; changed: boolean }[] = [];
        const retainedCellIds: string[] = [];
        const seen = new Set<string>();
        const refresh = options.refreshPackageId;
        if (refresh !== undefined && !/^[0-9a-f]{64}$/.test(refresh))
            throw new ChartInstallError('invalid-chart-refresh', 'A chart refresh needs a verified package identity.');
        for (const candidate of cells) {
            if (seen.has(candidate.meta.cellId))
                throw new ChartInstallError('duplicate-chart-cell', 'This delivery contains duplicate chart cells.');
            seen.add(candidate.meta.cellId);
            const bytes = await fs.readFile(candidate.filename);
            const hash = createHash('sha256').update(bytes).digest('hex');
            if (candidate.meta.contentSha256 && candidate.meta.contentSha256 !== hash) {
                throw new ChartInstallError(
                    'chart-checksum-mismatch',
                    `Converted chart ${candidate.meta.cellId} failed its integrity check.`,
                );
            }
            const safeId = candidate.meta.cellId.replace(/[^A-Za-z0-9_-]/g, '_');
            const meta: InstalledCellMeta = {
                ...candidate.meta,
                sourceUrl: redactChartSourceUrl(candidate.meta.sourceUrl),
                contentSha256: hash,
                sizeBytes: bytes.length,
                blobPath: `cells/${safeId}-${hash}.json`,
                licence: piChartLicence(candidate.meta),
            };
            const previous = byId.get(meta.cellId);
            if (refresh !== undefined) {
                if (meta.packageId !== refresh)
                    throw new ChartInstallError(
                        'invalid-chart-refresh',
                        `${meta.cellId} does not belong to the package being refreshed.`,
                    );
                if (previous?.packageId !== refresh) {
                    // Not this package's cell (any more): leave it as installed.
                    retainedCellIds.push(meta.cellId);
                    summary.unchanged++;
                    if (previous) prepared.push({ source: candidate.filename, meta: previous, changed: false });
                    continue;
                }
            }
            if (previous) {
                if (previous.sourceCellId && previous.sourceCellId !== meta.sourceCellId) {
                    throw new ChartInstallError(
                        'chart-producer-conflict',
                        `The native ENC identity for ${meta.cellId} does not match the installed chart.`,
                    );
                }
                const nativeProducerMatches =
                    typeof meta.sourceCellId === 'string' &&
                    /^[A-Z0-9]{2}[1-6][A-Z0-9]{5}$/.test(meta.sourceCellId) &&
                    meta.sourceHO === meta.sourceCellId.slice(0, 2);
                const verifiedLegacyProducerCorrection =
                    !previous.contentSha256 &&
                    ((/^[A-Z]{2}\d[A-Z0-9]{2,5}$/.test(meta.cellId) && meta.sourceHO === meta.cellId.slice(0, 2)) ||
                        (/^OC-/.test(meta.cellId) && nativeProducerMatches));
                if (previous.sourceHO !== meta.sourceHO && !verifiedLegacyProducerCorrection) {
                    throw new ChartInstallError(
                        'chart-producer-conflict',
                        `The issuing hydrographic office for ${meta.cellId} does not match the installed chart.`,
                    );
                }
                const revision = compareChartRevision(meta, previous);
                if (revision < 0) {
                    throw new ChartInstallError(
                        'chart-downgrade',
                        `${meta.cellId} is older than the installed chart. Existing charts were preserved.`,
                    );
                }
                const previousHash =
                    previous.contentSha256 ??
                    createHash('sha256')
                        .update(await fs.readFile(chartBlobPath(storeDir, previous)))
                        .digest('hex');
                if (previousHash === hash) {
                    // Matching metadata alone is not proof that a previous
                    // installation survived an interrupted write or disk fault.
                    const installedBytes = await fs.readFile(chartBlobPath(storeDir, previous));
                    if (createHash('sha256').update(installedBytes).digest('hex') !== hash) {
                        throw new ChartInstallError(
                            'chart-checksum-mismatch',
                            `${meta.cellId} failed verification in the installed store. Existing charts were preserved.`,
                        );
                    }
                    summary.unchanged++;
                    prepared.push({ source: candidate.filename, meta: previous, changed: false });
                    continue;
                }
                if (revision === 0 && previous.contentSha256) {
                    const installedBytes = await fs.readFile(chartBlobPath(storeDir, previous));
                    if (createHash('sha256').update(installedBytes).digest('hex') !== previous.contentSha256) {
                        throw new ChartInstallError(
                            'chart-checksum-mismatch',
                            `${meta.cellId} failed verification in the installed store. Existing charts were preserved.`,
                        );
                    }
                    if (sameChartContentIgnoringSencBuildDate(installedBytes, bytes)) {
                        // Preserve the currently selected version, package provenance,
                        // installation time and exact wire hash. Nothing is republished.
                        summary.unchanged++;
                        prepared.push({ source: candidate.filename, meta: previous, changed: false });
                        continue;
                    }
                    // The same chart revision from a DIFFERENT converter schema
                    // (encLayerContract ENC_CONVERSION_SCHEMA / the extractor's
                    // EXTRACTOR_SCHEMA): a newer conversion replaces the older one
                    // (how installed cells gain new layers, e.g. the bridge and
                    // overhead-clearance layers of Part B); an older one never
                    // replaces a newer one. Equal or unreadable schemas: conflict.
                    const incomingSchema = chartBlobExtractorSchema(bytes);
                    const installedSchema = chartBlobExtractorSchema(installedBytes);
                    const schemasKnown = incomingSchema !== null && installedSchema !== null;
                    if (schemasKnown && incomingSchema < installedSchema) {
                        summary.unchanged++;
                        prepared.push({ source: candidate.filename, meta: previous, changed: false });
                        continue;
                    }
                    if (!schemasKnown || incomingSchema === installedSchema) {
                        throw new ChartInstallError(
                            'chart-revision-conflict',
                            `${meta.cellId} has different content with the same chart revision. Existing charts were preserved.`,
                        );
                    }
                }
                summary.updated++;
            } else {
                summary.new++;
            }
            prepared.push({ source: candidate.filename, meta, changed: true });
        }
        // Validation/downgrade checks finish for every cell before any publication.
        for (const item of prepared) {
            if (!item.changed) continue;
            const destination = chartBlobPath(storeDir, item.meta);
            await fs.mkdir(path.dirname(destination), { recursive: true });
            // Never truncate a version already held by a reader. A concurrent
            // writer cannot get here under the lock, but COPYFILE_EXCL also
            // protects immutable files left by an interrupted installation.
            try {
                await fs.copyFile(item.source, destination, fs.constants.COPYFILE_EXCL);
                await fs.chmod(destination, 0o600);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                const actualHash = createHash('sha256')
                    .update(await fs.readFile(destination))
                    .digest('hex');
                if (actualHash !== item.meta.contentSha256)
                    throw new ChartInstallError(
                        'chart-checksum-mismatch',
                        'An existing chart version failed its integrity check.',
                    );
            }
            byId.set(item.meta.cellId, item.meta);
        }
        if (summary.new + summary.updated > 0) {
            await options.beforeCommit?.();
            await writeChartFileAtomic(
                path.join(storeDir, 'index.json'),
                JSON.stringify({ version: 1, cells: [...byId.values()] }, null, 2),
            );
        }
        return {
            cells: prepared.map((item) => item.meta),
            packageSummary: summary,
            changedCellIds: prepared.filter((item) => item.changed).map((item) => item.meta.cellId),
            retainedCellIds,
        };
    });
}

export async function removeChartCell(storeDir: string, cellId: string): Promise<boolean> {
    return withChartIndexLock(storeDir, async () => {
        const index = await readChartIndex(storeDir);
        const cells = index.cells.filter((cell) => cell.cellId !== cellId);
        if (cells.length === index.cells.length) return false;
        await writeChartFileAtomic(path.join(storeDir, 'index.json'), JSON.stringify({ version: 1, cells }, null, 2));
        return true;
    });
}
